'use strict';
const config = require('./config');
const db = require('./db');

const ANILIST_URL = 'https://graphql.anilist.co';
const KITSU_URL = 'https://kitsu.io/api/edge/characters';
const MAX_TELEGRAM_PHOTO_BYTES = 9_500_000;

const RARITY_TIERS = [
  { key: 'mythic', emoji: '🔴', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '🟠', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '🟣', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '🔵', label: 'RARE', min: 500 },
  { key: 'common', emoji: '⚪', label: 'COMMON', min: 0 },
];

const BOLD_UPPER = Array.from('𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙');
const BOLD_LOWER = Array.from('𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳');
const BOLD_NUM = Array.from('𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗');

function fancy(value) {
  return String(value == null ? '' : value).replace(/[A-Za-z0-9]/g, (c) => {
    if (c >= 'A' && c <= 'Z') return BOLD_UPPER[c.charCodeAt(0) - 65];
    if (c >= 'a' && c <= 'z') return BOLD_LOWER[c.charCodeAt(0) - 97];
    return BOLD_NUM[c.charCodeAt(0) - 48];
  });
}
function stripUrls(value) {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/[^\s)\]}]+/gi, '')
    .replace(/www\.[^\s)\]}]+/gi, '')
    .trim();
}
function sanitizeApiText(value) {
  let s = String(value == null ? '' : value);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)[*_~]+(?=\S)/g, '$1')
    .replace(/(?<=\S)[*_~]+(?=\s|$)/g, '');
  return stripUrls(s)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function safeUserName(value, fallback = 'Unknown user') {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || fallback;
}
function rarityFor(favorites) { const f = Number(favorites) || 0; return (RARITY_TIERS.find((t) => f >= t.min) || RARITY_TIERS[RARITY_TIERS.length - 1]).key; }
function rarityMeta(key) { return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1]; }
function truncateBio(value, max = 300) {
  const s = sanitizeApiText(value);
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, cut > 40 ? cut : max - 1).trim()}…`;
}
function wrapText(value, width = 34, maxLines = 7) {
  const words = truncateBio(value, width * maxLines).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines - 1) break;
    } else line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isSpawnClaimable(spawn, now = Date.now()) { return !!spawn && Number(spawn.claimed) !== 1 && !(Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now); }
function secondsRemaining(spawn, now = Date.now()) { return spawn ? Math.max(0, Math.ceil((Number(spawn.expires_at) - now) / 1000)) : 0; }
function seriesNameOf(char) {
  if (!char) return '';
  if (char.series) return stripUrls(char.series);
  const anime = Array.isArray(char.anime) ? char.anime : [];
  return stripUrls(anime[0] && anime[0].anime && (anime[0].anime.title || anime[0].anime.name) || '');
}
function animeListOf(char) {
  const anime = Array.isArray(char && char.anime) ? char.anime : [];
  return anime.slice(0, 5).map((a) => stripUrls(a.anime && (a.anime.title || a.anime.name) || '')).filter(Boolean).join(', ');
}

function announceCaption(card, spawn) {
  const meta = rarityMeta(card.rarity);
  const secs = secondsRemaining(spawn);
  const bioLines = wrapText(card.bio || 'A mysterious fighter has crossed into the JTF hunting grounds.', 34, 6);
  const series = seriesNameOf(card);
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
    '          ⚔️  𝐀𝐍𝐈𝐌𝐄 𝐇𝐔𝐍𝐓  ⚔️',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    '      ✨ 𝐀 𝐏𝐎𝐖𝐄𝐑𝐅𝐔𝐋 𝐏𝐑𝐄𝐒𝐄𝐍𝐂𝐄 𝐉𝐔𝐒𝐓 𝐄𝐍𝐓𝐄𝐑𝐄𝐃 𝐓𝐇𝐄 𝐉𝐓𝐅 𝐇𝐔𝐍𝐓𝐈𝐍𝐆 𝐆𝐑𝐎𝐔𝐍𝐃𝐒! ✨',
    '',
    `              👤 ${fancy(stripUrls(card.name || 'Unknown'))}`,
    `                 #${stripUrls(card.character_id || '')}`,
    '',
  ];
  if (series) lines.push(`      🎬 ${fancy(series)}`, '');
  lines.push(
    `          ${meta.emoji} 『 ${fancy(meta.label)} 』`,
    '',
    '╭──────────────────────────────╮',
    '📖 𝐂𝐇𝐀𝐑𝐀𝐂𝐓𝐄𝐑 𝐈𝐍𝐅𝐎',
    '',
    ...bioLines,
    '╰──────────────────────────────╯',
    '',
    `        ⏱️ ${fancy(String(secs))}𝐬 𝐑𝐄𝐌𝐀𝐈𝐍𝐈𝐍𝐆`,
    '           ⚡ 𝐅𝐢𝐫𝐬𝐭 𝐜𝐥𝐚𝐢𝐦 𝐰𝐢𝐧𝐬!',
  );
  return lines.join('\n').slice(0, 1024);
}
function claimedCaption(char, claimerName) {
  const meta = rarityMeta(char.rarity);
  return `⚔️ ${fancy('CHARACTER CLAIMED!')}\n👤 ${fancy(stripUrls(char.name))}\n${seriesNameOf(char) ? `🎬 ${fancy(seriesNameOf(char))}\n` : ''}${meta.emoji} ${fancy(meta.label)}\n🎯 ${fancy('Claimed by')} ${safeUserName(claimerName)}`;
}
function detailCaption(char, opts = {}) {
  const meta = rarityMeta(char.rarity);
  const lines = [`👤 ${fancy(stripUrls(char.name))}`, `🆔 Character ID: ${stripUrls(char.character_id)}`];
  if (seriesNameOf(char)) lines.push(`🎬 ${fancy(seriesNameOf(char))}`);
  const bio = truncateBio(char.bio);
  if (bio) lines.push(`📖 About: ${bio}`);
  const anime = animeListOf(char);
  if (anime) lines.push(`📚 Appears in: ${anime}`);
  lines.push(`${meta.emoji} Rarity: ${fancy(meta.label)}`);
  if (opts.claimedAt) lines.push(`📅 Claimed: ${new Date(Number(opts.claimedAt) || opts.claimedAt).toLocaleDateString()}`);
  return lines.join('\n');
}
function collectionCaption(rows) {
  if (!rows || !rows.length) return 'Your character collection is empty. Go hunt some! ⚔️';
  return `⚔️ ${fancy('YOUR COLLECTION')} (${rows.length})\n\n${rows.map((r, i) => `${i + 1}. ${rarityMeta(r.rarity).emoji} ${fancy(stripUrls(r.name))} — ${fancy(stripUrls(r.series || '?'))}`).join('\n')}`;
}
function leaderboardCaption(rows, limit = 10) {
  if (!rows || !rows.length) return 'No hunters yet. Start the hunt! ⚔️';
  const medals = ['🥇', '🥈', '🥉'];
  return `⚔️ ${fancy('CHARACTER LEADERBOARD')}\n\n${rows.map((r, i) => {
    const user = r.username ? `@${r.username}` : (r.first_name || `User ${r.user_id}`);
    // User names stay exactly as Telegram supplied them; no decorative font conversion.
    return `${medals[i] || `${i + 1}.`} ${safeUserName(user)} — ${Number(r.count) || 0}`;
  }).join('\n')}`;
}
function claimMarkup() { return { inline_keyboard: [[{ text: '⚔️ CLAIM CHARACTER', callback_data: 'hunt:claim' }]] }; }

const FALLBACK_POOL = [
  { character_id: 'fb-1001', name: 'Gojo Satoru', series: 'Jujutsu Kaisen', favorites: 75000, bio: 'The strongest jujutsu sorcerer and a teacher at Tokyo Jujutsu High.', image_url: 'https://cdn.myanimelist.net/images/characters/15/422168.jpg' },
  { character_id: 'fb-1002', name: 'Rem', series: 'Re:Zero', favorites: 65000, bio: 'A maid of the Roswaal mansion known for her loyalty and strength.', image_url: 'https://cdn.myanimelist.net/images/characters/9/311327.jpg' },
  { character_id: 'fb-1003', name: 'Asuna Yuuki', series: 'Sword Art Online', favorites: 55000, bio: 'The Lightning Flash of Aincrad and a skilled swordswoman.', image_url: 'https://cdn.myanimelist.net/images/characters/10/262051.jpg' },
  { character_id: 'fb-1004', name: 'Mikasa Ackerman', series: 'Attack on Titan', favorites: 60000, bio: 'An elite soldier of the Survey Corps and an Ackerman warrior.', image_url: 'https://cdn.myanimelist.net/images/characters/13/483950.jpg' },
  { character_id: 'fb-1005', name: 'Zero Two', series: 'Darling in the Franxx', favorites: 50000, bio: 'A mysterious elite pilot known as the Partner Killer.', image_url: 'https://cdn.myanimelist.net/images/characters/14/559013.jpg' },
  { character_id: 'fb-1006', name: 'Nezuko Kamado', series: 'Demon Slayer', favorites: 45000, bio: 'A demon who retains her human emotions and fights beside Tanjiro.', image_url: 'https://cdn.myanimelist.net/images/characters/2/378254.jpg' },
  { character_id: 'fb-1007', name: 'Yor Forger', series: 'Spy x Family', favorites: 40000, bio: 'An assassin known as the Thorn Princess who lives a double life.', image_url: 'https://cdn.myanimelist.net/images/characters/9/457751.jpg' },
  { character_id: 'fb-1008', name: 'Hinata Hyuga', series: 'Naruto', favorites: 35000, bio: 'A Hyuga kunoichi who masters the Byakugan and Gentle Fist.', image_url: 'https://cdn.myanimelist.net/images/characters/6/278736.jpg' },
  { character_id: 'fb-1009', name: 'Rias Gremory', series: 'High School DxD', favorites: 30000, bio: 'A high-class devil and president of the Occult Research Club.', image_url: 'https://cdn.myanimelist.net/images/characters/5/150011.jpg' },
  { character_id: 'fb-1010', name: 'Mai Sakurajima', series: 'Rascal Does Not Dream of Bunny Girl Senpai', favorites: 25000, bio: 'An actress affected by Adolescence Syndrome.', image_url: 'https://cdn.myanimelist.net/images/characters/3/361761.jpg' },
  { character_id: 'fb-1011', name: 'Chika Fujiwara', series: 'Kaguya-sama: Love Is War', favorites: 20000, bio: 'The energetic secretary of the Shuchiin student council.', image_url: 'https://cdn.myanimelist.net/images/characters/15/559031.jpg' },
  { character_id: 'fb-1012', name: 'Tanjiro Kamado', series: 'Demon Slayer', favorites: 70000, bio: 'A kind-hearted Demon Slayer searching for a cure for his sister.', image_url: 'https://cdn.myanimelist.net/images/characters/10/316805.jpg' },
  { character_id: 'fb-1015', name: 'Levi Ackerman', series: 'Attack on Titan', favorites: 65000, bio: "Humanity's strongest soldier and captain in the Survey Corps.", image_url: 'https://cdn.myanimelist.net/images/characters/12/321544.jpg' },
];
function fallbackCard(entry) { return { ...entry, anime: [{ anime: { name: entry.series } }], rarity: rarityFor(entry.favorites), source: 'Fallback' }; }
function pickFallbackCharacter() {
  const list = FALLBACK_POOL.filter((e) => !db.isHuntCharacterClaimed(e.character_id));
  if (!list.length) return null;
  const card = fallbackCard(list[Math.floor(Math.random() * list.length)]);
  db.cacheHuntCharacter(card);
  return card;
}

async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs || 10000, retries = 2, options = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref && timer.unref();
    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0', Accept: 'application/json', ...(options.headers || {}) },
        body: options.body,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      if (options.label) console.warn(`[hunt] ${options.label} HTTP ${res.status}`);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * attempt);
        continue;
      }
      return null;
    } catch (e) {
      clearTimeout(timer);
      if (options.label) console.warn(`[hunt] ${options.label} error: ${e.message}`);
      if (attempt < retries) { await sleep(600 * attempt); continue; }
      return null;
    }
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
  return {
    character_id: String(id),
    name: stripUrls(raw.name || 'Unknown'),
    series: stripUrls(anime[0] && anime[0].anime && (anime[0].anime.title || anime[0].anime.name) || ''),
    anime,
    image_url: imageUrl,
    bio: sanitizeApiText(raw.about || ''),
    favorites,
    rarity: rarityFor(favorites),
    source: 'Jikan',
  };
}
function normalizeAniList(raw) {
  if (!raw || !raw.id) return null;
  const imageUrl = raw.image && (raw.image.large || raw.image.medium) || '';
  if (!imageUrl) return null;
  const media = raw.media && raw.media.nodes || [];
  const series = media[0] && media[0].title && (media[0].title.english || media[0].title.romaji || media[0].title.native) || '';
  const favorites = Number(raw.favourites) || 0;
  return {
    character_id: `anilist-${raw.id}`,
    name: stripUrls(raw.name && (raw.name.full || raw.name.userPreferred) || 'Unknown'),
    series: stripUrls(series),
    anime: media.slice(0, 8).map((m) => ({ anime: { title: m.title && (m.title.english || m.title.romaji || m.title.native) || '' } })),
    image_url: imageUrl,
    bio: sanitizeApiText(raw.description || ''),
    favorites,
    rarity: rarityFor(favorites),
    source: 'AniList',
  };
}
function normalizeKitsu(raw) {
  if (!raw || !raw.id || !raw.attributes) return null;
  const a = raw.attributes;
  const image = a.image || {};
  const imageUrl = image.original || image.large || image.medium || '';
  if (!imageUrl) return null;
  return {
    character_id: `kitsu-${raw.id}`,
    name: stripUrls(a.names && (a.names.canonical || a.names.en || a.names.ja_jp) || a.canonicalName || 'Unknown'),
    series: '',
    anime: [],
    image_url: imageUrl,
    bio: sanitizeApiText(a.description || ''),
    favorites: 0,
    rarity: 'common',
    source: 'Kitsu',
  };
}

function normalizedName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}
function sameCharacterName(a, b) {
  const x = normalizedName(a);
  const y = normalizedName(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xa = new Set(x.split(' ').filter(Boolean));
  const ya = new Set(y.split(' ').filter(Boolean));
  const common = [...xa].filter((t) => ya.has(t));
  return common.length >= Math.min(2, xa.size, ya.size);
}

async function fetchRandomFromJikan() {
  await sleep(config.hunt.rateLimitMs || 700);
  const json = await fetchJson(config.hunt.randomUrl || 'https://api.jikan.moe/v4/random/characters', config.hunt.fetchTimeoutMs || 10000, 2, { label: 'Jikan random' });
  return json && json.data ? normalizeJikan(json.data) : null;
}
async function searchJikanCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const base = config.hunt.searchUrl || 'https://api.jikan.moe/v4/characters';
  const json = await fetchJson(`${base}?q=${encodeURIComponent(q)}&limit=1`, config.hunt.fetchTimeoutMs || 10000, 2, { label: 'Jikan search' });
  return json && Array.isArray(json.data) && json.data[0] ? normalizeJikan(json.data[0]) : null;
}
async function fetchJikanPictures(characterId) {
  if (!characterId || String(characterId).startsWith('anilist-') || String(characterId).startsWith('kitsu-')) return [];
  const base = config.hunt.baseUrl || 'https://api.jikan.moe/v4';
  const json = await fetchJson(`${base}/characters/${encodeURIComponent(characterId)}/pictures`, config.hunt.fetchTimeoutMs || 10000, 2, { label: 'Jikan pictures' });
  if (!json || !Array.isArray(json.data)) return [];
  return json.data.map((item, index) => {
    const imageUrl = item && item.jpg && (item.jpg.large_image_url || item.jpg.image_url) || '';
    return imageUrl ? { image_url: imageUrl, source: 'JikanPictures', picture_index: index } : null;
  }).filter(Boolean);
}
async function searchAniListCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const gql = `query ($search: String) { Character(search: $search) { id name { full userPreferred } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { search: q } }),
    label: 'AniList search',
  });
  return json && json.data && json.data.Character ? normalizeAniList(json.data.Character) : null;
}
async function fetchRandomFromAniList() {
  const page = 1 + Math.floor(Math.random() * 120);
  const gql = `query ($page: Int) { Page(page: $page, perPage: 25) { characters(sort: FAVOURITES_DESC) { id name { full userPreferred } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { page } }),
    label: 'AniList random fallback',
  });
  const rows = json && json.data && json.data.Page && Array.isArray(json.data.Page.characters) ? json.data.Page.characters : [];
  if (!rows.length) return null;
  return normalizeAniList(rows[Math.floor(Math.random() * rows.length)]);
}
async function searchKitsuCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const json = await fetchJson(`${KITSU_URL}?filter[name]=${encodeURIComponent(q)}&page[limit]=1`, config.hunt.fetchTimeoutMs || 10000, 2, { label: 'Kitsu search' });
  return json && Array.isArray(json.data) && json.data[0] ? normalizeKitsu(json.data[0]) : null;
}

async function probeImage(url) {
  if (!url) return { ok: false, bytes: 0 };
  const headers = { 'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0', Accept: 'image/*' };
  const check = async (method, extraHeaders = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    timer.unref && timer.unref();
    try {
      const res = await fetch(url, { method, signal: ac.signal, headers: { ...headers, ...extraHeaders } });
      const type = String(res.headers.get('content-type') || '');
      const len = Number(res.headers.get('content-length')) || 0;
      if (!res.ok || (type && !type.startsWith('image/'))) return { ok: false, bytes: 0 };
      if (len > MAX_TELEGRAM_PHOTO_BYTES) return { ok: false, bytes: len };
      return { ok: true, bytes: len };
    } catch (_) { return { ok: false, bytes: 0 }; } finally { clearTimeout(timer); }
  };
  const head = await check('HEAD');
  if (head.ok) return head;
  // Some CDNs reject HEAD but serve the image correctly. A one-byte range GET
  // verifies reachability without downloading the full artwork.
  return check('GET', { Range: 'bytes=0-0' });
}

function mergeMetadata(identity, others = []) {
  const all = [identity, ...others].filter(Boolean);
  const best = { ...identity };
  if (!best.series) best.series = (all.find((x) => x.series) || {}).series || '';
  if (!best.bio) best.bio = (all.find((x) => x.bio) || {}).bio || '';
  best.favorites = Math.max(...all.map((x) => Number(x.favorites) || 0));
  best.rarity = rarityFor(best.favorites);
  if (!best.anime || !best.anime.length) best.anime = (all.find((x) => Array.isArray(x.anime) && x.anime.length) || {}).anime || [];
  return best;
}

async function chooseBestCharacter(seed) {
  if (!seed) return null;
  const name = seed.name || '';
  const results = await Promise.allSettled([
    searchJikanCharacter(name),
    searchKitsuCharacter(name),
    searchAniListCharacter(name),
  ]);
  const jikan = results[0].status === 'fulfilled' && results[0].value && sameCharacterName(name, results[0].value.name) ? results[0].value : null;
  const kitsu = results[1].status === 'fulfilled' && results[1].value && sameCharacterName(name, results[1].value.name) ? results[1].value : null;
  const anilist = results[2].status === 'fulfilled' && results[2].value && sameCharacterName(name, results[2].value.name) ? results[2].value : null;

  // If the initial seed came from AniList but Jikan resolved the same character,
  // promote the Jikan identity/ID. AniList remains the final image fallback.
  const identity = jikan || seed;
  if (db.isHuntCharacterClaimed(identity.character_id)) return null;
  const merged = mergeMetadata(identity, [seed, jikan, kitsu, anilist]);

  const jikanForPictures = jikan || (seed.source === 'Jikan' ? seed : null);
  const jikanPictures = jikanForPictures ? (await fetchJikanPictures(jikanForPictures.character_id)).slice(0, 12) : [];
  const imageCandidates = [];
  for (const picture of jikanPictures) imageCandidates.push({ ...picture, priority: 400 });
  if (jikan && jikan.image_url) imageCandidates.push({ image_url: jikan.image_url, source: 'Jikan', priority: 350 });
  if (kitsu && kitsu.image_url) imageCandidates.push({ image_url: kitsu.image_url, source: 'Kitsu', priority: 250 });
  // Explicitly last: AniList profile portraits are only used when better sources fail.
  if (anilist && anilist.image_url) imageCandidates.push({ image_url: anilist.image_url, source: 'AniList', priority: 10 });
  if (seed.source === 'AniList' && seed.image_url && !anilist) imageCandidates.push({ image_url: seed.image_url, source: 'AniList', priority: 10 });
  if (seed.source !== 'AniList' && seed.image_url) imageCandidates.push({ image_url: seed.image_url, source: seed.source || 'Seed', priority: 300 });

  const scored = await Promise.all(imageCandidates.map(async (item) => ({
    ...item,
    probe: await probeImage(item.image_url),
  })));
  const usable = scored.filter((x) => x.probe && x.probe.ok);
  usable.sort((a, b) => (b.priority - a.priority) || ((b.probe.bytes || 0) - (a.probe.bytes || 0)));
  const selected = usable[0] || null;
  if (!selected) return null;
  merged.image_url = selected.image_url;
  merged.image_source = selected.source;
  console.log(`[hunt] ${merged.name}: image=${selected.source}; Jikan=${!!jikan}; Kitsu=${!!kitsu}; AniList=${!!anilist}`);
  return merged;
}

async function fetchSpawnCharacter() {
  // Strong priority: Jikan random/identity first. If Jikan cannot produce a
  // seed after multiple attempts, only then use AniList as the seed fallback.
  for (let attempt = 0; attempt < 4; attempt++) {
    const seed = await fetchRandomFromJikan();
    if (!seed) continue;
    const card = await chooseBestCharacter(seed);
    if (card) { db.cacheHuntCharacter(card); return card; }
  }

  console.warn('[hunt] Jikan random did not yield a usable character; trying fallback seed sources.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const seed = await fetchRandomFromAniList();
    if (!seed) continue;
    const card = await chooseBestCharacter(seed);
    if (card) { db.cacheHuntCharacter(card); return card; }
  }

  const pool = db.getHuntPool(50).filter((c) => !db.isHuntCharacterClaimed(c.character_id));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return pickFallbackCharacter();
}

async function resolveCharacter(id) {
  const cached = db.getCachedHuntCharacter(id);
  if (cached) return cached;
  const base = config.hunt.baseUrl || 'https://api.jikan.moe/v4';
  const json = await fetchJson(`${base}/characters/${encodeURIComponent(id)}/full`, config.hunt.fetchTimeoutMs || 10000, 2, { label: 'Jikan character detail' });
  const seed = json && json.data ? normalizeJikan(json.data) : null;
  const card = await chooseBestCharacter(seed);
  if (card) db.cacheHuntCharacter(card);
  return card;
}

let deps = null;
function attach(d) { deps = d || null; return module.exports; }
async function reply(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[hunt] reply:', e.message); }
  }
  return null;
}
async function fetchImageBuffer(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.hunt.fetchTimeoutMs || 10000);
  timer.unref && timer.unref();
  try {
    const res = await fetch(url, { headers: { Accept: 'image/*', 'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0' }, signal: ac.signal });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    const arr = await res.arrayBuffer();
    if (arr.byteLength > MAX_TELEGRAM_PHOTO_BYTES) throw new Error('image too large for Telegram photo');
    return { buffer: Buffer.from(arr), contentType: type };
  } finally { clearTimeout(timer); }
}
async function sendPhoto(chatId, url, caption, markup) {
  if (!deps || typeof deps.sendPhoto !== 'function') return null;
  try {
    const img = await fetchImageBuffer(url);
    return await deps.sendPhoto(chatId, img.buffer, { caption, reply_markup: markup }, { filename: `hunt.${img.contentType.includes('png') ? 'png' : 'jpg'}`, contentType: img.contentType });
  } catch (e) { console.warn('[hunt] buffered photo:', e.message); }
  try { return await deps.sendPhoto(chatId, url, { caption, reply_markup: markup }); } catch (e) { console.warn('[hunt] URL photo:', e.message); }
  return reply(chatId, caption, { title: '⚔️ ANIME HUNT', reply_markup: markup, alwaysShowMarkup: true });
}
async function answerCb(text) { if (deps && typeof deps.answerCb === 'function') try { await deps.answerCb(text); } catch (_) {} }

async function spawn(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'The Anime Hunt is disabled.' };
  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) return { ok: false, message: `⚔️ A character is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveHunt();
  const card = await fetchSpawnCharacter();
  if (!card) return { ok: false, message: '⚔️ The hunting grounds are quiet right now. Try again shortly.' };
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveHunt();
  await sendPhoto(opts.chatId, card.image_url, announceCaption(card, row), claimMarkup());
  return { ok: true, character: card, expiresAt };
}

async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;
  const row = db.getActiveHunt();
  if (!row) return await answer('No character is up for grabs right now.'), { ok: false, reason: 'no-active-hunt' };
  if (!isSpawnClaimable(row)) return await answer('This character already expired or was claimed.'), { ok: false, reason: 'not-claimable' };
  const char = { character_id: row.character_id, name: row.name, series: row.series, image_url: row.image_url, bio: row.bio, favorites: row.favorites, rarity: row.rarity };
  if (!db.claimHuntCharacter(userId, char)) return await answer('Someone else already claimed this character!'), { ok: false, reason: 'already-claimed' };
  db.clearActiveHunt();
  const user = db.getUser(userId) || {};
  const claimer = user.username ? `@${user.username}` : user.first_name || `user ${userId}`;
  await reply(opts.chatId || row.chat_id, claimedCaption(char, claimer), { title: '⚔️ CLAIMED' });
  return { ok: true, character: char, userId };
}
function expireIfNeeded(now = Date.now()) {
  const row = db.getActiveHunt();
  if (!row || isSpawnClaimable(row, now)) return 0;
  db.clearActiveHunt();
  return 1;
}

async function searchAndShow(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, message: 'Usage: /char <name>' };
  const results = await Promise.allSettled([searchJikanCharacter(q), searchKitsuCharacter(q), searchAniListCharacter(q)]);
  const jikan = results[0].status === 'fulfilled' ? results[0].value : null;
  const kitsu = results[1].status === 'fulfilled' ? results[1].value : null;
  const anilist = results[2].status === 'fulfilled' ? results[2].value : null;
  const seed = jikan || kitsu || anilist;
  if (!seed) return { ok: false, message: `No character found for ${stripUrls(q)}.` };
  const card = await chooseBestCharacter(seed) || seed;
  db.cacheHuntCharacter(card);
  await sendPhoto(opts.chatId, card.image_url, detailCaption(card), null);
  return { ok: true, character: card };
}

async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveHunt())) return;
  const groups = (typeof env.getChatIds === 'function' ? env.getChatIds() : []).filter((id) => Number(id) < 0);
  if (!groups.length) return;
  const card = await fetchSpawnCharacter();
  if (!card) return;
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, groups[0]);
  const row = db.getActiveHunt();
  for (const gid of groups) await sendPhoto(gid, card.image_url, announceCaption(card, row), claimMarkup());
}

let autoSpawnTimer = null;
let autoSpawnKickoff = null;
function msUntilMinute(minute) {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next - now;
}
function startAutoSpawn(_bot, env = {}) {
  if (autoSpawnTimer || autoSpawnKickoff || !config.hunt.enabled) return autoSpawnTimer || autoSpawnKickoff;
  autoSpawnKickoff = setTimeout(() => {
    autoSpawnKickoff = null;
    autoSpawnTick(env).catch((e) => console.warn('[hunt] auto:', e.message));
    autoSpawnTimer = setInterval(() => autoSpawnTick(env).catch((e) => console.warn('[hunt] auto:', e.message)), 3600000);
    autoSpawnTimer.unref && autoSpawnTimer.unref();
  }, msUntilMinute(25));
  autoSpawnKickoff.unref && autoSpawnKickoff.unref();
  console.log('[hunt] hourly auto-spawn scheduled at :25');
  return autoSpawnKickoff;
}
function state() { return { activeSpawn: db.getActiveHunt() || null, enabled: config.hunt.enabled }; }

module.exports = {
  RARITY_TIERS, rarityFor, rarityMeta, isSpawnClaimable, secondsRemaining, seriesNameOf,
  animeListOf, truncateBio, announceCaption, claimedCaption, detailCaption, collectionCaption,
  leaderboardCaption, claimMarkup, normalizeJikan, normalizeAniList, normalizeKitsu,
  fetchRandomFromJikan, searchJikanCharacter, searchAniListCharacter, searchKitsuCharacter,
  fetchJikanPictures, fetchSpawnCharacter, resolveCharacter, attach, spawn, claim,
  expireIfNeeded, searchAndShow, startAutoSpawn, autoSpawnTick, state, FALLBACK_POOL,
  fallbackCard, pickFallbackCharacter, mergeMetadata, probeImage, fancy, sanitizeApiText,
  _clear: () => db.clearActiveHunt(),
};
