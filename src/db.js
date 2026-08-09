'use strict';
/**
 * Rimuru Tempest Casino — SQLite data layer (better-sqlite3).
 * Stores: users (balance/wallet/bank/status), cooldowns, lottery state, heists.
 * All operations are synchronous & atomic (better-sqlite3).
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureDir } = require('./utils');

ensureDir(path.dirname(config.dbPath));

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('[db] better-sqlite3 failed to load:', e.message);
  console.error('[db] Run: npm install');
  process.exit(1);
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  wallet     INTEGER NOT NULL DEFAULT 0,
  bank       INTEGER NOT NULL DEFAULT 0,
  status     TEXT DEFAULT 'active',      -- active | muted | suspected | banned
  status_reason TEXT DEFAULT '',
  status_until INTEGER DEFAULT 0,         -- 0 = permanent
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id  INTEGER NOT NULL,
  action   TEXT NOT NULL,
  until    INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);

CREATE TABLE IF NOT EXISTS lottery (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pot        INTEGER NOT NULL DEFAULT 0,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  tickets    TEXT NOT NULL DEFAULT '[]'   -- JSON array of {user_id, count}
);

CREATE TABLE IF NOT EXISTS heists (
  leader_id    INTEGER PRIMARY KEY,
  leader_name  TEXT DEFAULT '',
  target_id    INTEGER NOT NULL,
  target_name  TEXT DEFAULT '',
  members      TEXT NOT NULL DEFAULT '[]',   -- JSON [{user_id, name}]
  started_at   INTEGER NOT NULL,
  status       TEXT DEFAULT 'open'            -- open | running
);

-- ===================== DASHBOARD TABLES =====================
-- Chat logs: every user message the bot sees (for moderation).
CREATE TABLE IF NOT EXISTS chat_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  chat_id    INTEGER NOT NULL,
  chat_title TEXT DEFAULT '',
  text       TEXT DEFAULT '',
  is_command INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Game history: every game/crime/income result (wins, losses, balances).
CREATE TABLE IF NOT EXISTS game_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  username    TEXT DEFAULT '',
  game        TEXT NOT NULL,        -- slots, dice, bj, mines, race, rob, ...
  bet         INTEGER DEFAULT 0,
  result      TEXT DEFAULT '',      -- win | lose | push | success | fail | ...
  amount      INTEGER DEFAULT 0,    -- net change (+/-)
  meta        TEXT DEFAULT '{}',    -- JSON extra (reels, multiplier, ...)
  created_at  INTEGER NOT NULL
);

-- Moderators / dashboard accounts.
CREATE TABLE IF NOT EXISTS admin_users (
  user_id     INTEGER PRIMARY KEY,  -- Telegram user ID
  username    TEXT DEFAULT '',
  role        TEXT DEFAULT 'mod',   -- owner | mod
  password    TEXT DEFAULT '',      -- dashboard login password (owner + mods)
  created_at  INTEGER NOT NULL,
  last_login  INTEGER DEFAULT 0
);

-- Events / missions (created from the dashboard, live in the bot).
CREATE TABLE IF NOT EXISTS bot_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'mission',  -- mission | event | giveaway | trivia
  reward      INTEGER DEFAULT 0,       -- coin reward on completion
  starts_at   INTEGER DEFAULT 0,
  ends_at     INTEGER DEFAULT 0,       -- 0 = forever
  active      INTEGER DEFAULT 1,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  completions INTEGER DEFAULT 0        -- how many users completed it
);

-- Broadcast history.
CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  target      TEXT DEFAULT 'all',    -- all | users | groups
  sent_count  INTEGER DEFAULT 0,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Activity feed (dashboard live feed).
CREATE TABLE IF NOT EXISTS activity_feed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT DEFAULT 'event',  -- event | user | game | mod | broadcast
  text        TEXT NOT NULL,
  meta        TEXT DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

-- Audit log (moderation actions).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,
  actor_name  TEXT DEFAULT '',
  action      TEXT NOT NULL,         -- give | deduct | ban | unban | ...
  target_id   INTEGER DEFAULT 0,
  detail      TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
`);

/* ---------------- Users ---------------- */

function getOrCreateUser(userId, meta = {}) {
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (row) {
    if (meta.username || meta.first_name) {
      db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?')
        .run(meta.username || row.username, meta.first_name || row.first_name, userId);
    }
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  }
  db.prepare('INSERT INTO users (user_id, username, first_name, wallet, bank, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, meta.username || '', meta.first_name || '', config.startBalance, 0, 'active', Date.now());
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function getNetWorth(userId) {
  const u = getUser(userId);
  if (!u) return 0;
  return u.wallet + u.bank;
}

function setWallet(userId, amount) {
  db.prepare('UPDATE users SET wallet = ? WHERE user_id = ?').run(amount, userId);
}

function setBank(userId, amount) {
  db.prepare('UPDATE users SET bank = ? WHERE user_id = ?').run(amount, userId);
}

/** Atomically add to wallet (positive or negative). Returns new wallet. */
function addWallet(userId, delta) {
  db.prepare('UPDATE users SET wallet = wallet + ? WHERE user_id = ?').run(delta, userId);
  return getUser(userId).wallet;
}

/** Atomically add to bank. Returns new bank. */
function addBank(userId, delta) {
  db.prepare('UPDATE users SET bank = bank + ? WHERE user_id = ?').run(delta, userId);
  return getUser(userId).bank;
}

function setStatus(userId, status, reason, until = 0) {
  db.prepare('UPDATE users SET status = ?, status_reason = ?, status_until = ? WHERE user_id = ?')
    .run(status, reason || '', until, userId);
}

function clearStatus(userId) {
  db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0 WHERE user_id = ?").run(userId);
}

/** Top 10 by net worth (wallet + bank). */
function leaderboard(limit = 10) {
  return db.prepare(`
    SELECT user_id, username, first_name, wallet, bank, (wallet + bank) AS networth
    FROM users
    ORDER BY networth DESC
    LIMIT ?
  `).all(limit);
}

/* ---------------- Cooldowns ---------------- */

function getCooldown(userId, action) {
  const row = db.prepare('SELECT until FROM cooldowns WHERE user_id = ? AND action = ?').get(userId, action);
  return row ? row.until : 0;
}

function setCooldown(userId, action, until) {
  db.prepare(`
    INSERT INTO cooldowns (user_id, action, until) VALUES (?, ?, ?)
    ON CONFLICT(user_id, action) DO UPDATE SET until = excluded.until
  `).run(userId, action, until);
}

function clearCooldown(userId, action) {
  db.prepare('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
}

/* ---------------- Lottery ---------------- */

function getLottery() {
  let row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO lottery (id, pot, ticket_count, tickets) VALUES (1, ?, 0, ?)')
      .run(config.lottery.baseJackpot, '[]');
    row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  }
  row.tickets = JSON.parse(row.tickets);
  return row;
}

function saveLottery(pot, ticketCount, tickets) {
  db.prepare('UPDATE lottery SET pot = ?, ticket_count = ?, tickets = ? WHERE id = 1')
    .run(pot, ticketCount, JSON.stringify(tickets));
}

/* ---------------- Heists ---------------- */

function getHeist(leaderId) {
  const row = db.prepare('SELECT * FROM heists WHERE leader_id = ?').get(leaderId);
  if (!row) return null;
  row.members = JSON.parse(row.members);
  return row;
}

function createHeist(heist) {
  db.prepare('INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(heist.leader_id, heist.leader_name, heist.target_id, heist.target_name, JSON.stringify(heist.members), heist.started_at, heist.status);
}

function updateHeistMembers(leaderId, members) {
  db.prepare('UPDATE heists SET members = ? WHERE leader_id = ?').run(JSON.stringify(members), leaderId);
}

function updateHeistStatus(leaderId, status) {
  db.prepare('UPDATE heists SET status = ? WHERE leader_id = ?').run(status, leaderId);
}

function deleteHeist(leaderId) {
  db.prepare('DELETE FROM heists WHERE leader_id = ?').run(leaderId);
}

/* ---------------- Dashboard: chat logs ---------------- */

function logChat(msg) {
  if (!msg || !msg.from) return;
  const text = String(msg.text || msg.caption || '');
  if (!text) return;
  db.prepare(`INSERT INTO chat_logs (user_id, username, first_name, chat_id, chat_title, text, is_command, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      msg.from.id,
      msg.from.username || '',
      msg.from.first_name || '',
      msg.chat ? msg.chat.id : 0,
      (msg.chat && msg.chat.title) || '',
      text,
      text.startsWith('/') ? 1 : 0,
      Date.now()
    );
}

function getChatLogs(limit = 100, userId = null) {
  if (userId) {
    return db.prepare('SELECT * FROM chat_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }
  return db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- Dashboard: game history ---------------- */

function logGameHistory(entry) {
  db.prepare(`INSERT INTO game_history (user_id, username, game, bet, result, amount, meta, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      entry.user_id,
      entry.username || '',
      entry.game,
      entry.bet || 0,
      entry.result || '',
      entry.amount || 0,
      JSON.stringify(entry.meta || {}),
      Date.now()
    );
}

function getGameHistory(limit = 100, userId = null) {
  if (userId) {
    return db.prepare('SELECT * FROM game_history WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }
  return db.prepare('SELECT * FROM game_history ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- Dashboard: moderators ---------------- */

function getAdminUser(userId) {
  return db.prepare('SELECT * FROM admin_users WHERE user_id = ?').get(userId);
}

function addAdminUser(userId, username, role, password) {
  db.prepare(`INSERT INTO admin_users (user_id, username, role, password, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, role = excluded.role, password = excluded.password`)
    .run(userId, username || '', role || 'mod', password || '', Date.now());
}

function removeAdminUser(userId) {
  db.prepare('DELETE FROM admin_users WHERE user_id = ?').run(userId);
}

function listAdminUsers() {
  return db.prepare('SELECT user_id, username, role, created_at, last_login FROM admin_users ORDER BY role DESC, user_id').all();
}

function setAdminLastLogin(userId) {
  db.prepare('UPDATE admin_users SET last_login = ? WHERE user_id = ?').run(Date.now(), userId);
}

/* ---------------- Dashboard: events / missions ---------------- */

function listEvents(activeOnly = false) {
  const sql = activeOnly
    ? 'SELECT * FROM bot_events WHERE active = 1 ORDER BY id DESC'
    : 'SELECT * FROM bot_events ORDER BY id DESC';
  return db.prepare(sql).all();
}

function createEvent(ev) {
  db.prepare(`INSERT INTO bot_events (title, description, type, reward, starts_at, ends_at, active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ev.title, ev.description || '', ev.type || 'mission', ev.reward || 0,
      ev.starts_at || 0, ev.ends_at || 0, ev.active === false ? 0 : 1,
      ev.created_by || 0, Date.now());
  return db.prepare('SELECT * FROM bot_events ORDER BY id DESC LIMIT 1').get();
}

function updateEvent(id, fields) {
  const ev = db.prepare('SELECT * FROM bot_events WHERE id = ?').get(id);
  if (!ev) return null;
  db.prepare(`UPDATE bot_events SET title = ?, description = ?, type = ?, reward = ?, active = ?, ends_at = ?
             WHERE id = ?`)
    .run(
      fields.title !== undefined ? fields.title : ev.title,
      fields.description !== undefined ? fields.description : ev.description,
      fields.type !== undefined ? fields.type : ev.type,
      fields.reward !== undefined ? fields.reward : ev.reward,
      fields.active !== undefined ? (fields.active ? 1 : 0) : ev.active,
      fields.ends_at !== undefined ? fields.ends_at : ev.ends_at,
      id
    );
  return db.prepare('SELECT * FROM bot_events WHERE id = ?').get(id);
}

function deleteEvent(id) {
  db.prepare('DELETE FROM bot_events WHERE id = ?').run(id);
}

function incrementEventCompletions(id) {
  db.prepare('UPDATE bot_events SET completions = completions + 1 WHERE id = ?').run(id);
}

/** Get the currently active event/mission for the bot to announce. */
function activeEvents() {
  const now = Date.now();
  return db.prepare(`SELECT * FROM bot_events WHERE active = 1 AND (starts_at = 0 OR starts_at <= ?) AND (ends_at = 0 OR ends_at > ?) ORDER BY id DESC`).all(now, now);
}

/* ---------------- Dashboard: broadcasts ---------------- */

function createBroadcast(message, target, createdBy) {
  db.prepare(`INSERT INTO broadcasts (message, target, sent_count, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)`)
    .run(message, target || 'all', 0, createdBy || 0, Date.now());
  return db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1').get();
}

function updateBroadcastCount(id, count) {
  db.prepare('UPDATE broadcasts SET sent_count = ? WHERE id = ?').run(count, id);
}

function listBroadcasts(limit = 50) {
  return db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- Dashboard: activity feed ---------------- */

function logActivity(type, text, meta = {}) {
  db.prepare(`INSERT INTO activity_feed (type, text, meta, created_at) VALUES (?, ?, ?, ?)`)
    .run(type || 'event', text, JSON.stringify(meta), Date.now());
  // keep the feed lean (last 500 entries)
  db.prepare('DELETE FROM activity_feed WHERE id NOT IN (SELECT id FROM activity_feed ORDER BY id DESC LIMIT 500)').run();
}

function getActivity(limit = 100) {
  return db.prepare('SELECT * FROM activity_feed ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- Dashboard: audit log ---------------- */

function logAudit(actorId, actorName, action, targetId, detail) {
  db.prepare(`INSERT INTO audit_log (actor_id, actor_name, action, target_id, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
    .run(actorId, actorName || '', action, targetId || 0, detail || '', Date.now());
}

function getAuditLog(limit = 100) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- Dashboard: stats ---------------- */

function dashboardStats() {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c;
  const banned = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'").get().c;
  const muted = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status IN ('muted','suspected')").get().c;
  const groups = db.prepare('SELECT COUNT(DISTINCT chat_id) AS c FROM chat_logs WHERE chat_id < 0').get().c;
  const coins = db.prepare('SELECT COALESCE(SUM(wallet),0) AS w, COALESCE(SUM(bank),0) AS b FROM users').get();
  const totalCoins = coins.w + coins.b;
  const games = db.prepare('SELECT COUNT(*) AS c FROM game_history').get().c;
  const msgs = db.prepare('SELECT COUNT(*) AS c FROM chat_logs').get().c;
  const lottery = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  const lot = lottery ? lottery.pot : 0;
  return {
    totalUsers: users,
    activeUsers,
    bannedUsers: banned,
    mutedUsers: muted,
    totalGroups: groups,
    coinsInCirculation: totalCoins,
    coinsWallet: coins.w,
    coinsBank: coins.b,
    totalGames: games,
    totalMessages: msgs,
    lotteryPot: lot,
    topUsers: leaderboard(10),
  };
}

/* ---------------- Cleanup ---------------- */

/** Clear expired temporary penalties (mute/suspend) — called periodically. */
function expirePenalties() {
  const now = Date.now();
  const expired = db.prepare(`
    SELECT user_id, status FROM users
    WHERE status IN ('muted','suspected') AND status_until > 0 AND status_until <= ?
  `).all(now);
  for (const u of expired) {
    db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0 WHERE user_id = ?").run(u.user_id);
  }
  return expired;
}

function close() {
  db.close();
}

module.exports = {
  db,
  getOrCreateUser,
  getUser,
  getNetWorth,
  setWallet,
  setBank,
  addWallet,
  addBank,
  setStatus,
  clearStatus,
  leaderboard,
  getCooldown,
  setCooldown,
  clearCooldown,
  getLottery,
  saveLottery,
  getHeist,
  createHeist,
  updateHeistMembers,
  updateHeistStatus,
  deleteHeist,
  expirePenalties,
  // Dashboard
  logChat,
  getChatLogs,
  logGameHistory,
  getGameHistory,
  getAdminUser,
  addAdminUser,
  removeAdminUser,
  listAdminUsers,
  setAdminLastLogin,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  incrementEventCompletions,
  activeEvents,
  createBroadcast,
  updateBroadcastCount,
  listBroadcasts,
  logActivity,
  getActivity,
  logAudit,
  getAuditLog,
  dashboardStats,
  close,
};
