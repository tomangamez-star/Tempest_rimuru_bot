'use strict';
/**
 * Rimuru Tempest Casino — admin module.
 * Owner-only controls:
 *  /ban [reason] — full ban (no bot interaction at all)
 *  /sus [reason] — can chat in group but can't gamble / talk to Rimuru
 *  /mute [reason] — can't talk at all (group messages are answered with silence)
 * All show reason + duration when they end.
 */
const db = require('./db');
const config = require('./config');

const STATUS = {
  BANNED: 'banned',
  SUSPECTED: 'suspected',
  MUTED: 'muted',
  ACTIVE: 'active',
};

/**
 * Apply a penalty. Duration optional (e.g. "2h", "1d", "30m", "1w").
 * Returns { ok, message }.
 */
function applyPenalty(userId, status, reason, durationStr) {
  const until = durationStr ? parseDuration(durationStr) : 0;
  if (durationStr && until === 0) {
    return { ok: false, message: `⏳ Bad duration \`${durationStr}\`. Use e.g. \`30m\`, \`2h\`, \`1d\`, \`1w\`, or omit for permanent.` };
  }
  const u = db.getUser(userId);
  if (!u) {
    return { ok: false, message: '❌ That user has never interacted with the bot.' };
  }
  db.setStatus(userId, status, reason || 'No reason given', until ? Date.now() + until : 0);
  const label = status === STATUS.BANNED ? 'banned' : status === STATUS.MUTED ? 'muted' : 'suspended';
  const dur = until ? ` for ${durationStr}` : ' permanently';
  return {
    ok: true,
    message: `🚨 **${u.first_name || userId}** has been **${label}**${dur}.\nReason: ${reason || 'No reason given'}`,
  };
}

/** Remove a penalty (owner can lift early). */
function liftPenalty(userId) {
  const u = db.getUser(userId);
  if (!u) return { ok: false, message: '❌ That user has never interacted with the bot.' };
  db.clearStatus(userId);
  return { ok: true, message: `✅ **${u.first_name || userId}** is free to play again.` };
}

/**
 * Check a user's interaction rights.
 * @returns {allowed:boolean, reply?:string} — reply is the message to send if blocked.
 */
function checkInteract(userId, { gambling = true } = {}) {
  const u = db.getUser(userId);
  if (!u) return { allowed: true };
  if (String(userId) === config.ownerId) return { allowed: true };

  const now = Date.now();
  const expired = u.status_until > 0 && u.status_until <= now;
  const status = expired ? STATUS.ACTIVE : u.status;

  if (status === STATUS.BANNED) {
    return { allowed: false, reply: `⛔ You are **banned** from Rimuru's casino.\nReason: ${u.status_reason || 'No reason given'}` };
  }
  if (status === STATUS.SUSPECTED) {
    if (gambling) {
      return { allowed: false, reply: `🧊 You've been **suspended** — no gambling, no Rimuru.\nReason: ${u.status_reason || 'No reason given'}` };
    }
    return { allowed: true };
  }
  if (status === STATUS.MUTED) {
    if (gambling) {
      return { allowed: false, reply: `🤐 You're **muted** — no gambling, no Rimuru.\nReason: ${u.status_reason || 'No reason given'}` };
    }
    // muted users can't talk to Rimuru either
    return { allowed: false, reply: null };
  }
  return { allowed: true };
}

/**
 * Parse "30m" / "2h" / "1d" / "1w" → ms. Returns 0 on invalid.
 */
function parseDuration(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

module.exports = {
  STATUS,
  applyPenalty,
  liftPenalty,
  checkInteract,
  parseDuration,
};