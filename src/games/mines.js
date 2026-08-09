'use strict';
/**
 * Rimuru Tempest Casino — Mines 💣
 * 5×5 grid, 3 mines placed randomly. Inline-button grid (blue = unrevealed).
 * Safe pick → tile turns green 💎, multiplier climbs (1.25x → 1.50x → ...).
 * "Cash out" button always visible → claim winnings. Hit a mine → lose everything.
 *
 * Callback payload format: mines:<userId>:<action>:<data>
 *   action: pick:<index> | cash
 */
const config = require('../config');
const { fmt, shuffle, randInt } = require('../utils');

// In-memory game sessions (SQLite would be overkill; resets on restart are fine)
const sessions = new Map();

function createSession(userId, bet) {
  // Place 3 mines on 25 cells
  const cells = Array.from({ length: 25 }, (_, i) => i);
  const mines = new Set(shuffle(cells).slice(0, config.mines.mineCount));
  const s = {
    userId,
    bet,
    mines,
    revealed: new Set(),
    cashout: 0,
    alive: true,
    startedAt: Date.now(),
  };
  sessions.set(userId, s);
  return s;
}

/** Multiplier for the NEXT pick based on current safe picks. */
function nextMult(s) {
  const idx = s.revealed.size;
  const m = config.mines.multipliers;
  return m[Math.min(idx, m.length - 1)];
}

function currentWorth(s) {
  return Math.floor(s.bet * nextMult(s));
}

function buildBoard(s, gameOver = false) {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      if (s.revealed.has(i)) {
        row.push('💎');
      } else if (gameOver && s.mines.has(i)) {
        row.push('💣');
      } else {
        row.push('🟦');
      }
    }
    rows.push(row.join(''));
  }
  return rows.join('\n');
}

function buildKeyboard(s, gameOver = false) {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const rowBtns = [];
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      const revealed = s.revealed.has(i);
      const isMine = s.mines.has(i);
      let text = '🟦';
      if (revealed) text = '💎';
      else if (gameOver && isMine) text = '💣';
      rowBtns.push({ text, callback_data: `mines:${s.userId}:pick:${i}` });
    }
    rows.push(rowBtns);
  }
  rows.push([{ text: `💰 Cash out ${fmt(currentWorth(s))}`, callback_data: `mines:${s.userId}:cash` }]);
  return { inline_keyboard: rows };
}

function statusText(s, gameOver = false) {
  const mult = nextMult(s);
  return (
    `💣 **MINES** — bet ${fmt(s.bet)}\n\n` +
    buildBoard(s, gameOver) +
    `\n\n💎 Safe picks: ${s.revealed.size}/22 | Next pick: **${mult.toFixed(2)}x**\n` +
    `💵 Cash out now: **${fmt(currentWorth(s))}**`
  );
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guard(userId, 'game', 'Gambling');
  if (g.blocked) return reply(g.message);

  const existing = sessions.get(userId);
  if (existing && existing.alive) {
    return reply('⏳ You already have a mines game running. Finish it or cash out first.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'mines round');
  if (!charge.ok) return reply(charge.message);
  cd.start(userId, 'game', config.cooldowns.game);

  const s = createSession(userId, bet.amount);
  const sent = await bot.sendMessage(chatId, statusText(s), {
    parse_mode: 'Markdown',
    reply_markup: buildKeyboard(s),
  });
  return { sent, session: s };
}

/** Handle mines:<uid>:pick:<i> callback */
async function onPick(ctx, { bot, chatId, userId, reply, editMsg, callbackId, answerCb }) {
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active mines game.');
    return;
  }
  const idx = parseInt(ctx.data.split(':')[3], 10);
  if (s.revealed.has(idx)) {
    await answerCb('Already revealed!');
    return;
  }
  if (s.mines.has(idx)) {
    // 💥 BOOM — lose everything (initial bet already charged)
    s.alive = false;
    await editMsg(statusText(s, true), { parse_mode: 'Markdown' });
    await answerCb('💥 BOOM! You hit a mine.');
    await bot.sendMessage(chatId, `💥 **BOOM!** You hit a mine and lost everything — including your ${fmt(s.bet)} bet.\n👛 Wallet: ${fmt(eco.balance(userId).wallet)}`, { parse_mode: 'Markdown' });
    sessions.delete(userId);
    return;
  }
  s.revealed.add(idx);
  if (s.revealed.size === 22) {
    // All safe cells found — auto cash out
    s.alive = false;
    const winnings = currentWorth(s);
    eco.creditWallet(userId, winnings);
    await editMsg(statusText(s, true), { parse_mode: 'Markdown' });
    await answerCb(`💎 All safe cells! +${fmt(winnings)}`);
    await bot.sendMessage(chatId, `🏆 **PERFECT CLEAR!** You found all 22 safe cells.\n💰 Won ${fmt(winnings)} (net +${fmt(winnings - s.bet)})\n👛 Wallet: ${fmt(eco.balance(userId).wallet)}`, { parse_mode: 'Markdown' });
    sessions.delete(userId);
    return;
  }
  await editMsg(statusText(s), { parse_mode: 'Markdown', reply_markup: buildKeyboard(s) });
  await answerCb(`💎 Safe! Multiplier now ${nextMult(s).toFixed(2)}x`);
}

/** Handle mines:<uid>:cash callback */
async function onCash(ctx, { bot, chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active mines game.');
    return;
  }
  const winnings = currentWorth(s);
  s.alive = false;
  eco.creditWallet(userId, winnings);
  await editMsg(`${statusText(s)}\n\n✅ **CASHED OUT** ${fmt(winnings)} (net +${fmt(winnings - s.bet)})`, { parse_mode: 'Markdown' });
  await answerCb(`💰 Cashed out ${fmt(winnings)}`);
  sessions.delete(userId);
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/mines [amount]` — e.g. `/mines 5000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = {
  play,
  onPick,
  onCash,
  createSession,
  nextMult,
  currentWorth,
  buildBoard,
  parseBet,
  sessions,
};
