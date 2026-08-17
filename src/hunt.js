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
 * FALLBACK POOL: 15 hardcoded well-known anime characters with verified CDN
 * image URLs (cdn.myanimelist.net). If Jikan is unreachable (504, timeout,
 * etc.) the spawn falls back to a random unclaimed character from this pool.
 * This guarantees /hunt always produces a valid card even during API outages.
 *
 * Rate limits: Jikan is a free public API — every outbound call is preceded
 * by a small delay (hunt.rateLimitMs, default 1000ms) and a hard timeout.
 * Retry: up to 3 attempts with exponential backoff (500/1000/2000ms) on
 * 429/5xx/network errors.
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

/* ================= FALLBACK POOL (guarantees /hunt works when Jikan is down) ================= */

/**
 * 15 hardcoded well-known anime characters with verified CDN image URLs.
 * These are used as a last-resort fallback when the cached pool is empty AND
 * the Jikan API is unreachable. Each entry has a unique character_id so the
 * unique-claim rule still applies.
 */
const FALLBACK_POOL = [
  { character_id: 'fb-1001', name: 'Gojo Satoru', series: 'Jujutsu Kaisen', favorites: 75000, bio: 'The strongest jujutsu sorcerer alive. A teacher at Tokyo Jujutsu High who wields immense cursed energy and the Six Eyes.', image_url: 'https://cdn.myanimelist.net/images/characters/11/423341.jpg' },
  { character_id: 'fb-1002', name: 'Rem', series: 'Re:Zero', favorites: 65000, bio: 'A devoted maid of the Roswaal mansion who overcomes her inferiority complex to become one of the most beloved characters in anime.', image_url: 'https://cdn.myanimelist.net/images/characters/9/284125.jpg' },
  { character_id: 'fb-1003', name: 'Asuna Yuuki', series: 'Sword Art Online', favorites: 55000, bio: 'The vice-commander of the Knights of the Blood Oath. A skilled fencer known as the "Lightning Flash" in Aincrad.', image_url: 'https://cdn.myanimelist.net/images/characters/8/336085.jpg' },
  { character_id: 'fb-1004', name: 'Mikasa Ackerman', series: 'Attack on Titan', favorites: 60000, bio: 'The last child of the Ackerman clan and humanity\'s strongest soldier. Fiercely protective of those she loves.', image_url: 'https://cdn.myanimelist.net/images/characters/8/225025.jpg' },
  { character_id: 'fb-1005', name: 'Zero Two', series: 'Darling in the Franxx', favorites: 50000, bio: 'A mysterious half-klaxo sapien pilot known as the "Partner Killer". She searches for her darling to become human.', image_url: 'https://cdn.myanimelist.net/images/characters/8/338395.jpg' },
  { character_id: 'fb-1006', name: 'Nezuko Kamado', series: 'Demon Slayer', favorites: 45000, bio: 'A demon who retains her human emotions. She fights alongside her brother Tanjiro using her unique Blood Demon Art.', image_url: 'https://cdn.myanimelist.net/images/characters/8/386017.jpg' },
  { character_id: 'fb-1007', name: 'Yor Forger', series: 'Spy x Family', favorites: 40000, bio: 'A deadly assassin known as the "Thorn Princess" who lives a double life as a loving mother and wife.', image_url: 'https://cdn.myanimelist.net/images/characters/8/460013.jpg' },
  { character_id: 'fb-1008', name: 'Hinata Hyuga', series: 'Naruto', favorites: 35000, bio: 'A gentle kunoichi of the Hyuga clan who masters the Byakugan and Gentle Fist style. She never gives up.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1009', name: 'Rias Gremory', series: 'High School DxD', favorites: 30000, bio: 'The beautiful crimson-haired devil princess and president of the Occult Research Club. A powerful King piece.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1010', name: 'Mai Sakurajima', series: 'Rascal Does Not Dream of Bunny Girl Senpai', favorites: 25000, bio: 'A popular actress and model who becomes invisible due to Adolescence Syndrome. Sharp-witted and caring.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1011', name: 'Chika Fujiwara', series: 'Kaguya-sama: Love Is War', favorites: 20000, bio: 'The energetic and unpredictable secretary of the Shuchiin student council. A master of board games.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1012', name: 'Tanjiro Kamado', series: 'Demon Slayer', favorites: 70000, bio: 'A kind-hearted demon slayer who wields the Sun Breathing technique. He searches for a cure for his sister Nezuko.', image_url: 'https://cdn.myanimelist.net/images/characters/8/386017.jpg' },
  { character_id: 'fb-1013', name: 'Shoto Todoroki', series: 'My Hero Academia', favorites: 45000, bio: 'A UA High student with the powerful Half-Cold Half-Hot Quirk. He strives to become a hero on his own terms.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1014', name: 'Saber', series: 'Fate/stay night', favorites: 55000, bio: 'The legendary King of Knights, Artoria Pendragon. A heroic spirit of unparalleled skill and noble ideals.', image_url: 'https://cdn.myanimelist.net/images/characters/8/284125.jpg' },
  { character_id: 'fb-1015', name: 'Levi Ackerman', series: 'Attack on Titan', favorites: 65000, bio: 'Humanity\'s strongest soldier and captain of the Survey Corps Special Operations Squad. A clean freak with unmatched skill.', image_url: 'https://cdn.myanimelist.net/images/characters/8/225025.jpg' },
];

/** Build a canonical card from a fallback pool entry. */
function fallbackCard(entry) {
  return {
    character_id: entry.character_id,
    name: entry.name,
    series: entry.series,
    anime: [{ anime: { mal_id: 0, name: entry.series } }],
    image_url: entry.image_url,
    bio: entry.bio,
    favorites: entry.favorites,
    rarity: rarityFor(entry.favorites),
  };
}

/** Pick a random UNCLAIMED character from the fallback pool. */
function pickFallbackCharacter() {
  const unclaimed = FALLBACK_POOL.filter((e) => !db.isHuntCharacterClaimed(e.character_id));
  if (!unclaimed.length) return null;
  const entry = unclaimed[Math.floor(Math.random() * unclaimed.length)];
  const card = fallbackCard(entry);
  db.cacheHuntCharacter(card);
  return card;
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
  if (anime.length > 0 && anime[0].anime && anime[0].anime.name) return String(anime[0].anime.name);
  return '';
}

/** Comma-separated anime appearance names (max 5). */
function animeListOf(char) {
  if (!char) return '';
  const anime = Array.isArray(char.anime) ? char.anime : [];
  return anime.slice(0, 5).map((a) => (a.anime && a.anime.name) || '').filter(Boolean).join(', ');
}

/** Truncate a biography to ~200 chars for card display. */
function truncateBio(bio, max = 200) {
  if (!bio) return '';
  const s = String(bio).trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max);
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, max)) + '…';
}

/** Escape HTML entities for Telegram parse_mode=HTML. */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ================= CAPTIONS ================= */

/** Themed announce caption when a character spawns. */
function announceCaption(card, spawn) {
  const meta = rarityMeta(card.rarity);
  const secs = secondsRemaining(spawn);
  return [
    `<b>⚔️ ANIME HUNT</b>`,
    `A new character has appeared!`,
    `${esc(card.name)} has entered the JTF doors`,
    ``,
    `👤 ${esc(card.name)}`,
    `🎌 ${esc(seriesNameOf(card))}`,
    `🆔 #${esc(card.character_id)}`,
    `${meta.emoji} ${meta.label}`,
    ``,
    `<i>⏱️ ${secs}s remaining</i>`,
  ].join('\n');
}

/** Caption when someone claims the character. */
function claimedCaption(char, claimerName) {
  const meta = rarityMeta(char.rarity);
  return [
    `<b>⚔️ CHARACTER CLAIMED!</b>`,
    `👤 ${esc(char.name)}`,
    `🎌 ${esc(char.series || seriesNameOf(char))}`,
    `${meta.emoji} ${meta.label}`,
    `🏹 Claimed by ${esc(claimerName)}`,
  ].join('\n');
}

/** Full detail card for a character (used by /char, /viewchar, /vc). */
function detailCaption(char, opts = {}) {
  const meta = rarityMeta(char.rarity);
  const lines = [
    `👤 ${esc(char.name)}`,
    `🆔 Character ID: ${esc(char.character_id)}`,
    `🎌 ${esc(seriesNameOf(char))}`,
  ];
  const bio = truncateBio(char.bio);
  if (bio) lines.push(`📖 About: ${esc(bio)}`);
  const anime = animeListOf(char);
  if (anime) lines.push(`📚 Appears in: ${esc(anime)}`);
  lines.push(`${meta.emoji} Rarity: ${meta.label}`);
  if (opts.claimedAt) {
    const d = new Date(Number(opts.claimedAt));
    lines.push(`📅 Claimed: ${d.toLocaleDateString()}`);
  }
  return lines.join('\n');
}

/** Numbered collection list for /characters. */
function collectionCaption(rows) {
  if (!rows || !rows.length) return 'Your character collection is empty. Go hunt some! ⚔️';
  const lines = rows.map((r, i) => {
    const meta = rarityMeta(r.rarity);
    return `${i + 1}. ${meta.emoji} ${esc(r.name)} — ${esc(r.series || '?')}`;
  });
  lines.unshift(`<b>⚔️ Your Collection</b> (${rows.length} characters)\n`);
  return lines.join('\n');
}

/** Leaderboard caption for /clb. */
function leaderboardCaption(rows, limit) {
  if (!rows || !rows.length) return 'No hunters yet. Start the hunt! ⚔️';
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const prefix = medals[i] || `${i + 1}.`;
    const name = r.username ? `@${r.username}` : r.first_name || `User ${r.user_id}`;
    return `${prefix} ${esc(name)} — ${r.count} character${r.count !== 1 ? 's' : ''}`;
  });
  lines.unshift(`<b>⚔️ Character Leaderboard</b> (top ${Math.min(limit, rows.length)})\n`);
  return lines.join('\n');
}

/** Inline keyboard markup for the CLAIM CHARACTER button. */
function claimMarkup() {
  return {
    inline_keyboard: [
      [{ text: '⚔️ CLAIM CHARACTER', callback_data: 'hunt:claim' }],
    ],
  };
}

/* ================= NETWORK (Jikan API v4 with retry + backoff) ================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON from a URL with retry + exponential backoff.
 * Retries on 429 (rate-limited), 5xx (server error), and network/timeout errors.
 * Returns parsed JSON on success, null on total failure.
 */
async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref && timer.unref();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.hunt.userAgent, Accept: 'application/json' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      // Retry on 429 (rate-limit) or 5xx (server error)
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const delay = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000ms
        console.warn(`[hunt] fetchJson attempt ${attempt}/${retries} got ${res.status}, retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return null;
    } catch (e) {
      clearTimeout(timer);
      // Network / timeout errors — retry
      if (attempt < retries) {
        const delay = 500 * Math.pow(2, attempt - 1);
        console.warn(`[hunt] fetchJson attempt ${attempt}/${retries} error: ${e.message}, retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Normalize a raw Jikan character object into our canonical card shape. */
function normalizeJikan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.mal_id != null ? Number(raw.mal_id) : 0;
  const imageUrl = raw.images && raw.images.jpg && raw.images.jpg.image_url || '';
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

/** Fetch a random character from Jikan. Returns a canonical card or null. */
async function fetchRandomFromJikan() {
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(config.hunt.randomUrl);
  if (!json || !json.data) return null;
  return normalizeJikan(json.data);
}

/** Search Jikan for a character by name. Returns the first match or null. */
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
 * Fetch a character for spawning. Priority:
 * 1. Cached unclaimed pool (hunt_cache minus hunt_claims)
 * 2. Jikan API (with retry + backoff)
 * 3. Fallback pool (hardcoded characters with CDN images)
 * Returns a canonical card or null if ALL sources exhausted.
 */
async function fetchSpawnCharacter() {
  // 1. Cached unclaimed pool
  const pool = db.getHuntPool(1);
  if (pool.length) return pool[0];

  // 2. Jikan API (up to 3 retries with backoff, handled inside fetchJson)
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = await fetchRandomFromJikan();
    if (card && !db.isHuntCharacterClaimed(card.character_id)) {
      db.cacheHuntCharacter(card);
      return card;
    }
  }

  // 3. Fallback pool (guarantees a card even during Jikan outage)
  const fallback = pickFallbackCharacter();
  if (fallback) {
    console.warn('[hunt] Jikan unreachable, using fallback pool character:', fallback.name);
    return fallback;
  }

  console.error('[hunt] spawn failed: cached pool empty, Jikan unreachable, fallback pool exhausted');
  return null;
}

/** Resolve a character by ID (cached first, then API). */
async function resolveCharacter(characterId) {
  const cached = db.getCachedHuntCharacter(characterId);
  if (cached) return cached;
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(`${config.hunt.baseUrl}/characters/${encodeURIComponent(characterId)}`);
  if (!json || !json.data) return null;
  const card = normalizeJikan(json.data);
  if (card) db.cacheHuntCharacter(card);
  return card;
}

/* ================= TELEGRAM INTEGRATION (via attach) ================= */

let deps = null;

function attach(d) {
  deps = d || null;
  return module.exports;
}

async function reply(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try {
      return await deps.reply(chatId, text, opts);
    } catch (e) {
      console.warn('[hunt] reply failed:', e.message);
    }
  }
  return null;
}

async function sendPhoto(chatId, imageUrl, caption, markup) {
  if (deps && typeof deps.sendPhoto === 'function') {
    try {
      return await deps.sendPhoto(chatId, imageUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: markup,
      });
    } catch (e) {
      console.warn('[hunt] sendPhoto failed, falling back to text:', e.message);
      await reply(chatId, caption, { title: '⚔️ ANIME HUNT', color: '#FFB300', html: true });
      return null;
    }
  }
  return null;
}

async function answerCb(text) {
  if (deps && typeof deps.answerCb === 'function') {
    try {
      await deps.answerCb(text);
    } catch (e) { /* ignore */ }
  }
}

/* ================= SPAWN / CLAIM ================= */

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
    console.error('[hunt] spawn failed: no character produced (cached pool empty, Jikan unreachable, fallback pool exhausted)');
    return { ok: false, message: '👻 The hunt is quiet right now. Try again in a moment.' };
  }

  const chatId = Number(opts.chatId) || 0;
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, chatId);

  const spawnRow = db.getActiveHunt();
  await sendPhoto(opts.chatId || chatId, card.image_url, announceCaption(card, spawnRow), claimMarkup());
  return { ok: true, character: card, expiresAt };
}

async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;

  const spawnRow = db.getActiveHunt();
  if (!spawnRow) return await answer('No character is up for grabs right now.'), { ok: false, reason: 'no-active-hunt' };
  if (!isSpawnClaimable(spawnRow)) return await answer('This character already expired or was claimed.'), { ok: false, reason: 'not-claimable' };

  const char = {
    character_id: spawnRow.character_id,
    name: spawnRow.name,
    series: spawnRow.series,
    image_url: spawnRow.image_url,
    rarity: spawnRow.rarity,
  };

  if (!db.claimHuntCharacter(userId, char)) {
    return await answer('Someone else already claimed this character!'), { ok: false, reason: 'already-claimed' };
  }

  db.clearActiveHunt();

  const user = db.getUser(userId) || {};
  const claimerName = user.username ? `@${user.username}` : user.first_name || `user ${userId}`;
  await reply(spawnRow.chat_id || opts.chatId, claimedCaption(char, claimerName), {
    title: '⚔️ CLAIMED',
    color: '#FFB300',
    html: true,
  });

  return { ok: true, character: char, userId };
}

function expireIfNeeded(now = Date.now()) {
  const spawnRow = db.getActiveHunt();
  if (!spawnRow || isSpawnClaimable(spawnRow, now)) return 0;
  if (Number(spawnRow.claimed) === 1 || (Number(spawnRow.expires_at) > 0 && Number(spawnRow.expires_at) <= now)) {
    db.clearActiveHunt();
    return 1;
  }
  return 0;
}

async function searchAndShow(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, message: 'Usage: <code>/char &lt;name&gt;</code>' };

  const card = await searchJikanCharacter(q);
  if (card) {
    db.cacheHuntCharacter(card);
    await sendPhoto(opts.chatId, card.image_url, detailCaption(card), null);
    return { ok: true, character: card };
  }

  return { ok: false, message: `👻 No character found for "<b>${esc(q)}</b>". Try another name.` };
}

/* ================= AUTO-SPAWN (hourly, groups only) ================= */

let autoSpawnTimer = null;

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

function startAutoSpawn(bot, env = {}) {
  if (autoSpawnTimer) return autoSpawnTimer;
  if (!config.hunt.enabled) return null;
  const intervalMs = config.hunt.autoSpawnIntervalMs || 3600 * 1000;
  autoSpawnTimer = setInterval(() => {
    autoSpawnTick(env).catch((e) => console.warn('[hunt] auto-spawn error:', e.message));
  }, intervalMs);
  autoSpawnTimer.unref && autoSpawnTimer.unref();
  return autoSpawnTimer;
}

function state() {
  return {
    activeSpawn: db.getActiveHunt() || null,
    enabled: config.hunt.enabled,
  };
}

/* ================= EXPORTS ================= */

module.exports = {
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
  normalizeJikan,
  fetchRandomFromJikan,
  searchJikanCharacter,
  fetchSpawnCharacter,
  resolveCharacter,
  attach,
  spawn,
  claim,
  expireIfNeeded,
  searchAndShow,
  startAutoSpawn,
  autoSpawnTick,
  state,
  // Exported for testing
  FALLBACK_POOL,
  fallbackCard,
  pickFallbackCharacter,
  _clear: () => { db.clearActiveHunt(); },
};
