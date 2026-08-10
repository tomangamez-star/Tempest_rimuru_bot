'use strict';
/**
 * Rimuru Tempest Casino — Tic-Tac-Toe ⭕❌ (vs the house bot)
 * /ttt [amount] — best of 1. The bot plays randomly-ish with a small
 * advantage (it never misses a winning move, you might). Win = 1.8x,
 * tie = half back (~55/45 edge).
 */
const config = require('../config');
const { fmt } = require('../utils');

const EMPTY = '·';
const HUMAN = '❌';
const BOT = '⭕';

function emptyBoard() {
  return [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
}

function winnerOf(b) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, c, d] of lines) {
    if (b[a] !== EMPTY && b[a] === b[c] && b[c] === b[d]) return b[a];
  }
  return b.includes(EMPTY) ? null : 'tie';
}

/** Bot move: win if possible, block if threatened, else random. */
function botMove(b) {
  const empties = b.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
  for (const i of empties) {
    const t = b.slice(); t[i] = BOT;
    if (winnerOf(t) === BOT) return i;
  }
  for (const i of empties) {
    const t = b.slice(); t[i] = HUMAN;
    if (winnerOf(t) === HUMAN) return i;
  }
  return empties[Math.floor(Math.random() * empties.length)];
}

function boardText(b) {
  return `${b[0]} ${b[1]} ${b[2]}\n${b[3]} ${b[4]} ${b[5]}\n${b[6]} ${b[7]} ${b[8]}`;
}

/** Pure logic: { board, result, payout } — result: player|bot|tie. */
function playTtt(bet) {
  const b = emptyBoard();
  // Player moves first (center if free, else random), then bot.
  const first = 4;
  b[first] = HUMAN;
  while (true) {
    const w = winnerOf(b);
    if (w) break;
    const m = botMove(b);
    if (m === undefined) break;
    b[m] = BOT;
    const w2 = winnerOf(b);
    if (w2) break;
    const empties = b.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
    if (!empties.length) break;
    const hm = empties[Math.floor(Math.random() * empties.length)];
    b[hm] = HUMAN;
  }
  const result = winnerOf(b) === HUMAN ? 'player' : winnerOf(b) === BOT ? 'bot' : 'tie';
  let payout = 0;
  if (result === 'player') payout = Math.floor(bet * 1.8);
  else if (result === 'tie') payout = Math.floor(bet * 0.5);
  return { board: b, result, payout, bet };
}

async function play(ctx) {
  const { args, eco, cd, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('⭕ Usage: `/ttt [amount]` — e.g. `/ttt 5000`. Beat the house at tic-tac-toe!');
  }
  const g = cd.guardGame(userId, 'ttt', 'Tic-Tac-Toe');
  if (g.blocked) return reply(g.message);
  const charge = eco.chargeWallet(userId, bet, 'game');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'ttt', config.perGameCooldownMs);

  const r = playTtt(bet);
  let net = -bet;
  let text;
  if (r.result === 'player') {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `You beat the house!\n\n✅ Payout <b>${fmt(r.payout)}</b> (net +${fmt(net)}).`;
  } else if (r.result === 'tie') {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet;
    text = `A draw.\n\n↩️ Half back: <b>${fmt(r.payout)}</b> (net ${fmt(net)}).`;
  } else {
    text = `The house wins.\n\n❌ Lost ${fmt(bet)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`<pre>${boardText(r.board)}</pre>\n\n${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.result === 'player', net };
}

module.exports = { play, playTtt, botMove, winnerOf, boardText };
