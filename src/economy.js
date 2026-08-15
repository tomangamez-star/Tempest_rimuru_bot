'use strict';
/**
 * Rimuru Tempest Casino — economy module.
 * Wallet (rob-able) vs Bank (safe, heist-able).
 * /wd — bank → wallet   /dep — wallet → bank
 * /donate — removes from WALLET (reply to user)
 * /transfer — removes from BANK (reply to user)
 */
const config = require('./config');
const db = require('./db');
const { fmt, parseAmount } = require('./utils');

/** Ensure user exists; returns user row. */
function ensure(userId, meta) {
  return db.getOrCreateUser(userId, meta);
}

/** Pay coins from wallet (for games). Returns { ok, message }. */
function chargeWallet(userId, amount, what = 'bet') {
  const u = ensure(userId);
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  // TIME-WALLET integration: drain timed coins first (they expire otherwise),
  // then the regular wallet covers the rest.
  const tw = db.getTimeWalletBalance ? db.getTimeWalletBalance(userId) : 0;
  const fromTw = Math.min(tw, amt);
  const fromWallet = amt - fromTw;
  if (fromWallet > 0 && u.wallet < fromWallet) {
    return { ok: false, message: `❌ You need ${fmt(amt)} for this ${what} — your wallet has ${fmt(u.wallet)}${fromTw ? ` (+ ${fmt(fromTw)} timed)` : ''}.` };
  }
  if (fromTw > 0) db.spendTimeWallet(userId, fromTw);
  if (fromWallet > 0) db.addWallet(userId, -fromWallet);
  return { ok: true, fromTw, fromWallet };
}

function netWorth(userId) {
  return db.getNetWorth(userId);
}

function balance(userId) {
  const u = db.getUser(userId);
  return u ? { wallet: u.wallet, bank: u.bank } : { wallet: 0, bank: 0 };
}

/** Wallet → Bank. Returns { ok, message, amount }. */
function deposit(userId, rawAmount) {
  const u = ensure(userId);
  const max = u.wallet;
  const amt = parseAmount(rawAmount, max);
  if (amt === null || amt === undefined) {
    return { ok: false, message: `🎩 Usage: \`/dep [amount]\` — your wallet has ${fmt(max)}. Use \`/dep all\` for everything.` };
  }
  if (amt <= 0 || amt > max) {
    return { ok: false, message: `❌ You can't deposit ${fmt(amt)} — you only have ${fmt(max)} in your wallet.` };
  }
  db.addWallet(userId, -amt);
  db.addBank(userId, amt);
  return { ok: true, amount: amt, message: `🏦 **Deposited** ${fmt(amt)} into your bank.\nWallet: ${fmt(u.wallet - amt)} → Bank: ${fmt(u.bank + amt)}` };
}

/** Bank → Wallet. Returns { ok, message, amount }. */
function withdraw(userId, rawAmount) {
  const u = ensure(userId);
  const max = u.bank;
  const amt = parseAmount(rawAmount, max);
  if (amt === null || amt === undefined) {
    return { ok: false, message: `🎩 Usage: \`/wd [amount]\` — your bank holds ${fmt(max)}. Use \`/wd all\` for everything.` };
  }
  if (amt <= 0 || amt > max) {
    return { ok: false, message: `❌ You can't withdraw ${fmt(amt)} — your bank only has ${fmt(max)}.` };
  }
  db.addBank(userId, -amt);
  db.addWallet(userId, amt);
  return { ok: true, amount: amt, message: `💸 **Withdrew** ${fmt(amt)} to your wallet.\nBank: ${fmt(u.bank - amt)} → Wallet: ${fmt(u.wallet + amt)}` };
}

/**
 * Donate coins to a user (from WALLET).
 * @param fromId donator, @param toId recipient, @param rawAmount
 */
function donate(fromId, toId, rawAmount) {
  if (fromId === toId) {
    return { ok: false, message: '🤨 You can\'t donate to yourself, genius.' };
  }
  const from = ensure(fromId);
  const max = from.wallet;
  const amt = parseAmount(rawAmount, max);
  if (amt === null || amt === undefined) {
    return { ok: false, message: `🎩 Reply to someone with \`/donate [amount]\` — your wallet has ${fmt(max)}.` };
  }
  if (amt <= 0 || amt > max) {
    return { ok: false, message: `❌ You can't donate ${fmt(amt)} — your wallet only has ${fmt(max)}.` };
  }
  ensure(toId);
  db.addWallet(fromId, -amt);
  db.addWallet(toId, amt);
  return { ok: true, amount: amt, message: `💝 **Donated** ${fmt(amt)} from your wallet to <a href="tg://user?id=${toId}">user</a>.\nYour wallet: ${fmt(from.wallet - amt)}` };
}

/**
 * Transfer coins to a user (from BANK — safe from robbers).
 * @param fromId sender, @param toId recipient, @param rawAmount
 */
function transfer(fromId, toId, rawAmount) {
  if (fromId === toId) {
    return { ok: false, message: '🤨 You can\'t transfer to yourself, genius.' };
  }
  const from = ensure(fromId);
  const max = from.bank;
  const amt = parseAmount(rawAmount, max);
  if (amt === null || amt === undefined) {
    return { ok: false, message: `🎩 Reply to someone with \`/transfer [amount]\` — your bank holds ${fmt(max)}.` };
  }
  if (amt <= 0 || amt > max) {
    return { ok: false, message: `❌ You can't transfer ${fmt(amt)} — your bank only has ${fmt(max)}.` };
  }
  ensure(toId);
  db.addBank(fromId, -amt);
  db.addBank(toId, amt);
  return { ok: true, amount: amt, message: `🏦 **Transferred** ${fmt(amt)} from your bank to <a href="tg://user?id=${toId}">user</a>.\nYour bank: ${fmt(from.bank - amt)}` };
}

/** Credit winnings to wallet. Returns new wallet. */
function creditWallet(userId, amount) {
  return db.addWallet(userId, amount);
}

module.exports = {
  ensure,
  netWorth,
  balance,
  deposit,
  withdraw,
  donate,
  transfer,
  chargeWallet,
  creditWallet,
};
