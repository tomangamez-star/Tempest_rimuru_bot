'use strict';
/**
 * Rimuru Tempest Casino — Dice Duel 🎲 (vs the house)
 * /duel [amount] — you and the bot each roll a d6; higher roll wins.
 * Ties go to the house (~55/45 edge). Win = 1.9x.
 */
const config = require('../config');
const { fmt, randInt } = require('../utils');
const rank = require('../rank');

/** Pure logic: { player, bot, result, payout }. Ties resolve toward the
 *  player's rank-tier win chance (peak hours = flat 50/50). */
function duel(bet, winChance = 0.5) {
  const player = randInt(1, 6);
  const bot = randInt(1, 6);
  let result;
  if (player > bot) result = 'player';
  else if (player < bot) result = 'bot';
  else result = Math.random() < winChance ? 'player' : 'bot';
  const payout = result === 'player' ? Math.floor(bet * 1.9) : 0;
  return { player, bot, result, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎲 Usage: `/duel [amount]` — e.g. `/duel 5000`. Higher roll wins (ties go to the house).');
  }
  const g = cd.guardGame(userId, 'duel', 'Dice Duel');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'duel');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'duel', config.perGameCooldownMs);

  const r = duel(bet, rank.getWinChance(userId, 'duel'));
  let net = -bet;
  let text;
  if (r.result === 'player') {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `You rolled <b>${r.player}</b> — the house rolled <b>${r.bot}</b>.\n\n✅ <b>YOU WIN!</b> Payout <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else if (r.player === r.bot) {
    text = `You rolled <b>${r.player}</b> — the house rolled <b>${r.bot}</b>.\n\n🤝 <b>TIE — house takes it.</b> Lost ${fmt(bet)}.`;
  } else {
    text = `You rolled <b>${r.player}</b> — the house rolled <b>${r.bot}</b>.\n\n❌ <b>HOUSE WINS.</b> Lost ${fmt(bet)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.result === 'player', net };
}

module.exports = { play, duel };