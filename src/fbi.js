'use strict';
/**
 * Rimuru Tempest Casino — FBI / SWAT law-enforcement layer 🚔
 *
 * Two modes:
 *   1. JUSTICE (automatic): when a MODERATOR (not the owner) tries to move more
 *      than `config.fbi.threshold` coins via /addcoin or /sb, Rimuru revokes
 *      their moderatorship and resets their balance to a 0..maxRemaining value
 *      that scales with how far over the threshold the attempt went.
 *   2. RAID (manual): the owner replies to a user with /FBI (alias /SWAT). FBI
 *      do NOT spawn — they WATCH. The user must type a case-sensitive escape
 *      code within `config.fbi.raidWindowMs` or lose a controlled % of their
 *      net worth (wallet first, then bank).
 *
 * This module is intentionally split into two layers:
 *   1. PURE functions (deterministic, testable without Telegram).
 *   2. A controller (attach() → deployAgainst / handleInput / sweep) that wires
 *      the pure logic to Telegram via injected callbacks.
 *
 * PERSISTENCE: all balance changes go through db.addWallet / db.addBank (and the
 * moderatorship change through db.removeAdminUser), so every mutation flows
 * through the v4 versioned write pipeline. It does NOT touch advisory locking,
 * hydration, or fencing.
 */
const config = require('./config');
const db = require('./db');
const { fmt, clamp } = require('./utils');

/* ================= PURE LOGIC (testable, no Telegram) ================= */

const ESCAPE_WORDS = ['WaTch', 'RaId', 'HuNt', 'SiReN', 'ChAse', 'AlErT'];

/**
 * Build a case-sensitive escape code. Start from a short word and randomly
 * flip each letter's case so the user must type it EXACTLY as shown.
 */
function buildEscapeCode(rng = Math.random) {
  const word = ESCAPE_WORDS[Math.floor(rng() * ESCAPE_WORDS.length)];
  let out = '';
  for (const ch of word) {
    out += rng() < 0.5 ? ch.toUpperCase() : ch.toLowerCase();
  }
  // Small chance of a trailing digit to make it harder (still typeable).
  if (rng() < 0.5) out += String(Math.floor(rng() * 10));
  return out;
}

/** Controlled fine: a % of net worth, clamped, never all of it. */
function fineAmount(networth) {
  const total = Math.max(0, Number(networth) || 0);
  if (!total) return 0;
  const raw = Math.floor(total * config.fbi.finePct);
  const capped = clamp(raw, config.fbi.fineMin, config.fbi.fineMax);
  return Math.max(0, Math.min(capped, total));
}

/**
 * Justice consequence for a moderator overstepping.
 * Returns { remaining } — the mod's new balance (0..maxRemaining).
 * The farther over the threshold, the harsher the reset (toward 0).
 */
function justiceRemaining(amount, threshold = config.fbi.threshold, max = config.fbi.maxRemaining) {
  const amt = Math.max(0, Number(amount) || 0);
  if (amt <= threshold) return max;
  // Excess ratio: at threshold → 1 (lenient), at 2×threshold+ → 0 (harsh).
  const excess = amt - threshold;
  const ratio = clamp(1 - excess / Math.max(1, threshold), 0, 1);
  return Math.floor(max * ratio);
}

/** Split a fine across wallet (first) then bank, mirroring attack's theft. */
function splitFine(wallet, bank) {
  const w = Math.max(0, Number(wallet) || 0);
  const b = Math.max(0, Number(bank) || 0);
  const total = w + b;
  const stolen = fineAmount(total);
  const fromWallet = Math.min(w, stolen);
  const fromBank = Math.min(b, stolen - fromWallet);
  return { stolen, fromWallet, fromBank };
}

/* ================= CONTROLLER (Telegram wiring) ================= */

const pendingRaids = new Map(); // userId -> { code, expiresAt, timer, chatId }
let deps = null;

function attach(d) {
  deps = d || null;
  return module.exports;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function targetHandle(u) {
  return u.username ? `@${esc(u.username)}` : esc(u.first_name || `user ${u.user_id}`);
}

async function send(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[fbi] reply failed:', e.message); }
  }
  return null;
}

async function announce(text) {
  if (deps && typeof deps.announce === 'function') {
    try { await deps.announce(text); return; } catch (e) { console.warn('[fbi] announce failed:', e.message); }
  }
}

function clearRaid(userId) {
  const p = pendingRaids.get(Number(userId));
  if (p && p.timer) clearTimeout(p.timer);
  pendingRaids.delete(Number(userId));
}

async function failRaid(targetId, chatId, reason) {
  clearRaid(targetId);
  const u = db.getUser(targetId) || { wallet: 0, bank: 0 };
  const { stolen, fromWallet, fromBank } = splitFine(u.wallet, u.bank);
  if (fromWallet > 0) db.addWallet(targetId, -fromWallet);
  if (fromBank > 0) db.addBank(targetId, -fromBank);
  const after = db.getUser(targetId) || { wallet: 0, bank: 0 };
  db.logActivity('event', `FBI raid breached ${targetId} (${reason}) — fined ${stolen}`, { target: targetId, stolen });
  await send(chatId,
    `🚔 <b>RAID COMPLETE</b>\n\n` +
    `The FBI breached the property and seized assets.\n` +
    `💰 Fined: <b>${fmt(stolen)}</b> (wallet ${fmt(fromWallet)} · bank ${fmt(fromBank)})\n` +
    `👛 Remaining wallet: <b>${fmt(after.wallet)}</b>\n` +
    `🏦 Remaining bank: <b>${fmt(after.bank)}</b>`,
    { title: '🚔 FBI RAID', color: '#FF5252', html: true }
  );
}

/** Start a raid: FBI watch silently, the target must escape or be fined. */
async function deployAgainst(targetId, opts = {}) {
  const now = Date.now();
  const chatId = opts.chatId != null ? opts.chatId : Number(targetId);
  const target = db.getUser(targetId);
  if (!target) {
    return { ok: false, message: 'That user has never interacted with the bot.' };
  }
  const code = buildEscapeCode();
  const expiresAt = now + config.fbi.raidWindowMs;
  clearRaid(targetId);
  const timer = setTimeout(() => {
    failRaid(Number(targetId), Number(targetId), 'raid timeout');
  }, config.fbi.raidWindowMs + 500);
  timer.unref && timer.unref();
  pendingRaids.set(Number(targetId), { code, expiresAt, timer, chatId: Number(targetId) });

  await send(chatId,
    `🚔 <b>FBI RAID</b>\n\n` +
    `The FBI are watching <b>${targetHandle(target)}</b>...\n` +
    `Type this EXACTLY (case-sensitive) to escape:\n\n` +
    `<code>${code}</code>\n\n` +
    `⏱ <b>${Math.round(config.fbi.raidWindowMs / 1000)} SECONDS</b>`,
    { title: '🚔 FBI RAID', color: '#FF5252', html: true }
  );

  await send(Number(targetId),
    `🚔 <b>FBI ARE AT YOUR DOOR</b>\n\n` +
    `They are watching... type this EXACTLY (caps matter) to escape:\n\n` +
    `<code>${code}</code>\n\n` +
    `⏱ <b>${Math.round(config.fbi.raidWindowMs / 1000)} SECONDS</b>`,
    { title: '🚔 FBI RAID', color: '#FF5252', html: true }
  );

  return { ok: true, targetId: Number(targetId), code, outcome: 'raid-watching' };
}

/** Handle a message that might be a raid escape code. Returns true if consumed. */
async function handleInput(userId, chatId, text) {
  const p = pendingRaids.get(Number(userId));
  if (!p) return false;
  const answer = String(text || '').trim();
  if (answer !== p.code) {
    await failRaid(userId, chatId || p.chatId, 'wrong escape code');
    return true;
  }
  clearRaid(userId);
  const u = db.getUser(userId) || { wallet: 0, bank: 0 };
  db.logActivity('event', `FBI raid escaped by ${userId}`, { target: userId });
  await send(chatId || p.chatId,
    `🏃 <b>ESCAPED!</b>\n\n` +
    `${targetHandle(u)} slipped away before the FBI could move. Assets intact.`,
    { title: '🏃 FBI RAID ESCAPED', color: '#4FC3F7', html: true }
  );
  return true;
}

/** Expire any pending raid whose window elapsed (safety sweep). */
async function sweep() {
  const now = Date.now();
  const expired = [];
  for (const [uid, p] of pendingRaids) {
    if (now >= p.expiresAt) expired.push(uid);
  }
  for (const uid of expired) {
    const p = pendingRaids.get(uid);
    if (p) await failRaid(uid, p.chatId, 'raid timeout');
  }
  return expired.length;
}

/** Expose state for tests + debug. */
function state() {
  return {
    pendingRaids: pendingRaids.size,
    pendingCodes: [...pendingRaids.values()].map((p) => p.code),
  };
}

module.exports = {
  // pure
  buildEscapeCode,
  fineAmount,
  justiceRemaining,
  splitFine,
  // controller
  attach,
  deployAgainst,
  handleInput,
  sweep,
  state,
  _clear: () => {
    for (const [uid, p] of pendingRaids) if (p.timer) clearTimeout(p.timer);
    pendingRaids.clear();
  },
};
