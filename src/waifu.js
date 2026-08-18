'use strict';
const config = require('./config');
const db = require('./db');

const ANILIST_URL = 'https://graphql.anilist.co';
const RARITY_TIERS = [
  { key: 'mythic', emoji: '🔴', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '🟠', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '🟣', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '🔵', label: 'RARE', min: 500 },
  { key: 'common', emoji: '⚪', label: 'COMMON', min: 0 },
];

const CHARACTER_NAMES = [
  'Rem','Ram','Emilia','Asuna Yuuki','Mikasa Ackerman','Zero Two','Hinata Hyuga',
  'Nezuko Kamado','Mai Sakurajima','Chika Fujiwara','Rias Gremory','Yor Forger',
  'Aqua','Megumin','Raphtalia','Holo','Saber','Rin Tohsaka','Erza Scarlet','Nami',
  'Nico Robin','Boa Hancock','Bulma','Android 18','Tsunade','Rukia Kuchiki','Yoruichi',
  'Shion','Shuna','Milim Nava','Albedo','Shalltear Bloodfallen','Makima','Power',
  'Miku Nakano','Nino Nakano','Kaguya Shinomiya','Ai Hayasaka','Chizuru Ichinose',
];

const CLEAN_NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,60}$/;
function isCleanEnglishName(s) { return CLEAN_NAME_RE.test(String(s || '').trim()); }
function randomCharacterName() { return CHARACTER_NAMES[Math.floor(Math.random() * CHARACTER_NAMES.length)]; }
function characterIdFor(value) { return `waifu-${String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`; }
function rarityFor(favorites) {
  const f = Number(favorites) || 0;
  return (RARITY_TIERS.find((t) => f >= t.min) || RARITY_TIERS[RARITY_TIERS.length - 1]).key;
}
function rarityMeta(key) { return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1]; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function stripHtml(s) { return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function truncate(s, max = 280) { const t = stripHtml(s); return t.length <= max ? t : `${t.slice(0, max - 1).trim()}…`; }
function displaySeries(s) { const t = String(s || '').trim(); return !t || /^https?:\/\//i.test(t) ? '' : t; }

function normalizeCharacter(raw, source = 'anilist') {
  if (!raw || typeof raw !== 'object') return null;
  if (source === 'anilist') {
    const id = Number(raw.id) || 0;
    const imageUrl = raw.image && (raw.image.large || raw.image.medium) || '';
    const name = raw.name && (raw.name.full || raw.name.userPreferred) || '';
    if (!id || !imageUrl || !name) return null;
    const media = raw.media && raw.media.nodes || [];
    const first = media[0] || {};
    const title = first.title || {};
    const series = title.english || title.romaji || title.native || '';
    const favorites = Number(raw.favourites) || 0;
    return {
      character_id: `anilist-${id}`,
      name: String(name).trim(),
      series: String(series || '').trim(),
      image_url: imageUrl,
      bio: stripHtml(raw.description || ''),
      favorites,
      rarity: rarityFor(favorites),
      source: 'AniList',
    };
  }
  // Compatibility path for old tests/helpers that pass {url: ...}.
  const imageUrl = String(raw.url || '').trim();
  if (!imageUrl) return null;
  return { character_id: characterIdFor(imageUrl), name: randomCharacterName(), series: '', image_url: imageUrl, bio: '', favorites: 0, rarity: 'common', source };
}

function isSpawnClaimable(spawn, now = Date.now()) {
  return !!spawn && Number(spawn.claimed) !== 1 && !(Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now);
}
function secondsRemaining(spawn, now = Date.now()) {
  if (!spawn) return 0;
  return Math.max(0, Math.ceil((Number(spawn.expires_at) - now) / 1000));
}

function cardCaption(char, spawn, claimerName = null, superDrop = false) {
  const meta = rarityMeta(char.rarity);
  const lines = [superDrop ? '✨ <b>SUPER WAIFU DROPPED</b> ✨' : '💝 <b>WAIFU DROPPED</b>', ''];
  lines.push(`👤 <b>${esc(char.name)}</b>`);
  lines.push(`🆔 ${esc(char.character_id)}`);
  if (displaySeries(char.series)) lines.push(`🎬 ${esc(displaySeries(char.series))}`);
  lines.push(`${meta.emoji} ${meta.label}`);
  const bio = truncate(char.bio, 240);
  if (bio) lines.push(`📖 ${esc(bio)}`);
  lines.push('');
  if (claimerName) lines.push(`✅ Claimed by <b>${esc(claimerName)}</b>`);
  else lines.push(`⏳ <b>${secondsRemaining(spawn)}s</b> to claim — first tap wins!`);
  return lines.join('\n');
}

function collectionCaption(rows) {
  if (!rows || !rows.length) return `💝 <b>YOUR WAIFU COLLECTION</b>\n\nYou haven't claimed anyone yet. Wait for a waifu drop!`;
  return `💝 <b>YOUR WAIFU COLLECTION</b>\n\n${rows.map((r, i) => `${i + 1}. <b>${esc(r.name || 'Unknown')}</b>${displaySeries(r.series) ? ` — ${esc(r.series)}` : ''}`).join('\n')}\n\n📚 <b>${rows.length}</b> waifu${rows.length === 1 ? '' : 's'} claimed.\n\nUse /viewwaifu &lt;number&gt; to view one.`;
}
function detailCaption(row) {
  if (!row) return '💔 Not found.';
  const meta = rarityMeta(row.rarity);
  return [`💝 <b>${esc(row.name || 'Unknown')}</b>`, `🆔 ${esc(row.character_id || '')}`, displaySeries(row.series) ? `🎬 ${esc(row.series)}` : '', `${meta.emoji} ${meta.label}`, row.claimed_at ? `🕒 Claimed: ${new Date(Number(row.claimed_at) || row.claimed_at).toISOString().slice(0, 10)}` : ''].filter(Boolean).join('\n');
}
function leaderboardCaption(rows) {
  if (!rows || !rows.length) return '💝 <b>WAIFU LEADERBOARD</b>\n\nNobody has claimed a waifu yet.';
  return `💝 <b>WAIFU COLLECTION LEADERBOARD</b>\n\n${rows.map((r, i) => `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`} <b>${esc(r.first_name || r.username || `User ${r.user_id}`)}</b> — ${Number(r.count) || 0}`).join('\n')}`;
}
function characterCaption(rows) { return collectionCaption(rows); }
function claimMarkup() { return { inline_keyboard: [[{ text: '💝 CLAIM WAIFU', callback_data: 'waifu:claim' }]] }; }

async function fetchAniListPage(page) {
  const query = `query ($page: Int) { Page(page: $page, perPage: 25) { characters(sort: FAVOURITES_DESC) { id gender name { full userPreferred } image { large medium } description(asHtml: false) favourites media(perPage: 3, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } } }`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.waifu.fetchTimeoutMs || 10000);
  timer.unref && timer.unref();
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': config.waifu.userAgent || 'RimuruTempestCasino/1.0' },
      body: JSON.stringify({ query, variables: { page } }),
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json && json.data && json.data.Page && Array.isArray(json.data.Page.characters) ? json.data.Page.characters : [];
  } catch (_) { return []; } finally { clearTimeout(timer); }
}

async function fetchFromJikanByName(name) {
  const base = config.hunt && config.hunt.searchUrl || 'https://api.jikan.moe/v4/characters';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.waifu.fetchTimeoutMs || 10000);
  timer.unref && timer.unref();
  try {
    const res = await fetch(`${base}?q=${encodeURIComponent(name)}&limit=1`, { headers: { Accept: 'application/json', 'User-Agent': config.waifu.userAgent || 'RimuruTempestCasino/1.0' }, signal: ac.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json && json.data && json.data[0];
    if (!raw) return null;
    const imageUrl = raw.images && raw.images.jpg && (raw.images.jpg.large_image_url || raw.images.jpg.image_url) || '';
    if (!imageUrl) return null;
    const favorites = Number(raw.favorites) || 0;
    return { character_id: `jikan-${raw.mal_id}`, name: raw.name || name, series: '', image_url: imageUrl, bio: raw.about || '', favorites, rarity: rarityFor(favorites), source: 'Jikan' };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function fetchFromNekos() { return fetchCharacter(); }
async function fetchFromWaifuPics() { return fetchCharacter(); }

async function fetchCharacter() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = 1 + Math.floor(Math.random() * 80);
    const chars = await fetchAniListPage(page);
    const females = chars.filter((c) => String(c.gender || '').toLowerCase() === 'female');
    for (let i = females.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [females[i], females[j]] = [females[j], females[i]]; }
    for (const raw of females) {
      const card = normalizeCharacter(raw, 'anilist');
      if (card && !db.isWaifuCharacterClaimed(card.character_id)) return card;
    }
  }
  // Token-free secondary source with real character identity.
  for (let attempt = 0; attempt < 4; attempt++) {
    const card = await fetchFromJikanByName(randomCharacterName());
    if (card && !db.isWaifuCharacterClaimed(card.character_id)) return card;
  }
  return null;
}

let deps = null;
function attach(d) { deps = d || null; return module.exports; }
async function reply(chatId, text, opts = {}) { if (deps && typeof deps.reply === 'function') try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[waifu] reply:', e.message); } return null; }
async function sendPhoto(chatId, imageUrl, caption, markup) { if (deps && typeof deps.sendPhoto === 'function') try { return await deps.sendPhoto(chatId, imageUrl, { caption, parse_mode: 'HTML', reply_markup: markup }); } catch (e) { console.warn('[waifu] photo:', e.message); return reply(chatId, caption, { title: '💝 WAIFU', html: true }); } return null; }
async function answerCb(text) { if (deps && typeof deps.answerCb === 'function') try { await deps.answerCb(text); } catch (_) {} }

async function spawn(opts = {}) {
  if (!config.waifu.enabled) return { ok: false, message: 'The waifu collection is disabled.' };
  expireIfNeeded();
  const existing = db.getActiveWaifu();
  if (isSpawnClaimable(existing)) return { ok: false, message: `💝 A waifu is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveWaifu();
  const card = await fetchCharacter();
  if (!card) return { ok: false, message: '💔 The waifu API is unavailable right now. Try again shortly.' };
  const expiresAt = Date.now() + config.waifu.claimWindowMs;
  db.setActiveWaifu(card, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveWaifu();
  await sendPhoto(opts.chatId, card.image_url, cardCaption(card, row), claimMarkup());
  return { ok: true, character: card, expiresAt };
}

async function spawnSuper(opts = {}) {
  if (!config.waifu.enabled) return { ok: false, message: 'The waifu collection is disabled.' };
  expireIfNeeded();
  const existing = db.getActiveWaifu();
  if (isSpawnClaimable(existing)) return { ok: false, message: `💍 A waifu is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveWaifu();
  let best = null;
  for (let i = 0; i < 3; i++) {
    const c = await fetchCharacter();
    if (c && (!best || Number(c.favorites) > Number(best.favorites))) best = c;
  }
  if (!best) return { ok: false, message: '💔 The waifu API is unavailable right now. Try again shortly.' };
  best.rarity = Number(best.favorites) >= 20000 ? rarityFor(best.favorites) : 'legendary';
  const expiresAt = Date.now() + config.waifu.claimWindowMs;
  db.setActiveWaifu(best, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveWaifu();
  await sendPhoto(opts.chatId, best.image_url, cardCaption(best, row, null, true), claimMarkup());
  return { ok: true, character: best, expiresAt, super: true };
}

async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;
  const row = db.getActiveWaifu();
  if (!row) return await answer('No waifu is up for grabs right now.'), { ok: false, reason: 'no-active-spawn' };
  if (!isSpawnClaimable(row)) return await answer('This waifu already expired or was claimed.'), { ok: false, reason: 'not-claimable' };
  const char = { character_id: row.character_id, name: row.name, series: row.series, image_url: row.image_url, bio: row.bio, favorites: row.favorites, rarity: row.rarity };
  if (!db.claimWaifuCharacter(userId, char)) return await answer('Someone else already claimed this waifu!'), { ok: false, reason: 'already-claimed' };
  db.clearActiveWaifu();
  const user = db.getUser(userId) || {};
  const claimer = user.username ? `@${user.username}` : user.first_name || `user ${userId}`;
  await reply(opts.chatId || row.chat_id, cardCaption(char, row, claimer), { title: '💝 CLAIMED', color: '#FF80AB', html: true });
  return { ok: true, character: char, userId };
}

function expireIfNeeded(now = Date.now()) { const row = db.getActiveWaifu(); if (!row || isSpawnClaimable(row, now)) return 0; db.clearActiveWaifu(); return 1; }
let autoSpawnTimer = null;
async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveWaifu())) return;
  const groupIds = (typeof env.getChatIds === 'function' ? env.getChatIds() : []).filter((id) => Number(id) < 0);
  if (!groupIds.length) return;
  const card = await fetchCharacter();
  if (!card) return;
  const expiresAt = Date.now() + config.waifu.claimWindowMs;
  db.setActiveWaifu(card, expiresAt, groupIds[0]);
  const row = db.getActiveWaifu();
  for (const gid of groupIds) await sendPhoto(gid, card.image_url, cardCaption(card, row), claimMarkup());
}
function startAutoSpawn(_bot, env = {}) { if (autoSpawnTimer || !config.waifu.enabled) return autoSpawnTimer; autoSpawnTimer = setInterval(() => autoSpawnTick(env).catch((e) => console.warn('[waifu] auto:', e.message)), config.waifu.autoSpawnIntervalMs || 3600000); autoSpawnTimer.unref && autoSpawnTimer.unref(); return autoSpawnTimer; }
function state() { return { activeSpawn: db.getActiveWaifu() || null, enabled: config.waifu.enabled }; }

module.exports = {
  CHARACTER_NAMES, isCleanEnglishName, randomCharacterName, characterIdFor, normalizeCharacter,
  isSpawnClaimable, secondsRemaining, cardCaption, collectionCaption, detailCaption,
  leaderboardCaption, characterCaption, claimMarkup, fetchCharacter, fetchFromNekos,
  fetchFromWaifuPics, attach, spawn, spawnSuper, claim, expireIfNeeded, startAutoSpawn,
  autoSpawnTick, state, rarityFor, rarityMeta, _clear: () => db.clearActiveWaifu(),
};
