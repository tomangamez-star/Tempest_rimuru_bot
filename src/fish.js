'use strict';
/**
 * Rimuru Tempest Casino — Fishing 🎣
 * /fish — requires a Fishing Hook (buy it at /shop). Catch fish worth coins,
 * or junk. Own the hook forever (not consumed per cast).
 * 15s cooldown... actually keep it on the normal income cadence (config).
 */
const config = require('./config');
const db = require('./db');
const cd = require('./cooldowns');
const { fmt, randInt, pick } = require('./utils');

/**
 * /fish — one cast. Requires at least 1 fishing hook in inventory.
 * @returns { ok, message, caught?, amount? }
 */
function fish(userId, meta = {}) {
  const g = cd.guard(userId, 'fish', 'Fishing');
  if (g.blocked) return { ok: false, message: g.message };

  if (!db.hasItem(userId, 'hook')) {
    return {
      ok: false,
      message:
        `🎣 You need a <b>Fishing Hook</b> to fish!\n` +
        `Buy one at <code>/shop</code> (item 4) — only <b>${fmt(15000)}</b> coins. The fish are waiting.`,
    };
  }

  db.getOrCreateUser(userId, meta);

  const [min, max] = config.income.fish; // [1000, 8000] — same as the old bare /fish
  const amount = randInt(min, max);
  const catchChance = 0.75; // 75% catch, 25% junk (hook makes it worthwhile)

  db.addWallet(userId, amount);
  cd.start(userId, 'fish', config.cooldowns.fish);
  const wallet = db.getUser(userId).wallet;

  if (Math.random() < catchChance) {
    const line = pick(config.fish.catchLines)(fmt(amount));
    return {
      ok: true,
      caught: true,
      amount,
      message: `${line}\n👛 Wallet: ${fmt(wallet)}`,
    };
  }
  return {
    ok: true,
    caught: false,
    amount: 0,
    message: `${pick(config.fish.junkLines)}\n👛 Wallet: ${fmt(wallet)}`,
  };
}

module.exports = { fish };
