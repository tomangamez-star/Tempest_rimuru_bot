'use strict';
/**
 * Rimuru Tempest Casino — Race 🏁
 * Bet on a car color. Four cars race; positions decide the payout:
 *   1st place → 3x bet   (high)
 *   2nd place → 1.5x bet (less)
 *   3rd/4th   → 0        (nothing)
 *
 * Flow:
 *   /race [amount] → inline color buttons (Red/Blue/Green/Yellow) →
 *   pick a color → the race runs instantly → result message with payout.
 *
 * Callback payload: race:<userId>:<color>   (color = red|blue|green|yellow)
 * The inline color buttons are GAMEPLAY and ALWAYS show (never gated).
 */
const config = require('../config');
const { fmt, shuffle, pick, randInt } = require('../utils');
const rank = require('../rank');

// In-memory pending bets: userId -> { bet, color? } (color set when picked)
const sessions = new Map();

const CARS = [
  { key: 'red', label: '🔴 Red', emoji: '🏎️' },
  { key: 'blue', label: '🔵 Blue', emoji: '🏎️' },
  { key: 'green', label: '🟢 Green', emoji: '🏎️' },
  { key: 'yellow', label: '🟡 Yellow', emoji: '🏎️' },
];

// Payout multiplier per finishing position (index 0 = 1st place)
const POSITION_MULT = [3.0, 1.5, 0, 0];

/** Build the inline color-selection keyboard (always shown). */
function colorKeyboard(userId) {
  return {
    inline_keyboard: [
      CARS.slice(0, 2).map((c) => ({ text: c.label, callback_data: `race:${userId}:${c.key}` })),
      CARS.slice(2).map((c) => ({ text: c.label, callback_data: `race:${userId}:${c.key}` })),
    ],
  };
}

/**
 * Run a race: shuffle the 4 cars into a finishing order, return the
 * ranked list [{key,label,place}] (place 1..4). `winChance` is the player's
 * rank-tier win odds — it biases the player's car toward a top-2 finish
 * (0.5 = fair 2/4 chance, higher = better odds, lower = whale tax).
 */
function runRace(winChance = 0.5, pickedColor = null) {
  let order = shuffle(CARS.slice());
  if (pickedColor) {
    // Fair top-2 chance for a 4-car race is 0.5; scale from the rank odds.
    const top2 = 0.5 + (winChance - 0.5) * 0.4; // ±20% at the extremes
    if (Math.random() < top2) {
      const mine = CARS.find((c) => c.key === pickedColor);
      order = order.filter((c) => c.key !== pickedColor);
      order.splice(Math.random() < 0.5 ? 0 : 1, 0, mine);
    }
  }
  return order.map((car, i) => ({ ...car, place: i + 1 }));
}

/** Payout for a car finishing at `place` (1-4). */
function payoutFor(place) {
  const mult = POSITION_MULT[Math.min(Math.max(place - 1, 0), POSITION_MULT.length - 1)];
  return mult;
}

/** Render the finishing board for the result message (HTML). */
function renderBoard(ranked) {
  const medals = ['🥇', '🥈', '🥉', '4️⃣'];
  return ranked
    .map((car) => `${medals[car.place - 1]} ${car.label} — ${car.place === 1 ? '1st' : car.place === 2 ? '2nd' : car.place === 3 ? '3rd' : '4th'}`)
    .join('\n');
}

async function play(ctx) {
  const { msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'race', 'Race');
  if (g.blocked) return reply(g.message);

  if (sessions.has(userId)) {
    return reply('🏁 You already have a race pending. Pick a car color or wait for it to finish.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'race bet');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'race', config.perGameCooldownMs);

  sessions.set(userId, { bet: bet.amount, color: null });

  // Inline color buttons = gameplay, ALWAYS shown (not gated by
  // SHOW_INLINE_BUTTONS — the race is unplayable without them).
  return reply(
    `🏁 <b>RACE</b> — bet ${fmt(bet.amount)}\n\n` +
      `Pick your car color. The flag drops the moment you choose!\n\n` +
      `💰 Payouts: <b>1st = 3x</b> · <b>2nd = 1.5x</b> · 3rd/4th = 0`,
    { html: true, reply_markup: colorKeyboard(userId) }
  );
}

/** Handle race:<userId>:<color> callback — run the race instantly. */
async function onPick(ctx, { bot, chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || s.color !== null) {
    await answerCb('No pending race bet.');
    return;
  }
  const color = String(ctx.data.split(':')[2] || '').toLowerCase();
  if (!CARS.some((c) => c.key === color)) {
    await answerCb('Unknown color.');
    return;
  }
  const car = CARS.find((c) => c.key === color);
  s.color = color;

  const ranked = runRace(rank.getWinChance(userId, 'race'), color);
  const mine = ranked.find((c) => c.key === color);
  const mult = payoutFor(mine.place);
  const winnings = Math.floor(s.bet * mult);
  const net = winnings - s.bet;
  const won = mult > 0;

  if (won) eco.creditWallet(userId, winnings);
  rank.recordMatchResult(userId, s.bet, won);

  const lines = [
    `🏁 <b>RACE RESULT</b> — you bet ${fmt(s.bet)} on ${car.label}\n\n`,
    renderBoard(ranked) + '\n\n',
  ];
  if (won) {
    lines.push(`🎉 Your car finished <b>${mine.place === 1 ? '1st 🥇' : '2nd 🥈'}</b>!`);
    lines.push(`💰 Won <b>${fmt(winnings)}</b> (${mult.toFixed(1)}x — net +${fmt(net)})`);
  } else {
    lines.push(`💨 Your car finished <b>${mine.place === 1 ? '1st 🥇' : mine.place === 2 ? '2nd 🥈' : mine.place === 3 ? '3rd 🥉' : '4th'}</b> — no payout.`);
    lines.push(`💸 You lost your ${fmt(s.bet)} bet.`);
  }
  lines.push(`\n👛 Wallet: ${fmt(eco.balance(userId).wallet)}`);

  await editMsg(lines.join(''), { parse_mode: 'HTML' });
  await answerCb(won ? `🏆 +${fmt(net)}` : '💸 Lost');
  sessions.delete(userId);
  return { ranked, won, winnings, net };
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🏁 Usage: `/race [amount]` — e.g. `/race 5000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = {
  play,
  onPick,
  runRace,
  payoutFor,
  renderBoard,
  parseBet,
  CARS,
  POSITION_MULT,
  sessions,
};
