'use strict';
/**
 * Rimuru Tempest Casino — Waifu character-collection feature 💝
 *
 * FULLY ISOLATED: no coin rewards, no rank progression, no game-stat or
 * economy hooks. It has its own Postgres tables (waifu_claims, waifu_spawn)
 * and its own commands (/waifu, /wspawn, /collection, /waifus, /character).
 *
 * Character source (no API key): nekos.best /api/v2/waifu (image + artist +
 * source metadata) is primary; waifu.pics /sfw/waifu (image URL only) is the
 * automatic fallback. Every response is normalized to a canonical character
 * card and its identity is derived from the image URL, so the same image can
 * never be claimed twice.
 *
 * Persistence goes through the existing db layer (waifu_* helpers), so
 * claims and the active spawn survive redeploys via the v4 mirror pipeline.
 * It does NOT touch advisory locking, hydration, or fencing.
 */
const config = require('./config');
const db = require('./db');
const crypto = require('crypto');

/* ================= PURE LOGIC (testable, no Telegram / network) ================= */

/** Stable identity for a character, derived from its image URL. */
function characterIdFor(imageUrl) {
  return crypto.createHash('sha1').update(String(imageUrl || '')).digest('hex').slice(0, 24);
}

/**
 * Normalize a raw API payload into a canonical character card.
 * `source` is 'nekos' or 'waifupics'. Returns null when unusable.
 *   nekos.best → { artist_name, artist_href, source_url, url }
 *   waifu.pics → { url }
 */
function normalizeCharacter(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const imageUrl = String(raw.url || '').trim();
  if (!imageUrl) return null;

  let name = '';
  let series = '';
  if (source === 'nekos') {
    name = String(raw.artist_name || '').trim() || 'Unknown Artist';
    series = String(raw.source_url || '').trim();
  } else {
    name = 'Unknown Waifu';
    series = '';
  }

  return {
    character_id: characterIdFor(imageUrl),
    name,
    series,
    image_url: imageUrl,
    artist_href: String(raw.artist_href || '').trim(),
  };
}

/** True when a spawn row is still claimable (exists, unclaimed, unexpired). */
function isSpawnClaimable(spawn, now = Date.now()) {
  if (!spawn) return false;
  if (Number(spawn.claimed) === 1) return false;
  if (Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now) return false;
  return true;
}

/** How many seconds remain until a spawn expires (0 when none/expired). */
function secondsRemaining(spawn, now = Date.now()) {
  if (!spawn) return 0;
  const left = Number(spawn.expires_at) - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML caption for a spawned character card. */
function cardCaption(char, spawn, claimerName = null) {
  const lines = [
    `💝 <b>WAIFU DROPPED</b>`,
    ``,
    `🎨 <b>${esc(char.name)}</b>`,
  ];
  if (char.series) lines.push(`🔗 Source: ${esc(char.series)}`);
  lines.push(``);
  if (claimerName) {
    lines.push(`✅ Claimed by <b>${esc(claimerName)}</b>`);
  } else {
    lines.push(`⏳ <b>${secondsRemaining(spawn)}s</b> to claim — first tap wins!`);
  }
  return lines.join('\n');
}

/** HTML for a user's collection list. */
function collectionCaption(rows) {
  if (!rows.length) {
    return `💝 <b>YOUR WAIFU COLLECTION</b>\n\nYou haven't claimed anyone yet. Use /waifu to start your collection!`;
  }
  const list = rows.map((r, i) =>
    `${i + 1}️⃣ <b>${esc(r.name || 'Unknown')}</b>${r.series ? ` — ${esc(r.series)}` : ''}`
  ).join('\n');
  return `💝 <b>YOUR WAIFU COLLECTION</b>\n\n${list}\n\n📚 <b>${rows.length}</b> character${rows.length === 1 ? '' : 's'} claimed.`;
}

/** HTML for a single claimed character's detail. */
function detailCaption(row) {
  if (!row) return `💔 Not found.`;
  return (
    `💝 <b>${esc(row.name || 'Unknown')}</b>\n\n` +
    (row.series ? `🔗 Source: ${esc(row.series)}\n` : '') +
    `🕒 Claimed: ${new Date(row.claimed_at).toISOString().slice(0, 10)}\n` +
    `🖼️ <a href="${esc(row.image_url)}">Image link</a>`
  );
}

/** The Claim inline keyboard (gameplay-critical — always rendered). */
function claimMarkup() {
  return {
    inline_keyboard: [[{ text: '💝 Claim', callback_data: 'waifu:claim' }]],
  };
}

/* ================= API FETCH (no auth key) ================= */

/** Fetch with a hard timeout via AbortController. Returns parsed JSON or null. */
async function fetchJson(url, headers = {}, timeoutMs = config.waifu.fetchTimeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref && timer.unref();
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one random character from nekos.best. Returns canonical card or null. */
async function fetchFromNekos() {
  const json = await fetchJson(config.waifu.nekosBestUrl, {
    'User-Agent': config.waifu.userAgent,
    Accept: 'application/json',
  });
  const results = json && Array.isArray(json.results) ? json.results : null;
  if (!results || !results.length) return null;
  return normalizeCharacter(results[0], 'nekos');
}

/** Fetch one random character from waifu.pics (image only). */
async function fetchFromWaifuPics() {
  const json = await fetchJson(config.waifu.waifuPicsUrl, {
    'User-Agent': config.waifu.userAgent,
    Accept: 'application/json',
  });
  return normalizeCharacter(json, 'waifupics');
}

/**
 * Fetch a random UNCLAIMED character. Tries nekos.best first, then
 * waifu.pics, and skips any character that was already claimed (bounded
 * retries) so a claimed character is never presented again.
 */
async function fetchCharacter() {
  const attempts = [
    fetchFromNekos,
    fetchFromWaifuPics,
    fetchFromNekos,
    fetchFromWaifuPics,
  ];
  for (const fn of attempts) {
    const card = await fn();
    if (!card) continue;
    if (db.isCharacterClaimed(card.character_id)) continue;
    return card;
  }
  return null;
}

/* ================= CONTROLLER (Telegram wiring) ================= */

let deps = null;

function attach(d) {
  deps = d || null;
  return module.exports;
}

async function reply(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[waifu] reply failed:', e.message); }
  }
  return null;
}

async function sendPhoto(chatId, imageUrl, caption, markup) {
  if (deps && typeof deps.sendPhoto === 'function') {
    try { return await deps.sendPhoto(chatId, imageUrl, { caption, parse_mode: 'HTML', reply_markup: markup }); } catch (e) {
      console.warn('[waifu] sendPhoto failed, falling back to text:', e.message);
      await reply(chatId, caption, { title: '💝 WAIFU', color: '#FF80AB', html: true });
      return null;
    }
  }
  return null;
}

async function answerCb(text) {
  if (deps && typeof deps.answerCb === 'function') {
    try { await deps.answerCb(text); } catch (e) { /* non-fatal */ }
  }
}

/**
 * Spawn a new character (image + metadata + Claim button). Rejects when a
 * live, unclaimed, unexpired spawn already exists. Returns a result object.
 */
async function spawn(opts = {}) {
  if (!config.waifu.enabled) return { ok: false, message: 'The waifu collection is disabled.' };

  // Expire any stale spawn first, then check for a live one.
  expireIfNeeded();
  const existing = db.getActiveSpawn();
  if (isSpawnClaimable(existing)) {
    return {
      ok: false,
      message: `💝 A character is already up for grabs — tap <b>Claim</b> on it first! (${secondsRemaining(existing)}s left)`,
    };
  }
  if (existing) db.clearActiveSpawn();

  const card = await fetchCharacter();
  if (!card) {
    return { ok: false, message: '💔 The waifu portal is quiet right now. Try again in a moment.' };
  }

  const expiresAt = Date.now() + config.waifu.claimWindowMs;
  db.setActiveSpawn(card, expiresAt);
  const spawnRow = db.getActiveSpawn();

  await sendPhoto(
    opts.chatId,
    card.image_url,
    cardCaption(card, spawnRow),
    claimMarkup()
  );

  return { ok: true, character: card, expiresAt };
}

/**
 * Claim the currently-active spawn. First eligible user wins; the claim is
 * written through db.claimCharacter (unique on character_id), so a duplicate
 * tap can never re-claim the same character.
 */
async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;
  const spawn = db.getActiveSpawn();
  if (!spawn) {
    await answer('No character is up for grabs right now.');
    return { ok: false, reason: 'no-active-spawn' };
  }
  if (!isSpawnClaimable(spawn)) {
    await answer('This character already expired or was claimed.');
    return { ok: false, reason: 'not-claimable' };
  }

  const char = {
    character_id: spawn.character_id,
    name: spawn.name,
    series: spawn.series,
    image_url: spawn.image_url,
  };

  const row = db.claimCharacter(userId, char);
  if (!row) {
    await answer('Someone else already claimed this character!');
    return { ok: false, reason: 'already-claimed' };
  }

  // The character is claimed — clear the active spawn so a fresh one can spawn.
  db.clearActiveSpawn();

  const user = db.getUser(userId) || {};
  const claimerName = user.username ? `@${user.username}` : (user.first_name || `user ${userId}`);
  await reply(opts.chatId, cardCaption(char, spawn, claimerName), {
    title: '💝 CLAIMED',
    color: '#FF80AB',
    html: true,
  });

  return { ok: true, character: char, userId };
}

/** Expire a stale, unclaimed spawn (called by /waifu and the periodic sweep). */
function expireIfNeeded(now = Date.now()) {
  const spawn = db.getActiveSpawn();
  if (!spawn) return 0;
  if (isSpawnClaimable(spawn, now)) return 0;
  if (Number(spawn.claimed) === 1) {
    // Claimed spawns are cleared by claim(); this is a defensive cleanup.
    db.clearActiveSpawn();
    return 1;
  }
  if (Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now) {
    db.clearActiveSpawn();
    return 1;
  }
  return 0;
}

/** Expose state for tests + debug. */
function state() {
  return {
    activeSpawn: db.getActiveSpawn() || null,
    enabled: config.waifu.enabled,
  };
}

module.exports = {
  // pure
  characterIdFor,
  normalizeCharacter,
  isSpawnClaimable,
  secondsRemaining,
  cardCaption,
  collectionCaption,
  detailCaption,
  claimMarkup,
  // API fetch
  fetchCharacter,
  fetchFromNekos,
  fetchFromWaifuPics,
  // controller
  attach,
  spawn,
  claim,
  expireIfNeeded,
  state,
  _clear: () => {
    db.clearActiveSpawn();
  },
};
