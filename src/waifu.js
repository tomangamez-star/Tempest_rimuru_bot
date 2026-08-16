'use strict';
/**
 * Rimuru Tempest Casino — Waifu character-collection feature 💝
 *
 * FULLY ISOLATED: no coin rewards, no rank progression, no game-stat or
 * economy hooks. It has its own Postgres tables (waifu_claims, waifu_spawn)
 * and its own commands (/waifu, /wspawn, /collection, /waifus, /character,
 * /viewwaifu, /vw, /wlb).
 *
 * Character source (no API key): nekos.best /api/v2/waifu (image + artist +
 * source metadata) is primary; waifu.pics /sfw/waifu (image URL only) is the
 * automatic fallback. Every response is normalized to a canonical character
 * card and its identity is derived from the image URL, so the same image can
 * never be claimed twice.
 *
 * URL/LINK POLICY: image URLs, source URLs and artist links are NEVER shown
 * in captions or messages. The image URL is kept only as an internal field so
 * the bot can fetch the photo bytes for sendPhoto.
 *
 * NAMES: APIs don't reliably return a real English character name, so every
 * card gets a clean name — the API value is used only when it validates as a
 * readable English name, otherwise a curated anime-name is assigned.
 *
 * Persistence goes through the existing db layer (waifu_* helpers), so
 * claims and the active spawn survive redeploys via the v4 mirror pipeline.
 * It does NOT touch advisory locking, hydration, or fencing.
 */
const config = require('./config');
const db = require('./db');
const crypto = require('crypto');

/* ================= CURATED CHARACTER NAMES (no API key, always clean English) ================= */

const CHARACTER_NAMES = [
  'Rem', 'Ram', 'Emilia', 'Asuna Yuuki', 'Mikasa Ackerman', 'Zero Two',
  'Hinata Hyuga', 'Nezuko Kamado', 'Mai Sakurajima', 'Chika Fujiwara',
  'Rias Gremory', 'Yor Forger', 'Aqua', 'Megumin', 'Darkness', 'Raphtalia',
  'Holo', 'Saber', 'Rin Tohsaka', 'Sakura Haruno', 'Ino Yamanaka', 'Temari',
  'Erza Scarlet', 'Lucy Heartfilia', 'Mirajane Strauss', 'Wendy Marvell',
  'Nami', 'Nico Robin', 'Boa Hancock', 'Bulma', 'Android 18', 'Chi-Chi',
  'Videl', 'Tsunade', 'Kushina Uzumaki', 'Mei Terumi', 'Konan',
  'Orihime Inoue', 'Rukia Kuchiki', 'Yoruichi Shihoin', 'Rangiku Matsumoto',
  'Momo Hinamori', 'Hiyori Sarugaki', 'Nelliel Tu Odelschwanck',
  'Tier Harribel', 'Retsu Unohana', 'Soifon', 'Nanao Ise', 'Isane Kotetsu',
  'Tohru', 'Kanna Kamui', 'Lucoa', 'Elma', 'Shion', 'Shuna', 'Milim Nava',
  'Ramiris', 'Testarossa', 'Ultima', 'Carrera', 'Sistina', 'Tione Hiryute',
  'Ais Wallenstein', 'Hestia', 'Ryuu Lion', 'Liliruca Arde', 'Eina Tulle',
  'Syr Flover', 'Haruhime', 'Wiz', 'Yunyun', 'Iris', 'Claire Kagenou',
  'Alexia Midgar', 'Beta', 'Alpha', 'Albedo', 'Shalltear Bloodfallen',
  'Aura Bella Fiora', 'Mare Bello Fiore', 'CZ2128 Delta', 'Narberal Gamma',
  'Solution Epsilon', 'Entoma Vasilissa Zeta', 'Zesshi Zetsumei', 'Makima',
  'Power', 'Kobeni Higashiyama', 'Asa Mitaka', 'Reze', 'Rikka Takanashi',
  'Shouko Nishimiya', 'Yui Hirasawa', 'Mio Akiyama', 'Ritsu Tainaka',
  'Tsumugi Kotobuki', 'Azusa Nakano', 'Sawako Yamanaka', 'Miku Nakano',
  'Nino Nakano', 'Ichika Nakano', 'Yotsuba Nakano', 'Itsuki Nakano',
  'Yumeko Jabami', 'Mary Saotome', 'Kirari Momobami', 'Kaguya Shinomiya',
  'Ai Hayasaka', 'Kei Shirogane', 'Hina Amano', 'Nagisa Furukawa',
  'Tomoyo Sakagami', 'Kyou Fujibayashi', 'Kotomi Ichinose', 'Fuko Ibuki',
  'Ushio Okazaki', 'Akane Tendo', 'Shampoo', 'Ukyo Kuonji', 'Kasumi Tendo',
  'Nabiki Tendo', 'Haruhi Suzumiya', 'Yuki Nagato', 'Mikuru Asahina',
  'Tsuruya', 'Sango', 'Kagome Higurashi', 'Rin Shima', 'Nadeshiko Kagamihara',
  'Aoi Inuyama', 'Chizuru Ichinose', 'Sumi Sakurasawa', 'Mami Nanami',
];

const CLEAN_NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,40}$/;

/** True when the API returned a usable English name (not gibberish/URLs). */
function isCleanEnglishName(s) {
  return CLEAN_NAME_RE.test(String(s || '').trim());
}

/** Pick a stable, readable name from the curated list. */
function randomCharacterName() {
  return CHARACTER_NAMES[Math.floor(Math.random() * CHARACTER_NAMES.length)];
}

/** Series text is only shown when it is a real name, never a URL/link. */
function displaySeries(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return '';
  return t;
}

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
 *
 * URL fields (source_url, artist_href) are intentionally dropped — the bot
 * never displays links. The image URL is kept only for sendPhoto.
 */
function normalizeCharacter(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const imageUrl = String(raw.url || '').trim();
  if (!imageUrl) return null;

  let name = '';
  if (source === 'nekos') {
    const candidate = String(raw.artist_name || '').trim();
    name = isCleanEnglishName(candidate) ? candidate : randomCharacterName();
  } else {
    name = randomCharacterName();
  }

  return {
    character_id: characterIdFor(imageUrl),
    name,
    series: '',
    image_url: imageUrl,
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

/** HTML caption for a spawned character card (no links shown). */
function cardCaption(char, spawn, claimerName = null) {
  const lines = [
    `💝 <b>WAIFU DROPPED</b>`,
    ``,
    `🎨 <b>${esc(char.name)}</b>`,
  ];
  lines.push(``);
  if (claimerName) {
    lines.push(`✅ Claimed by <b>${esc(claimerName)}</b>`);
  } else {
    lines.push(`⏳ <b>${secondsRemaining(spawn)}s</b> to claim — first tap wins!`);
  }
  return lines.join('\n');
}

/** HTML for a user's collection list (numbered, no links). */
function collectionCaption(rows) {
  if (!rows.length) {
    return `💝 <b>YOUR WAIFU COLLECTION</b>\n\nYou haven't claimed anyone yet. Use /waifu to start your collection!`;
  }
  const list = rows.map((r, i) => {
    const series = displaySeries(r.series);
    return `${i + 1}. <b>${esc(r.name || 'Unknown')}</b>${series ? ` — ${esc(series)}` : ''}`;
  }).join('\n');
  return `💝 <b>YOUR WAIFU COLLECTION</b>\n\n${list}\n\n📚 <b>${rows.length}</b> character${rows.length === 1 ? '' : 's'} claimed.\n\nUse /viewwaifu &lt;number&gt; to view one.`;
}

/** HTML for a single claimed character's detail (no links shown). */
function detailCaption(row) {
  if (!row) return `💔 Not found.`;
  const series = displaySeries(row.series);
  return (
    `💝 <b>${esc(row.name || 'Unknown')}</b>\n\n` +
    (series ? `📺 Series: ${esc(series)}\n` : '') +
    `🕒 Claimed: ${new Date(row.claimed_at).toISOString().slice(0, 10)}`
  );
}

/** HTML for the collection-count leaderboard (/wlb). */
function leaderboardCaption(rows) {
  if (!rows.length) {
    return `💝 <b>WAIFU LEADERBOARD</b>\n\nNobody has claimed a waifu yet. Be the first!`;
  }
  const list = rows.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const name = esc(r.name || r.first_name || r.username || `User ${r.user_id}`);
    const count = Number(r.count) || 0;
    return `${medal} <b>${name}</b> — ${count} waifu${count === 1 ? '' : 's'}`;
  }).join('\n');
  return `💝 <b>WAIFU COLLECTION LEADERBOARD</b>\n\n${list}`;
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

/* ================= AUTO-SPAWN (hourly, announced to groups) ================= */

let autoSpawnTimer = null;

/**
 * Hourly auto-spawn tick: skip when a live spawn already exists, otherwise
 * fetch a fresh character, persist it as the active spawn, and send the
 * claimable photo to every known group chat.
 */
async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveSpawn())) return;

  const card = await fetchCharacter();
  if (!card) return;

  const expiresAt = Date.now() + config.waifu.claimWindowMs;
  db.setActiveSpawn(card, expiresAt);
  const spawnRow = db.getActiveSpawn();
  const caption = cardCaption(card, spawnRow);
  const markup = claimMarkup();

  const groupIds = (typeof env.getChatIds === 'function' ? env.getChatIds() : [])
    .filter((cid) => Number(cid) < 0);

  for (const gid of groupIds) {
    await sendPhoto(gid, card.image_url, caption, markup);
  }
}

/**
 * Start the hourly auto-spawn loop. Returns the interval handle (or null when
 * disabled). Idempotent — repeated calls return the existing timer.
 */
function startAutoSpawn(bot, env = {}) {
  if (autoSpawnTimer) return autoSpawnTimer;
  if (!config.waifu.enabled) return null;
  const intervalMs = config.waifu.autoSpawnIntervalMs || (60 * 60 * 1000);
  autoSpawnTimer = setInterval(() => {
    autoSpawnTick(env).catch((e) => console.warn('[waifu] auto-spawn error:', e.message));
  }, intervalMs);
  autoSpawnTimer.unref && autoSpawnTimer.unref();
  return autoSpawnTimer;
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
  CHARACTER_NAMES,
  isCleanEnglishName,
  randomCharacterName,
  characterIdFor,
  normalizeCharacter,
  isSpawnClaimable,
  secondsRemaining,
  cardCaption,
  collectionCaption,
  detailCaption,
  leaderboardCaption,
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
  startAutoSpawn,
  autoSpawnTick,
  state,
  _clear: () => {
    db.clearActiveSpawn();
  },
};
