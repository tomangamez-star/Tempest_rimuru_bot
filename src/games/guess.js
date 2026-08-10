'use strict';
/**
 * Rimuru Tempest Casino — Guess the Number 🔢
 * /guess [amount] — pick a number 1-10. ONE correct answer.
 * You get 3 chances:
 *   1st correct guess → bet ×5
 *   2nd correct guess → bet ×3
 *   3rd (last) correct → bet ×2
 * After each wrong guess Rimuru hints "higher than X" / "lower than X".
 * All 3 chances used without a hit → lose the whole bet.
 *
 * Callback payload: guess:<userId>:pick:<n>   (n = 1..10)
 * The 1-10 inline buttons are GAMEPLAY — they ALWAYS show (never gated).
 */
const config = require('../config');
const { fmt, randInt } = require('../utils');

// In-memory game sessions (same pattern as mines/blackjack)
const sessions = new Map();

// Payout multiplier by which correct guess it is (1st/2nd/3rd)
const GUESS_MULT = [5, 3, 2];
const MAX_CHANCES = 3;

function createSession(userId, bet) {
  const s = {
    userId,
    bet,
    answer: randInt(1, 10),
    chancesLeft: MAX_CHANCES,
    guesses: [],        // numbers already picked (buttons disabled)
    done: false,
    won: false,
    startedAt: Date.now(),
  };
  sessions.set(userId, s);
  return s;
}

/** Payout multiplier for the CURRENT chance (1st remaining = 5x, then 3x, 2x). */
function multFor(s) {
  // chancesLeft=3 → 5x (first), 2 → 3x, 1 → 2x
  return GUESS_MULT[MAX_CHANCES - s.chancesLeft];
}

/** Build the 1-10 inline keyboard. Used buttons are disabled-ish (plain 1️⃣2️⃣…🔟 text). */
function keyboard(s, gameOver = false) {
  const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const rows = [];
  for (let i = 0; i < 10; i += 5) {
    const row = [];
    for (let j = i; j < i + 5; j++) {
      const n = j + 1;
      // A number that was already guessed still renders as a dead button
      // (Telegram greys used buttons out); the game code rejects re-picks.
      row.push({ text: nums[j], callback_data: `guess:${s.userId}:pick:${n}` });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function statusText(s, hint = '') {
  const mult = multFor(s);
  return (
    `🔢 <b>GUESS THE NUMBER</b> — bet ${fmt(s.bet)}\n\n` +
    `I'm thinking of a number between <b>1</b> and <b>10</b>.\n` +
    `Chances left: <b>${'❤️'.repeat(s.chancesLeft)}${'🖤'.repeat(MAX_CHANCES - s.chancesLeft)}</b>\n` +
    `Current payout if you hit now: <b>${mult}x</b> (${fmt(s.bet * mult)})\n` +
    (hint ? `\n${hint}` : '')
  );
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'guess', 'Guess the Number');
  if (g.blocked) return reply(g.message);

  const existing = sessions.get(userId);
  if (existing && !existing.done) {
    return reply('⏳ You already have a guess game running. Finish it first.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'guess round');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'guess', config.perGameCooldownMs);

  const s = createSession(userId, bet.amount);
  // alwaysShowMarkup: the 1-10 grid is GAMEPLAY — must render even when
  // SHOW_INLINE_BUTTONS=false (same rule as mines/race).
  const sent = await reply(statusText(s), { html: true, reply_markup: keyboard(s), alwaysShowMarkup: true });
  return { sent, session: s };
}

/** Handle guess:<uid>:pick:<n> callback */
async function onPick(ctx, { bot, chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || s.done) {
    await answerCb('No active guess game.');
    return;
  }
  const n = parseInt(ctx.data.split(':')[3], 10);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    await answerCb('Invalid pick.');
    return;
  }
  if (s.guesses.includes(n)) {
    await answerCb('Already picked that one!');
    return;
  }
  s.guesses.push(n);

  if (n === s.answer) {
    // ✅ Correct — pay out at the current multiplier
    s.done = true;
    s.won = true;
    const mult = multFor(s);
    const payout = s.bet * mult;
    eco.creditWallet(userId, payout);
    const net = payout - s.bet;
    const guessWord = { 1: 'first', 2: 'second', 3: 'last' }[s.chancesLeft];
    const text =
      `${statusText(s)}\n\n` +
      `🎉 <b>CORRECT! The number was ${s.answer}!</b>\n` +
      `You nailed it on the <b>${guessWord} try</b> — <b>${mult}x</b> payout!\n` +
      `💰 Won <b>${fmt(payout)}</b> (net <b>+${fmt(net)}</b>)\n` +
      `👛 Wallet: ${fmt(eco.balance(userId).wallet)}`;
    // Game over — buttons replaced with a dead grid so nothing is clickable.
    await editMsg(text, { parse_mode: 'HTML', reply_markup: keyboard(s, true), alwaysShowMarkup: true });
    await answerCb(`🎉 Correct! +${fmt(payout)}`);
    sessions.delete(userId);
    return;
  }

  // ❌ Wrong — consume a chance and give a higher/lower hint
  s.chancesLeft--;
  const hint =
    s.answer > n
      ? `📈 <b>The number is HIGHER than ${n}.</b>`
      : `📉 <b>The number is LOWER than ${n}.</b>`;

  if (s.chancesLeft <= 0) {
    s.done = true;
    s.won = false;
    const text =
      `${statusText(s, hint)}\n\n` +
      `💥 <b>GAME OVER.</b> The number was <b>${s.answer}</b>.\n` +
      `You're out of chances — the whole bet of <b>${fmt(s.bet)}</b> is gone.\n` +
      `👛 Wallet: ${fmt(eco.balance(userId).wallet)}`;
    await editMsg(text, { parse_mode: 'HTML', reply_markup: keyboard(s, true), alwaysShowMarkup: true });
    await answerCb('💥 Out of chances!');
    sessions.delete(userId);
    return;
  }

  // Still alive — update board with the hint, buttons for unused numbers
  await editMsg(statusText(s, hint), { parse_mode: 'HTML', reply_markup: keyboard(s), alwaysShowMarkup: true });
  await answerCb(`❌ Not ${n} — ${s.answer > n ? 'higher' : 'lower'}!`);
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎯 Usage: `/guess [amount]` — e.g. `/guess 10000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = {
  play,
  onPick,
  createSession,
  multFor,
  GUESS_MULT,
  MAX_CHANCES,
  parseBet,
  sessions,
};
