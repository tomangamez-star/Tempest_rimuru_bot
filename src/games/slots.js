'use strict';
/**
 * Rimuru Tempest Casino — Slots 🎰
 * 3 reels. 2 match = 2x bet, 3 match = 4x bet. House edge 55/45.
 */
const config = require('../config');
const { pick, fmt } = require('../utils');

/**
 * Pure logic — returns result object.
 * @returns {{win:boolean, reels:string[], mult:number, payout:number, bet:number}}
 */
function spin(bet) {
  const items = config.slots.items;
  const reels = [pick(items), pick(items), pick(items)];
  const [a, b, c] = reels;
  let mult = 0;
  if (a === b && b === c) mult = config.slots.threeMatchMult;
  else if (a === b || a === c || b === c) mult = config.slots.twoMatchMult;
  else if (Math.random() < 0.55) mult = 0; // house edge on no-match
  const payout = mult > 0 ? bet * mult : 0;
  return { win: payout > 0, reels, mult, payout, bet };
}

/**
 * Telegram handler. ctx: { bot, msg, args, eco, cd, chatId, userId, reply }
 */
async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return ctx.reply(bet.error);

  const g = cd.guard(userId, 'game', 'Gambling');
  if (g.blocked) return ctx.reply(g.message);

  const charge = eco.chargeWallet(userId, bet.amount, 'spin');
  if (!charge.ok) return ctx.reply(charge.message);

  cd.start(userId, 'game', config.cooldowns.game);
  const r = spin(bet.amount);
  let net = -bet.amount;
  let text;
  if (r.win) {
    eco.creditWallet(userId, r.payout);
    net = r.payout - bet.amount;
    text = `🎰 ${r.reels.join(' | ')}\n\n✅ **YOU WIN!** ${r.mult}x — you get ${fmt(r.payout)} back (net +${fmt(net)}).`;
  } else {
    text = `🎰 ${r.reels.join(' | ')}\n\n❌ No luck, mortal. You lost ${fmt(bet.amount)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  ctx.reply(`${text}\n👛 Wallet: ${fmt(wallet)}`, { parse_mode: 'Markdown' });
  return { won: r.win, net };
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/slots [amount]` — e.g. `/slots 5000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = { play, spin, parseBet };
