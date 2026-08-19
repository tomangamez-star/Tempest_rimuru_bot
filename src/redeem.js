'use strict';
/**
 * Rimuru Tempest Casino — Redeem codes 🎟️
 *
 *   /redeem [CODE]                    — user redeems a code → coins to BANK
 *   /redeem create [CODE] [AMT] [USES]— owner (unlimited) / mod (≤50M cap)
 *   /redeem list                      — owner/mods: active codes
 *   /redeem delete [CODE]             — owner/mods: remove a code
 *
 * Rules:
 *   - One redemption per user per code.
 *   - Codes have a max number of total uses.
 *   - Coins always go to the BANK (not the wallet — safe from robbers).
 *   - Moderators can create codes BUT capped at 50,000,000 per code, and
 *     they CANNOT redeem their own created code (owner codes are fine).
 *   - Owner has no amount limit and may redeem anything.
 */
const config = require('./config');
const db = require('./db');
const { fmt } = require('./utils');

const MOD_MAX_AMOUNT = 50000000; // 50M cap for moderator-created codes
const CODE_RE = /^[A-Za-z0-9_-]{3,24}$/;

/** Normalize a code to canonical form (uppercase, trimmed). */
function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

/** Is the user an owner? */
function isOwner(userId) {
  return String(userId) === String(config.ownerId);
}

/** Is the user staff (owner or a dashboard moderator)? */
function isMod(userId) {
  if (isOwner(userId)) return true;
  try {
    const a = db.getAdminUser(Number(userId));
    return !!a && (a.role === 'mod' || a.role === 'owner');
  } catch (e) {
    return false;
  }
}

/** Staff who may create/list/delete codes = owner + moderators. */
function canManage(userId) {
  return isOwner(userId) || isMod(userId);
}

/**
 * /redeem create [CODE] [AMT] [USES]
 * Owner: unlimited amount. Mod: amount capped at 50M.
 * Returns { ok, message, code? }.
 */
function createCode(userId, args, meta = {}) {
  if (!canManage(userId)) {
    return { ok: false, message: '🔒 Only the King and his moderators can mint codes.' };
  }
  const [rawCode, rawAmt, rawUses] = args || [];
  const code = normCode(rawCode);
  if (!CODE_RE.test(code)) {
    return {
      ok: false,
      message: '🎟️ Usage: <code>/redeem create [CODE] [AMOUNT] [USES]</code> — code must be 3-24 letters/numbers/_-.',
    };
  }
  const amount = Math.floor(Number(rawAmt));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: '🎟️ Give a real coin amount: <code>/redeem create TEMPEST 500000 10</code>' };
  }
  const maxUses = Math.max(1, Math.floor(Number(rawUses) || 1));
  if (maxUses > 100000) {
    return { ok: false, message: '💥 100,000 uses max per code. The house has limits.' };
  }

  const owner = isOwner(userId);
  if (!owner && amount > MOD_MAX_AMOUNT) {
    return {
      ok: false,
      message:
        `🚫 As a moderator you can only mint codes up to <b>${fmt(MOD_MAX_AMOUNT)}</b>. ` +
        `Ask the King for bigger ones.`,
    };
  }

  const existing = db.getRedeemCode(code);
  if (existing) {
    return { ok: false, message: `⚠️ Code <code>${code}</code> already exists. Use <code>/redeem delete ${code}</code> first.` };
  }

  const role = owner ? 'owner' : 'mod';
  const row = db.createRedeemCode(code, amount, maxUses, userId, role);
  if (!row) {
    return { ok: false, message: `⚠️ Could not create <code>${code}</code> — try a different code.` };
  }
  db.logAudit(userId, meta.username || String(userId), 'redeem_create', 0, `${code} amount=${amount} uses=${maxUses}`);
  db.logActivity('mod', `${meta.first_name || meta.username || userId} minted redeem code ${code} (${fmt(amount)} × ${maxUses})`);
  return {
    ok: true,
    code,
    message:
      `🎟️ <b>CODE MINTED</b>\n\n` +
      `Code: <code>${code}</code>\n` +
      `Amount: <b>${fmt(amount)}</b> (goes to BANK on redemption)\n` +
      `Uses: <b>${fmt(maxUses)}</b>\n\n` +
      `Share it — users redeem with <code>/redeem ${code}</code>.`,
  };
}

/**
 * /redeem [CODE] — redeem a code. Coins go to the BANK.
 * One redemption per user per code; total uses capped.
 * Moderators cannot redeem their OWN code (owner codes are fine).
 * Returns { ok, message, amount? }.
 */
function redeemCode(userId, codeRaw, meta = {}) {
  const code = normCode(codeRaw);
  if (!code) {
    return {
      ok: false,
      message:
        '🎟️ <b>REDEEM</b>\n\n' +
        'Use <code>/redeem [CODE]</code> to claim coins (they go straight to your BANK).\n' +
        'Staff: <code>/redeem create [CODE] [AMT] [USES]</code> · <code>/redeem list</code> · <code>/redeem delete [CODE]</code>',
    };
  }
  const rec = db.getRedeemCode(code);
  if (!rec) {
    return { ok: false, message: `❌ Code <code>${code}</code> doesn't exist. Double-check the spelling, mortal.` };
  }
  // Moderator cannot redeem their own created code.
  if (isMod(userId) && !isOwner(userId) && rec.created_by === userId) {
    return {
      ok: false,
      message: `🚫 You minted <code>${code}</code> yourself — you can't redeem your own codes. Ask the King for one.`,
    };
  }
  if (db.hasRedeemed(userId, code)) {
    return { ok: false, message: `🔁 You already redeemed <code>${code}</code>. One per user, per code.` };
  }
  if (rec.used_count >= rec.max_uses) {
    return { ok: false, message: `😵 <code>${code}</code> is all used up. The vault is empty.` };
  }
  if (!db.recordRedemption(userId, code)) {
    return { ok: false, message: `🔁 You already redeemed <code>${code}</code>. One per user, per code.` };
  }
  // Ensure the user row exists (a moderator who never /started still has a row).
  db.getOrCreateUser(userId, meta);
  db.addBank(userId, rec.amount); // coins go to the BANK — safe from robbers
  db.logAudit(userId, meta.username || String(userId), 'redeem', 0, `${code} +${rec.amount}`);
  db.logActivity('user', `${meta.first_name || meta.username || userId} redeemed ${code} (+${fmt(rec.amount)})`, { target: userId, code, amount: rec.amount });
  const u = db.getUser(userId);
  return {
    ok: true,
    amount: rec.amount,
    message:
      `🎉 <b>CODE REDEEMED</b>\n\n` +
      `Code: <code>${code}</code>\n` +
      `💰 <b>+${fmt(rec.amount)}</b> coins deposited to your <b>BANK</b> (robber-proof).\n\n` +
      `🏦 Bank: <b>${fmt(u ? u.bank : 0)}</b> · 👛 Wallet: <b>${fmt(u ? u.wallet : 0)}</b>`,
  };
}

/** /redeem list — active codes (owner/mods). */
function listCodes(userId) {
  if (!canManage(userId)) {
    return { ok: false, message: '🔒 Only the King and his moderators can view the code vault.' };
  }
  const codes = db.listRedeemCodes();
  if (!codes.length) {
    return { ok: false, message: '🎟️ No codes exist yet. Mint one: <code>/redeem create TEMPEST 500000 10</code>' };
  }
  const lines = codes.map((c) =>
    `• <code>${c.code}</code> — <b>${fmt(c.amount)}</b> · ${fmt(c.used_count)}/${fmt(c.max_uses)} used · ` +
    `by ${c.created_by === Number(config.ownerId) ? '👑 King' : '🛡️ mod'} · ${new Date(c.created_at).toLocaleString()}`
  );
  return { ok: true, message: `🎟️ <b>ACTIVE CODES</b>\n\n${lines.join('\n')}` };
}

/** /redeem delete [CODE] — remove a code (owner/mods). */
function deleteCode(userId, codeRaw, meta = {}) {
  if (!canManage(userId)) {
    return { ok: false, message: '🔒 Only the King and his moderators can delete codes.' };
  }
  const code = normCode(codeRaw);
  if (!code) {
    return { ok: false, message: '🎟️ Usage: <code>/redeem delete [CODE]</code>' };
  }
  if (!db.deleteRedeemCode(code)) {
    return { ok: false, message: `❌ Code <code>${code}</code> not found.` };
  }
  db.logAudit(userId, meta.username || String(userId), 'redeem_delete', 0, code);
  db.logActivity('mod', `${meta.first_name || meta.username || userId} deleted redeem code ${code}`);
  return { ok: true, message: `🗑️ Code <code>${code}</code> deleted. The vault door closes.` };
}

/** Command router used by bot.js. */
async function handle(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const sub = String(args[0] || '').toLowerCase();
  const from = ctx.msg && ctx.msg.from || {};
  const meta = { username: from.username || '', first_name: from.first_name || '' };
  let result;
  if (sub === 'create') result = createCode(ctx.userId, args.slice(1), meta);
  else if (sub === 'list') result = listCodes(ctx.userId);
  else if (sub === 'delete') result = deleteCode(ctx.userId, args[1], meta);
  else result = redeemCode(ctx.userId, args[0], meta);
  await ctx.reply(result.message, { title: result.ok ? '🎟️ REDEEM' : '🎟️ REDEEM', html: true });
  return result;
}

module.exports = {
  MOD_MAX_AMOUNT,
  isOwner,
  isMod,
  canManage,
  normCode,
  createCode,
  redeemCode,
  listCodes,
  deleteCode,
  handle,
};
