'use strict';
/**
 * Rimuru Tempest Casino — admin module.
 * Owner-only controls:
 *  /ban [reason] — full ban (no bot interaction at all)
 *  /sus [reason] — can chat in group but can't gamble / talk to Rimuru
 *  /mute [reason] — can't talk at all (group messages are answered with silence)
 * All show reason + duration when they end.
 *
 * Staff handlers (health, debug, setBalance, addCoins, stop, run, restart,
 * ban, suspend, mute, unban, unsus, unmute, hide, xleaderboard) live here —
 * bot.js delegates to these.
 */
const db = require('./db');
const config = require('./config');
const backup = require('./backup');
const leaderboard = require('./leaderboard');
const { fmt, humanDuration } = require('./utils');
const crypto = require('crypto');

const STATUS = {
  BANNED: 'banned',
  SUSPECTED: 'suspected',
  MUTED: 'muted',
  ACTIVE: 'active',
};

/**
 * Apply a penalty. Duration optional (e.g. "2h", "1d", "30m", "1w").
 * Returns { ok, message }.
 */
function applyPenalty(userId, status, reason, durationStr) {
  const until = durationStr ? parseDuration(durationStr) : 0;
  if (durationStr && until === 0) {
    return { ok: false, message: `⏳ Bad duration \`${durationStr}\`. Use e.g. \`30m\`, \`2h\`, \`1d\`, \`1w\`, or omit for permanent.` };
  }
  const u = db.getUser(userId);
  if (!u) {
    return { ok: false, message: '❌ That user has never interacted with the bot.' };
  }
  db.setStatus(userId, status, reason || 'No reason given', until ? Date.now() + until : 0);
  const label = status === STATUS.BANNED ? 'banned' : status === STATUS.MUTED ? 'muted' : 'suspended';
  const dur = until ? ` for ${durationStr}` : ' permanently';
  return {
    ok: true,
    message: `🚨 **${u.first_name || userId}** has been **${label}**${dur}.\nReason: ${reason || 'No reason given'}`,
  };
}

/** Remove a penalty (owner can lift early). */
function liftPenalty(userId) {
  const u = db.getUser(userId);
  if (!u) return { ok: false, message: '❌ That user has never interacted with the bot.' };
  db.clearStatus(userId);
  return { ok: true, message: `✅ **${u.first_name || userId}** is free to play again.` };
}

/**
 * Check a user's interaction rights.
 * @returns {allowed:boolean, reply?:string} — reply is the message to send if blocked.
 */
function checkInteract(userId, { gambling = true } = {}) {
  const u = db.getUser(userId);
  if (!u) return { allowed: true };
  if (String(userId) === String(config.ownerId)) return { allowed: true };

  const now = Date.now();
  const expired = u.status_until > 0 && u.status_until <= now;
  const status = expired ? STATUS.ACTIVE : u.status;

  if (status === STATUS.BANNED) {
    return { allowed: false, reply: `⛔ You are **banned** from Rimuru's casino.\nReason: ${u.status_reason || 'No reason given'}` };
  }
  if (status === STATUS.SUSPECTED) {
    if (gambling) {
      return { allowed: false, reply: `🧊 You've been **suspended** — no gambling, no Rimuru.\nReason: ${u.status_reason || 'No reason given'}` };
    }
    return { allowed: true };
  }
  if (status === STATUS.MUTED) {
    if (gambling) {
      return { allowed: false, reply: `🤐 You're **muted** — no gambling, no Rimuru.\nReason: ${u.status_reason || 'No reason given'}` };
    }
    // muted users can't talk to Rimuru either
    return { allowed: false, reply: null };
  }
  return { allowed: true };
}

/**
 * Parse "30m" / "2h" / "1d" / "1w" → ms. Returns 0 on invalid.
 */
function parseDuration(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

/* ===================== staff helpers ===================== */

function isOwner(userId) {
  return String(userId) === String(config.ownerId);
}

function isStaff(userId) {
  if (isOwner(userId)) return true;
  try {
    return !!db.getAdminUser(Number(userId));
  } catch (e) {
    return false;
  }
}

function metaOf(msg) {
  const from = (msg && msg.from) || {};
  return { username: from.username || '', first_name: from.first_name || '' };
}

function repliedUser(msg) {
  const r = (msg && msg.reply_to_message) || null;
  if (!r || !r.from) return null;
  return r.from;
}

function splitDurReason(args) {
  if (!args || !args.length) return { dur: null, reason: '' };
  if (parseDuration(args[0])) {
    return { dur: args[0], reason: args.slice(1).join(' ') };
  }
  return { dur: null, reason: args.join(' ') };
}

function gateAllowed() {
  // Membership gate is enforced in bot.js; admin handlers are staff-gated here.
  return { ok: true };
}

/* ===================== owner purge lock ===================== */

let purgeState = null;
let pendingPurgeApproval = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isPurgeLocked() { return !!purgeState; }

function purgeAmount(raw) {
  const amt = Math.floor(Number(String(raw == null ? '' : raw).replace(/,/g, '')));
  return Number.isFinite(amt) && amt >= 0 ? amt : null;
}


function clearPendingPurgeApproval() {
  if (pendingPurgeApproval && pendingPurgeApproval.timeout) clearTimeout(pendingPurgeApproval.timeout);
  pendingPurgeApproval = null;
}

async function requestModPurge(ctx, rawAmount) {
  if (!isStaff(ctx.userId) || isOwner(ctx.userId)) return beginPurge(ctx, rawAmount);
  const amount = purgeAmount(rawAmount);
  if (amount === null) return ctx.reply('Usage: <code>/purge [amount]</code>. Amount must be zero or greater.', { title: '💀 PURGE', color: '#F44336', html: true });
  if (purgeState || pendingPurgeApproval) return ctx.reply('A purge or purge approval is already active.', { title: '💀 PURGE', color: '#F44336' });
  const actor = metaOf(ctx.msg);
  pendingPurgeApproval = { requesterId:Number(ctx.userId), requesterChatId:Number(ctx.chatId), requesterName:actor.username||actor.first_name||String(ctx.userId), amount, timeout:null };
  const req = pendingPurgeApproval;
  try {
    await ctx.bot.sendMessage(Number(config.ownerId), `💀 <b>MOD PURGE REQUEST</b>\n\nModerator: <b>${req.requesterName}</b> <code>${req.requesterId}</code>\nRequested wallet: <b>${fmt(amount)}</b>\nBank: <b>0</b>\n\nReply <code>YES</code> to approve or <code>NO</code> to reject.`, { parse_mode:'HTML' });
  } catch (e) { clearPendingPurgeApproval(); return ctx.reply('Could not reach the owner for purge approval.', { title:'💀 PURGE', color:'#F44336' }); }
  await ctx.reply('⏳ Purge request sent to the owner. Nothing will happen unless the owner approves it.', { title:'💀 PURGE APPROVAL', color:'#FFD700' });
  req.timeout=setTimeout(()=>{ if(pendingPurgeApproval===req){ clearPendingPurgeApproval(); Promise.resolve(ctx.bot.sendMessage(req.requesterChatId,'🕯️ Purge request expired. No balances were changed.')).catch(()=>{}); } },90000);
  req.timeout.unref && req.timeout.unref();
}

async function handlePurgeApprovalMessage(ctx, text) {
  if (!pendingPurgeApproval || !isOwner(ctx.userId) || Number(ctx.chatId)!==Number(config.ownerId)) return false;
  const clean=String(text||'').trim().toLowerCase();
  if (!['yes','no'].includes(clean)) return false;
  const req=pendingPurgeApproval; clearPendingPurgeApproval();
  if (clean==='no') {
    await ctx.reply('❌ Mod purge request rejected. No balances were changed.', { title:'💀 PURGE REJECTED', color:'#F44336' });
    try{await ctx.bot.sendMessage(req.requesterChatId,'❌ The owner rejected your purge request.');}catch(e){}
    return true;
  }
  try{await ctx.bot.sendMessage(req.requesterChatId,'✅ The owner approved your purge request. Final confirmation is now with the owner.');}catch(e){}
  await beginPurge(ctx, req.amount);
  return true;
}

function clearPurgeState() {
  if (purgeState && purgeState.timeout) clearTimeout(purgeState.timeout);
  purgeState = null;
}

async function beginPurge(ctx, rawAmount) {
  if (!isOwner(ctx.userId)) {
    return ctx.reply('Only the King can purge the realm. 👑', { title: '🔒 OWNER ONLY', color: '#F44336' });
  }
  const amount = purgeAmount(rawAmount);
  if (amount === null) {
    return ctx.reply('Usage: <code>/sb [amount] all</code> or <code>/purge [amount]</code>. Amount must be zero or greater.', { title: '💀 PURGE', color: '#F44336', html: true });
  }
  if (purgeState) {
    return ctx.reply('A purge sequence is already active.', { title: '💀 PURGE', color: '#F44336' });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const ownerName = (ctx.msg && ctx.msg.from && (ctx.msg.from.first_name || ctx.msg.from.username)) || 'King';
  purgeState = {
    ownerId: Number(ctx.userId),
    chatId: Number(ctx.chatId),
    amount,
    code,
    phase: 'confirm',
    startedAt: Date.now(),
    timeout: null,
  };

  // Lock first: from this point until success/cancel, ordinary commands and
  // callback buttons are ignored so nobody can observe a half-finished purge.
  await ctx.reply(`☠️ <b>THE PURGE HAS BEGUN...</b>

The gates are sealed. Rimuru has gone silent across the realm.`, { title: '💀 PURGE PROTOCOL', color: '#F44336', html: true });
  await sleep(1200);
  await ctx.reply(
    `⚠️ <b>${ownerName}</b>, are you sure you want to rewrite every player's net worth?

` +
    `Wallet → <b>${fmt(amount)}</b>
Bank → <b>0</b>

` +
    `Ranks, items, stats, waifus and characters will remain untouched.

` +
    `Text <code>${code}</code> to confirm.`,
    { title: '⚠️ FINAL CONFIRMATION', color: '#FFD700', html: true }
  );

  purgeState.timeout = setTimeout(() => {
    if (!purgeState || purgeState.code !== code || purgeState.phase !== 'confirm') return;
    const reply = ctx.reply;
    clearPurgeState();
    Promise.resolve(reply('🕯️ Purge confirmation expired. The realm has been unlocked; no balances were changed.', { title: '💀 PURGE CANCELLED', color: '#00BCD4' })).catch(() => {});
  }, 90000);
  purgeState.timeout.unref && purgeState.timeout.unref();
}

async function applyPurgeDurably(amount) {
  const stamp = Date.now();
  const pInfo = db.syncInfo();
  if (pInfo.configured) {
    if (!pInfo.ready || !pInfo.writable) throw new Error('Postgres persistence is not writable');
    const ok = await db.pgRun('users', 'UPDATE users SET wallet = $1, bank = 0, networth = $1, updated_at = $2', [amount, stamp]);
    if (!ok) throw new Error('Postgres balance purge failed');
  }
  return db.setAllNetworth(amount, stamp);
}

async function handlePurgeMessage(ctx, text) {
  if (!purgeState) return false;
  if (!isOwner(ctx.userId)) return true; // global silence for everyone else

  const clean = String(text || '').trim();
  if (purgeState.phase === 'confirm' && /^\/cancelpurge(?:@\w+)?$/i.test(clean)) {
    clearPurgeState();
    await ctx.reply('🕯️ Purge cancelled. No balances were changed.', { title: '💀 PURGE CANCELLED', color: '#00BCD4' });
    return true;
  }
  if (purgeState.phase !== 'confirm') return true;
  if (clean !== purgeState.code) {
    if (/^\d{6}$/.test(clean)) await ctx.reply('❌ Wrong confirmation code. The purge remains locked.', { title: '💀 PURGE', color: '#F44336' });
    return true;
  }

  if (purgeState.timeout) clearTimeout(purgeState.timeout);
  purgeState.timeout = null;
  purgeState.phase = 'executing';
  const amount = purgeState.amount;
  const actor = metaOf(ctx.msg);
  await ctx.reply(`🩸 <b>CLEARING USERS’ NET WORTH...</b>

Rimuru is rewriting the ledger. No one may speak until judgment is complete.`, { title: '☠️ PURGE IN PROGRESS', color: '#F44336', html: true });

  // The delay is theatrical, but the actual database mutation is one bulk
  // update in each datastore so players cannot be left half-purged.
  await sleep(8000);
  let affected = 0;
  try {
    affected = await applyPurgeDurably(amount);
    db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'purge_balances', amount, `global users=${affected}`);
    db.logActivity('admin', `/purge ${fmt(amount)} by ${actor.username || ctx.userId} — ${affected} users`, { actor: ctx.userId, affected, amount });
  } catch (e) {
    clearPurgeState();
    await ctx.reply(`⚠️ <b>PURGE ABORTED</b>

The persistent ledger refused the operation: ${String(e.message || e).slice(0, 180)}

No local purge was committed.`, { title: '💀 PURGE FAILED', color: '#F44336', html: true });
    return true;
  }

  await sleep(52000);
  clearPurgeState();
  await ctx.reply(
    `💀💀💀 <b>PURGE SUCCESSFUL</b> 💀💀💀

` +
    `<b>${affected}</b> users were judged.
` +
    `👛 Every wallet: <b>${fmt(amount)}</b>
🏦 Every bank: <b>0</b>

` +
    `Ranks, items, stats and collections survived. The realm may speak again.`,
    { title: '💀 PURGE COMPLETE', color: '#FFD700', html: true }
  );
  return true;
}

async function purge(ctx) {
  if (isOwner(ctx.userId)) return beginPurge(ctx, (ctx.args || [])[0]);
  return requestModPurge(ctx, (ctx.args || [])[0]);
}


async function mod(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can appoint moderators. 👑', { title: '🔒 OWNER ONLY', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to the person you want to promote with <code>/mod</code>.', { title: '🛡️ ADD MODERATOR', color: '#F44336', html: true });
  if (target.is_bot) return ctx.reply('Bots cannot be appointed as Rimuru moderators.', { title: '🛡️ ADD MODERATOR', color: '#F44336' });
  if (String(target.id) === String(config.ownerId)) return ctx.reply('You are already the permanent owner. 👑', { title: '🛡️ MODERATOR', color: '#FFD700' });

  db.getOrCreateUser(target.id, { username: target.username || '', first_name: target.first_name || '' });
  const existing = db.getAdminUser(Number(target.id));
  const row = db.addAdminUser(Number(target.id), target.username || target.first_name || '', 'mod', existing ? existing.password : '', Number(ctx.userId));
  const actor = metaOf(ctx.msg);
  db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'add_mod', Number(target.id), target.username || target.first_name || '');
  db.logActivity('mod', `Moderator ${existing ? 'refreshed' : 'added'}: ${target.username || target.first_name || target.id}`, { target: Number(target.id), actor: Number(ctx.userId) });
  const shown = target.username ? `@${target.username}` : (target.first_name || 'Unnamed user');
  await ctx.reply(
    `🛡️ <b>MODERATOR ${existing ? 'UPDATED' : 'APPOINTED'}</b>

` +
    `User: <b>${shown}</b>
Telegram ID: <code>${target.id}</code>
` +
    `Role: <b>${row && row.role ? row.role : 'mod'}</b>

` +
    `Saved to Rimuru's moderator list and visible in the dashboard.`,
    { title: '🛡️ NEW MODERATOR', color: '#00BCD4', html: true }
  );
}

/* ===================== staff handlers ===================== */

async function health(ctx, opts = {}) {
  try {
    const pkg = require('../package.json');
    const stats = db.dashboardStats();
    const mem = process.memoryUsage();
    const pInfo = db.syncInfo();
    const pgStatus = pInfo.configured
      ? (pInfo.ready && pInfo.connected ? `✅ connected (${pInfo.host}:${pInfo.port})` : `❌ ${pInfo.host}:${pInfo.port} — ${pInfo.lastPgError || 'connecting…'}`)
      : 'off (SQLite-only, ephemeral)';
    const verified = pInfo.configured
      ? `✅ writes: ${pInfo.writesOk} · failures: ${pInfo.writesFailed} · last write ${pInfo.lastWriteAt ? `${Math.floor((Date.now() - pInfo.lastWriteAt) / 1000)}s ago` : 'never'} · verified ${pInfo.lastVerifyAt ? `${Math.floor((Date.now() - pInfo.lastVerifyAt) / 1000)}s ago` : 'never'}`
      : 'n/a';
    const lines = [
      `🤖 <b>Version</b>: ${pkg.version || 'n/a'} (${opts.commitHash || 'n/a'})`,
      `⏱ <b>Uptime</b>: ${humanDuration(Math.floor(process.uptime() * 1000))}`,
      `🏓 <b>Ping</b>: ${db.ping()}ms`,
      `👥 <b>Users</b>: ${fmt(stats.users || 0)}`,
      `💰 <b>Coins in circulation</b>: ${fmt(stats.totalCoins || 0)}`,
      `🖥 <b>Persistence</b>: ${pgStatus}${pInfo.configured ? ` (mirrors: ${pInfo.lastMirrorAt ? 'running' : 'pending'} · hydrated: ${pInfo.hydrated ? 'yes' : 'no'})` : ''}`,
      `✔️ <b>Verified writes</b>: ${verified}`,
      `💾 <b>Memory</b>: rss ${fmt(Math.round(mem.rss / 1048576))} MB · heap ${fmt(Math.round(mem.heapUsed / 1048576))} MB`,
      `⚠️ <b>Last error</b>: ${opts.lastError ? String(opts.lastError.message || opts.lastError).slice(0, 200) : 'none'}`,
    ];
    await ctx.reply(lines.join('\n'), { title: '👍 HEALTH', color: '#00BCD4', html: true });
  } catch (e) {
    await ctx.reply(`⚠️ Health check failed: ${e.message}`, { title: '👍 HEALTH', color: '#F44336' });
  }
}

async function debug(ctx, opts = {}) {
  if (!isStaff(ctx.userId)) {
    return ctx.reply('Only staff can do that. 👑', { title: '🔒 STAFF ONLY', color: '#F44336' });
  }
  try {
    const pkg = require('../package.json');
    const stats = db.dashboardStats();
    const cdCount = db.getCooldownCount();
    const mem = process.memoryUsage();
    const pInfo = db.syncInfo();
    const pgStatus = pInfo.configured
      ? (pInfo.ready && pInfo.connected ? `✅ connected (${pInfo.host}:${pInfo.port})` : `❌ ${pInfo.host}:${pInfo.port} — ${pInfo.lastPgError || 'connecting…'}`)
      : 'off (SQLite-only, ephemeral)';
    const verified = pInfo.configured
      ? `✅ writes: ${pInfo.writesOk} · failures: ${pInfo.writesFailed} · last write ${pInfo.lastWriteAt ? `${Math.floor((Date.now() - pInfo.lastWriteAt) / 1000)}s ago` : 'never'} · verified ${pInfo.lastVerifyAt ? `${Math.floor((Date.now() - pInfo.lastVerifyAt) / 1000)}s ago` : 'never'}`
      : 'n/a';
    const lines = [
      `🤖 <b>Version</b>: ${pkg.version || 'n/a'} (${opts.commitHash || 'n/a'})`,
      `⏱ <b>Uptime</b>: ${humanDuration(Math.floor(process.uptime() * 1000))}`,
      `🏓 <b>Ping</b>: ${db.ping()}ms`,
      `👥 <b>Users</b>: ${fmt(stats.users || 0)}`,
      `💰 <b>Coins in circulation</b>: ${fmt(stats.totalCoins || 0)}`,
      `⏳ <b>Active cooldowns</b>: ${fmt(cdCount)}`,
      `🖥 <b>Persistence</b>: ${pgStatus}${pInfo.configured ? ` (mirrors: ${pInfo.lastMirrorAt ? 'running' : 'pending'} · hydrated: ${pInfo.hydrated ? 'yes' : 'no'})` : ''}`,
      `✔️ <b>Verified writes</b>: ${verified}`,
      `Auto-backup: ${(() => { try { const bs = backup.getBackupState(); return `on · keep ${bs.keep} · ran ${bs.runCount} · suspect ${bs.suspectCount}`; } catch (e) { return 'n/a'; } })()}`,
      `💾 <b>Memory</b>: rss ${fmt(Math.round(mem.rss / 1048576))} MB · heap ${fmt(Math.round(mem.heapUsed / 1048576))} MB`,
      `⚠️ <b>Last error</b>: ${opts.lastError ? String(opts.lastError.message || opts.lastError).slice(0, 200) : 'none'}`,
    ];
    const actor = metaOf(ctx.msg);
    db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'debug', 0, 'staff debug dump');
    db.logActivity('mod', `/debug by ${actor.username || ctx.userId}`, { target: ctx.userId });
    await ctx.reply(lines.join('\n'), { title: '🛠 DEBUG', color: '#00BCD4', html: true });
  } catch (e) {
    await ctx.reply(`⚠️ Debug failed: ${e.message}`, { title: '🛠 DEBUG', color: '#F44336' });
  }
}

async function setBalance(ctx) {
  const args = ctx.args || [];
  if (args.some((a) => String(a).toLowerCase() === 'all')) {
    return beginPurge(ctx, args[0]);
  }
  const r = staffCoin(ctx, 'set');
  await ctx.reply(r.message, { title: r.title, color: r.color, html: true });
}

async function addCoins(ctx) {
  const r = staffCoin(ctx, 'add');
  await ctx.reply(r.message, { title: r.title, color: r.color, html: true });
}

function staffCoin(ctx, mode) {
  if (!isStaff(ctx.userId)) {
    return { title: '🔒 STAFF ONLY', color: '#F44336', message: 'Only the King and his moderators can do that. 👑' };
  }
  const raw = String((ctx.args || [])[0] || '').trim();
  const amt = Math.floor(Number(raw.replace(/,/g, '')));
  const minAmount = mode === 'add' ? 1 : 0;
  if (!Number.isFinite(amt) || amt < minAmount) {
    return {
      title: mode === 'add' ? '➕ ADDCOIN' : '🎯 SET BALANCE',
      color: '#F44336',
      message: mode === 'add'
        ? `Usage: <code>/addcoin [amount] [@username or reply]</code> — amount must be a positive number.`
        : `Usage: <code>/sb [amount] [@username or reply]</code> — amount must be zero or greater (0 clears wallet AND bank).`,
    };
  }
  let targetId = ctx.userId;
  const replied = repliedUser(ctx.msg);
  const mention = (ctx.args || []).find((a) => String(a).startsWith('@'));
  if (replied) {
    targetId = replied.id;
  } else if (mention) {
    const uname = String(mention).slice(1).toLowerCase();
    const row = db.findUserByUsername(uname);
    if (!row) {
      return { title: '❓ UNKNOWN USER', color: '#F44336', message: `No user found for <code>@${uname}</code> — they must /start the bot first.` };
    }
    targetId = row.user_id;
  }
  const actor = metaOf(ctx.msg);
  const target = db.getOrCreateUser(targetId);
  if (mode === 'add') db.addWallet(targetId, amt);
  else db.setNetworth(targetId, amt);
  const after = db.getUser(targetId);
  db.logActivity('admin', `/${mode} ${fmt(amt)} -> ${target.first_name || targetId} by ${actor.username || ctx.userId}`, { target: targetId, actor: ctx.userId });
  return {
    title: mode === 'add' ? '➕ COINS ADDED' : '🎯 BALANCE SET',
    color: '#FFD700',
    message: (mode === 'add'
      ? `➕ <b>Added</b> ${fmt(amt)} coins to `
      : `🎯 <b>Set</b> networth to <b>${fmt(amt)}</b> (wallet ${fmt(amt)} · bank 0) for `) +
      `<a href="tg://user?id=${targetId}">${target.first_name || targetId}</a>.\n` +
      `💳 Wallet: <b>${fmt(after.wallet)}</b> · 🏦 Bank: <b>${fmt(after.bank)}</b> · 💎 Net: <b>${fmt(after.wallet + after.bank)}</b>`,
  };
}

async function stop(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 PAUSE', color: '#F44336' });
  db.setBotPaused(true);
  db.logActivity('mod', `/stop by ${metaOf(ctx.msg).username || ctx.userId} — bot PAUSED`, { target: ctx.userId });
  await ctx.reply(
    `🔒 <b>RIMURU PAUSED</b>\n\n` +
    `All non-owner users are now ignored — no commands, no games, no button taps.\n` +
    `The pause is <b>persisted</b> and survives redeploys.\n\n` +
    `Resume with <code>/run</code>. The house is closed. 🚪`,
    { title: '🔒 PAUSE', color: '#F44336', html: true }
  );
}

async function run(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '▶️ RESUME', color: '#F44336' });
  db.setBotPaused(false);
  db.logActivity('mod', `/run by ${metaOf(ctx.msg).username || ctx.userId} — bot RESUMED`, { target: ctx.userId });
  await ctx.reply(
    `▶️ <b>RIMURU RESUMED</b>\n\n` +
    `The house is open again. Welcome back, mortals. 🎰`,
    { title: '▶️ RESUME', color: '#FFD700', html: true }
  );
}

async function restart(ctx) {
  if (!isStaff(ctx.userId)) return ctx.reply('Only the King and his moderators can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const actor = metaOf(ctx.msg);
  db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'restart', 0, 'full state reset');
  db.logActivity('mod', `/restart by ${actor.username || ctx.userId}`, { target: ctx.userId });
  const cleared = [];
  try {
    const mines = require('./games/mines');
    const blackjack = require('./games/blackjack');
    const higherlower = require('./games/higherlower');
    const race = require('./games/race');
    for (const [userId, s] of mines.sessions || []) { s.alive = false; cleared.push(`mines:${userId}`); }
    if (mines.sessions) mines.sessions.clear();
    for (const [userId, s] of blackjack.sessions || []) { s.done = true; cleared.push(`blackjack:${userId}`); }
    if (blackjack.sessions) blackjack.sessions.clear();
    for (const [userId, s] of higherlower.sessions || []) { s.alive = false; cleared.push(`higherlower:${userId}`); }
    if (higherlower.sessions) higherlower.sessions.clear();
    for (const userId of race.sessions ? race.sessions.keys() : []) cleared.push(`race:${userId}`);
    if (race.sessions) race.sessions.clear();
  } catch (e) { /* game modules optional */ }

  try {
    const openHeists = db.getOpenHeists();
    for (const row of openHeists) {
      db.deleteHeist(row.leader_id);
      cleared.push(`heist:${row.leader_id}`);
    }
    const cdRows = db.db.prepare('SELECT user_id, action FROM cooldowns').all();
    for (const row of cdRows) cleared.push(`cd:${row.user_id}:${row.action}`);
    db.clearAllCooldowns();
    db.saveLottery((config.lottery && config.lottery.baseJackpot) || 5000000, 0, []);
    cleared.push('lottery');
  } catch (e) { /* non-fatal */ }

  await ctx.reply(
    `🔄 <b>RESTART COMPLETE</b>\n\n` +
    `Cleared <b>${cleared.length}</b> active state entries:\n` +
    `• Active games: mines, blackjack, higher/lower, race\n` +
    `• Open heists & timers\n` +
    `• All cooldowns\n` +
    `• Lottery pot reset\n\n` +
    `The house is clean. Everything starts fresh. ✨`,
    { title: '🔒 ADMIN — RESTART', color: '#FFD700', html: true }
  );
}

async function ban(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/ban [reason]</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const { dur, reason } = splitDurReason(ctx.args);
  const r = applyPenalty(target.id, STATUS.BANNED, reason, dur);
  await ctx.reply(r.message, { title: '🔒 ADMIN — BAN', color: '#F44336' });
}

async function suspend(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/sus [reason]</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const { dur, reason } = splitDurReason(ctx.args);
  const r = applyPenalty(target.id, STATUS.SUSPECTED, reason, dur);
  await ctx.reply(r.message, { title: '🔒 ADMIN — SUSPEND', color: '#F44336' });
}

async function mute(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/mute [reason]</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const { dur, reason } = splitDurReason(ctx.args);
  const r = applyPenalty(target.id, STATUS.MUTED, reason, dur);
  await ctx.reply(r.message, { title: '🔒 ADMIN — MUTE', color: '#F44336' });
}

async function unban(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/unban</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const r = liftPenalty(target.id);
  await ctx.reply(r.message, { title: '🔒 ADMIN — UNBAN', color: '#00BCD4' });
}

async function unsus(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/unsus</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const r = liftPenalty(target.id);
  await ctx.reply(r.message, { title: '🔒 ADMIN — UNSUSPEND', color: '#00BCD4' });
}

async function unmute(ctx) {
  if (!isOwner(ctx.userId)) return ctx.reply('Only the King can do that. 👑', { title: '🔒 ADMIN', color: '#F44336' });
  const target = repliedUser(ctx.msg);
  if (!target) return ctx.reply('Reply to someone with <code>/unmute</code>. 🎯', { title: '🔒 ADMIN', color: '#F44336', html: true });
  const r = liftPenalty(target.id);
  await ctx.reply(r.message, { title: '🔒 ADMIN — UNMUTE', color: '#00BCD4' });
}

async function hide(ctx) {
  const cd = require('./cooldowns');
  const eco = require('./economy');
  const g = cd.guard(ctx.userId, 'hide', 'Hiding');
  if (g.blocked) return ctx.reply(g.message, { title: '💀 HIDE', color: '#F44336' });
  const price = (config.hide && config.hide.price) || 5000;
  const charge = eco.chargeWallet(ctx.userId, price, 'hide');
  if (!charge.ok) return ctx.reply(charge.message, { title: '💀 HIDE', color: '#F44336' });
  db.setHidden(ctx.userId, Date.now() + ((config.hide && config.hide.durationMs) || 60000));
  cd.start(ctx.userId, 'hide', (config.cooldowns && config.cooldowns.hide) || 60000);
  db.logActivity('user', `💀 /hide by ${metaOf(ctx.msg).username || ctx.userId}`, { target: ctx.userId, cost: price });
  await ctx.reply(
    `💀 <b>YOU VANISHED</b>\n\n` +
    `You paid <b>${fmt(price)}</b> to slip into the shadows.\n` +
    `For <b>60 seconds</b> nobody can <code>/rob</code> or <code>/heist</code> you.`,
    { title: '💀 HIDE', color: '#00BCD4', html: true }
  );
}

async function xleaderboard(ctx) {
  if (!isStaff(ctx.userId)) {
    return ctx.reply('Only staff can view the extended leaderboard. 👑', { title: '🔒 STAFF ONLY', color: '#F44336' });
  }
  const n = Number(String((ctx.args || [])[0] || '100').replace(/,/g, ''));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 100;
  await ctx.reply(leaderboard.renderCount(limit), { title: '🏆 EXTENDED LEADERBOARD', color: '#FFD700', html: true });
}

module.exports = {
  STATUS,
  applyPenalty,
  liftPenalty,
  checkInteract,
  parseDuration,
  // Staff handlers (bot.js delegates)
  health,
  debug,
  setBalance,
  addCoins,
  stop,
  run,
  restart,
  ban,
  suspend,
  mute,
  unban,
  unsus,
  unmute,
  hide,
  xleaderboard,
  mod,
  purge,
  isPurgeLocked,
  handlePurgeMessage,
  handlePurgeApprovalMessage,
};
