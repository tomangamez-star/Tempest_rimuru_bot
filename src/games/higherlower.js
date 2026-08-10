'use strict';
/**
 * Rimuru Tempest Casino — Higher or Lower ♠
 * Guess if the next card is higher or lower (buttons).
 * Streak multiplier climbs with each correct guess; cash out anytime.
 * Wrong guess = bust (lose initial bet + accumulated winnings).
 *
 * Callback: hl:<userId>:<action>  (high | low | cash)
 */
const config = require('../config');
const { fmt, shuffle, esc } = require('../utils');

const sessions = new Map();

const STREAK_MULT = [1.0, 1.2, 1.44, 1.73, 2.07, 2.49, 2.99, 3.58, 4.30, 5.16, 6.19, 7.43, 8.92, 10.70, 12.84];

function makeDeck() {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const suits = ['♠', '♥', '♦', '♣'];
  const deck = [];
  for (const r of ranks) for (const s of suits) deck.push({ rank: r, suit: s });
  return shuffle(deck);
}

function rankValue(card) {
  const map = { J: 11, Q: 12, K: 13, A: 14 };
  return map[card.rank] || parseInt(card.rank, 10);
}

function cardStr(card) {
  return `${card.rank}${card.suit}`;
}

function createSession(userId, bet) {
  const deck = makeDeck();
  const current = deck.pop();
  const s = { userId, bet, deck, current, streak: 0, alive: true, won: 0 };
  sessions.set(userId, s);
  return s;
}

function currentPayout(s) {
  const mult = STREAK_MULT[Math.min(s.streak, STREAK_MULT.length - 1)];
  return Math.floor(s.bet * mult);
}

function render(s) {
  return (
    `♠ <b>HIGHER OR LOWER</b> — bet ${fmt(s.bet)}\n\n` +
    `Current card: <b>${esc(cardStr(s.current))}</b>\n` +
    `Streak: <b>${s.streak}</b> | Payout now: <b>${fmt(currentPayout(s))}</b>`
  );
}

function keyboard(s) {
  return {
    inline_keyboard: [[
      { text: '⬆️ Higher', callback_data: `hl:${s.userId}:high` },
      { text: '⬇️ Lower', callback_data: `hl:${s.userId}:low` },
      { text: `💰 Cash out ${fmt(currentPayout(s))}`, callback_data: `hl:${s.userId}:cash` },
    ]],
  };
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'higherlower', 'Higher or Lower');
  if (g.blocked) return reply(g.message);

  if (sessions.has(userId)) {
    return reply('⏳ You already have a higher/lower game running. Cash out or bust first.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'round');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'higherlower', config.perGameCooldownMs);

  const s = createSession(userId, bet.amount);
  const sent = await reply(render(s), { html: true, reply_markup: keyboard(s), alwaysShowMarkup: true });
  return { sent, session: s };
}

async function onAction(ctx, { bot, chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active higher/lower game.');
    return;
  }
  const action = ctx.data.split(':')[2];

  if (action === 'cash') {
    const winnings = currentPayout(s);
    s.alive = false;
    eco.creditWallet(userId, winnings);
    await editMsg(`${render(s)}\n\n✅ <b>CASHED OUT</b> ${fmt(winnings)} (net +${fmt(winnings - s.bet)})`, { parse_mode: 'HTML' });
    await answerCb(`💰 Cashed out ${fmt(winnings)}`);
    sessions.delete(userId);
    return;
  }

  // high / low guess
  const guessHigher = action === 'high';
  const next = s.deck.pop();
  const curVal = rankValue(s.current);
  const nextVal = rankValue(next);
  let correct;
  if (nextVal === curVal) {
    correct = true; // ties count as a win (friendly rule)
  } else {
    correct = guessHigher ? nextVal > curVal : nextVal < curVal;
  }

  if (correct) {
    s.streak++;
    s.current = next;
    const text = `${render(s)}\n\n✅ Correct! Next card was <b>${esc(cardStr(next))}</b>.`;
    // alwaysShowMarkup: Higher/Lower/Cash-out are GAMEPLAY buttons — they
    // must render even when SHOW_INLINE_BUTTONS=false (fixes "no button").
    await editMsg(text, { parse_mode: 'HTML', reply_markup: keyboard(s), alwaysShowMarkup: true });
    await answerCb(`✅ Streak ${s.streak}`);
  } else {
    // Bust — lose initial bet + accumulated
    s.alive = false;
    const text = `${render(s)}\n\n❌ <b>BUST!</b> Next card was <b>${esc(cardStr(next))}</b>. You lost ${fmt(s.bet)}.`;
    await editMsg(text, { parse_mode: 'HTML' });
    await answerCb('❌ Wrong guess!');
    sessions.delete(userId);
  }
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/hl [amount]` — e.g. `/hl 5000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = { play, onAction, createSession, rankValue, cardStr, STREAK_MULT, sessions };