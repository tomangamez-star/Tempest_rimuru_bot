'use strict';
/**
 * Rimuru Tempest Casino — Crash 💥
 * /crash [amount] — a LIVE multiplier rocket.
 *
 * The multiplier climbs in real time and the message keeps updating. The
 * crash point is chosen by the house up front (the longer you hold, the
 * likelier it crashes). The bot NEVER auto-cashes-out: the USER decides by
 * pressing the 💰 CASHOUT button under the live message.
 *
 * Callback payload: crash:<userId>:cash
 */
const config = require('../config');
const { fmt } = require('../utils');
const rank = require('../rank');

// In-memory live sessions (ephemeral — resets on redeploy, like mines).
const sessions = new Map();

// How often the multiplier ticks up (ms).
const TICK_MS = 900;
// How much the multiplier rises per tick (accelerates as the ride goes on).
const BASE_STEP = 0.05;

/**
 * Roll the crash multiplier: base distribution is 45% of bets survive ≥ 1.5x,
 * house keeps 10%. `winChance` (player's rank-tier odds) shifts the CDF so a
 * higher win chance → higher survival odds; peak hours pass 0.5 → default.
 */
function rollCrash(winChance = 0.5) {
  const r = Math.random();
  const shift = (winChance - 0.5) * 0.20; // ±10% at the extremes
  const s = r - shift;
  if (s < 0.30) return 1.0;            // crash at 1.00x — lose instantly
  if (s < 0.50) return 1.25;           // small tick
  if (s < 0.70) return 1.5;
  if (s < 0.85) return 2.0;
  if (s < 0.93) return 3.0;
  if (s < 0.98) return 5.0;
  return 10.0;
}

/** Pure logic: { crash, payout } — payout = bet × crash, 0 when crash=1.0. */
function playCrash(bet, winChance = 0.5) {
  const crash = rollCrash(winChance);
  const payout = crash > 1.0 ? Math.floor(bet * crash) : 0;
  return { crash, payout, bet };
}

/** Current multiplier of a session (rounded for display). */
function currentMult(s) {
  return Math.max(1, Number(s.mult));
}

/** Current payout value if the user cashes out right now. */
function currentWorth(s) {
  return Math.floor(s.bet * currentMult(s));
}

function statusText(s, crashed = false) {
  const m = currentMult(s);
  if (crashed) {
    return (
      `💥 <b>CRASH AT ${m.toFixed(2)}x</b>\n\n` +
      `The rocket exploded. You lost <b>${fmt(s.bet)}</b>.\n` +
      `⏱ Ride ended at <b>${m.toFixed(2)}x</b>`
    );
  }
  return (
    `💥 <b>CRASH</b> — bet ${fmt(s.bet)}\n\n` +
    `🚀 Multiplier: <b>${m.toFixed(2)}x</b>\n` +
    `💰 Cash out now: <b>${fmt(currentWorth(s))}</b> (+${fmt(currentWorth(s) - s.bet)})\n\n` +
    `⏳ <i>The rocket keeps climbing… press CASHOUT before it crashes.</i>`
  );
}

function buildKeyboard(s) {
  return {
    inline_keyboard: [[
      { text: `💰 CASHOUT ${fmt(currentWorth(s))}`, callback_data: `crash:${s.userId}:cash` },
    ]],
  };
}

function stopTimer(s) {
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

async function crashNow(s, deps) {
  if (!s.alive) return;
  s.alive = false;
  stopTimer(s);
  sessions.delete(s.userId);
  // Rank progression: a crash at 1.00x = loss; crashing above 1.0x still
  // counts as a loss since the player never cashed out.
  rank.recordMatchResult(s.userId, s.bet, false);
  try {
    await deps.editMsg(statusText(s, true), { parse_mode: 'HTML', alwaysShowMarkup: true });
  } catch (e) { /* non-fatal */ }
  try {
    await deps.reply(
      `💥 <b>CRASHED!</b> You lost your ${fmt(s.bet)} bet.\n` +
      `👛 Wallet: ${fmt(deps.eco.balance(s.userId).wallet)}`,
      { html: true }
    );
  } catch (e) { /* non-fatal */ }
}

function startTicker(s, deps) {
  const step = () => {
    if (!s.alive) return;
    // Accelerate slightly so long rides get exciting.
    s.mult = Math.min(999, s.mult + BASE_STEP + Math.floor(s.mult - 1) * 0.005);
    if (s.mult >= s.crashPoint) {
      crashNow(s, deps);
      return;
    }
    deps.editMsg(statusText(s), {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(s),
      alwaysShowMarkup: true,
    }).catch(() => {});
  };
  s.timer = setInterval(step, TICK_MS);
  s.timer.unref && s.timer.unref();
}

async function play(ctx) {
  const { args, eco, cd, chatId, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(bet) || bet <= 0) {
    return reply('🎯 Usage: `/crash [amount]` — e.g. `/crash 5000`. Cash out before it crashes!');
  }

  const g = cd.guardGame(userId, 'crash', 'Crash');
  if (g.blocked) return reply(g.message);

  const existing = sessions.get(userId);
  if (existing && existing.alive) {
    return reply('⏳ You already have a crash rocket climbing. Cash out or wait for it to crash first.');
  }

  const charge = eco.chargeWallet(userId, bet, 'crash');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'crash', config.perGameCooldownMs);

  const s = {
    userId,
    bet,
    chatId,
    mult: 1.0,
    crashPoint: rollCrash(rank.getWinChance(userId, 'crash')),
    alive: true,
    timer: null,
    startedAt: Date.now(),
  };
  sessions.set(userId, s);

  // Send the live message with the CASHOUT button (gameplay-critical markup).
  const sent = await reply(statusText(s), {
    html: true,
    reply_markup: buildKeyboard(s),
    alwaysShowMarkup: true,
  });

  const deps = {
    reply: (t, o) => reply(t, o),
    editMsg: (t, o) => {
      if (!sent || !sent.message_id) return Promise.resolve(null);
      return ctx.editMsg(chatId, sent.message_id, t, o);
    },
    eco,
  };

  // A crash at exactly 1.0 is instant — end it now instead of a pointless tick.
  if (s.crashPoint <= 1.0) {
    setTimeout(() => crashNow(s, deps), 400);
  } else {
    startTicker(s, deps);
  }

  return { sent, session: s };
}

/** Handle crash:<uid>:cash callback. */
async function onCash(ctx, { chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active crash game.');
    return;
  }
  const winnings = currentWorth(s);
  s.alive = false;
  stopTimer(s);
  sessions.delete(s.userId);
  eco.creditWallet(userId, winnings);
  // Rank progression: a cashout at any multiplier is a WIN (player chose when
  // to stop).
  rank.recordMatchResult(userId, s.bet, true);

  await editMsg(
    `${statusText(s)}\n\n✅ <b>CASHED OUT ${fmt(winnings)}</b> (net +${fmt(winnings - s.bet)})`,
    { parse_mode: 'HTML', alwaysShowMarkup: true }
  );
  await answerCb(`💰 Cashed out ${fmt(winnings)}`);
  await reply(
    `🚀 <b>RIDE COMPLETE</b>\n` +
    `You cashed out at ${currentMult(s).toFixed(2)}x for <b>${fmt(winnings)}</b> (net +${fmt(winnings - s.bet)}).\n` +
    `👛 Wallet: ${fmt(eco.balance(userId).wallet)}`,
    { html: true }
  );
}

module.exports = {
  play,
  onCash,
  playCrash,
  rollCrash,
  currentMult,
  currentWorth,
  statusText,
  buildKeyboard,
  sessions,
  TICK_MS,
};
