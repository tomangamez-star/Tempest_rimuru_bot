'use strict';
/**
 * Rimuru Tempest Casino — Coin Flip Streak \ud83e\ude99\ud83d\udd25
 * /cfs [heads|tails] [amount] — predict flips; each correct flip doubles
 * the running payout. One wrong flip = lose the whole bet (55/45 edge:
 * expected multiplier \u2248 0.9 even though it feels like 2x per round).
 */
const config = require('../config');
const { fmt } = require('../utils');
const rank = require('../rank');

/** Simulate the streak: how many correct flips before a miss.
 *  Capped at MAX_STREAK_WINS so bet * 2^wins can never overflow a
 *  Postgres/SQLite integer column (that overflow was the root cause
 *  of the /cf /cfs "postgres disconnect" bug — an uncapped streak
 *  could occasionally produce a payout too large for the DB, which
 *  choked the write pipeline into degraded/maintenance mode).
 */
const MAX_STREAK_WINS = 20; // bet * 2^20 (~1,048,576x) is already a huge win; plenty of headroom under any INTEGER/BIGINT column
function streak(choice, winChance = 0.5) {
  let wins = 0;
  while (wins < MAX_STREAK_WINS) {
    const flip = Math.random() < winChance ? choice : (choice === 'heads' ? 'tails' : 'heads');
    if (flip === choice) wins++;
    else break;
  }
  return { wins };
}

/** Pure logic: { wins, payout } — payout = bet × 2^wins. */
const MAX_PAYOUT = 5_000_000_000; // hard ceiling regardless of bet size — protects the DB even if config.js maxBet is ever raised
function playStreak(bet, choice, winChance = 0.5) {
  const { wins } = streak(choice, winChance);
  const payout = wins > 0 ? Math.min(Math.floor(bet * Math.pow(2, wins)), MAX_PAYOUT) : 0;
  return { wins, payout, bet, choice };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const choice = String(args[0] || '').toLowerCase();
  if (!['h', 't', 'heads', 'tails', 'head', 'tail'].includes(choice)) {
    return reply('\ud83e\ude99 Usage: `/cfs [heads|tails] [amount]` \u2014 e.g. `/cfs tails 5000`. Ride a streak of correct flips!');
  }
  const norm = choice === 'h' || choice === 'heads' || choice === 'head' ? 'heads' : 'tails';
  const raw = String(args[1] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('\ud83c\udfaf Usage: `/cfs [heads|tails] [amount]` \u2014 e.g. `/cfs tails 5000`.');
  }
  const g = cd.guardGame(userId, 'cfs', 'Coin Flip Streak');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'streak');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'cfs', config.perGameCooldownMs);

  const r = playStreak(bet, norm, rank.getWinChance(userId, 'cfs'));
  let net = -bet;
  let text;
  if (r.wins > 0) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `\ud83e\ude99 <b>${r.wins} STREAK${r.wins > 1 ? 'S' : ''}!</b>\n\n` +
      `You called <b>${norm}</b> and nailed ${r.wins} flip${r.wins > 1 ? 's' : ''} in a row before a miss.\n` +
      `\u2705 Payout <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else {
    text = `\ud83e\ude99 The very first flip missed your call.\n\n\u274c Lost ${fmt(bet)}. The streak ends before it begins.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n\ud83d\udc5b Wallet: ${fmt(wallet)}`);
  return { won: r.wins > 0, net, bet };
}

module.exports = { play, playStreak, streak };