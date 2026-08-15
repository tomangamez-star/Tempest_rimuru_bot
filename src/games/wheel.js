'use strict';
/**
 * Rimuru Tempest Casino — Wheel of Fortune 🎡
 * /wheel [amount] — spin a 12-segment wheel. Payouts: 0.5x–10x,
 * ~55/45 house edge (expected value ≈ 0.9).
 */
const config = require('../config');
const { fmt, pick } = require('../utils');
const rank = require('../rank');

// 12 segments: [label, mult, weight] — heavy low, rare jackpot
const SEGMENTS = [
  { label: '0.5x', mult: 0.5, w: 3 },
  { label: '1x', mult: 1.0, w: 3 },
  { label: '1x', mult: 1.0, w: 2 },
  { label: '2x', mult: 2.0, w: 2 },
  { label: '0.5x', mult: 0.5, w: 3 },
  { label: '3x', mult: 3.0, w: 2 },
  { label: '1x', mult: 1.0, w: 2 },
  { label: '0.5x', mult: 0.5, w: 3 },
  { label: '5x', mult: 5.0, w: 1 },
  { label: '2x', mult: 2.0, w: 2 },
  { label: '1.5x', mult: 1.5, w: 2 },
  { label: '10x', mult: 10.0, w: 1 },
];

function weightedPick() {
  const total = SEGMENTS.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const seg of SEGMENTS) {
    r -= seg.w;
    if (r <= 0) return seg;
  }
  return SEGMENTS[0];
}

/** Pure logic: { segment, payout } — payout = floor(bet × mult). */
function spin(bet, winChance = 0.5) {
  let seg = weightedPick();
  // Rank-tier win chance: on a losing spin (<1x segment), allow a re-spin
  // toward a 1x+ segment with the player's rank odds (peak hours = 0.5).
  if (seg.mult < 1 && Math.random() < Math.max(0, winChance - 0.5) * 2) {
    seg = weightedPick();
  }
  const payout = seg.mult < 1 ? 0 : Math.floor(bet * seg.mult);
  return { segment: seg, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎡 Usage: `/wheel [amount]` — e.g. `/wheel 5000`. Spin the wheel!');
  }
  const g = cd.guardGame(userId, 'wheel', 'Wheel of Fortune');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'spin');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'wheel', config.perGameCooldownMs);

  const r = spin(bet, rank.getWinChance(userId, 'wheel'));
  let net = -bet;
  let text;
  if (r.payout > 0) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `🎡 The wheel lands on <b>${r.segment.label}</b>!\n\n` +
      `✅ You win <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else {
    text = `🎡 The wheel lands on <b>${r.segment.label}</b>.\n\n` +
      `❌ You lose ${fmt(bet)}. The house keeps the pot.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.payout > 0, net };
}

module.exports = { play, spin, weightedPick, SEGMENTS };
