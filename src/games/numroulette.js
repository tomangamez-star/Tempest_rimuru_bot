'use strict';
/**
 * Rimuru Tempest Casino — Number Roulette 🎯
 * /num [1-10] [amount] — pick a number 1-10. The rarer the number,
 * the higher the payout (2x for 1&10 up to 9x for the rarest middle pick).
 * House edge ~55/45.
 */
const config = require('../config');
const { fmt, randInt } = require('../utils');

// Payout multiplier by chosen number (rarer middle numbers pay more).
const PAYOUTS = { 1: 2.0, 2: 4.0, 3: 6.0, 4: 8.0, 5: 9.0, 6: 9.0, 7: 8.0, 8: 6.0, 9: 4.0, 10: 2.0 };

/** Pure logic: { chosen, drawn, payout } */
function playNum(chosen, bet) {
  const drawn = randInt(1, 10);
  const win = drawn === chosen;
  const payout = win ? Math.floor(bet * PAYOUTS[chosen]) : 0;
  return { chosen, drawn, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const chosen = Math.floor(Number(args[0]));
  if (!Number.isFinite(chosen) || chosen < 1 || chosen > 10) {
    return reply('🎯 Usage: `/num [1-10] [amount]` — e.g. `/num 7 5000`. Rarer picks pay more!');
  }
  const raw = String(args[1] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎯 Usage: `/num [1-10] [amount]` — e.g. `/num 7 5000`.');
  }
  const g = cd.guardGame(userId, 'num', 'Number Roulette');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'spin');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'num', config.perGameCooldownMs);

  const r = playNum(chosen, bet);
  let net = -bet;
  let text;
  if (r.payout > 0) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `🎯 The ball lands on <b>${r.drawn}</b>!\n\n` +
      `✅ <b>JACKPOT!</b> ${r.chosen} pays <b>${PAYOUTS[r.chosen].toFixed(1)}x</b> → <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else {
    text = `🎯 The ball lands on <b>${r.drawn}</b>.\n\n` +
      `❌ You picked ${r.chosen}. Lost ${fmt(bet)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.payout > 0, net };
}

module.exports = { play, playNum, PAYOUTS };
