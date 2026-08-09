'use strict';
/**
 * Rimuru Tempest Casino — cooldown helpers.
 */
const db = require('./db');
const { humanDuration } = require('./utils');

/** Returns remaining ms for (user, action), or 0 if not cooling down. */
function remaining(userId, action) {
  const until = db.getCooldown(userId, action);
  const left = until - Date.now();
  return left > 0 ? left : 0;
}

/**
 * Guard: if cooldown active, returns { blocked: true, message } — the caller
 * should reply with `message` and do nothing else.
 */
function guard(userId, action, what = 'That') {
  const left = remaining(userId, action);
  if (left > 0) {
    return {
      blocked: true,
      message: `⏳ **${what} is on cooldown.** Try again in \`${humanDuration(left)}\`.`,
    };
  }
  return { blocked: false };
}

/** Start a cooldown for (user, action) lasting `ms`. */
function start(userId, action, ms) {
  db.setCooldown(userId, action, Date.now() + ms);
}

/* ------------------------------------------------------------------ *
 *  PER-GAME COOLDOWNS (no global gambling cooldown).                  *
 *  Each game has its own cooldown key: "game:slots", "game:dice", …   *
 *  Switching between different games is always instant.               *
 * ------------------------------------------------------------------ */

/** Guard for a specific game. Returns { blocked, message }. */
function guardGame(userId, gameName, what = 'That game') {
  const left = remaining(userId, `game:${gameName}`);
  if (left > 0) {
    return {
      blocked: true,
      message: `⏳ **${what} is cooling down.** Try again in \`${humanDuration(left)}\`.`,
    };
  }
  return { blocked: false };
}

/** Start a per-game cooldown for (user, gameName). */
function startGame(userId, gameName, ms) {
  start(userId, `game:${gameName}`, ms);
}

module.exports = { remaining, guard, start, guardGame, startGame };