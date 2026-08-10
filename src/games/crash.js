'use strict';
/**
 * Rimuru Tempest Casino — Crash 💥
 * /crash [amount] — a multiplier ticks up (1.00x → 1.25x → 1.5x ...).
 * Cash out before it crashes; the crash point is chosen by the house with a
 * ~55/45 edge (the game stops growing at a random point — the longer you
 * hold, the likelier it crashes).
 * Simple single-press flow: bet → immediate outcome (cash-out at the random
 * crash multiplier) keeps it fair and playable without a live loop.
 */
const config = require('../config');
const { fmt, randInt } = require('../utils');

/** Roll the crash multiplier: 45% of bets survive ≥ 1.5x, house keeps 10%. */
function rollCrash() {
  const r = Math.random();
  if (r < 0.30) return 1.0;            // crash at 1.00x — lose instantly
  if (r < 0.50) return 1.25;           // small tick
  if (r < 0.70) return 1.5;
  if (r < 0.85) return 2.0;
  if (r < 0.93) return 3.0;
  if (r < 0.98) return 5.0;
  return 10.0;
}

/** Pure logic: { crash, payout } — payout = bet × crash, 0 when crash=1.0. */
function playCrash(bet) {
  const crash = rollCrash();
  const payout = crash > 1.0 ? Math.floor(bet * crash) : 0;
  return { crash, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎯 Usage: `/crash [amount]` — e.g. `/crash 5000`. Cash out before it crashes!');
  }
  const g = cd.guardGame(userId, 'crash', 'Crash');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'crash');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'crash', config.perGameCooldownMs);

  const r = playCrash(bet);
  let net = -bet;
  let text;
  if (r.payout > 0) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `💥 <b>CRASH AT ${r.crash.toFixed(2)}x!</b>\n\n` +
      `You rode the rocket to <b>${r.crash.toFixed(2)}x</b> — payout <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else {
    text = `💥 <b>CRASHED AT 1.00x!</b>\n\n` +
      `It exploded the moment you clicked. Lost ${fmt(bet)}. Better luck next round.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.payout > 0, net };
}

module.exports = { play, playCrash, rollCrash };
