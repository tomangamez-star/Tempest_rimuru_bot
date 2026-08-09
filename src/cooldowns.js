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

module.exports = { remaining, guard, start };
