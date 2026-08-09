'use strict';
/**
 * Rimuru Tempest Casino — Dice 🎲
 * /dice [number 1-6] [amount] — uses Telegram's animated dice.
 * Pick a number, if it hits = bet x6 (rare / hard to win).
 * Falls back to a simulated roll when sendDice isn't available.
 */
const config = require('../config');
const { fmt } = require('../utils');

/** Pure logic: returns { rolled, win, payout, bet } */
function roll(bet, picked) {
  const rolled = Math.floor(Math.random() * 6) + 1;
  const win = rolled === picked;
  return { rolled, win, payout: win ? bet * config.dice.mult : 0, bet };
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const picked = parseInt(args[0], 10);
  const bet = parseBet(args[1], eco, userId);
  if (bet.error) return reply(bet.error);
  if (![1, 2, 3, 4, 5, 6].includes(picked)) {
    return reply('🎩 Usage: `/dice [1-6] [amount]` — e.g. `/dice 5 2000`');
  }

  const g = cd.guardGame(userId, 'dice', 'Dice');
  if (g.blocked) return reply(g.message);

  const charge = eco.chargeWallet(userId, bet.amount, 'dice roll');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'dice', config.perGameCooldownMs);

  let rolled = null;
  try {
    const diceMsg = await bot.sendDice(chatId, { emoji: '🎲' });
    rolled = diceMsg.dice.value;
  } catch (e) {
    // Fallback: simulated roll
    rolled = Math.floor(Math.random() * 6) + 1;
  }

  const r = roll(bet.amount, picked);
  const actual = rolled ?? r.rolled;
  const win = actual === picked;
  let net = -bet.amount;
  let text;
  if (win) {
    const payout = bet.amount * config.dice.mult;
    eco.creditWallet(userId, payout);
    net = payout - bet.amount;
    text = `🎲 You picked **${picked}**… the dice shows **${actual}**!\n\n✅ **JACKPOT!** ${config.dice.mult}x — you get ${fmt(payout)} (net +${fmt(net)}).`;
  } else {
    text = `🎲 You picked **${picked}**… the dice shows **${actual}**.\n\n❌ Missed. Lost ${fmt(bet.amount)}.`;
  }
  const wallet = eco.balance(userId).wallet;
  reply(`${text}\n👛 Wallet: ${fmt(wallet)}`);
  return { won: win, net };
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/dice [1-6] [amount]`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = { play, roll, parseBet };