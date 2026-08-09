'use strict';
/**
 * Rimuru Tempest Casino — Roulette 🎡
 * Standard European roulette (0-36). Bets:
 *   color [red|black] — 2x
 *   parity [even|odd] — 2x
 *   half [1-18|19-36] — 2x
 *   dozen [1st|2nd|3rd] — 3x
 *   column [1st|2nd|3rd] — 3x
 *   straight [0-36] — 36x
 *   split [a,b] — 18x
 */
const config = require('../config');
const { fmt } = require('../utils');

const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACKS = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

function colorOf(n) {
  if (n === 0) return 'green';
  return REDS.has(n) ? 'red' : 'black';
}

function dozenOf(n) {
  if (n === 0) return null;
  return Math.ceil(n / 12);
}

function columnOf(n) {
  if (n === 0) return null;
  return ((n - 1) % 3) + 1;
}

/** Pure logic: { number, color, win, payout, bet } */
function spin(bet, type, value) {
  const n = Math.floor(Math.random() * 37);
  let win = false;
  let mult = 0;

  switch (type) {
    case 'color': {
      mult = config.roulette.colorMult;
      win = value === 'red' ? REDS.has(n) : value === 'black' ? BLACKS.has(n) : false;
      break;
    }
    case 'parity': {
      if (n === 0) break;
      mult = config.roulette.parityMult;
      win = value === 'even' ? n % 2 === 0 : value === 'odd' ? n % 2 === 1 : false;
      break;
    }
    case 'half': {
      if (n === 0) break;
      mult = config.roulette.halfMult;
      win = value === 'low' ? n <= 18 : value === 'high' ? n >= 19 : false;
      break;
    }
    case 'dozen': {
      mult = config.roulette.dozenMult;
      const d = dozenOf(n);
      win = d === parseInt(value, 10);
      break;
    }
    case 'column': {
      mult = config.roulette.columnMult;
      const c = columnOf(n);
      win = c === parseInt(value, 10);
      break;
    }
    case 'straight': {
      mult = config.roulette.straightMult;
      win = n === parseInt(value, 10);
      break;
    }
    case 'split': {
      mult = config.roulette.splitMult;
      const pair = String(value).split(/[,|]/).map(Number);
      win = pair.includes(n);
      break;
    }
    default:
      break;
  }

  const payout = win ? bet * mult : 0;
  return { number: n, color: colorOf(n), win, payout, bet };
}

const TYPE_HELP = {
  color: '`/roulette color red 5000` (red|black, 2x)',
  parity: '`/roulette even 5000` (even|odd, 2x)',
  half: '`/roulette high 5000` (low=1-18|high=19-36, 2x)',
  dozen: '`/roulette dozen 2 5000` (1st|2nd|3rd, 3x)',
  column: '`/roulette column 3 5000` (1st|2nd|3rd, 3x)',
  straight: '`/roulette straight 7 5000` (0-36, 36x)',
  split: '`/roulette split 7,8 5000` (two adjacent numbers, 18x)',
};

function parseBet(ctx) {
  const { args } = ctx;
  const last = args[args.length - 1];
  const amt = Number(String(last || '').replace(/,/g, ''));
  if (!last || !Number.isFinite(amt) || amt <= 0) return { error: null };
  const rest = args.slice(0, -1).join(' ').trim();
  const pieces = rest.split(/\s+/);
  return { amount: Math.floor(amt), pieces };
}

async function play(ctx) {
  const { eco, cd, userId, reply } = ctx;
  const parsed = parseBet(ctx);
  const p = parsed.pieces || [];
  let type;
  let value;

  if (p.length === 1) {
    const w = p[0].toLowerCase();
    if (['red', 'black'].includes(w)) { type = 'color'; value = w; }
    else if (['even', 'odd'].includes(w)) { type = 'parity'; value = w; }
    else if (['low', 'high'].includes(w)) { type = 'half'; value = w; }
    else {
      return reply(`🎩 Usage:\n${Object.values(TYPE_HELP).join('\n')}`);
    }
  } else if (p.length === 2) {
    const w = p[0].toLowerCase();
    if (w === 'dozen' && ['1', '2', '3'].includes(p[1])) { type = 'dozen'; value = p[1]; }
    else if (w === 'column' && ['1', '2', '3'].includes(p[1])) { type = 'column'; value = p[1]; }
    else if (w === 'straight' && Number.isInteger(Number(p[1])) && Number(p[1]) >= 0 && Number(p[1]) <= 36) { type = 'straight'; value = p[1]; }
    else if (w === 'split') {
      const pair = p[1].split(/[,|]/).map(Number);
      if (pair.length === 2 && pair.every((x) => Number.isInteger(x) && x >= 0 && x <= 36)) { type = 'split'; value = pair.join(','); }
      else return reply(`🎩 Usage: \`/roulette split 7,8 5000\``);
    } else {
      return reply(`🎩 Usage:\n${Object.values(TYPE_HELP).join('\n')}`);
    }
  } else {
    return reply(`🎩 Usage:\n${Object.values(TYPE_HELP).join('\n')}`);
  }

  if (!parsed.amount) {
    return reply(`🎩 Add an amount! e.g. \`/roulette ${p.join(' ')} 5000\``);
  }

  const g = cd.guardGame(userId, 'roulette', 'Roulette');
  if (g.blocked) return reply(g.message);

  const charge = eco.chargeWallet(userId, parsed.amount, 'roulette bet');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'roulette', config.perGameCooldownMs);

  const r = spin(parsed.amount, type, value);
  let net = -parsed.amount;
  let text;
  if (r.win) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - parsed.amount;
    text = `🎡 The ball lands on **${r.number} ${r.color}**!\n\n✅ **WIN!** ${config.roulette[`${type}Mult`]}x — you get ${fmt(r.payout)} (net +${fmt(net)}).`;
  } else {
    text = `🎡 The ball lands on **${r.number} ${r.color}**.\n\n❌ Lost ${fmt(parsed.amount)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: r.win, net };
}

module.exports = { play, spin, colorOf, REDS, BLACKS, TYPE_HELP };