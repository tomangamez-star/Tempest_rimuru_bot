'use strict';
/**
 * Rimuru Tempest Casino — Coin Flip 🪙
 * /cf [heads|tails] [amount]. Win = double (bet + winnings → payout 2x bet).
 */
const config = require('../config');
const { fmt } = require('../utils');
const rank = require('../rank');

/** Pure logic: { flip, win, payout, bet }.
 *  `winChance` (player win odds) comes from the rank system; peak hours are
 *  flat 50/50, otherwise the rank tier applies. */
function flipCoin(bet, choice, winChance = 0.5) {
  const flip = Math.random() < winChance ? choice : (choice === 'heads' ? 'tails' : 'heads');
  const win = flip === choice;
  return { flip, win, payout: win ? bet * config.coinflip.mult : 0, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const choice = String(args[0] || '').toLowerCase();
  if (!['h', 't', 'heads', 'tails', 'head', 'tail'].includes(choice)) {
    return reply('🎩 Usage: `/cf [heads|tails] [amount]` — e.g. `/cf tails 5000`');
  }
  const norm = choice === 'h' || choice === 'heads' || choice === 'head' ? 'heads' : 'tails';
  const bet = parseBet(args[1], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'coinflip', 'Coin Flip');
  if (g.blocked) return reply(g.message);

  const charge = eco.chargeWallet(userId, bet.amount, 'flip');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'coinflip', config.perGameCooldownMs);

  const r = flipCoin(bet.amount, norm, rank.getWinChance(userId, 'coinflip'));
  let net = -bet.amount;
  let text;
  if (r.win) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet.amount;
    text = `🪙 The coin lands **${r.flip.toUpperCase()}**!\n\n✅ **DOUBLE!** You get ${fmt(r.payout)} (net +${fmt(net)}).`;
  } else {
    text = `🪙 The coin lands **${r.flip.toUpperCase()}**.\n\n❌ You picked ${norm}. Lost ${fmt(bet.amount)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.win, net };
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/cf [heads|tails] [amount]`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = { play, flipCoin, parseBet };