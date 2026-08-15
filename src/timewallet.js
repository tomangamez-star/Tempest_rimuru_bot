'use strict';
/**
 * Rimuru Tempest Casino — Time-Wallet ⏳
 *
 * A THIRD storage place for timed rank rewards. Coins land here on promotion
 * and MUST be spent before their expiry window, otherwise they vanish. It is
 * a safe gift: attack/rob/heist/FBI theft never touches it.
 *
 * Spending is automatic — when a player places a bet or makes a purchase, the
 * time-wallet drains FIRST (oldest-expiring coins first), then the regular
 * wallet. This keeps the mechanic frictionless while honoring the "must spend
 * before expiry" rule.
 */
const db = require('./db');

/** Current spendable time-wallet balance (0 when expired). */
function balance(userId, now = Date.now()) {
  return db.getTimeWalletBalance(userId, now);
}

/** Return the full row (for display/tests). */
function info(userId, now = Date.now()) {
  return db.getTimeWalletRow(userId, now);
}

/** Spend `amount` from the time-wallet first. Returns { spent, remaining }. */
function spend(userId, amount, now = Date.now()) {
  return db.spendTimeWallet(userId, amount, now);
}

/** Expire stale timed coins. Returns number of expired rows. */
function sweep(now = Date.now()) {
  return db.sweepExpiredTimeWallet(now);
}

/** Display text for /rank and /balance. */
function display(userId) {
  const row = info(userId);
  if (!row || Number(row.amount) <= 0) {
    return '⏳ <b>Time-wallet:</b> 0 (empty)';
  }
  const amt = Number(row.amount);
  const exp = Number(row.expires_at) || 0;
  const remain = exp - Date.now();
  const when = remain > 0
    ? `expires in ${Math.floor(remain / 3600000)}h ${Math.floor((remain % 3600000) / 60000)}m`
    : 'EXPIRED';
  return `⏳ <b>Time-wallet:</b> ${amt.toLocaleString()} coins (${when})`;
}

module.exports = { balance, info, spend, sweep, display };
