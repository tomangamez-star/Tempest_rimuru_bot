'use strict';
const config = require('./config');
const db = require('./db');

const RARITY_TIERS = [
  { key: 'mythic', emoji: '\ud83d\udd34', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '\ud83d\udfe0', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '\ud83d\udfe3', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '\ud83d\udd35', label: 'RARE', min: 500 },
  { key: 'common', emoji: '\u26aa', label: 'COMMON', min: 0 },
];

function rarityFor(favorites) {
  const f = Number(favorites) || 0;
  for (const t of RARITY_TIERS) { if (f >= t.min) return t.key; }
  return 'common';
}

function rarityMeta(key) {
  return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1];
}

const FALLBACK_POOL = [
  { character_id: 'fb-1001', name: 'Gojo Satoru', series: 'Jujutsu Kaisen', favorites: 75000, bio: 'The strongest jujutsu sorcerer alive. A teacher at Tokyo Jujutsu High who wields immense cursed energy and the Six Eyes.', image_url: 'https://cdn.myanimelist.net/images/characters/15/422168.jpg' },
  { character_id: 'fb-1002', name: 'Rem', series: 'Re:Zero', favorites: 65000, bio: 'A devoted maid of the Roswaal mansion who overcomes her inferiority complex to become one of the most beloved characters in anime.', image_url: 'https://cdn.myanimelist.net/images/characters/9/311327.jpg' },
  { character_id: 'fb-1003', name: 'Asuna Yuuki', series: 'Sword Art Online', favorites: 55000, bio: 'The vice-commander of the Knights of the Blood Oath. A skilled fencer known as the "Lightning Flash" in Aincrad.', image_url: 'https://cdn.myanimelist.net/images/characters/10/262051.jpg' },
  { character_id: 'fb-1004', name: 'Mikasa Ackerman', series: 'Attack on Titan', favorites: 60000, bio: 'The last child of the Ackerman clan and humanity\'s strongest soldier. Fiercely protective of those she loves.', image_url: 'https://cdn.myanimelist.net/images/characters/13/483950.jpg' },
  { character_id: 'fb-1005', name: 'Zero Two', series: 'Darling in the Franxx', favorites: 50000, bio: 'A mysterious half-klaxo sapien pilot known as the "Partner Killer". She searches for her darling to become human.', image_url: 'https://cdn.myanimelist.net/images/characters/14/559013.jpg' },
  { character_id: 'fb-1006', name: 'Nezuko Kamado', series: 'Demon Slayer', favorites: 45000, bio: 'A demon who retains her human emotions. She fights alongside her brother Tanjiro using her unique Blood Demon Art.', image_url: 'https://cdn.myanimelist.net/images/characters/2/378254.jpg' },
  { character_id: 'fb-1007', name: 'Yor Forger', series: 'Spy x Family', favorites: 40000, bio: 'A deadly assassin known as the "Thorn Princess" who lives a double life as a loving mother and wife.', image_url: 'https://cdn.myanimelist.net/images/characters/9/457751.jpg' },
  { character_id: 'fb-1008', name: 'Hinata Hyuga', series: 'Naruto', favorites: 35000, bio: 'A gentle kunoichi of the Hyuga clan who masters the Byakugan and Gentle Fist style. She never gives up.', image_url: 'https://cdn.myanimelist.net/images/characters/6/278736.jpg' },
  { character_id: 'fb-1009', name: 'Rias Gremory', series: 'High School DxD', favorites: 30000, bio: 'The beautiful crimson-haired devil princess and president of the Occult Research Club. A powerful King piece.', image_url: 'https://cdn.myanimelist.net/images/characters/5/150011.jpg' },
  { character_id: 'fb-1010', name: 'Mai Sakurajima', series: 'Rascal Does Not Dream of Bunny Girl Senpai', favorites: 25000, bio: 'A popular actress and model who becomes invisible due to Adolescence Syndrome. Sharp-witted and caring.', image_url: 'https://cdn.myanimelist.net/images/characters/3/361761.jpg' },
  { character_id: 'fb-1011', name: 'Chika Fujiwara', series: 'Kaguya-sama: Love Is War', favorites: 20000, bio: 'The energetic and unpredictable secretary of the Shuchiin student council. A master of board games.', image_url: 'https://cdn.myanimelist.net/images/characters/15/559031.jpg' },
  { character_id: 'fb-1012', name: 'Tanjiro Kamado', series: 'Demon Slayer', favorites: 70000, bio: 'A kind-hearted demon slayer who wields the Sun Breathing technique. He searches for a cure for his sister Nezuko.', image_url: 'https://cdn.myanimelist.net/images/characters/10/316805.jpg' },
  { character_id: 'fb-1013', name: 'Shoto Todoroki', series: 'My Hero Academia', favorites: 45000, bio: 'A UA High student with the powerful Half-Cold Half-Hot Quirk. He strives to become a hero on his own terms.', image_url: 'https://cdn.myanimelist.net/images/characters/8/299594.jpg' },
  { character_id: 'fb-1014', name: 'Saber', series: 'Fate/stay night', favorites: 55000, bio: 'The legendary King of Knights, Artoria Pendragon. A heroic spirit of unparalleled skill and noble ideals.', image_url: 'https://cdn.myanimelist.net/images/characters/16/345701.jpg' },
  { character_id: 'fb-1015', name: 'Levi Ackerman', series: 'Attack on Titan', favorites: 65000, bio: 'Humanity\'s strongest soldier and captain of the Survey Corps Special Operations Squad. A clean freak with unmatched skill.', image_url: 'https://cdn.myanimelist.net/images/characters/12/321544.jpg' },
];

function fallbackCard(entry) {
  return { character_id: entry.character_id, name: entry.name, series: entry.series, anime: [{ anime: { mal_id: 0, name: entry.series } }], image_url: entry.image_url, bio: entry.bio, favorites: entry.favorites, rarity: rarityFor(entry.favorites) };
}

function pickFallbackCharacter() {
  const unclaimed = FALLBACK_POOL.filter((e) => !db.isHuntCharacterClaimed(e.character_id));
  if (!unclaimed.length) return null;
  const entry = unclaimed[Math.floor(Math.random() * unclaimed.length)];
  const card = fallbackCard(entry);
  db.cacheHuntCharacter(card);
  return card;
}

function isSpawnClaimable(spawn, now = Date.now()) {
  if (!spawn) return false;
  if (Number(spawn.claimed) === 1) return false;
  if (Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now) return false;
  return true;
}

function secondsRemaining(spawn, now = Date.now()) {
  if (!spawn) return 0;
  const left = Number(spawn.expires_at) - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function seriesNameOf(char) {
  if (!char) return '';
  if (char.series) return String(char.series);
  const anime = Array.isArray(char.anime) ? char.anime : [];
  if (anime.length > 0 && anime[0].anime && anime[0].anime.name) return String(anime[0].anime.name);
  return '';
}

function animeListOf(char) {
  if (!char) return '';
  const anime = Array.isArray(char.anime) ? char.anime : [];
  return anime.slice(0, 5).map((a) => (a.anime && a.anime.name) || '').filter(Boolean).join(', ');
}

function truncateBio(bio, max = 200) {
  if (!bio) return '';
  const s = String(bio).trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max);
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, max)) + '\u2026';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function announceCaption(card, spawn) {
  const meta = rarityMeta(card.rarity);
  const secs = secondsRemaining(spawn);
  return `<b>\u2694\ufe0f ANIME HUNT</b>\nA new character has appeared!\n${esc(card.name)} has entered the JTF doors\n\n\ud83d\udc64 ${esc(card.name)}\n\ud83c\udf8c ${esc(seriesNameOf(card))}\n\ud83c\udd94 #${esc(card.character_id)}\n${meta.emoji} ${meta.label}\n\n<i>\u23f1\ufe0f ${secs}s remaining</i>`;
}

function claimedCaption(char, claimerName) {
  const meta = rarityMeta(char.rarity);
  return `<b>\u2694\ufe0f CHARACTER CLAIMED!</b>\n\ud83d\udc64 ${esc(char.name)}\n\ud83c\udf8c ${esc(char.series || seriesNameOf(char))}\n${meta.emoji} ${meta.label}\n\ud83c\udff9 Claimed by ${esc(claimerName)}`;
}

function detailCaption(char, opts = {}) {
  const meta = rarityMeta(char.rarity);
  const lines = [`\ud83d\udc64 ${esc(char.name)}`, `\ud83c\udd94 Character ID: ${esc(char.character_id)}`, `\ud83c\udf8c ${esc(seriesNameOf(char))}`];
  const bio = truncateBio(char.bio);
  if (bio) lines.push(`\ud83d\udcd6 About: ${esc(bio)}`);
  const anime = animeListOf(char);
  if (anime) lines.push(`\ud83d\udcda Appears in: ${esc(anime)}`);
  lines.push(`${meta.emoji} Rarity: ${meta.label}`);
  if (opts.claimedAt) lines.push(`\ud83d\udcc5 Claimed: ${new Date(Number(opts.claimedAt)).toLocaleDateString()}`);
  return lines.join('\n');
}

function collectionCaption(rows) {
  if (!rows || !rows.length) return 'Your character collection is empty. Go hunt some! \u2694\ufe0f';
  const lines = rows.map((r, i) => { const meta = rarityMeta(r.rarity); return `${i + 1}. ${meta.emoji} ${esc(r.name)} \u2014 ${esc(r.series || '?')}`; });
  lines.unshift(`<b>\u2694\ufe0f Your Collection</b> (${rows.length} characters)\n`);
  return lines.join('\n');
}

function leaderboardCaption(rows, limit) {
  if (!rows || !rows.length) return 'No hunters yet. Start the hunt! \u2694\ufe0f';
  const medals = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'];
  const lines = rows.map((r, i) => { const prefix = medals[i] || `${i + 1}.`; const name = r.username ? `@${r.username}` : r.first_name || `User ${r.user_id}`; return `${prefix} ${esc(name)} \u2014 ${r.count} character${r.count !== 1 ? 's' : ''}`; });
  lines.unshift(`<b>\u2694\ufe0f Character Leaderboard</b> (top ${Math.min(limit, rows.length)})\n`);
  return lines.join('\n');
}

function claimMarkup() { return { inline_keyboard: [[{ text: '\u2694\ufe0f CLAIM CHARACTER', callback_data: 'hunt:claim' }]] }; }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref && timer.unref();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.hunt.userAgent, Accept: 'application/json' }, signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(500 * Math.pow(2, attempt - 1)); continue; }
      return null;
    } catch (e) { clearTimeout(timer); if (attempt < retries) { await sleep(500 * Math.pow(2, attempt - 1)); continue; } return null; }
  }
  return null;
}

function normalizeJikan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.mal_id != null ? Number(raw.mal_id) : 0;
  const imageUrl = raw.images && raw.images.jpg && raw.images.jpg.image_url || '';
  if (!id || !imageUrl) return null;
  const favorites = Number(raw.favorites) || 0;
  return { character_id: String(id), name: String(raw.name || '').trim() || 'Unknown', series: '', anime: Array.isArray(raw.anime) ? raw.anime.slice(0, 8) : [], image_url: imageUrl, bio: String(raw.about || '').trim(), favorites, rarity: rarityFor(favorites) };
}

async function fetchRandomFromJikan() {
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(config.hunt.randomUrl);
  if (!json || !json.data) return null;
  return normalizeJikan(json.data);
}

async function searchJikanCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  await sleep(config.hunt.rateLimitMs);
  const json = await fetchJson(`${config.hunt.searchUrl}?q=${encodeURIComponent(q)}&limit=1`);
  if (!json || !Array.isArray(json.data) || !json.data.length) return null;
  return normalizeJikan(json.data[0]);
}

async function fetchSpawnCharacter() {
  const pool = db.getHuntPool(1);
  if (pool.length) return pool[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = await fetchRandomFromJikan();
    if (card && !db.isHuntCharacterClaimed(card.character_id)) { db.cacheHuntCharacter(card); return card; }
  }
  const fallback = pickFallbackCharacter();
  if (fallback) { console.warn('[hunt] Jikan unreachable, using fallback pool:', fallback.name); return fallback; }
  console.error('[hunt] spawn failed: all sources exhausted');
  return null;
}

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

let deps = null;
function attach(d) { deps = d || null; return module.exports; }

async function reply(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') { try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[hunt] reply failed:', e.message); } }
  return null;
}

async function sendPhoto(chatId, imageUrl, caption, markup) {
  if (deps && typeof deps.sendPhoto === 'function') {
    try { return await deps.sendPhoto(chatId, imageUrl, { caption, parse_mode: 'HTML', reply_markup: markup }); } catch (e) { console.warn('[hunt] sendPhoto failed:', e.message); await reply(chatId, caption, { title: '\u2694\ufe0f ANIME HUNT', color: '#FFB300', html: true }); }
  }
  return null;
}

async function answerCb(text) { if (deps && typeof deps.answerCb === 'function') { try { await deps.answerCb(text); } catch (e) {} } }

async function spawn(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'The Anime Hunt is disabled.' };
  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) return { ok: false, message: `\u2694\ufe0f A character is already up for grabs \u2014 tap <b>CLAIM CHARACTER</b> on it first! (${secondsRemaining(existing)}s left)` };
  if (existing) db.clearActiveHunt();
  const card = await fetchSpawnCharacter();
  if (!card) return { ok: false, message: '\ud83d\udc7b The hunt is quiet right now. Try again in a moment.' };
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
  const char = { character_id: spawnRow.character_id, name: spawnRow.name, series: spawnRow.series, image_url: spawnRow.image_url, rarity: spawnRow.rarity };
  if (!db.claimHuntCharacter(userId, char)) return await answer('Someone else already claimed this character!'), { ok: false, reason: 'already-claimed' };
  db.clearActiveHunt();
  const user = db.getUser(userId) || {};
  const claimerName = user.username ? `@${user.username}` : user.first_name || `user ${userId}`;
  await reply(spawnRow.chat_id || opts.chatId, claimedCaption(char, claimerName), { title: '\u2694\ufe0f CLAIMED', color: '#FFB300', html: true });
  return { ok: true, character: char, userId };
}

function expireIfNeeded(now = Date.now()) {
  const spawnRow = db.getActiveHunt();
  if (!spawnRow || isSpawnClaimable(spawnRow, now)) return 0;
  if (Number(spawnRow.claimed) === 1 || (Number(spawnRow.expires_at) > 0 && Number(spawnRow.expires_at) <= now)) { db.clearActiveHunt(); return 1; }
  return 0;
}

async function searchAndShow(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, message: 'Usage: <code>/char &lt;name&gt;</code>' };
  const card = await searchJikanCharacter(q);
  if (card) { db.cacheHuntCharacter(card); await sendPhoto(opts.chatId, card.image_url, detailCaption(card), null); return { ok: true, character: card }; }
  return { ok: false, message: `\ud83d\udc7b No character found for "<b>${esc(q)}</b>". Try another name.` };
}

let autoSpawnTimer = null;

async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveHunt())) return;
  const card = await fetchSpawnCharacter();
  if (!card) return;
  const groupIds = (typeof env.getChatIds === 'function' ? env.getChatIds() : []).filter((cid) => Number(cid) < 0);
  if (!groupIds.length) return;
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, groupIds[0]);
  const spawnRow = db.getActiveHunt();
  for (const gid of groupIds) { await sendPhoto(gid, card.image_url, announceCaption(card, spawnRow), claimMarkup()); }
}

function startAutoSpawn(bot, env = {}) {
  if (autoSpawnTimer) return autoSpawnTimer;
  if (!config.hunt.enabled) return null;
  const intervalMs = config.hunt.autoSpawnIntervalMs || 3600 * 1000;
  autoSpawnTimer = setInterval(() => { autoSpawnTick(env).catch((e) => console.warn('[hunt] auto-spawn error:', e.message)); }, intervalMs);
  autoSpawnTimer.unref && autoSpawnTimer.unref();
  return autoSpawnTimer;
}

function state() { return { activeSpawn: db.getActiveHunt() || null, enabled: config.hunt.enabled }; }

module.exports = {
  RARITY_TIERS, rarityFor, rarityMeta, isSpawnClaimable, secondsRemaining,
  seriesNameOf, animeListOf, truncateBio, announceCaption, claimedCaption,
  detailCaption, collectionCaption, leaderboardCaption, claimMarkup,
  normalizeJikan, fetchRandomFromJikan, searchJikanCharacter, fetchSpawnCharacter,
  resolveCharacter, attach, spawn, claim, expireIfNeeded, searchAndShow,
  startAutoSpawn, autoSpawnTick, state,
  FALLBACK_POOL, fallbackCard, pickFallbackCharacter,
  _clear: () => { db.clearActiveHunt(); },
};