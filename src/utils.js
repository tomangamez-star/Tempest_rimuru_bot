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

/** Escape HTML for Telegram parse_mode=HTML. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Ensure a directory exists. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
};
