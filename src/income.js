'use strict';
/**
 * Rimuru Tempest Casino — Passive income 💰
 * /beg /work /fish /dig (cooldowns) + /daily (24h) + /bonus (weekly, manual claim).
 */
const config = require('./config');
const db = require('./db');
const cd = require('./cooldowns');
const { fmt, randInt, pick } = require('./utils');

const BEG_LINES = [
  (c) => `🙏 A kind stranger drops **${fmt(c)}** in your cup.`,
  (c) => `🪙 Someone's pocket "accidentally" empties ${fmt(c)} your way.`,
  (c) => `😏 The King tosses you **${fmt(c)}**. Don't get used to it.`,
  (c) => `🐉 A merchant takes pity and gives **${fmt(c)}**.`,
];
const WORK_LINES = [
  (c) => `🛠️ You haul cargo for the guild — **${fmt(c)}** earned.`,
  (c) => `📦 Delivery job done — **${fmt(c)}**.`,
  (c) => `🧹 You sweep the casino floor — **${fmt(c)}**.`,
  (c) => `⚒️ Smithing commission — **${fmt(c)}**.`,
];
const FISH_LINES = [
  (c) => `🐟 You reel in a fat fish — sold for **${fmt(c)}**.`,
  (c) => `🎣 Catch of the day — **${fmt(c)}**.`,
  (c) => `🦑 A rare squid! **${fmt(c)}**.`,
];
const DIG_LINES = [
  (c) => `⛏️ You unearth a rusty chest — **${fmt(c)}** inside!`,
  (c) => `💎 A glint of treasure — **${fmt(c)}**!`,
  (c) => `🪦 Ancient coins — **${fmt(c)}**.`,
];

function earn(userId, action, meta = {}) {
  const g = cd.guard(userId, action, { beg: 'Begging', work: 'Working', fish: 'Fishing', dig: 'Digging' }[action]);
  if (g.blocked) return { ok: false, message: g.message };

  const [min, max] = config.income[action];
  const amount = randInt(min, max);
  db.getOrCreateUser(userId, meta);
  db.addWallet(userId, amount);
  cd.start(userId, action, config.cooldowns[action]);

  const line = { beg: BEG_LINES, work: WORK_LINES, fish: FISH_LINES, dig: DIG_LINES }[action];
  const wallet = db.getUser(userId).wallet;
  return {
    ok: true,
    amount,
    message: `${pick(line)(amount)}\n👛 Wallet: ${fmt(wallet)}`,
  };
}

/** /daily — 24h cooldown. */
function daily(userId, meta = {}) {
  const g = cd.guard(userId, 'daily', 'Daily bonus');
  if (g.blocked) return { ok: false, message: g.message };

  const [min, max] = config.income.daily;
  const amount = randInt(min, max);
  db.getOrCreateUser(userId, meta);
  db.addWallet(userId, amount);
  cd.start(userId, 'daily', config.cooldowns.daily);
  const wallet = db.getUser(userId).wallet;
  return {
    ok: true,
    amount,
    message: `📅 **DAILY REWARD!** ${fmt(amount)} added.\n👛 Wallet: ${fmt(wallet)}\nSee you tomorrow.`,
  };
}

/** /bonus — weekly, manual claim. */
function bonus(userId, meta = {}) {
  const g = cd.guard(userId, 'bonus', 'Weekly bonus');
  if (g.blocked) return { ok: false, message: g.message };

  const [min, max] = config.income.bonus;
  const amount = randInt(min, max);
  db.getOrCreateUser(userId, meta);
  db.addWallet(userId, amount);
  cd.start(userId, 'bonus', config.cooldowns.bonus);
  const wallet = db.getUser(userId).wallet;
  return {
    ok: true,
    amount,
    message: `🎁 **WEEKLY BONUS!** ${fmt(amount)} added.\n👛 Wallet: ${fmt(wallet)}\nCome back next week for more.`,
  };
}

module.exports = { earn, daily, bonus };