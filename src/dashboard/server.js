'use strict';
/**
 * Rimuru Tempest Casino — Admin Dashboard server.
 *
 * Serves the admin dashboard website + REST API + Socket.IO realtime
 * (moderator chat room + live stats) from the SAME HTTP server as the
 * bot's health endpoint (see src/index.js).
 *
 * Auth: the OWNER (Telegram ID 8781690556) is always an admin. Extra
 * moderators are added via the dashboard (owner only) and stored in the
 * admin_users table. Each admin logs in with { userId, password }.
 *   - Owner default password: DASHBOARD_PASSWORD env (or auto-generated).
 *   - Mod passwords: set by the owner when adding a moderator.
 * Sessions are signed cookies (7-day TTL).
 *
 * API (all JSON):
 *   POST /api/login          { userId, password } -> { token }
 *   POST /api/logout
 *   GET  /api/me             -> current admin
 *   GET  /api/stats          -> overview stats
 *   GET  /api/users          -> user list (with search + pagination)
 *   GET  /api/users/:id      -> per-user detail (profile, history, logs)
 *   POST /api/users/:id/action  { action, amount, reason, duration }
 *        action: give | deduct | set | fine | jail | suspend | mute | ban | unban | lift
 *   GET  /api/logs/chat?userId=&limit=
 *   GET  /api/logs/games?userId=&limit=
 *   GET  /api/activity
 *   GET  /api/audit
 *   GET  /api/events  POST /api/events  PATCH /api/events/:id  DELETE /api/events/:id
 *   POST /api/broadcast  { message, target: all|users|groups }
 *   GET  /api/broadcasts
 *   GET  /api/mods   POST /api/mods  DELETE /api/mods/:userId   (owner only)
 *   GET  /api/rimuru/chat?q=  -> Rimuru mini-assistant chat (Groq)
 *   POST /api/rimuru/message { text } -> Rimuru reply for the widget
 *
 * Socket.IO events:
 *   'mod:join'   (name)        join the moderator room
 *   'mod:msg'    { text, name }  send a room message (broadcast to room)
 *   'mod:history'  -> last 200 room messages
 *   Server -> 'mod:msg'        new room message to all members
 *   Server -> 'stats'          live stats pushed every 15s
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('../config');
const db = require('../db');
const admin = require('../admin');

const OWNER_ID = Number(config.ownerId);
const SESSION_TTL = config.dashboard.sessionTtlMs;
const SESSION_SECRET = process.env.DASHBOARD_SECRET || crypto.randomBytes(32).toString('hex');
const MOD_ROOM = 'moderators';

/** Active bot reference (set by bot.js after boot so broadcasts can fan out). */
let activeBot = null;
function setActiveBot(bot) {
  activeBot = bot;
}

/* ---------- broadcast queue (module-level — bot.js drains it) ---------- */
const broadcastQueue = [];
function queueBroadcast(id, message, target) {
  broadcastQueue.push({ id, message, target, queuedAt: Date.now() });
  while (broadcastQueue.length > 100) broadcastQueue.shift();
}
/** Called by bot.js periodically to drain the queue (real fan-out). */
function drainBroadcastQueue(sendFn) {
  const item = broadcastQueue.shift();
  if (!item || typeof sendFn !== 'function') return null;
  try {
    // Async delivery: sendFn fires its own (item, done) — we don't await it,
    // so the next item in the queue is drained immediately.
    const cb = (count) => {
      try {
        db.updateBroadcastCount(item.id, count);
        db.logActivity('broadcast', `Broadcast delivered to ${count} chats`, { broadcast_id: item.id });
      } catch (e) { /* non-fatal */ }
    };
    const ret = sendFn(item, cb);
    if (ret && typeof ret.catch === 'function') ret.catch((e) => console.error('[dashboard] broadcast send failed:', e.message));
  } catch (e) {
    console.error('[dashboard] broadcast drain error:', e.message);
  }
  return item;
}
function pendingBroadcasts() {
  return broadcastQueue.length;
}

/** In-memory moderator chat room history (also persisted to activity feed). */
const modHistory = [];
const MOD_HISTORY_MAX = 200;

/** Generate a random dashboard password if none configured. */
function ensureOwnerPassword() {
  // Always uses the CURRENT configured password (DASHBOARD_PASSWORD env or
  // the fixed default in config) and upserts the owner row, so the password
  // takes effect even on instances that already have an owner account.
  const pw = config.dashboard.password || '';
  const owner = db.getAdminUser(OWNER_ID);
  db.addAdminUser(OWNER_ID, (owner && owner.username) || 'thedevilslord', 'owner', pw);
  if (!owner) {
    console.log(`[dashboard] Owner admin account created (user_id ${OWNER_ID}).`);
  }
  return pw;
}

/** Create the dashboard Express app (mounted by src/index.js on the SAME http.Server). */
function createDashboard(server, bot) {
  const app = express();
  const io = new Server(server, {
    /* same-origin only — Socket.IO shares the bot's port */
    serveClient: true,
    cors: { origin: false },
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(SESSION_SECRET));

  /* ---------- sessions ---------- */

  function signSession(userId, role) {
    const payload = `${userId}.${role}.${Date.now()}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex').slice(0, 24);
    return `${payload}.${sig}`;
  }

  function verifySession(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex').slice(0, 24);
    if (sig !== parts[3]) return null;
    const ts = Number(parts[2]);
    if (!ts || Date.now() - ts > SESSION_TTL) return null;
    return { userId: Number(parts[0]), role: parts[1] };
  }

  function currentAdmin(req) {
    const token = req.cookies && req.cookies.rimuru_session;
    return verifySession(token);
  }

  function requireAuth(req, res, next) {
    const s = currentAdmin(req);
    if (!s) {
      res.status(401).json({ ok: false, error: 'Not authenticated' });
      return;
    }
    req.admin = s;
    next();
  }

  function requireOwner(req, res, next) {
    if (!req.admin || req.admin.role !== 'owner') {
      res.status(403).json({ ok: false, error: 'Owner only' });
      return;
    }
    next();
  }

  function setSessionCookie(res, token) {
    res.cookie('rimuru_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL,
    });
  }

  /* ---------- helpers ---------- */

  /** Resolve + sanitize a user row for the API. */
  function userView(u) {
    if (!u) return null;
    return {
      user_id: u.user_id,
      username: u.username,
      first_name: u.first_name,
      wallet: u.wallet,
      bank: u.bank,
      networth: u.wallet + u.bank,
      status: u.status,
      status_reason: u.status_reason,
      status_until: u.status_until,
      created_at: u.created_at,
    };
  }

  function audit(actor, action, targetId, detail) {
    try {
      db.logAudit(actor.userId, actor.role, action, targetId, detail);
    } catch (e) { /* non-fatal */ }
  }

  /* ---------- static dashboard page ---------- */

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  /* ---------- auth ---------- */

  app.post('/api/login', (req, res) => {
    const { userId, password } = req.body || {};
    const uid = Number(userId);
    if (!uid || !password) {
      res.status(400).json({ ok: false, error: 'userId and password required' });
      return;
    }
    const account = db.getAdminUser(uid);
    if (!account) {
      res.status(403).json({ ok: false, error: 'No admin account for that user ID' });
      return;
    }
    if (account.password !== String(password)) {
      res.status(403).json({ ok: false, error: 'Wrong password' });
      return;
    }
    db.setAdminLastLogin(uid);
    setSessionCookie(res, signSession(account.user_id, account.role));
    db.logActivity('mod', `${account.username || account.user_id} logged in`, {});
    res.json({ ok: true, user: { user_id: account.user_id, username: account.username, role: account.role } });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie('rimuru_session');
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const u = db.getAdminUser(req.admin.userId);
    res.json({ ok: true, user: u ? { user_id: u.user_id, username: u.username, role: u.role } : null });
  });

  /* ---------- stats ---------- */

  app.get('/api/stats', requireAuth, (req, res) => {
    try {
      const s = db.dashboardStats();
      s.uptime = Math.floor(process.uptime());
      res.json({ ok: true, stats: s });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ---------- users ---------- */

  app.get('/api/users', requireAuth, (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    let rows;
    if (q) {
      rows = db.searchUsers(q, limit, offset);
    } else {
      rows = db.listUsersByNetWorth(limit, offset);
    }
    res.json({ ok: true, users: rows.map(userView) });
  });

  app.get('/api/users/:id', requireAuth, (req, res) => {
    const uid = Number(req.params.id);
    const u = db.getUser(uid);
    if (!u) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }
    const games = db.getGameHistory(30, uid);
    const logs = db.getChatLogs(30, uid);
    const cooldowns = db.getUserCooldowns(uid);
    res.json({ ok: true, user: userView(u), games, logs, cooldowns });
  });

  /* ---------- user moderation actions ---------- */

  app.post('/api/users/:id/action', requireAuth, (req, res) => {
    const uid = Number(req.params.id);
    const { action, amount, reason, duration } = req.body || {};
    const u = db.getUser(uid);
    if (!u) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }
    const actor = req.admin;
    const label = `${u.first_name || u.username || uid}`;
    let out = { ok: true };

    try {
      switch (action) {
        case 'give': {
          const amt = Math.floor(Number(amount));
          if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'amount must be positive' });
          db.addWallet(uid, amt);
          db.logActivity('mod', `${actor.role} gave ${amt.toLocaleString()} to ${label}`, { target: uid });
          audit(actor, 'give', uid, `+${amt}`);
          out.message = `Gave ${amt.toLocaleString()} to ${label}. New wallet: ${db.getUser(uid).wallet.toLocaleString()}`;
          break;
        }
        case 'deduct': {
          const amt = Math.floor(Number(amount));
          if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'amount must be positive' });
          db.addWallet(uid, -amt);
          db.logActivity('mod', `${actor.role} deducted ${amt.toLocaleString()} from ${label}`, { target: uid });
          audit(actor, 'deduct', uid, `-${amt}`);
          out.message = `Deducted ${amt.toLocaleString()} from ${label}. New wallet: ${db.getUser(uid).wallet.toLocaleString()}`;
          break;
        }
        case 'set': {
          const amt = Math.floor(Number(amount));
          if (amt < 0) return res.status(400).json({ ok: false, error: 'amount must be >= 0' });
          db.setWallet(uid, amt);
          db.logActivity('mod', `${actor.role} set ${label}'s wallet to ${amt.toLocaleString()}`, { target: uid });
          audit(actor, 'set', uid, `wallet=${amt}`);
          out.message = `Set ${label}'s wallet to ${amt.toLocaleString()}`;
          break;
        }
        case 'fine': {
          const amt = Math.floor(Number(amount));
          if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'amount must be positive' });
          db.addWallet(uid, -amt);
          db.logActivity('mod', `${actor.role} fined ${label} ${amt.toLocaleString()}`, { target: uid });
          audit(actor, 'fine', uid, `-${amt} (${reason || ''})`);
          out.message = `Fined ${amt.toLocaleString()} from ${label}.`;
          break;
        }
        case 'jail': {
          // jail = banned from gambling only (suspected) — the user can still chat
          const r = admin.applyPenalty(uid, admin.STATUS.SUSPECTED, reason || 'Jailed by mod', duration);
          db.logActivity('mod', `${actor.role} jailed ${label}`, { target: uid });
          audit(actor, 'jail', uid, reason || '');
          out.message = r.message;
          break;
        }
        case 'suspend': {
          const r = admin.applyPenalty(uid, admin.STATUS.SUSPECTED, reason || 'Suspended by mod', duration);
          db.logActivity('mod', `${actor.role} suspended ${label}`, { target: uid });
          audit(actor, 'suspend', uid, reason || '');
          out.message = r.message;
          break;
        }
        case 'mute': {
          const r = admin.applyPenalty(uid, admin.STATUS.MUTED, reason || 'Muted by mod', duration);
          db.logActivity('mod', `${actor.role} muted ${label}`, { target: uid });
          audit(actor, 'mute', uid, reason || '');
          out.message = r.message;
          break;
        }
        case 'ban': {
          const r = admin.applyPenalty(uid, admin.STATUS.BANNED, reason || 'Banned by mod', duration);
          db.logActivity('mod', `${actor.role} banned ${label}`, { target: uid });
          audit(actor, 'ban', uid, reason || '');
          out.message = r.message;
          break;
        }
        case 'unban':
        case 'lift': {
          const r = admin.liftPenalty(uid);
          db.logActivity('mod', `${actor.role} lifted penalties on ${label}`, { target: uid });
          audit(actor, 'unban', uid, '');
          out.message = r.message;
          break;
        }
        default:
          return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
      }
      res.json({ ok: true, message: out.message, user: userView(db.getUser(uid)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ---------- logs ---------- */

  app.get('/api/logs/chat', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const userId = req.query.userId ? Number(req.query.userId) : null;
    res.json({ ok: true, logs: db.getChatLogs(limit, userId) });
  });

  app.get('/api/logs/games', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const userId = req.query.userId ? Number(req.query.userId) : null;
    res.json({ ok: true, logs: db.getGameHistory(limit, userId) });
  });

  app.get('/api/activity', requireAuth, (req, res) => {
    res.json({ ok: true, activity: db.getActivity(100) });
  });

  app.get('/api/audit', requireAuth, (req, res) => {
    res.json({ ok: true, audit: db.getAuditLog(100) });
  });

  /* ---------- events / missions ---------- */

  app.get('/api/events', requireAuth, (req, res) => {
    res.json({ ok: true, events: db.listEvents() });
  });

  app.post('/api/events', requireAuth, (req, res) => {
    const { title, description, type, reward, ends_at } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });
    // Whitelist event types so a bad/unknown type can never 400 or poison the
    // missions view. 'giveaway' = free entry (no cost) with a big reward.
    const EVENT_TYPES = ['mission', 'event', 'giveaway', 'trivia', 'challenge'];
    const t = EVENT_TYPES.includes(String(type || 'mission')) ? String(type) : 'mission';
    const rewardN = Math.max(0, Math.floor(Number(reward) || 0));
    const ev = db.createEvent({
      title,
      description: description || '',
      type: t,
      reward: rewardN,
      ends_at: Number(ends_at) || 0,
      created_by: req.admin.userId,
    });
    db.logActivity('event', `Event created: ${title} (${t})`, { event_id: ev.id });
    audit(req.admin, 'create_event', 0, title);
    res.json({ ok: true, event: ev });
  });

  /** Create a pre-built free-entry giveaway event (no cost, big reward). */
  app.post('/api/events/giveaway', requireAuth, (req, res) => {
    const { title, description, reward } = req.body || {};
    const ev = db.createEvent({
      title: title || '🎁 Free Giveaway',
      description: description || 'Free entry — no coins needed. Huge reward on completion!',
      type: 'giveaway',
      reward: Math.max(0, Math.floor(Number(reward) || 500000)),
      ends_at: Number(req.body.ends_at) || 0,
      created_by: req.admin.userId,
    });
    db.logActivity('event', `Giveaway event created: ${ev.title}`, { event_id: ev.id });
    audit(req.admin, 'create_giveaway', 0, ev.title);
    res.json({ ok: true, event: ev });
  });

  app.patch('/api/events/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { title, description, type, reward, active, ends_at } = req.body || {};
    const ev = db.updateEvent(id, { title, description, type, reward, active, ends_at });
    if (!ev) return res.status(404).json({ ok: false, error: 'Event not found' });
    db.logActivity('event', `Event updated: ${ev.title}`, { event_id: ev.id });
    res.json({ ok: true, event: ev });
  });

  app.delete('/api/events/:id', requireAuth, (req, res) => {
    db.deleteEvent(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- broadcast ---------- */

  app.post('/api/broadcast', requireAuth, (req, res) => {
    const { message, target } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: 'message required' });
    }
    const tgt = ['all', 'users', 'groups'].includes(target) ? target : 'all';
    const rec = db.createBroadcast(String(message).trim(), tgt, req.admin.userId);
    db.logActivity('broadcast', `Broadcast queued (${tgt}): ${String(message).slice(0, 60)}`, { broadcast_id: rec.id });
    audit(req.admin, 'broadcast', 0, `target=${tgt}`);

    // Fan out via the live bot (best-effort, async — never blocks the API).
    if (activeBot && typeof activeBot.sendMessage === 'function') {
      queueBroadcast(rec.id, String(message).trim(), tgt);
      console.log(`[dashboard] broadcast #${rec.id} queued (target=${tgt})`);
    } else {
      console.warn('[dashboard] broadcast queued but bot not ready — will deliver on next boot cycle');
    }
    res.json({ ok: true, broadcast: rec, note: 'Queued for delivery' });
  });

  app.get('/api/broadcasts', requireAuth, (req, res) => {
    res.json({ ok: true, broadcasts: db.listBroadcasts(50) });
  });

  /* ---------- moderator management (owner only) ---------- */

  app.get('/api/mods', requireAuth, (req, res) => {
    res.json({ ok: true, mods: db.listAdminUsers() });
  });

  app.post('/api/mods', requireAuth, requireOwner, (req, res) => {
    const { userId, username, password } = req.body || {};
    const uid = Number(userId);
    if (!uid || !password) {
      return res.status(400).json({ ok: false, error: 'userId and password required' });
    }
    if (uid === OWNER_ID) {
      return res.status(400).json({ ok: false, error: 'Owner account is fixed' });
    }
    db.addAdminUser(uid, username || '', 'mod', String(password));
    db.logActivity('mod', `Moderator added: ${username || uid}`, { target: uid });
    audit(req.admin, 'add_mod', uid, username || '');
    res.json({ ok: true });
  });

  app.delete('/api/mods/:userId', requireAuth, requireOwner, (req, res) => {
    const uid = Number(req.params.userId);
    if (uid === OWNER_ID) {
      return res.status(400).json({ ok: false, error: 'Cannot remove the owner' });
    }
    db.removeAdminUser(uid);
    db.logActivity('mod', `Moderator removed: ${uid}`, { target: uid });
    audit(req.admin, 'remove_mod', uid, '');
    res.json({ ok: true });
  });

  /* ---------- Rimuru mini-assistant (Groq) ---------- */

  app.post('/api/rimuru/message', requireAuth, async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ ok: false, error: 'text required' });
    }
    try {
      const rimuru = require('../rimuru');
      const ans = await rimuru.reply(String(text).trim(), {
        id: req.admin.userId,
        first_name: req.admin.role === 'owner' ? 'King' : 'Moderator',
        username: '',
        isOwner: req.admin.role === 'owner',
      });
      res.json({ ok: true, reply: ans });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/rimuru/ping', (req, res) => {
    res.json({ ok: true, rimuru: 'awake' });
  });

  /* ---------- Socket.IO (moderator room + live stats) ---------- */

  io.on('connection', (socket) => {
    let userName = 'anonymous';

    socket.on('mod:join', (data) => {
      userName = (data && data.name) || 'anonymous';
      socket.join(MOD_ROOM);
      socket.emit('mod:history', modHistory);
      io.to(MOD_ROOM).emit('mod:msg', {
        name: 'system',
        text: `${userName} joined the room`,
        ts: Date.now(),
      });
    });

    socket.on('mod:msg', (data) => {
      const text = String((data && data.text) || '').slice(0, 1000);
      if (!text) return;
      const entry = { name: userName, text, ts: Date.now() };
      modHistory.push(entry);
      if (modHistory.length > MOD_HISTORY_MAX) modHistory.shift();
      io.to(MOD_ROOM).emit('mod:msg', entry);
      try {
        db.logActivity('mod', `[room] ${userName}: ${text.slice(0, 120)}`, {});
      } catch (e) { /* non-fatal */ }
    });

    socket.on('disconnect', () => {
      io.to(MOD_ROOM).emit('mod:msg', {
        name: 'system',
        text: `${userName} left the room`,
        ts: Date.now(),
      });
    });
  });

  // Push live stats every 15s to connected dashboards
  setInterval(() => {
    try {
      const s = db.dashboardStats();
      s.uptime = Math.floor(process.uptime());
      io.emit('stats', s);
    } catch (e) { /* non-fatal */ }
  }, 15000);

  return { app, io, drainBroadcastQueue, pendingBroadcasts };
}

module.exports = { createDashboard, setActiveBot, drainBroadcastQueue, OWNER_ID, ensureOwnerPassword };
