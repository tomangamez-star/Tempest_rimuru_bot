'use strict';
/**
 * Rimuru Tempest Casino — shared utilities.
 */
const fs = require('fs');

/** Format a number with thousands separators. */
function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/** Random integer in [min, max] inclusive. */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Shuffle a copy of an array (Fisher–Yates). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Simple chance roll: returns true with `p` probability (0..1). */
function chance(p) {
  return Math.random() < p;
}

/** Human duration from ms: "1h 5m", "24h", "10m", "45s". */
function humanDuration(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && !d && !h) parts.push(`${sec}s`);
  return parts.slice(0, 2).join(' ') || '0s';
}

/** Parse a user-supplied amount: "5000", "all", "half", empty. */
function parseAmount(raw, max) {
  if (raw === undefined || raw === null) return null; // signal "no amount given"
  const t = String(raw).trim().toLowerCase();
  if (t === 'all' || t === 'max' || t === '') return max;
  if (t === 'half') return Math.floor(max / 2);
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Clamp a number into [min, max]. */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** Ensure a directory exists. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ *
 *  RIMURU THEME — vibrant blue/cyan + gold, notebook-note style.      *
 *  Every bot message is wrapped as a "note" with a vertical red       *
 *  margin line on the LEFT edge (like a notebook page).               *
 * ------------------------------------------------------------------ */

const THEME = {
  // Vibrant Rimuru blues/cyans (HTML hex, pop on dark themes)
  blue: '#4FC3F7',
  deepBlue: '#29B6F6',
  cyan: '#00E5FF',
  gold: '#FFD54F',
  goldDeep: '#FFC107',
  red: '#FF5252',
  // Emoji accents sprinkled through messages
  acc: {
    slime: '🐉',     // Rimuru's draconic aura
    note: '📝',      // notebook marker
    coin: '💰',
    wallet: '👛',
    bank: '🏦',
    crown: '👑',
    star: '✨',
    win: '🎉',
    lose: '💀',
    game: '🎮',
    money: '💵',
    flame: '🔥',
  },
};

/**
 * Escape HTML for Telegram parse_mode=HTML.
 * @param {*} s
 * @param {boolean} [keepBr] keep \n as <br> inside the note body (default true)
 */
function esc(s, keepBr = true) {
  let out = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (keepBr) out = out.replace(/\n/g, '<br>');
  return out;
}

/**
 * Wrap text as a notebook note: a vertical red margin line on the LEFT,
 * blue-tinted note background, bold colored title, emoji accents.
 * Always returns a full HTML block (safe with parse_mode: 'HTML').
 *
 * @param {string} title  short bold title (emoji allowed), e.g. '💰 BALANCE'
 * @param {string} body   note body — *bold* and `code` markdown get converted
 * @param {object} [opts] { color, icon, replyTo } — color = THEME color for title
 * @returns {string} styled HTML string
 */
function note(title, body, opts = {}) {
  const color = opts.color || THEME.blue;
  const icon = opts.icon || THEME.acc.note;
  const t = esc(title, false);
  let b;
  if (opts.html === true) {
    // Trusted HTML body: keep <b>/<code>/<a> tags intact, still convert
    // markdown **bold** / `code`, and newlines to <br>.
    b = String(body == null ? '' : body)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  } else {
    // Plain/markdown body: escape everything, then convert markdown to HTML.
    b = esc(body || '')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  // NOTE: no <span> allowed — Telegram HTML rejects bare <span> tags
  // (only <span class="tg-spoiler"> is valid). The colored look comes from
  // the emoji + <b>; the left red margin comes from <blockquote> itself.
  const safeTitle = sanitizeHtml(t);
  const safeBody = sanitizeHtml(b).trim();
  if (!safeBody) {
    // Telegram does not render the blockquote bar for empty content —
    // always keep at least one text line inside the quote.
    return `<blockquote><b>${icon} ${safeTitle}</b></blockquote>`;
  }
  return (
    `<blockquote><b>${icon} ${safeTitle}</b>\n${safeBody}</blockquote>`
  );
}

/**
 * Safety net: strip ANY tag Telegram HTML does not support
 * (e.g. <span ...>, <div>, <style>, <font>) so a bad tag can never
 * cause a "can't parse entities" 400.
 *
 * Rules (Telegram Bot API HTML subset):
 *  - Allowed tags: b, i, u, s, a, code, pre, blockquote, tg-spoiler, br.
 *  - ALL tag ATTRIBUTES are stripped (no attribute is legal on allowed
 *    tags — e.g. <b style="..."> is rejected by Telegram).
 *  - Empty pairs and duplicated opens are removed so no dangling/unmatched
 *    tag can reach Telegram's parser.
 *  - Anything that isn't a clean allowed tag is escaped to &lt; so it
 *    renders as plain text instead of failing the whole message.
 */
function sanitizeHtml(html) {
  let out = String(html == null ? '' : html)
    // 1) <span class="tg-spoiler"> is legal (spoiler text)
    .replace(/<span\s+class=["']tg-spoiler["']\s*>/gi, '<tg-spoiler>')
    .replace(/<\/span\s*>/gi, '</tg-spoiler>')
    // 2) strip attributes from every remaining tag
    .replace(/<(\/?)(b|i|u|s|a|code|pre|blockquote|tg-spoiler|br)(\s[^>]*)?>/gi, '<$1$2>');
  // 3) fixpoint: drop empty pairs + duplicate opens so no dangling tags remain
  for (let i = 0; i < 5; i++) {
    const prev = out;
    out = out
      .replace(/<(b|i|u|s|code|pre|tg-spoiler)>\s*<\/\1>/gi, '')
      .replace(/<(b|i|u|s|code|pre|tg-spoiler)>(?=<\1>)/gi, '');
    if (out === prev) break;
  }
  // 4) escape anything else that still looks like a tag
  return out.replace(/<(?!\/?(?:b|i|u|s|a|code|pre|blockquote|tg-spoiler|br)\s*>)/gi, '&lt;');
}

/** Default Rimuru note header used across the bot. */
function noteHeader(title, opts = {}) {
  return note(title, '', { ...opts, icon: opts.icon || THEME.acc.note });
}

module.exports = {
  fmt,
  randInt,
  pick,
  shuffle,
  chance,
  humanDuration,
  parseAmount,
  clamp,
  esc,
  ensureDir,
  THEME,
  note,
  noteHeader,
  sanitizeHtml,
};