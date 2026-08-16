'use strict';
/**
 * Rimuru Tempest Casino — Anime Hunt feature ⚔️
 *
 * FULLY ISOLATED: no coin rewards, no rank progression, no game-stat or
 * economy hooks. It has its own Postgres tables (hunt_cache, hunt_claims,
 * hunt_spawn) and its own commands (/hunt, /shunt, /char, /whois,
 * /characters, /viewchar, /vc, /clb).
 *
 * Data source: Jikan API v4 (https://api.jikan.moe/v4) — free, public,
 * NO API key required.
 *   - /v4/random/characters  → spawns
 *   - /v4/characters?q=<name> → /char /whois search
 * Character data (id, name, image, bio, anime list, favorites) is CACHED in
 * Postgres (hunt_cache) rather than repeatedly hitting the API. Random spawns
 * pull from the pool of cached characters first, then top up from the API.
 *
 * Rate limits: Jikan is a free public API — every outbound call is preceded
 * by a small delay (hunt.rateLimitMs, default 1000ms) and a hard timeout.
 *
 * Rarity is data-driven from the favorites count:
 *   ⚪ Common     < 500
 *   🔵 Rare       ≥ 500
 *   🟣 Epic       ≥ 5,000
 *   🟠 Legendary  ≥ 20,000
 *   🔴 Mythic     ≥ 50,000
 *
 * Persistence goes through the existing db layer (hunt_* helpers), so
 * claims, cached characters and the active spawn survive redeploys via the
 * v4 mirror pipeline. It does NOT touch advisory locking, hydration, or
 * fencing beyond registering its tables in TABLE_COLS/TABLE_PKS.
 */
const config = require('./config');
const db = require('./db');

/* ================= RARITY (data-driven from Jikan favorites) ================= */

const RARITY_TIERS = [
  { key: 'mythic', emoji: '🔴', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '🟠', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '🟣', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '🔵', label: 'RARE', min: 500 },
  { key: 'common', emoji: '⚪', label: 'COMMON', min: 0 },
];

/** Map a Jikan favorites count to a rarity key (⚪🔵🟣🟠🔴). */
function rarityFor(favorites) {
  const f = Number(favorites) || 0;
  for (const t of RARITY_TIERS) {
    if (f >= t.min) return t.key;
  }
  return 'common';
}

function rarityMeta(key) {
  return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1];
}

/* ================= PURE LOGIC (testable, no Telegram / network) ================= */

/** True when a hunt spawn row is still claimable (exists, unclaimed, unexpired). */
function isSpawnClaimable(spawn, now = Date.now()) {
  if (!spawn) return false;
  if (Number(spawn.claimed) === 1) return false;
  if (Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now) return false;
  return true;
}

/** How many seconds remain until a hunt spawn expires (0 when none/expired). */
function secondsRemaining(spawn, now = Date.now()) {
  if (!spawn) return 0;
  const left = Number(spawn.expires_at) - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** A character's series name (from Jikan anime array or name string). */
function seriesNameOf(char) {
  if (!char) return '';
  if (char.series) return String(char.series);
  const anime = Array.isArray(char.anime) ? char.anime : [];
  const first = anime[0];
  if (typeof first === 'string') return first;
  if (first && typeof first.anime === 'object' && first.anime && typeof first.anime.name === 'string') return first.anime.name;
  if (first && typeof first.name === 'string') return first.name;
  return '';
}

/** Up to N anime names (comma-joined) for the "Appears in" line. */
function animeListOf(char, max = 4) {
  const anime = Array.isArray(char.anime) ? char.anime : [];
  const names = anime
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a && typeof a.anime === 'object' && a.anime && typeof a.anime.name === 'string') return a.anime.name;
      return (a && a.name) || '';
    })
    .filter((s) => String(s).trim().length > 0)
    .slice(0, max);
  return names;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncate a biography for the detail card (keep it readable). */
function truncateBio(bio, max = 500) {
  const t = String(bio || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** The themed ⚔️ ANIME HUNT announcement card (with claim countdown). */
function announceCaption(char, spawn) {
  const rm = rarityMeta(char.rarity);
  const lines = [
    `⚔️ <b>ANIME HUNT</b>`,
    ``,
    `A new character has appeared!`,
    `<b>${esc(char.name)}</b> has entered the JTF doors`,
    ``,
    `${rm.emoji} <b>${esc(char.name)}</b>`,
    seriesNameOf(char) ? `🎌 ${esc(seriesNameOf(char))}` : '',
    `🆔 #${esc(String(char.character_id || '').slice(0, 12))}`,
    ``,
    `⏳ <b>${secondsRemaining(spawn)}s</b> to claim — first tap wins!`,
  ].filter((l) => l !== '');
  return lines.join('\n');
}

/** The ⚔️ CHARACTER CLAIMED confirmation card. */
function claimedCaption(char, claimerName) {
  const rm = rarityMeta(char.rarity);
  const lines = [
    `⚔️ <b>CHARACTER CLAIMED!</b>`,
    ``,
    `👤 ${esc(char.name)}`,
    seriesNameOf(char) ? `🎌 ${esc(seriesNameOf(char))}` : '',
    `${rm.emoji} <b>${rm.label}</b>`,
    `🏹 Claimed by <b>${esc(claimerName)}</b>`,
  ].filter((l) => l !== '');
  return lines.join('\n');
}

/** The full character detail card (/char /whois /viewchar /vc). */
function detailCaption(char, opts = {}) {
  if (!char) return '👻 <b>Character not found.</b>';
  const rm = rarityMeta(char.rarity);
  const series = seriesNameOf(char);
  const anime = animeListOf(char, 4);
  const bio = truncateBio(char.bio || opts.bio, 500);
  const lines = [
    `👤 <b>${esc(char.name)}</b>`,
    `🆔 Character ID: ${esc(String(char.character_id || ''))}`,
    series ? `🎌 ${esc(series)}` : '',
    bio ? `📖 About: ${esc(bio)}` : '',
    anime.length ? `📚 Appears in: ${esc(anime.join(', '))}` : '',
    `💎 Rarity: ${rm.emoji} ${rm.label}`,
    opts.claimedAt ? `🗓 Claimed: ${new Date(opts.claimedAt).toISOString().slice(0, 10)}` : '',
  ].filter((l) => l !== '');
  return lines.join('\n');
}

/** A user's hunt collection (numbered/orderly). */
function collectionCaption(rows) {
  if (!rows.length) {
    return `⚔️ <b>YOUR CHARACTER COLLECTION</b>\n\nYou haven't claimed anyone yet. Keep an eye out for the next hunt!`;
  }
  const list = rows.map((r, i) => {
    const rm = rarityMeta(r.rarity);
    return `${i + 1}. ${rm.emoji} <b>${esc(r.name || 'Unknown')}</b>${r.series ? ` — ${esc(r.series)}` : ''}`;
  }).join('\n');
  return (
    `⚔️ <b>YOUR CHARACTER COLLECTION</b>\n\n${list}\n\n` +
    `📚 <b>${rows.length}</b> character${rows.length === 1 ? '' : 's'} claimed.\n\n` +
    `Use /viewchar &lt;number&gt; to view one.`
  );
}

/** The character-collection leaderboard (/clb). */
function leaderboardCaption(rows, limit = 10) {
  if (!rows.length) {
    return `⚔️ <b>CHARACTER LEADERBOARD</b>\n\nNobody has claimed a character yet. Be the first hunter!`;
  }
  const list = rows.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const name = esc(r.name || r.first_name || r.username || `User ${r.user_id}`);
    const count = Number(r.count) || 0;
    return `${medal} <b>${name}</b> — ${count} character${count === 1 ? '' : 's'}`;
  }).join('\n');
  return `⚔️ <b>CHARACTER LEADERBOARD</b> (top ${limit})\n\n${list}`;
}

/** The CLAIM CHARACTER inline keyboard. */
function claimMarkup() {
  return {
    inline_keyboard: [[{ text: '⚔️ CLAIM CHARACTER', callback_data: 'hunt:claim' }]],
  };
}

/* ================= JIKAN API (free, public, no key) ================= */

/** Sleep helper — Jikan rate-limit courtesy delay. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch JSON with a hard timeout (AbortController). Returns parsed JSON or null. */
async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref && timer.unref();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': config.hunt.userAgent,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a Jikan character object into a canonical hunt card. */
function normalizeJikan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.mal_id != null ? Number(raw.mal_id) : 0;
  const imageUrl = raw.images && raw.images.jpg ? (raw.images.jpg.image_url || '') : '';
  if (!id || !imageUrl) return null;
  const favorites = Number(raw.favorites) || 0;
  return {
    character_id: String(id),
    name: String(raw.name || '').trim() || 'Unknown',
    series: '',
    anime: Array.isArray(raw.anime) ? raw.anime.slice(0, 8) : [],
    image_url: imageUrl,
    bio: String(raw.about || '').trim(),
    favorites,
    rarity: rarityFor(favorites),
  };
}

/** Fetch ONE random character from Jikan. Honors the rate-limit delay. */
async function fetchRandomFromJikan() {
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(config.hunt.randomUrl);
  if (!json || !json.data) return null;
  return normalizeJikan(json.data);
}

/** Search Jikan for a character by name. Honors the rate-limit delay. */
async function searchJikanCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  await sleep(config.hunt.rateLimitMs);
  const url = `${config.hunt.searchUrl}?q=${encodeURIComponent(q)}&limit=1`;
  const json = await fetchJson(url);
  if (!json || !Array.isArray(json.data) || !json.data.length) return null;
  return normalizeJikan(json.data[0]);
}

/**
 * Spawn a character: prefer the cached, unclaimed pool (no API hit); when the
 * pool is empty, fetch from Jikan (bounded retries) and cache the result.
 * Never returns an already-claimed character.
 */
async function fetchSpawnCharacter() {
  const pool = db.getHuntPool(1);
  if (pool.length) return pool[0];

  for (let attempt = 0; attempt < 3; attempt++) {
    const card = await fetchRandomFromJikan();
    if (!card) continue;
    if (db.isHuntCharacterClaimed(card.character_id)) continue;
    db.cacheHuntCharacter(card);
    return card;
  }
  return null;
}

/** Resolve a character by id: cache first, then Jikan (search by id fallback). */
async function resolveCharacter(characterId) {
  const cached = db.getCachedHuntCharacter(characterId);
  if (cached) return cached;
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(`${config.hunt.baseUrl}/characters/${encodeURIComponent(characterId)}`);
  if (!json || !json.data) return null;
  const card = normalizeJikan(json.data);
  if (!card) return null;
  db.cacheHuntCharacter(card);
  return card;
}

/* ================= CONTROLLER (Telegram wiring) ================= */

let deps = null;

function attach(d) {
  deps = d || null;
  return module.exports;
}

async function reply(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[hunt] reply failed:', e.message); }
  }
  return null;
}

async function sendPhoto(chatId, imageUrl, caption, markup) {
  if (deps && typeof deps.sendPhoto === 'function') {
    try { return await deps.sendPhoto(chatId, imageUrl, { caption, parse_mode: 'HTML', reply_markup: markup }); } catch (e) {
      console.warn('[hunt] sendPhoto failed, falling back to text:', e.message);
      await reply(chatId, caption, { title: '⚔️ ANIME HUNT', color: '#FFB300', html: true });
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
 * Spawn a new hunt (image + metadata + CLAIM CHARACTER button). Rejects when
 * a live, unclaimed, unexpired hunt already exists. `chatId` is where the
 * spawn is announced; it is persisted so the claim can reply in that chat.
 */
async function spawn(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'The Anime Hunt is disabled.' };

  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) {
    return {
      ok: false,
      message: `⚔️ A character is already up for grabs — tap <b>CLAIM CHARACTER</b> on it first! (${secondsRemaining(existing)}s left)`,
    };
  }
  if (existing) db.clearActiveHunt();

  const card = await fetchSpawnCharacter();
  if (!card) {
    return { ok: false, message: '👻 The hunt is quiet right now. Try again in a moment.' };
  }

  const chatId = Number(opts.chatId) || 0;
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, chatId);
  const spawnRow = db.getActiveHunt();

  await sendPhoto(
    opts.chatId || chatId,
    card.image_url,
    announceCaption(card, spawnRow),
    claimMarkup()
  );

  return { ok: true, character: card, expiresAt };
}

/**
 * Claim the active hunt. First eligible user wins; the claim goes through
 * db.claimHuntCharacter (unique on character_id), so a duplicate tap can
 * never re-claim the same character.
 */
async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;
  const spawn = db.getActiveHunt();
  if (!spawn) {
    await answer('No character is up for grabs right now.');
    return { ok: false, reason: 'no-active-hunt' };
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
    rarity: spawn.rarity,
  };

  const row = db.claimHuntCharacter(userId, char);
  if (!row) {
    await answer('Someone else already claimed this character!');
    return { ok: false, reason: 'already-claimed' };
  }

  // Claimed — clear the active hunt so a fresh one can spawn.
  db.clearActiveHunt();

  const user = db.getUser(userId) || {};
  const claimerName = user.username ? `@${user.username}` : (user.first_name || `user ${userId}`);
  await reply(spawn.chat_id || opts.chatId, claimedCaption(char, claimerName), {
    title: '⚔️ CLAIMED',
    color: '#FFB300',
    html: true,
  });

  return { ok: true, character: char, userId };
}

/** Expire a stale, unclaimed hunt (called by /hunt and the periodic sweep). */
function expireIfNeeded(now = Date.now()) {
  const spawn = db.getActiveHunt();
  if (!spawn) return 0;
  if (isSpawnClaimable(spawn, now)) return 0;
  if (Number(spawn.claimed) === 1) {
    db.clearActiveHunt();
    return 1;
  }
  if (Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now) {
    db.clearActiveHunt();
    return 1;
  }
  return 0;
}

/**
 * /char (alias /whois) — search Jikan for a character and display their info.
 * Results are cached in Postgres; the character is NOT claimed by viewing.
 */
async function searchAndShow(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, message: 'Usage: <code>/char &lt;name&gt;</code>' };

  const card = await searchJikanCharacter(q);
  if (!card) {
    return { ok: false, message: `👻 No character found for "<b>${esc(q)}</b>". Try another name.` };
  }
  db.cacheHuntCharacter(card);

  await sendPhoto(
    opts.chatId,
    card.image_url,
    detailCaption(card),
    null
  );
  return { ok: true, character: card };
}

/* ================= AUTO-SPAWN (hourly, GROUPS ONLY) ================= */

let autoSpawnTimer = null;

/**
 * Hourly auto-spawn tick: skip when a live hunt already exists, otherwise
 * spawn a fresh character and announce it to every known GROUP chat (never
 * DMs — group chat ids are negative on Telegram).
 */
async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveHunt())) return;

  const card = await fetchSpawnCharacter();
  if (!card) return;

  const groupIds = (typeof env.getChatIds === 'function' ? env.getChatIds() : [])
    .filter((cid) => Number(cid) < 0);

  if (!groupIds.length) return;

  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, groupIds[0]);
  const spawnRow = db.getActiveHunt();
  const caption = announceCaption(card, spawnRow);
  const markup = claimMarkup();

  for (const gid of groupIds) {
    await sendPhoto(gid, card.image_url, caption, markup);
  }
}

/**
 * Start the hourly group-only auto-spawn loop. Returns the interval handle
 * (or null when disabled). Idempotent — repeated calls return the existing timer.
 */
function startAutoSpawn(bot, env = {}) {
  if (autoSpawnTimer) return autoSpawnTimer;
  if (!config.hunt.enabled) return null;
  const intervalMs = config.hunt.autoSpawnIntervalMs || (60 * 60 * 1000);
  autoSpawnTimer = setInterval(() => {
    autoSpawnTick(env).catch((e) => console.warn('[hunt] auto-spawn error:', e.message));
  }, intervalMs);
  autoSpawnTimer.unref && autoSpawnTimer.unref();
  return autoSpawnTimer;
}

/** Expose state for tests + debug. */
function state() {
  return {
    activeSpawn: db.getActiveHunt() || null,
    enabled: config.hunt.enabled,
  };
}

module.exports = {
  // pure
  RARITY_TIERS,
  rarityFor,
  rarityMeta,
  isSpawnClaimable,
  secondsRemaining,
  seriesNameOf,
  animeListOf,
  truncateBio,
  announceCaption,
  claimedCaption,
  detailCaption,
  collectionCaption,
  leaderboardCaption,
  claimMarkup,
  // Jikan
  normalizeJikan,
  fetchRandomFromJikan,
  searchJikanCharacter,
  fetchSpawnCharacter,
  resolveCharacter,
  // controller
  attach,
  spawn,
  claim,
  expireIfNeeded,
  searchAndShow,
  startAutoSpawn,
  autoSpawnTick,
  state,
  _clear: () => {
    db.clearActiveHunt();
  },
};
