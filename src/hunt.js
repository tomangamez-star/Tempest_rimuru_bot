'use strict';
const config = require('./config');
const db = require('./db');

const RARITY_TIERS = [
  { key: 'mythic', emoji: '🔴', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '🟠', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '🟣', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '🔵', label: 'RARE', min: 500 },
  { key: 'common', emoji: '⚪', label: 'COMMON', min: 0 },
];
function rarityFor(favorites) { const f = Number(favorites) || 0; return (RARITY_TIERS.find((t) => f >= t.min) || RARITY_TIERS[RARITY_TIERS.length - 1]).key; }
function rarityMeta(key) { return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1]; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function truncateBio(bio, max = 260) { const s = String(bio || '').replace(/\s+/g, ' ').trim(); return s.length <= max ? s : `${s.slice(0, max - 1).trim()}…`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const FALLBACK_POOL = [
  { character_id: 'fb-1001', name: 'Gojo Satoru', series: 'Jujutsu Kaisen', favorites: 75000, bio: 'The strongest jujutsu sorcerer and a teacher at Tokyo Jujutsu High.', image_url: 'https://cdn.myanimelist.net/images/characters/15/422168.jpg' },
  { character_id: 'fb-1002', name: 'Rem', series: 'Re:Zero', favorites: 65000, bio: 'A maid of the Roswaal mansion known for her loyalty and strength.', image_url: 'https://cdn.myanimelist.net/images/characters/9/311327.jpg' },
  { character_id: 'fb-1012', name: 'Tanjiro Kamado', series: 'Demon Slayer', favorites: 70000, bio: 'A kind-hearted Demon Slayer searching for a cure for his sister.', image_url: 'https://cdn.myanimelist.net/images/characters/10/316805.jpg' },
  { character_id: 'fb-1015', name: 'Levi Ackerman', series: 'Attack on Titan', favorites: 65000, bio: "Humanity's strongest soldier and captain in the Survey Corps.", image_url: 'https://cdn.myanimelist.net/images/characters/12/321544.jpg' },
];
function fallbackCard(e) { return { ...e, anime: [{ anime: { mal_id: 0, name: e.series } }], rarity: rarityFor(e.favorites) }; }
function pickFallbackCharacter() { const list = FALLBACK_POOL.filter((e) => !db.isHuntCharacterClaimed(e.character_id)); if (!list.length) return null; const c = fallbackCard(list[Math.floor(Math.random() * list.length)]); db.cacheHuntCharacter(c); return c; }
function isSpawnClaimable(spawn, now = Date.now()) { return !!spawn && Number(spawn.claimed) !== 1 && !(Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now); }
function secondsRemaining(spawn, now = Date.now()) { return spawn ? Math.max(0, Math.ceil((Number(spawn.expires_at) - now) / 1000)) : 0; }
function seriesNameOf(char) { if (!char) return ''; if (char.series) return String(char.series); const anime = Array.isArray(char.anime) ? char.anime : []; return anime[0] && anime[0].anime && (anime[0].anime.title || anime[0].anime.name) || ''; }
function animeListOf(char) { const anime = Array.isArray(char && char.anime) ? char.anime : []; return anime.slice(0, 5).map((a) => a.anime && (a.anime.title || a.anime.name) || '').filter(Boolean).join(', '); }
function announceCaption(card, spawn) { const meta = rarityMeta(card.rarity); const bio = truncateBio(card.bio, 230); return [`<b>⚔️ ANIME HUNT</b>`, 'A new character has appeared!', '', `👤 <b>${esc(card.name)}</b>`, `🆔 #${esc(card.character_id)}`, seriesNameOf(card) ? `🎬 ${esc(seriesNameOf(card))}` : '', `${meta.emoji} ${meta.label}`, bio ? `📖 ${esc(bio)}` : '', '', `<i>⏱️ ${secondsRemaining(spawn)}s remaining — first claim wins!</i>`].filter(Boolean).join('\n'); }
function claimedCaption(char, claimerName) { const meta = rarityMeta(char.rarity); return `<b>⚔️ CHARACTER CLAIMED!</b>\n👤 ${esc(char.name)}\n${seriesNameOf(char) ? `🎬 ${esc(seriesNameOf(char))}\n` : ''}${meta.emoji} ${meta.label}\n🎯 Claimed by ${esc(claimerName)}`; }
function detailCaption(char, opts = {}) { const meta = rarityMeta(char.rarity); const lines = [`👤 ${esc(char.name)}`, `🆔 Character ID: ${esc(char.character_id)}`]; if (seriesNameOf(char)) lines.push(`🎬 ${esc(seriesNameOf(char))}`); const bio = truncateBio(char.bio); if (bio) lines.push(`📖 About: ${esc(bio)}`); const anime = animeListOf(char); if (anime) lines.push(`📚 Appears in: ${esc(anime)}`); lines.push(`${meta.emoji} Rarity: ${meta.label}`); if (opts.claimedAt) lines.push(`📅 Claimed: ${new Date(Number(opts.claimedAt) || opts.claimedAt).toLocaleDateString()}`); return lines.join('\n'); }
function collectionCaption(rows) { if (!rows || !rows.length) return 'Your character collection is empty. Go hunt some! ⚔️'; return `<b>⚔️ Your Collection</b> (${rows.length} characters)\n\n${rows.map((r, i) => `${i + 1}. ${rarityMeta(r.rarity).emoji} ${esc(r.name)} — ${esc(r.series || '?')}`).join('\n')}`; }
function leaderboardCaption(rows, limit = 10) { if (!rows || !rows.length) return 'No hunters yet. Start the hunt! ⚔️'; const medals = ['🥇','🥈','🥉']; return `<b>⚔️ Character Leaderboard</b> (top ${Math.min(limit, rows.length)})\n\n${rows.map((r, i) => `${medals[i] || `${i + 1}.`} ${esc(r.username ? `@${r.username}` : r.first_name || `User ${r.user_id}`)} — ${r.count}`).join('\n')}`; }
function claimMarkup() { return { inline_keyboard: [[{ text: '⚔️ CLAIM CHARACTER', callback_data: 'hunt:claim' }]] }; }

async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs || 10000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs); timer.unref && timer.unref();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0', Accept: 'application/json' }, signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(650 * attempt); continue; }
      return null;
    } catch (_) { clearTimeout(timer); if (attempt < retries) { await sleep(650 * attempt); continue; } return null; }
  }
  return null;
}
function normalizeJikan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.mal_id) || 0;
  const imageUrl = raw.images && raw.images.jpg && (raw.images.jpg.large_image_url || raw.images.jpg.image_url) || '';
  if (!id || !imageUrl) return null;
  const anime = Array.isArray(raw.anime) ? raw.anime.slice(0, 8) : [];
  const favorites = Number(raw.favorites) || 0;
  return { character_id: String(id), name: String(raw.name || 'Unknown').trim(), series: anime[0] && anime[0].anime && (anime[0].anime.title || anime[0].anime.name) || '', anime, image_url: imageUrl, bio: String(raw.about || '').trim(), favorites, rarity: rarityFor(favorites) };
}
async function fetchRandomFromJikan() { await sleep(config.hunt.rateLimitMs || 900); const json = await fetchJson(config.hunt.randomUrl || 'https://api.jikan.moe/v4/random/characters'); return json && json.data ? normalizeJikan(json.data) : null; }
async function searchJikanCharacter(query) { const q = String(query || '').trim(); if (!q) return null; await sleep(config.hunt.rateLimitMs || 900); const base = config.hunt.searchUrl || 'https://api.jikan.moe/v4/characters'; const json = await fetchJson(`${base}?q=${encodeURIComponent(q)}&limit=1`); return json && Array.isArray(json.data) && json.data[0] ? normalizeJikan(json.data[0]) : null; }

// Important v1.0.3 fix: do NOT return the top cached character first forever.
// Always ask the live API for a fresh unclaimed character; cache is fallback.
async function fetchSpawnCharacter() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const card = await fetchRandomFromJikan();
    if (card && !db.isHuntCharacterClaimed(card.character_id)) { db.cacheHuntCharacter(card); return card; }
  }
  const pool = db.getHuntPool(50).filter((c) => !db.isHuntCharacterClaimed(c.character_id));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return pickFallbackCharacter();
}
async function resolveCharacter(id) { const cached = db.getCachedHuntCharacter(id); if (cached) return cached; await sleep(config.hunt.rateLimitMs || 900); const base = config.hunt.baseUrl || 'https://api.jikan.moe/v4'; const json = await fetchJson(`${base}/characters/${encodeURIComponent(id)}/full`); const card = json && json.data ? normalizeJikan(json.data) : null; if (card) db.cacheHuntCharacter(card); return card; }

let deps = null;
function attach(d) { deps = d || null; return module.exports; }
async function reply(chatId, text, opts = {}) { if (deps && typeof deps.reply === 'function') try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[hunt] reply:', e.message); } return null; }
async function sendPhoto(chatId, url, caption, markup) { if (deps && typeof deps.sendPhoto === 'function') try { return await deps.sendPhoto(chatId, url, { caption, parse_mode: 'HTML', reply_markup: markup }); } catch (e) { console.warn('[hunt] photo:', e.message); return reply(chatId, caption, { title: '⚔️ ANIME HUNT', html: true }); } return null; }
async function answerCb(text) { if (deps && typeof deps.answerCb === 'function') try { await deps.answerCb(text); } catch (_) {} }
async function spawn(opts = {}) { if (!config.hunt.enabled) return { ok: false, message: 'The Anime Hunt is disabled.' }; expireIfNeeded(); const existing = db.getActiveHunt(); if (isSpawnClaimable(existing)) return { ok: false, message: `⚔️ A character is already up for grabs (${secondsRemaining(existing)}s left).` }; if (existing) db.clearActiveHunt(); const card = await fetchSpawnCharacter(); if (!card) return { ok: false, message: '⚔️ The character API is unavailable right now. Try again shortly.' }; const expiresAt = Date.now() + config.hunt.claimWindowMs; db.setActiveHunt(card, expiresAt, Number(opts.chatId) || 0); const row = db.getActiveHunt(); await sendPhoto(opts.chatId, card.image_url, announceCaption(card, row), claimMarkup()); return { ok: true, character: card, expiresAt }; }
async function claim(userId, opts = {}) { const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb; const row = db.getActiveHunt(); if (!row) return await answer('No character is up for grabs right now.'), { ok: false, reason: 'no-active-hunt' }; if (!isSpawnClaimable(row)) return await answer('This character already expired or was claimed.'), { ok: false, reason: 'not-claimable' }; const char = { character_id: row.character_id, name: row.name, series: row.series, image_url: row.image_url, bio: row.bio, favorites: row.favorites, rarity: row.rarity }; if (!db.claimHuntCharacter(userId, char)) return await answer('Someone else already claimed this character!'), { ok: false, reason: 'already-claimed' }; db.clearActiveHunt(); const user = db.getUser(userId) || {}; const claimer = user.username ? `@${user.username}` : user.first_name || `user ${userId}`; await reply(opts.chatId || row.chat_id, claimedCaption(char, claimer), { title: '⚔️ CLAIMED', color: '#FFB300', html: true }); return { ok: true, character: char, userId }; }
function expireIfNeeded(now = Date.now()) { const row = db.getActiveHunt(); if (!row || isSpawnClaimable(row, now)) return 0; db.clearActiveHunt(); return 1; }
async function searchAndShow(query, opts = {}) { const q = String(query || '').trim(); if (!q) return { ok: false, message: 'Usage: <code>/char &lt;name&gt;</code>' }; const card = await searchJikanCharacter(q); if (!card) return { ok: false, message: `No character found for <b>${esc(q)}</b>.` }; db.cacheHuntCharacter(card); await sendPhoto(opts.chatId, card.image_url, detailCaption(card), null); return { ok: true, character: card }; }
let autoSpawnTimer = null;
async function autoSpawnTick(env = {}) { expireIfNeeded(); if (isSpawnClaimable(db.getActiveHunt())) return; const groups = (typeof env.getChatIds === 'function' ? env.getChatIds() : []).filter((id) => Number(id) < 0); if (!groups.length) return; const card = await fetchSpawnCharacter(); if (!card) return; const expiresAt = Date.now() + config.hunt.claimWindowMs; db.setActiveHunt(card, expiresAt, groups[0]); const row = db.getActiveHunt(); for (const gid of groups) await sendPhoto(gid, card.image_url, announceCaption(card, row), claimMarkup()); }
function startAutoSpawn(_bot, env = {}) { if (autoSpawnTimer || !config.hunt.enabled) return autoSpawnTimer; autoSpawnTimer = setInterval(() => autoSpawnTick(env).catch((e) => console.warn('[hunt] auto:', e.message)), config.hunt.autoSpawnIntervalMs || 3600000); autoSpawnTimer.unref && autoSpawnTimer.unref(); return autoSpawnTimer; }
function state() { return { activeSpawn: db.getActiveHunt() || null, enabled: config.hunt.enabled }; }
module.exports = { RARITY_TIERS, rarityFor, rarityMeta, isSpawnClaimable, secondsRemaining, seriesNameOf, animeListOf, truncateBio, announceCaption, claimedCaption, detailCaption, collectionCaption, leaderboardCaption, claimMarkup, normalizeJikan, fetchRandomFromJikan, searchJikanCharacter, fetchSpawnCharacter, resolveCharacter, attach, spawn, claim, expireIfNeeded, searchAndShow, startAutoSpawn, autoSpawnTick, state, FALLBACK_POOL, fallbackCard, pickFallbackCharacter, _clear: () => db.clearActiveHunt() };
