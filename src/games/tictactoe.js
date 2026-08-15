'use strict';
/**
 * Rimuru Tempest Casino — Tic-Tac-Toe ⭕❌ (button game vs the house)
 * /ttt [amount] — beat the house bot.
 *
 * Flow:
 *   1. Difficulty selection: Easy (low pay), Normal (medium), Hard (high pay,
 *      strong minimax AI).
 *   2. Pick X or O. X moves first; if you pick O the bot moves first.
 *   3. Tap a cell to place your mark; the bot answers with its mark.
 *   4. Win / lose / draw settles the bet. Betting is OPTIONAL — with no bet
 *      you play for fun and earn nothing.
 *
 * Callback payloads:
 *   ttt:<userId>:diff:<easy|normal|hard>
 *   ttt:<userId>:mark:<X|O>
 *   ttt:<userId>:pick:<index>
 */
const config = require('../config');
const { fmt } = require('../utils');
const rank = require('../rank');

// Legacy display constants (also used by the pure-logic tests).
const EMPTY = '·';
const HUMAN = '❌';
const BOT = '⭕';

// In-memory sessions (ephemeral — resets on redeploy).
const sessions = new Map();

// Difficulty tuning: win multiplier + tie refund multiplier.
const DIFFICULTIES = {
  easy: { label: 'Easy', winMult: 1.2, tieMult: 0.25 },
  normal: { label: 'Normal', winMult: 1.8, tieMult: 0.5 },
  hard: { label: 'Hard', winMult: 2.6, tieMult: 1.0 },
};

function emptyBoard() {
  return [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
}

/** Winner of a board using the legacy HUMAN/BOT constants, or 'tie'. */
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

/** Normal bot move: win if possible, block if threatened, else random. */
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

/**
 * Pure auto-play logic (kept for backward-compatible tests). Player is always
 * X and moves first, bot is O with the "normal" strategy.
 */
function playTtt(bet) {
  const b = emptyBoard();
  b[4] = HUMAN;
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

/* ---------------- interactive game (button-based) ---------------- */

function stopTimer(s) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}

/** Generic winner check for any two marks (interactive boards use X/O). */
function winnerBetween(b, playerMark, botMark) {
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

/** Minimax for Hard: never makes a mistake. */
function minimaxMove(b, playerMark, botMark) {
  const empties = b.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
  if (!empties.length) return null;

  function score(board, isBotTurn) {
    const w = winnerBetween(board, playerMark, botMark);
    if (w === botMark) return 10;
    if (w === playerMark) return -10;
    if (w === 'tie') return 0;

    const moves = board.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
    if (isBotTurn) {
      let best = -Infinity;
      for (const i of moves) {
        const t = board.slice(); t[i] = botMark;
        best = Math.max(best, score(t, false));
      }
      return best;
    }
    let best = Infinity;
    for (const i of moves) {
      const t = board.slice(); t[i] = playerMark;
      best = Math.min(best, score(t, true));
    }
    return best;
  }

  let bestMove = empties[0];
  let bestScore = -Infinity;
  for (const i of empties) {
    const t = b.slice(); t[i] = botMark;
    const s = score(t, false);
    if (s > bestScore) {
      bestScore = s;
      bestMove = i;
    }
  }
  return bestMove;
}

/** Easy AI: mostly random, but it can still accidentally take a winning cell. */
function easyMove(b, playerMark, botMark) {
  const empties = b.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
  if (!empties.length) return null;
  // 35% of the time take an obvious win, otherwise random.
  if (Math.random() < 0.35) {
    for (const i of empties) {
      const t = b.slice(); t[i] = botMark;
      if (winnerBetween(t, playerMark, botMark) === botMark) return i;
    }
  }
  return empties[Math.floor(Math.random() * empties.length)];
}

/** Normal AI: win if possible, block if threatened, else random. */
function normalMove(b, playerMark, botMark) {
  const empties = b.map((v, i) => (v === EMPTY ? i : -1)).filter((i) => i >= 0);
  for (const i of empties) {
    const t = b.slice(); t[i] = botMark;
    if (winnerBetween(t, playerMark, botMark) === botMark) return i;
  }
  for (const i of empties) {
    const t = b.slice(); t[i] = playerMark;
    if (winnerBetween(t, playerMark, botMark) === playerMark) return i;
  }
  return empties[Math.floor(Math.random() * empties.length)];
}

function chooseBotMove(s) {
  if (s.difficulty === 'hard') return minimaxMove(s.board, s.playerMark, s.botMark);
  if (s.difficulty === 'easy') return easyMove(s.board, s.playerMark, s.botMark);
  return normalMove(s.board, s.playerMark, s.botMark);
}

function payoutFor(s, result) {
  if (!s.bet) return 0;
  const d = DIFFICULTIES[s.difficulty] || DIFFICULTIES.normal;
  if (result === 'player') return Math.floor(s.bet * d.winMult);
  if (result === 'tie') return Math.floor(s.bet * d.tieMult);
  return 0;
}

function renderCell(v) {
  if (v === 'X') return '❌';
  if (v === 'O') return '⭕';
  return '·';
}

function boardTextInteractive(s) {
  const b = s.board;
  return `${renderCell(b[0])} ${renderCell(b[1])} ${renderCell(b[2])}\n` +
         `${renderCell(b[3])} ${renderCell(b[4])} ${renderCell(b[5])}\n` +
         `${renderCell(b[6])} ${renderCell(b[7])} ${renderCell(b[8])}`;
}

function diffText() {
  return (
    `⭕ <b>TIC-TAC-TOE</b>\n\n` +
    `Pick a difficulty:\n` +
    `• <b>Easy</b> — win ${DIFFICULTIES.easy.winMult.toFixed(1)}x, tie ${(DIFFICULTIES.easy.tieMult * 100).toFixed(0)}% back\n` +
    `• <b>Normal</b> — win ${DIFFICULTIES.normal.winMult.toFixed(1)}x, tie ${(DIFFICULTIES.normal.tieMult * 100).toFixed(0)}% back\n` +
    `• <b>Hard</b> — win ${DIFFICULTIES.hard.winMult.toFixed(1)}x, tie ${(DIFFICULTIES.hard.tieMult * 100).toFixed(0)}% back (strong AI)`
  );
}

function markText() {
  return (
    `⭕ <b>TIC-TAC-TOE</b>\n\n` +
    `Choose your mark:\n` +
    `• <b>❌ X</b> — you move first\n` +
    `• <b>⭕ O</b> — the bot moves first`
  );
}

function statusText(s, result = null) {
  const d = DIFFICULTIES[s.difficulty] || DIFFICULTIES.normal;
  let suffix = '';
  if (result === 'player') suffix = `\n\n🎉 <b>YOU WIN!</b> Payout ${fmt(payoutFor(s, 'player'))}`;
  else if (result === 'bot') suffix = `\n\n💀 <b>HOUSE WINS.</b>`;
  else if (result === 'tie') suffix = `\n\n🤝 <b>DRAW.</b> ${s.bet ? `Refund ${fmt(payoutFor(s, 'tie'))}` : 'No payout (no bet).'}`;
  return (
    `⭕ <b>TIC-TAC-TOE</b> — ${d.label}\n` +
    (s.bet ? `Bet: <b>${fmt(s.bet)}</b>\n` : `No bet — playing for fun\n`) +
    `You: ${renderCell(s.playerMark)} · Bot: ${renderCell(s.botMark)}\n\n` +
    `<code>${boardTextInteractive(s)}</code>${suffix}`
  );
}

function buildBoardKeyboard(s) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = s.board[i];
      if (v !== EMPTY) {
        row.push({ text: renderCell(v), callback_data: `ttt:${s.userId}:pick:${i}` });
      } else {
        row.push({ text: '·', callback_data: `ttt:${s.userId}:pick:${i}` });
      }
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function buildDiffKeyboard(s) {
  return {
    inline_keyboard: [
      [{ text: '🟢 Easy', callback_data: `ttt:${s.userId}:diff:easy` }],
      [{ text: '🟡 Normal', callback_data: `ttt:${s.userId}:diff:normal` }],
      [{ text: '🔴 Hard', callback_data: `ttt:${s.userId}:diff:hard` }],
    ],
  };
}

function buildMarkKeyboard(s) {
  return {
    inline_keyboard: [
      [
        { text: '❌ X', callback_data: `ttt:${s.userId}:mark:X` },
        { text: '⭕ O', callback_data: `ttt:${s.userId}:mark:O` },
      ],
    ],
  };
}

function createSession(userId, chatId, bet) {
  const s = {
    userId,
    chatId,
    bet,
    stage: 'diff',
    difficulty: null,
    playerMark: 'X',
    botMark: 'O',
    board: emptyBoard(),
    turn: 'player',
    alive: true,
    startedAt: Date.now(),
    timer: null,
  };
  sessions.set(userId, s);
  return s;
}

function clearSession(userId) {
  const s = sessions.get(userId);
  if (s) stopTimer(s);
  sessions.delete(userId);
}

async function play(ctx) {
  const { args, eco, cd, chatId, userId, reply } = ctx;
  const raw = String(args[0] || '').replace(/,/g, '');
  const bet = raw ? Math.floor(Number(raw)) : 0;
  if (raw && (!Number.isFinite(bet) || bet <= 0)) {
    return reply('⭕ Usage: `/ttt [amount]` — e.g. `/ttt 5000`, or just `/ttt` to play for fun.');
  }

  const g = cd.guardGame(userId, 'ttt', 'Tic-Tac-Toe');
  if (g.blocked) return reply(g.message);

  const existing = sessions.get(userId);
  if (existing && existing.alive) {
    return reply('⏳ You already have a tic-tac-toe game running. Finish it first.');
  }

  if (bet > 0) {
    const charge = eco.chargeWallet(userId, bet, 'tic-tac-toe');
    if (!charge.ok) return reply(charge.message);
    cd.startGame(userId, 'ttt', config.perGameCooldownMs);
  }

  const s = createSession(userId, chatId, bet);
  const sent = await reply(diffText(), {
    html: true,
    reply_markup: buildDiffKeyboard(s),
    alwaysShowMarkup: true,
  });
  return { sent, session: s };
}

/** Handle ttt:<uid>:diff:<easy|normal|hard> and ttt:<uid>:mark:<X|O>. */
async function onSetup(ctx, { chatId, userId, reply, editMsg, answerCb, eco }) {
  const parts = String(ctx.data || '').split(':');
  const action = parts[2];
  const value = parts[3];
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active tic-tac-toe game.');
    return;
  }

  if (action === 'diff') {
    if (!DIFFICULTIES[value]) {
      await answerCb('Unknown difficulty.');
      return;
    }
    s.difficulty = value;
    await editMsg(markText(), { parse_mode: 'HTML', reply_markup: buildMarkKeyboard(s), alwaysShowMarkup: true });
    await answerCb(`Difficulty: ${DIFFICULTIES[value].label}`);
    return;
  }

  if (action === 'mark') {
    if (value !== 'X' && value !== 'O') {
      await answerCb('Unknown mark.');
      return;
    }
    s.playerMark = value;
    s.botMark = value === 'X' ? 'O' : 'X';
    s.turn = value === 'X' ? 'player' : 'bot';
    // If the bot goes first (player chose O), make its opening move now.
    if (s.turn === 'bot') {
      const m = chooseBotMove(s);
      if (m != null) s.board[m] = s.botMark;
      s.turn = 'player';
    }
    await editMsg(statusText(s), { parse_mode: 'HTML', reply_markup: buildBoardKeyboard(s), alwaysShowMarkup: true });
    await answerCb(`You are ${value} — good luck!`);
    return;
  }

  await answerCb('Unknown action.');
}

/** Handle ttt:<uid>:pick:<index>. */
async function onPick(ctx, { chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || !s.alive) {
    await answerCb('No active tic-tac-toe game.');
    return;
  }
  if (s.stage !== 'diff' && s.difficulty == null) {
    // Should not happen; guard anyway.
    await answerCb('Choose a difficulty first.');
    return;
  }
  const idx = parseInt(String(ctx.data || '').split(':')[3], 10);
  if (!Number.isFinite(idx) || idx < 0 || idx > 8 || s.board[idx] !== EMPTY) {
    await answerCb('That cell is already taken!');
    return;
  }

  // Player move.
  s.board[idx] = s.playerMark;
  let result = winnerBetween(s.board, s.playerMark, s.botMark);
  if (result) {
    await settle(s, result, { reply, editMsg, answerCb, eco });
    return;
  }

  // Bot move.
  const m = chooseBotMove(s);
  if (m != null) s.board[m] = s.botMark;
  result = winnerBetween(s.board, s.playerMark, s.botMark);
  if (result) {
    await settle(s, result, { reply, editMsg, answerCb, eco });
    return;
  }

  await editMsg(statusText(s), { parse_mode: 'HTML', reply_markup: buildBoardKeyboard(s), alwaysShowMarkup: true });
  await answerCb('Your move.');
}

async function settle(s, result, { reply, editMsg, answerCb, eco }) {
  s.alive = false;
  stopTimer(s);
  const payout = payoutFor(s, result);
  const won = result === 'player';
  const net = payout - s.bet;

  if (s.bet) {
    if (payout > 0) eco.creditWallet(s.userId, payout);
    // Rank progression: only betting games count (free games never do).
    rank.recordMatchResult(s.userId, s.bet, result === 'player' ? true : result === 'tie' ? 'push' : false);
  }

  await editMsg(statusText(s, result), { parse_mode: 'HTML', alwaysShowMarkup: true });
  await answerCb(result === 'player' ? '🎉 You win!' : result === 'tie' ? '🤝 Draw.' : '💀 House wins.');
  await reply(
    (won
      ? `🎉 <b>YOU BEAT THE HOUSE!</b>\nPayout <b>${fmt(payout)}</b> (net +${fmt(net)}).`
      : result === 'tie'
        ? `🤝 <b>DRAW.</b> ${s.bet ? `Refund <b>${fmt(payout)}</b> (net ${fmt(net)}).` : 'No payout (no bet).'}`
        : `💀 <b>THE HOUSE WINS.</b> ${s.bet ? `Lost <b>${fmt(s.bet)}</b>.` : 'No payout (no bet).'}`) +
    `\n👛 Wallet: ${fmt(eco.balance(s.userId).wallet)}`,
    { html: true }
  );
  clearSession(s.userId);
}

/** Single entry point for bot.js callbacks. */
async function onAction(ctx, deps) {
  const action = String(ctx.data || '').split(':')[2];
  if (action === 'pick') return onPick(ctx, deps);
  return onSetup(ctx, deps);
}

module.exports = {
  // legacy pure logic (tests)
  play,
  onAction,
  playTtt,
  botMove,
  winnerOf,
  boardText,
  // interactive internals (tests + reuse)
  emptyBoard,
  DIFFICULTIES,
  winnerBetween,
  minimaxMove,
  easyMove,
  normalMove,
  chooseBotMove,
  payoutFor,
  sessions,
};
