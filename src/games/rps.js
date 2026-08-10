'use strict';
/**
 * Rimuru Tempest Casino — Rock-Paper-Scissors ✊✋✌️
 * /rps [rock|paper|scissors] [amount] — play vs the house.
 * House edge: on a tie the player loses half the bet (~55/45).
 */
const config = require('../config');
const { fmt } = require('../utils');

const MOVES = ['rock', 'paper', 'scissors'];
const ALIASES = { r: 'rock', p: 'paper', s: 'scissors', rock: 'rock', paper: 'paper', scissors: 'scissors' };
const ICONS = { rock: '✊', paper: '✋', scissors: '✌️' };

/** Who wins? 'player' | 'house' | 'tie' */
function judge(player, house) {
  if (player === house) return 'tie';
  if ((player === 'rock' && house === 'scissors') ||
      (player === 'paper' && house === 'rock') ||
      (player === 'scissors' && house === 'paper')) return 'player';
  return 'house';
}

/** Pure logic: { player, house, result, payout } — tie pays half back. */
function playRps(player, bet) {
  const house = MOVES[Math.floor(Math.random() * 3)];
  const result = judge(player, house);
  let payout = 0;
  if (result === 'player') payout = Math.floor(bet * 1.9);   // ~95% of double (house keeps 5%)
  else if (result === 'tie') payout = Math.floor(bet * 0.5); // push pays half back
  return { player, house, result, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const move = String(args[0] || '').toLowerCase();
  const player = ALIASES[move];
  if (!player) {
    return reply('✊ Usage: `/rps [rock|paper|scissors] [amount]` — e.g. `/rps rock 5000`.');
  }
  const raw = String(args[1] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎯 Usage: `/rps [rock|paper|scissors] [amount]` — e.g. `/rps rock 5000`.');
  }
  const g = cd.guardGame(userId, 'rps', 'Rock Paper Scissors');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'match');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'rps', config.perGameCooldownMs);

  const r = playRps(player, bet);
  let net = -bet;
  let text;
  if (r.result === 'player') {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `${ICONS[r.player]} vs ${ICONS[r.house]} — <b>YOU WIN!</b>\n\n✅ Payout <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else if (r.result === 'tie') {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `${ICONS[r.player]} vs ${ICONS[r.house]} — <b>TIE.</b>\n\n↩️ Half your bet back: <b>${fmt(r.payout)}</b> (net ${fmt(net)}).`;
  } else {
    text = `${ICONS[r.player]} vs ${ICONS[r.house]} — <b>HOUSE WINS.</b>\n\n❌ Lost ${fmt(bet)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.result === 'player', net };
}

module.exports = { play, playRps, judge, MOVES };
