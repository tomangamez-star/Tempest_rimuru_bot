'use strict';

const config = require('./config');
const db = require('./db');

const ANILIST_URL = 'https://graphql.anilist.co';
const GELBOORU_API_URL = 'https://gelbooru.com/index.php';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_TELEGRAM_PHOTO_BYTES = 9_500_000;
const DEFAULT_VISION_MODEL = 'qwen/qwen3.6-27b';

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

function rarityFor(favorites) {
  const f = Number(favorites) || 0;
  return (RARITY_TIERS.find((t) => f >= t.min) || RARITY_TIERS[RARITY_TIERS.length - 1]).key;
}
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
function leaderboardCaption(rows) {
  if (!rows || !rows.length) return 'No hunters yet. Start the hunt! ⚔️';
  const medals = ['🥇', '🥈', '🥉'];
  return `⚔️ ${fancy('CHARACTER LEADERBOARD')}\n\n${rows.map((r, i) => {
    const user = r.username ? `@${r.username}` : (r.first_name || `User ${r.user_id}`);
    return `${medals[i] || `${i + 1}.`} ${safeUserName(user)} — ${Number(r.count) || 0}`;
  }).join('\n')}`;
}
function claimMarkup() { return { inline_keyboard: [[{ text: '⚔️ CLAIM CHARACTER', callback_data: 'hunt:claim' }]] }; }

// Offline-only emergency pool. Runtime sourcing is AniList identity + Gelbooru artwork.
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
function fallbackCard(entry) {
  if (!entry) return null;
  return {
    ...entry,
    rarity: rarityFor(entry.favorites),
    source: 'OfflineEmergency',
    image_source: 'OfflineEmergency',
    anime: [{ anime: { name: entry.series, title: entry.series } }],
  };
}
function pickFallbackCharacter() {
  const available = FALLBACK_POOL.filter((x) => !db.isHuntCharacterClaimed(x.character_id));
  if (!available.length) return null;
  return fallbackCard(available[Math.floor(Math.random() * available.length)]);
}

async function fetchJson(url, timeoutMs = config.hunt.fetchTimeoutMs || 10000, retries = 1, options = {}) {
  const label = options.label || 'request';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref && timer.unref();
    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0',
          ...(options.headers || {}),
        },
        body: options.body,
        signal: ac.signal,
      });
      if (!res.ok) {
        console.warn(`[hunt] ${label} HTTP ${res.status}${attempt < retries ? ' — retrying' : ''}`);
        if (attempt < retries) { await sleep(350 * (attempt + 1)); continue; }
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn(`[hunt] ${label} failed: ${e && e.name === 'AbortError' ? 'timeout' : e.message}`);
      if (attempt < retries) { await sleep(350 * (attempt + 1)); continue; }
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

function normalizeAniList(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id) || 0;
  const nameObj = raw.name || {};
  const name = nameObj.full || nameObj.userPreferred || '';
  const imageUrl = raw.image && (raw.image.large || raw.image.medium) || '';
  if (!id || !name || !imageUrl) return null;
  const media = raw.media && Array.isArray(raw.media.nodes) ? raw.media.nodes : [];
  const first = media[0] || {};
  const title = first.title || {};
  const series = title.english || title.romaji || title.native || '';
  const aliases = [];
  for (const item of [nameObj.full, nameObj.userPreferred, ...(Array.isArray(nameObj.alternative) ? nameObj.alternative : [])]) {
    const cleaned = stripUrls(item || '').trim();
    if (cleaned && !aliases.includes(cleaned)) aliases.push(cleaned);
  }
  const favorites = Number(raw.favourites) || 0;
  return {
    character_id: `anilist-${id}`,
    anilist_id: id,
    name: stripUrls(name),
    aliases,
    series: stripUrls(series),
    image_url: imageUrl,
    reference_image_url: imageUrl,
    bio: sanitizeApiText(raw.description || ''),
    favorites,
    rarity: rarityFor(favorites),
    source: 'AniList',
    image_source: 'AniListReference',
    anime: media.map((m) => ({ anime: { name: (m.title && (m.title.english || m.title.romaji || m.title.native)) || '' } })),
  };
}

// Legacy normalizers kept so existing tests/older callers do not break. They are
// not used by the v1.0.7 runtime sourcing path.
function normalizeJikan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.mal_id) || 0;
  const imageUrl = raw.images && raw.images.jpg && (raw.images.jpg.large_image_url || raw.images.jpg.image_url) || '';
  if (!id || !imageUrl) return null;
  const favorites = Number(raw.favorites) || 0;
  const anime = Array.isArray(raw.anime) ? raw.anime : [];
  return {
    character_id: String(id),
    name: stripUrls(raw.name || `Character ${id}`),
    series: seriesNameOf({ anime }),
    image_url: imageUrl,
    bio: sanitizeApiText(raw.about || ''),
    favorites,
    rarity: rarityFor(favorites),
    anime,
    source: 'JikanLegacy',
  };
}
function normalizeKitsu(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw.attributes || {};
  const image = a.image || {};
  const imageUrl = image.original || image.large || image.medium || '';
  if (!raw.id || !imageUrl) return null;
  return {
    character_id: `kitsu-${raw.id}`,
    name: stripUrls(a.canonicalName || a.name || `Character ${raw.id}`),
    series: '', image_url: imageUrl, bio: sanitizeApiText(a.description || ''), favorites: 0,
    rarity: 'common', source: 'KitsuLegacy',
  };
}

async function searchAniListCharacter(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const gql = `query ($search: String) { Character(search: $search) { id name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { search: q } }), label: 'AniList search',
  });
  return json && json.data && json.data.Character ? normalizeAniList(json.data.Character) : null;
}
async function fetchAniListById(id) {
  const n = Number(String(id || '').replace(/^anilist-/, ''));
  if (!n) return null;
  const gql = `query ($id: Int) { Character(id: $id) { id name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { id: n } }), label: 'AniList detail',
  });
  return json && json.data && json.data.Character ? normalizeAniList(json.data.Character) : null;
}
async function fetchRandomFromAniList() {
  const page = 1 + Math.floor(Math.random() * 120);
  const gql = `query ($page: Int) { Page(page: $page, perPage: 25) { characters(sort: FAVOURITES_DESC) { id name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { page } }), label: 'AniList random',
  });
  const rows = json && json.data && json.data.Page && Array.isArray(json.data.Page.characters) ? json.data.Page.characters : [];
  if (!rows.length) return null;
  const shuffled = rows.slice().sort(() => Math.random() - 0.5);
  for (const raw of shuffled) {
    const card = normalizeAniList(raw);
    if (card && !db.isHuntCharacterClaimed(card.character_id)) return card;
  }
  return null;
}

function normalizeGelbooruTag(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'"`]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}
function gelbooruTagVariants(card) {
  const names = [card && card.name, ...((card && Array.isArray(card.aliases)) ? card.aliases : [])].filter(Boolean);
  const out = [];
  for (const raw of names) {
    if (!/^[\x00-\x7F]+$/.test(raw)) continue;
    const tag = normalizeGelbooruTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
    const parts = tag.split('_').filter(Boolean);
    if (parts.length >= 2) {
      const reversed = [...parts].reverse().join('_');
      if (!out.includes(reversed)) out.push(reversed);
      const lastFirst = `${parts[parts.length - 1]}_${parts.slice(0, -1).join('_')}`;
      if (!out.includes(lastFirst)) out.push(lastFirst);
    }
  }
  return out.slice(0, 8);
}
function gelbooruCredentials() {
  const apiKey = String(process.env.GELBOORU_API_KEY || '').trim();
  const userId = String(process.env.GELBOORU_USER_ID || '').trim();
  return apiKey && userId ? { apiKey, userId } : null;
}
function gelbooruPosts(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.post)) return json.post;
  if (json && json.post && typeof json.post === 'object') return [json.post];
  return [];
}
function gelbooruTags(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tag)) return json.tag;
  if (json && json.tag && typeof json.tag === 'object') return [json.tag];
  return [];
}
function gelbooruSeriesTag(card) {
  const series = normalizeGelbooruTag(card && card.series || '');
  return series.length >= 3 ? series : '';
}
function gelbooruTagLookupUrl(pattern) {
  const creds = gelbooruCredentials();
  if (!creds || !pattern) return null;
  const u = new URL(GELBOORU_API_URL);
  u.searchParams.set('page', 'dapi');
  u.searchParams.set('s', 'tag');
  u.searchParams.set('q', 'index');
  u.searchParams.set('json', '1');
  u.searchParams.set('limit', '100');
  u.searchParams.set('name_pattern', `%${pattern}%`);
  u.searchParams.set('api_key', creds.apiKey);
  u.searchParams.set('user_id', creds.userId);
  return u.toString();
}
function distinctiveNameTokens(card) {
  const values = [card && card.name, ...((card && Array.isArray(card.aliases)) ? card.aliases : [])].filter(Boolean);
  const tokens = [];
  for (const value of values) {
    for (const token of normalizeGelbooruTag(value).split('_')) {
      if (token.length < 3 || /^\d+$/.test(token) || tokens.includes(token)) continue;
      tokens.push(token);
    }
  }
  return tokens.sort((a, b) => b.length - a.length).slice(0, 3);
}
async function discoverGelbooruTags(card) {
  const direct = new Set(gelbooruTagVariants(card));
  const seriesTag = gelbooruSeriesTag(card);
  const rows = [];
  for (const token of distinctiveNameTokens(card).slice(0, 2)) {
    const url = gelbooruTagLookupUrl(token);
    const json = await fetchJson(url, config.hunt.fetchTimeoutMs || 10000, 1, { label: `Gelbooru tag lookup ${token}` });
    for (const raw of gelbooruTags(json)) {
      const name = String(raw && raw.name || '').trim();
      if (!name) continue;
      const normalized = normalizeGelbooruTag(name);
      const tokenHits = distinctiveNameTokens(card).filter((t) => normalized.includes(t)).length;
      if (!tokenHits) continue;
      let score = tokenHits * 25 + Math.min(20, Math.log10(Math.max(1, Number(raw.count) || 1)) * 5);
      if (direct.has(normalized)) score += 100;
      if (seriesTag && normalized.includes(seriesTag)) score += 20;
      rows.push({ name, normalized, score });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  const out = [];
  for (const row of rows) {
    if (!out.includes(row.name)) out.push(row.name);
    if (out.length >= 6) break;
  }
  if (out.length) console.log(`[hunt] ${card.name}: discovered Gelbooru tags=${out.slice(0, 4).join(',')}`);
  return out;
}
function normalizeGelbooruPost(raw, queryTag) {
  if (!raw || typeof raw !== 'object') return null;
  const fileUrl = String(raw.file_url || raw.fileUrl || '').trim();
  const sampleUrl = String(raw.sample_url || raw.sampleUrl || raw.preview_url || raw.previewUrl || '').trim();
  if (!fileUrl && !sampleUrl) return null;
  const rating = String(raw.rating || '').toLowerCase();
  if (rating && !['safe', 's', 'general', 'g'].includes(rating)) return null;
  const tags = String(raw.tags || '').split(/\s+/).filter(Boolean);
  return {
    id: String(raw.id || ''),
    query_tag: queryTag,
    tags,
    file_url: fileUrl || sampleUrl,
    sample_url: sampleUrl || fileUrl,
    width: Number(raw.width || 0),
    height: Number(raw.height || 0),
    score: Number(raw.score || 0),
    rating,
  };
}
function gelbooruSearchUrl(tag, seriesTag = '') {
  const creds = gelbooruCredentials();
  if (!creds) return null;
  const u = new URL(GELBOORU_API_URL);
  u.searchParams.set('page', 'dapi');
  u.searchParams.set('s', 'post');
  u.searchParams.set('q', 'index');
  u.searchParams.set('json', '1');
  u.searchParams.set('limit', '50');
  u.searchParams.set('tags', `${tag}${seriesTag ? ` ${seriesTag}` : ''} rating:safe sort:score:desc`);
  u.searchParams.set('api_key', creds.apiKey);
  u.searchParams.set('user_id', creds.userId);
  return u.toString();
}
function artworkRank(post) {
  const goodResolution = post.width >= 700 && post.height >= 700 ? 1 : 0;
  const solo = post.tags.includes('solo') ? 1 : 0;
  const area = Math.min(25_000_000, Math.max(0, post.width * post.height));
  return (goodResolution * 1e12) + (solo * 1e11) + (Math.max(-1000, post.score) * 1e7) + area;
}
async function fetchGelbooruTagBatch(card, tags, seriesTag = '') {
  const queries = [];
  for (const tag of tags.slice(0, 4)) {
    if (seriesTag) queries.push({ tag, series: seriesTag });
    queries.push({ tag, series: '' });
  }
  const settled = await Promise.all(queries.map(async ({ tag, series }) => {
    const url = gelbooruSearchUrl(tag, series);
    const json = await fetchJson(url, Math.min(7000, config.hunt.fetchTimeoutMs || 10000), 0, { label: `Gelbooru tag ${tag}` });
    return gelbooruPosts(json).map((post) => normalizeGelbooruPost(post, tag)).filter(Boolean);
  }));
  const seen = new Set();
  const out = [];
  for (const posts of settled) {
    for (const post of posts) {
      const key = post.file_url || post.sample_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(post);
    }
  }
  out.sort((a, b) => artworkRank(b) - artworkRank(a));
  return out.slice(0, 12);
}
async function searchGelbooruArtwork(card) {
  if (!gelbooruCredentials()) {
    console.warn('[hunt] GELBOORU_API_KEY/GELBOORU_USER_ID missing — using AniList emergency portrait.');
    return [];
  }
  const seriesTag = gelbooruSeriesTag(card);
  const direct = gelbooruTagVariants(card);

  let found = await fetchGelbooruTagBatch(card, direct.slice(0, 4), seriesTag);
  if (!found.length && direct.length > 4) found = await fetchGelbooruTagBatch(card, direct.slice(4, 8), seriesTag);
  if (!found.length) {
    const discovered = await discoverGelbooruTags(card);
    found = await fetchGelbooruTagBatch(card, discovered, seriesTag);
  }

  console.log(`[hunt] ${card.name}: Gelbooru candidates=${found.length}${found[0] ? ` tag=${found[0].query_tag}` : ''}`);
  return found.slice(0, 8);
}

function parseVisionJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}
async function verifyArtworkWithVision(card, candidate) {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return { ok: false, unavailable: true, confidence: 0, reason: 'GROQ_API_KEY missing' };
  const reference = card.reference_image_url || card.image_url;
  const candidateUrl = candidate.sample_url || candidate.file_url;
  if (!reference || !candidateUrl) return { ok: false, confidence: 0, reason: 'missing image URL' };
  const model = String(process.env.HUNT_VISION_MODEL || DEFAULT_VISION_MODEL).trim();
  const minConfidence = Math.min(0.95, Math.max(0.5, Number(process.env.HUNT_VISION_MIN_CONFIDENCE || 0.72)));
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 140,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Image 1 is a trusted AniList reference portrait of the anime character "${card.name}"${card.series ? ` from "${card.series}"` : ''}. Image 2 is candidate fan/artwork from a tagged anime image database. Decide whether Image 2 clearly depicts the SAME character as Image 1. Different pose, clothes, art style, age rendering, or background are allowed. Match distinctive face, hair, eyes, and character design. It is okay if other characters also appear, but the target must be clearly visible. Also reject nudity, explicit sexual content, or clearly sexualized imagery even if the character matches. Return JSON only: {"match":true|false,"safe":true|false,"confidence":0.0,"reason":"short reason"}.`,
        },
        { type: 'image_url', image_url: { url: reference } },
        { type: 'image_url', image_url: { url: candidateUrl } },
      ],
    }],
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(12000, config.hunt.fetchTimeoutMs || 10000));
  timer.unref && timer.unref();
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[hunt] Groq vision HTTP ${res.status} (${model})`);
      return { ok: false, unavailable: true, confidence: 0, reason: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const parsed = parseVisionJson(content) || {};
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const match = parsed.match === true || String(parsed.match).toLowerCase() === 'true';
    const safe = parsed.safe === true || String(parsed.safe).toLowerCase() === 'true';
    return { ok: match && safe && confidence >= minConfidence, match, safe, confidence, reason: sanitizeApiText(parsed.reason || '') };
  } catch (e) {
    console.warn(`[hunt] Groq vision failed: ${e && e.name === 'AbortError' ? 'timeout' : e.message}`);
    return { ok: false, unavailable: true, confidence: 0, reason: 'vision request failed' };
  } finally { clearTimeout(timer); }
}

async function probeImage(url) {
  if (!url) return { ok: false, bytes: 0 };
  const headers = { 'User-Agent': config.hunt.userAgent || 'RimuruTempestCasino/1.0', Accept: 'image/*' };
  const check = async (method, extraHeaders = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
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
  return check('GET', { Range: 'bytes=0-0' });
}

async function displayUrlForCandidate(candidate) {
  const full = candidate.file_url;
  if (full) {
    const p = await probeImage(full);
    if (p.ok) return full;
  }
  const sample = candidate.sample_url;
  if (sample) {
    const p = await probeImage(sample);
    if (p.ok) return sample;
  }
  return '';
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
  const identity = seed.source === 'AniList' ? seed : await searchAniListCharacter(seed.name || '');
  if (!identity) return null;
  if (db.isHuntCharacterClaimed(identity.character_id)) return null;
  const merged = mergeMetadata(identity, [seed]);
  merged.reference_image_url = identity.reference_image_url || identity.image_url;

  const candidates = await searchGelbooruArtwork(merged);
  const hasVision = !!String(process.env.GROQ_API_KEY || '').trim();
  if (candidates.length && hasVision) {
    for (const candidate of candidates.slice(0, 4)) {
      const verdict = await verifyArtworkWithVision(merged, candidate);
      console.log(`[hunt] ${merged.name}: vision tag=${candidate.query_tag} match=${!!verdict.match} confidence=${Number(verdict.confidence || 0).toFixed(2)}`);
      if (!verdict.ok) continue;
      const displayUrl = await displayUrlForCandidate(candidate);
      if (!displayUrl) continue;
      merged.image_url = displayUrl;
      merged.image_source = 'Gelbooru+GroqVision';
      merged.image_tag = candidate.query_tag;
      merged.image_score = candidate.score;
      merged.vision_confidence = verdict.confidence;
      console.log(`[hunt] ${merged.name}: selected Gelbooru artwork tag=${candidate.query_tag} score=${candidate.score} vision=${verdict.confidence.toFixed(2)}`);
      return merged;
    }
  } else if (candidates.length && !hasVision) {
    console.warn(`[hunt] ${merged.name}: Gelbooru candidates found but GROQ_API_KEY is missing; refusing unverified artwork.`);
  }

  // Identity must stay correct. If artwork cannot be visually verified, use the
  // trusted AniList portrait only as an emergency display fallback.
  const p = await probeImage(identity.image_url);
  if (p.ok) {
    merged.image_url = identity.image_url;
    merged.image_source = 'AniListEmergency';
    console.warn(`[hunt] ${merged.name}: no verified Gelbooru artwork; using AniList emergency portrait.`);
    return merged;
  }
  return null;
}

async function fetchSpawnCharacter() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = await fetchRandomFromAniList();
    if (!seed) continue;
    const card = await chooseBestCharacter(seed);
    if (card) { db.cacheHuntCharacter(card); return card; }
  }

  // Only re-use modern AniList identities from cache; do not resurrect old
  // Jikan/Kitsu cache entries from previous builds.
  const pool = db.getHuntPool(50).filter((c) => String(c.character_id || '').startsWith('anilist-') && !db.isHuntCharacterClaimed(c.character_id));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];

  // Keep the historical fallback pool for offline regression tests only. In
  // production, do not regress to old MAL/Jikan-era portrait artwork.
  if (process.env.NODE_ENV === 'test') return pickFallbackCharacter();
  console.warn('[hunt] no AniList identity/cache available; skipping spawn instead of using legacy artwork.');
  return null;
}

async function resolveCharacter(id) {
  const cached = db.getCachedHuntCharacter(id);
  if (cached) return cached;
  if (!String(id || '').startsWith('anilist-')) return null;
  const seed = await fetchAniListById(id);
  const card = await chooseBestCharacter(seed);
  if (card) db.cacheHuntCharacter(card);
  return card;
}

// Hard-disabled legacy runtime sources. Kept as exported no-ops so older code
// importing these names does not crash while guaranteeing Jikan/Kitsu are not
// consulted by Hunt v1.0.7.
async function fetchRandomFromJikan() { return null; }
async function searchJikanCharacter() { return null; }
async function fetchJikanPictures() { return []; }
async function searchKitsuCharacter() { return null; }

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
  const seed = await searchAniListCharacter(q);
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
  console.log(`[hunt-v1.0.7] AniList identity + Gelbooru artwork + Groq vision (${process.env.HUNT_VISION_MODEL || DEFAULT_VISION_MODEL})`);
  return autoSpawnKickoff;
}
function state() { return { activeSpawn: db.getActiveHunt() || null, enabled: config.hunt.enabled }; }

module.exports = {
  RARITY_TIERS, rarityFor, rarityMeta, isSpawnClaimable, secondsRemaining, seriesNameOf,
  animeListOf, truncateBio, announceCaption, claimedCaption, detailCaption, collectionCaption,
  leaderboardCaption, claimMarkup, normalizeJikan, normalizeAniList, normalizeKitsu,
  fetchRandomFromJikan, searchJikanCharacter, searchAniListCharacter, searchKitsuCharacter,
  fetchJikanPictures, fetchRandomFromAniList, fetchAniListById, fetchSpawnCharacter, resolveCharacter,
  attach, spawn, claim, expireIfNeeded, searchAndShow, startAutoSpawn, autoSpawnTick, state,
  FALLBACK_POOL, fallbackCard, pickFallbackCharacter, mergeMetadata, probeImage, fancy, sanitizeApiText,
  normalizeGelbooruTag, gelbooruTagVariants, gelbooruSeriesTag, discoverGelbooruTags, searchGelbooruArtwork, verifyArtworkWithVision,
  _clear: () => db.clearActiveHunt(),
};
