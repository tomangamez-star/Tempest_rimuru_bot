'use strict';
/**
 * Rimuru Tempest Casino — Mines 💣
 * 5×5 grid, 4 mines placed randomly — but only 3 are VISIBLE (the 4th is
 * hidden forever). The mined boxes MOVE after every safe pick: the board
 * re-randomizes each turn, so you never know where the mines are.
 * Inline-button grid (blue = unrevealed).
 *
 * Reward system: NO payout before the 1st move. Each safe pick adds +25% of
 * the ORIGINAL wager to the cash-out value (bet 1000 → +250 per pick).
 *   cash-out = bet + bet × 0.25 × safe_picks   (multiplier = 1 + 0.25 × picks)
 * "Cash out" button always visible → claim winnings. Hit a visible mine →
 * lose everything (the hidden 4th mine is never shown on reveal).
 *
 * Callback payload format: mines:<userId>:<action>:<data>
 *   action: pick:<index> | cash
 */
const config = require('../config');
const { fmt, shuffle, randInt } = require('../utils');
const rank = require('../rank');
const spectator = require('../staff-spectator');

// In-memory game sessions (SQLite would be overkill; resets on restart are fine)
const sessions = new Map();

const GRID = config.mines.grid; // 5
const TOTAL_CELLS = GRID * GRID; // 25
const MINE_COUNT = config.mines.mineCount || 4; // 4 mines (3 visible + 1 hidden)
const VISIBLE_MINES = config.mines.visibleMines || 3;
const MULT_PER_PICK = config.mines.multPerPick || 0.25;
const MAX_PICKS = config.mines.maxPicks || TOTAL_CELLS - VISIBLE_MINES; // 22

/** Randomly place the mines on `exclude` indices (used for the first board). */
function placeMines(exclude = []) {
  const ex = new Set(exclude);
  const cells = [];
  for (let i = 0; i < TOTAL_CELLS; i++) if (!ex.has(i)) cells.push(i);
  return new Set(shuffle(cells).slice(0, MINE_COUNT));
}

/**
 * Re-roll the mines after a safe pick. The mines NEVER land on a cell the
 * player already revealed (that would look broken), and never on the cell
 * they just picked — the board genuinely reshuffles each turn.
 */
function reshuffleMines(s) {
  const taken = new Set([...s.revealed]);
  const cells = [];
  for (let i = 0; i < TOTAL_CELLS; i++) if (!taken.has(i)) cells.push(i);
  s.mines = new Set(shuffle(cells).slice(0, MINE_COUNT));
  return s.mines;
}

function createSession(userId, bet) {
  const s = {
    userId,
    bet,
    mines: placeMines(),          // 4 mines: 3 visible + 1 hidden
    hiddenMine: null,             // set on reveal — the mine that stays hidden
    revealed: new Set(),
    picks: 0,                     // safe picks completed (reward driver)
    alive: true,
    startedAt: Date.now(),
  };
  sessions.set(userId, s);
  return s;
}

/** Multiplier for the NEXT pick = 1 + 0.25 × picks completed. */
function nextMult(s) {
  return 1 + MULT_PER_PICK * s.picks;
}

/**
 * Current cash-out value — the reward only starts AFTER the 1st move.
 * cash-out = bet + bet × 0.25 × safe_picks (0 picks → exactly the bet).
 */
function currentWorth(s) {
  return Math.floor(s.bet + s.bet * MULT_PER_PICK * s.picks);
}

/**
 * Render the 5×5 grid as TEXT (emoji board in the note body).
 * The tapped/revealed cell is rendered BIGGER than the rest
 * (💎 for a safe reveal, 💥 for a mine — same as the button labels).
 */
function buildBoard(s, gameOver = false) {
  const rows = [];
  for (let r = 0; r < GRID; r++) {
    const row = [];
    for (let c = 0; c < GRID; c++) {
      const i = r * GRID + c;
      if (s.revealed.has(i)) {
        row.push('💎');
      } else if (gameOver && s.mines.has(i) && i !== s.hiddenMine) {
        // Only the 3 VISIBLE mines are shown — the hidden 4th never appears.
        row.push('💥');
      } else {
        row.push('🟦');
      }
    }
    rows.push(row.join(' '));
  }
  return rows.join('\n');
}

function buildKeyboard(s, gameOver = false) {
  const rows = [];
  for (let r = 0; r < GRID; r++) {
    const rowBtns = [];
    for (let c = 0; c < GRID; c++) {
      const i = r * GRID + c;
      const revealed = s.revealed.has(i);
      const isMine = s.mines.has(i);
      // The TAPPED cell grows BIGGER (larger label) while the 5×5 grid stays.
      // Revealed safe cell → 💎 (enlarged); revealed mine → 💥 (enlarged).
      if (revealed) {
        rowBtns.push({ text: '💎', callback_data: `mines:${s.userId}:pick:${i}` });
      } else if (gameOver && isMine && i !== s.hiddenMine) {
        rowBtns.push({ text: '💥', callback_data: `mines:${s.userId}:pick:${i}` });
      } else {
        rowBtns.push({ text: '🟦', callback_data: `mines:${s.userId}:pick:${i}` });
      }
    }
    rows.push(rowBtns);
  }
  // Cash-out button — label shows the CURRENT value (bet before the 1st move).
  rows.push([{ text: `💰 Cash out ${fmt(currentWorth(s))}`, callback_data: `mines:${s.userId}:cash` }]);
  return { inline_keyboard: rows };
}

function statusText(s, gameOver = false) {
  const mult = nextMult(s);
  return (
    `💣 <b>MINES</b> — bet ${fmt(s.bet)}\n\n` +
    buildBoard(s, gameOver) +
    `\n\n💎 Safe picks: ${s.picks}/${MAX_PICKS} | Next pick: <b>${mult.toFixed(2)}x</b>\n` +
    (s.picks > 0
      ? `💰 Cash out now: <b>${fmt(currentWorth(s))}</b> (+${fmt(currentWorth(s) - s.bet)})\n`
      : `💰 Cash out now: <b>${fmt(currentWorth(s))}</b> (first pick unlocks the reward)\n`) +
    `⚠️ <i>4 mines — one is hidden. The mines move after every pick.</i>`
  );
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'mines', 'Mines');
  if (g.blocked) return reply(g.message);

  const existing = sessions.get(userId);
  if (existing && existing.alive) {
    return reply('⏳ You already have a mines game running. Finish it or cash out first.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'mines round');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'mines', config.perGameCooldownMs);

  const s = createSession(userId, bet.amount);
  s.chatId = chatId; s.playerName = (msg && msg.from && (msg.from.first_name || msg.from.username)) || String(userId);
  spectator.mines(s).catch(() => {});
  // alwaysShowMarkup: the 5×5 grid is GAMEPLAY — it must render even when
  // SHOW_INLINE_BUTTONS=false (fixes the "mines grid missing" regression).
  const sent = await reply(statusText(s), { html: true, reply_markup: buildKeyboard(s), alwaysShowMarkup: true });
  return { sent, session: s };
}

/** Handle mines:<uid>:pick:<i> callback */
async function onPick(ctx, { bot, chatId, userId, reply, editMsg, callbackId, answerCb, eco }) {
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
    // 💥 BOOM — lose everything (initial bet already charged).
    // The hidden 4th mine is never shown: keep ONE mine cell unmarked.
    s.alive = false;
    rank.recordMatchResult(userId, s.bet, false);
    const mineCells = [...s.mines];
    const hidden = s.hiddenMine === null ? mineCells[randInt(0, mineCells.length - 1)] : s.hiddenMine;
    s.hiddenMine = hidden;
    await editMsg(statusText(s, true), { parse_mode: 'HTML', alwaysShowMarkup: true });
    await answerCb('💥 BOOM! You hit a mine.');
    await reply(
      `💥 <b>BOOM!</b> You hit a mine and lost everything — including your ${fmt(s.bet)} bet.\n` +
      `🕳️ <i>One mine stays hidden… ${VISIBLE_MINES} of ${MINE_COUNT} revealed.</i>\n` +
      `👛 Wallet: ${fmt(eco.balance(userId).wallet)}`,
      { html: true }
    );
    spectator.end('mines', s, 'Mine hit').catch(() => {});
    sessions.delete(userId);
    return;
  }
  // ✅ Safe pick — the board RESHUFFLES: the mines move to new positions
  // (never under a revealed cell, never under the cell you just picked).
  s.revealed.add(idx);
  s.picks += 1;
  if (config.mines.reshuffleAfterPick !== false) reshuffleMines(s);
  spectator.mines(s).catch(() => {});
  if (s.picks >= MAX_PICKS) {
    // All safe cells found — auto cash out
    s.alive = false;
    const winnings = currentWorth(s);
    eco.creditWallet(userId, winnings);
    rank.recordMatchResult(userId, s.bet, true);
    await editMsg(statusText(s, true), { parse_mode: 'HTML', alwaysShowMarkup: true });
    await answerCb(`💎 All safe cells! +${fmt(winnings)}`);
    await reply(
      `🏆 <b>PERFECT CLEAR!</b> You cleared all ${MAX_PICKS} safe cells.\n` +
      `💰 Won ${fmt(winnings)} (net +${fmt(winnings - s.bet)})\n` +
      `👛 Wallet: ${fmt(eco.balance(userId).wallet)}`,
      { html: true }
    );
    spectator.end('mines', s, 'Perfect clear').catch(() => {});
    sessions.delete(userId);
    return;
  }
  // alwaysShowMarkup: keep the clickable grid on every board update
  await editMsg(statusText(s), { parse_mode: 'HTML', reply_markup: buildKeyboard(s), alwaysShowMarkup: true });
  await answerCb(`💎 Safe! +${fmt(Math.floor(s.bet * MULT_PER_PICK))} added — mines moved! Next ${nextMult(s).toFixed(2)}x`);
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
  rank.recordMatchResult(userId, s.bet, winnings > s.bet);
  await editMsg(
    `${statusText(s)}\n\n✅ <b>CASHED OUT</b> ${fmt(winnings)} (net +${fmt(winnings - s.bet)})`,
    { parse_mode: 'HTML', alwaysShowMarkup: true }
  );
  await answerCb(`💰 Cashed out ${fmt(winnings)}`);
  spectator.end('mines', s, 'Cashed out').catch(() => {});
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
  placeMines,
  reshuffleMines,
  nextMult,
  currentWorth,
  buildBoard,
  parseBet,
  sessions,
  MINE_COUNT,
  VISIBLE_MINES,
  MAX_PICKS,
};
