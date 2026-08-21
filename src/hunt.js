'use strict';
const customCards = require('./custom-cards');

const config = require('./config');
const db = require('./db');
const cardRenderer = require('./hunt-card');
const specialCardRenderer = require('./special-hunt-card');
const signatureCardRenderer = require('./jtf-gen-card');

const ANILIST_URL = 'https://graphql.anilist.co';
const ANIME_PICTURES_API_URL = 'https://api.anime-pictures.net/api/v3';
const DANBOORU_PUBLIC_URL = 'https://danbooru.donmai.us';
const GELBOORU_API_URL = 'https://gelbooru.com/index.php';
const SAFEBOORU_API_URL = 'https://safebooru.org/index.php';
const DANBOORU_SAFE_URL = 'https://safebooru.donmai.us';
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

// Spawn rarity is intentionally rolled first, then Rimuru selects a character
// whose AniList favourites fit that tier. This avoids the old behaviour where
// a uniformly-random popularity page made T2 dominate almost every /hunt.
const HUNT_TIER_TARGETS = [
  { tier: 6, label: 'GODLIKE',  weight: 3,  min: 80000, max: Infinity, pageMin: 1,  pageMax: 1 },
  { tier: 5, label: 'ULTIMATE', weight: 7,  min: 50000, max: 79999,    pageMin: 1,  pageMax: 2 },
  { tier: 4, label: 'LEGACY',   weight: 12, min: 20000, max: 49999,    pageMin: 1,  pageMax: 5 },
  { tier: 3, label: 'MYTHICAL', weight: 22, min: 5000,  max: 19999,    pageMin: 2,  pageMax: 18 },
  { tier: 2, label: 'RARE',     weight: 30, min: 500,   max: 4999,     pageMin: 6,  pageMax: 55 },
  { tier: 1, label: 'COMMON',   weight: 26, min: 0,     max: 499,      pageMin: 35, pageMax: 60 },
];

function huntTierFromFavorites(favorites) {
  const f = Math.max(0, Number(favorites) || 0);
  return HUNT_TIER_TARGETS.find((t) => f >= t.min && f <= t.max) || HUNT_TIER_TARGETS[HUNT_TIER_TARGETS.length - 1];
}

function rollHuntSpawnTier(rng = Math.random) {
  const total = HUNT_TIER_TARGETS.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.max(0, Math.min(0.999999999, Number(rng()) || 0)) * total;
  for (const target of HUNT_TIER_TARGETS) {
    if (roll < target.weight) return target;
    roll -= target.weight;
  }
  return HUNT_TIER_TARGETS[HUNT_TIER_TARGETS.length - 1];
}

function randomIntInclusive(min, max) {
  const lo = Math.ceil(Number(min) || 0);
  const hi = Math.floor(Number(max) || lo);
  return lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
}

// /shunt uses a smaller premium catalogue. Danbooru must prove at runtime
// that the chosen real character has at least six safe solo portrait artworks.
const SPECIAL_CHARACTER_CATALOG = [
  'Satoru Gojo', 'Makima', 'Power', 'Denji', 'Aki Hayakawa',
  'Rimuru Tempest', 'Sung Jin-Woo', 'Tanjiro Kamado', 'Nezuko Kamado', 'Kyojuro Rengoku',
  'Giyu Tomioka', 'Mitsuri Kanroji', 'Shinobu Kocho', 'Muichiro Tokito', 'Tengen Uzui',
  'Naruto Uzumaki', 'Sasuke Uchiha', 'Kakashi Hatake', 'Itachi Uchiha', 'Hinata Hyuga',
  'Monkey D. Luffy', 'Roronoa Zoro', 'Nami', 'Nico Robin', 'Boa Hancock',
  'Levi Ackerman', 'Mikasa Ackerman', 'Eren Yeager', 'Historia Reiss',
  'Ichigo Kurosaki', 'Rukia Kuchiki', 'Sosuke Aizen',
  'Kirito', 'Asuna Yuuki', 'Sinon',
  'Rem', 'Ram', 'Emilia',
  'Zero Two', 'Marin Kitagawa', 'Ai Hoshino', 'Aqua Hoshino',
  'Megumin', 'Frieren', 'Fern', 'Violet Evergarden',
  'Yor Forger', 'Loid Forger', 'Anya Forger',
  'Momo Ayase', 'Ken Takakura',
  'Ryomen Sukuna', 'Yuji Itadori', 'Megumi Fushiguro', 'Nobara Kugisaki',
  'Toji Fushiguro', 'Yuta Okkotsu',
  'Shoto Todoroki', 'Katsuki Bakugo', 'Izuku Midoriya',
  'Kurisu Makise', 'Holo', 'Mai Sakurajima', 'Miku Nakano',
];
const SPECIAL_MIN_ARTWORKS = 6;

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

function storedSpecialTier(card) {
  const m = String(card && card.image_url || '').match(/#jtf-oldgen-t([1-6])$/i);
  return m ? Number(m[1]) : 0;
}
function storedSignatureTier(card) {
  const m = String(card && card.image_url || '').match(/#jtf-signature-t([1-6])$/i);
  return m ? Number(m[1]) : 0;
}
function withStoredSpecialTier(card) {
  const tier = storedSpecialTier(card);
  return tier && card && !Number(card.forced_tier) ? { ...card, forced_tier: tier } : card;
}
function withStoredPresentationTier(card) {
  const tier = storedSignatureTier(card) || storedSpecialTier(card);
  return tier && card && !Number(card.forced_tier) ? { ...card, forced_tier: tier } : card;
}
function cardTierMeta(card) { return cardRenderer.tierFor(withStoredPresentationTier(card)); }

function announceCaption(card, spawn) {
  const tier = cardTierMeta(card);
  const secs = secondsRemaining(spawn);
  const series = seriesNameOf(card);
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
    '             🃏  𝐂𝐀𝐑𝐃𝐒  🃏',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    '          ✨ 𝐀 𝐍𝐄𝐖 𝐂𝐀𝐑𝐃 𝐇𝐀𝐒 𝐀𝐏𝐏𝐄𝐀𝐑𝐄𝐃! ✨',
    '',
    `              👤 ${fancy(stripUrls(card.name || 'Unknown'))}`,
  ];
  if (series) lines.push(`              🎬 ${fancy(series)}`);
  lines.push(
    '',
    `          🃏 『 ${fancy(`T${tier.tier} ${tier.label}`)} 』`,
    '',
    `        ⏱️ ${fancy(String(secs))}𝐬 𝐑𝐄𝐌𝐀𝐈𝐍𝐈𝐍𝐆`,
    '           ⚡ 𝐅𝐢𝐫𝐬𝐭 𝐜𝐥𝐚𝐢𝐦 𝐰𝐢𝐧𝐬!',
  );
  return lines.join('\n').slice(0, 1024);
}

function specialAnnounceCaption(card, spawn) {
  const tier = cardTierMeta(card);
  const secs = secondsRemaining(spawn);
  const series = seriesNameOf(card);
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
    '        ✦  𝐒𝐏𝐄𝐂𝐈𝐀𝐋 𝐇𝐔𝐍𝐓  ✦',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    '       🔥 𝐀𝐍 𝐎𝐋𝐃 𝐆𝐄𝐍 𝐂𝐀𝐑𝐃 𝐇𝐀𝐒 𝐀𝐏𝐏𝐄𝐀𝐑𝐄𝐃!',
    '',
    `              👤 ${fancy(stripUrls(card.name || 'Unknown'))}`,
  ];
  if (series) lines.push(`              🎬 ${fancy(series)}`);
  lines.push('', `          ✦ 『 ${fancy(`T${tier.tier} ${tier.label}`)} 』`, '', `        ⏱️ ${fancy(String(secs))}𝐬 𝐑𝐄𝐌𝐀𝐈𝐍𝐈𝐍𝐆`, '           ⚡ 𝐅𝐢𝐫𝐬𝐭 𝐜𝐥𝐚𝐢𝐦 𝐰𝐢𝐧𝐬!');
  return lines.join('\n').slice(0, 1024);
}
function signatureAnnounceCaption(card, spawn) {
  const tier = cardTierMeta(card);
  const secs = secondsRemaining(spawn);
  const series = seriesNameOf(card);
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
    '       ♦️  𝐉𝐓𝐅 𝐒𝐈𝐆𝐍𝐀𝐓𝐔𝐑𝐄  ♦️',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    '      ✨ 𝐀 𝐒𝐈𝐆𝐍𝐀𝐓𝐔𝐑𝐄 𝐂𝐀𝐑𝐃 𝐇𝐀𝐒 𝐀𝐑𝐑𝐈𝐕𝐄𝐃!',
    '',
    `              👤 ${fancy(stripUrls(card.name || 'Unknown'))}`,
  ];
  if (series) lines.push(`              🎬 ${fancy(series)}`);
  lines.push('', `          ♦️ 『 ${fancy(`T${tier.tier} ${tier.label}`)} 』`, '', `        ⏱️ ${fancy(String(secs))}𝐬 𝐑𝐄𝐌𝐀𝐈𝐍𝐈𝐍𝐆`, '           ⚡ 𝐅𝐢𝐫𝐬𝐭 𝐜𝐥𝐚𝐢𝐦 𝐰𝐢𝐧𝐬!');
  return lines.join('\n').slice(0, 1024);
}

function claimedCaption(char, claimerName) {
  const tier = cardTierMeta(char);
  return `🃏 ${fancy('CARD CLAIMED!')}\n👤 ${fancy(stripUrls(char.name))}\n${seriesNameOf(char) ? `🎬 ${fancy(seriesNameOf(char))}\n` : ''}⭐ ${fancy(`T${tier.tier} ${tier.label}`)}\n🎯 ${fancy('Claimed by')} ${safeUserName(claimerName)}`;
}
function detailCaption(char, opts = {}) {
  const tier = cardTierMeta(char);
  const lines = [`🃏 ${fancy(stripUrls(char.name))}`, `🆔 Card ID: ${stripUrls(char.character_id)}`];
  if (seriesNameOf(char)) lines.push(`🎬 ${fancy(seriesNameOf(char))}`);
  const bio = truncateBio(char.bio);
  if (bio) lines.push(`📖 About: ${bio}`);
  const anime = animeListOf(char);
  if (anime) lines.push(`📚 Appears in: ${anime}`);
  lines.push(`⭐ Card Tier: ${fancy(`T${tier.tier} ${tier.label}`)}`);
  if (opts.claimedAt) lines.push(`📅 Claimed: ${new Date(Number(opts.claimedAt) || opts.claimedAt).toLocaleDateString()}`);
  return lines.join('\n');
}
function collectionCaption(rows) {
  if (!rows || !rows.length) return 'Your card collection is empty. Use /hunt to find one! 🃏';
  return `🃏 ${fancy('YOUR CARDS')} (${rows.length})\n\n${rows.map((r, i) => {
    const tier = cardTierMeta(r);
    return `${i + 1}. T${tier.tier} ${fancy(stripUrls(r.name))} — ${fancy(stripUrls(r.series || '?'))}`;
  }).join('\n')}`;
}
function leaderboardCaption(rows) {
  if (!rows || !rows.length) return 'No card collectors yet. Start with /hunt! 🃏';
  const medals = ['🥇', '🥈', '🥉'];
  return `🃏 ${fancy('CARD LEADERBOARD')}\n\n${rows.map((r, i) => {
    const user = r.username ? `@${r.username}` : (r.first_name || `User ${r.user_id}`);
    return `${medals[i] || `${i + 1}.`} ${safeUserName(user)} — ${Number(r.count) || 0} cards`;
  }).join('\n')}`;
}
function claimMarkup() { return { inline_keyboard: [[{ text: '🃏 CLAIM CARD', callback_data: 'hunt:claim' }]] }; }

// Emergency identity pool. Live Cards prefer exact character-tag artwork and render it into the T1-T6 frame.
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
    gender: String(raw.gender || '').trim(),
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
  const gql = `query ($search: String) { Character(search: $search) { id gender name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { search: q } }), label: 'AniList search',
  });
  return json && json.data && json.data.Character ? normalizeAniList(json.data.Character) : null;
}
async function fetchAniListById(id) {
  const n = Number(String(id || '').replace(/^anilist-/, ''));
  if (!n) return null;
  const gql = `query ($id: Int) { Character(id: $id) { id gender name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } }`;
  const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { id: n } }), label: 'AniList detail',
  });
  return json && json.data && json.data.Character ? normalizeAniList(json.data.Character) : null;
}
async function fetchRandomFromAniList(targetTier = null) {
  const target = targetTier && Number(targetTier.tier)
    ? targetTier
    : HUNT_TIER_TARGETS.find((x) => x.tier === Number(targetTier)) || rollHuntSpawnTier();

  const gql = `query ($page: Int) { Page(page: $page, perPage: 50) { characters(sort: FAVOURITES_DESC) { id gender name { full userPreferred native alternative } image { large medium } description(asHtml: false) favourites media(perPage: 8, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } } }`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const page = randomIntInclusive(target.pageMin, target.pageMax);
    const json = await fetchJson(ANILIST_URL, config.hunt.fetchTimeoutMs || 10000, 2, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { page } }), label: `AniList T${target.tier} spawn`,
    });
    const rows = json && json.data && json.data.Page && Array.isArray(json.data.Page.characters) ? json.data.Page.characters : [];
    if (!rows.length) continue;

    const candidates = rows
      .map(normalizeAniList)
      .filter(Boolean)
      .filter((card) => !db.isHuntCharacterClaimed(card.character_id))
      .filter((card) => huntTierFromFavorites(card.favorites).tier === target.tier)
      .sort(() => Math.random() - 0.5);

    if (candidates.length) {
      const picked = candidates[0];
      console.log(`[cards] rolled T${target.tier} ${target.label}; selected ${picked.name} (${Number(picked.favorites) || 0} AniList favourites)`);
      return picked;
    }
  }

  console.warn(`[cards] no unclaimed AniList character found inside rolled T${target.tier} band this attempt.`);
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
    provider: 'Gelbooru',
    exact_tag: true,
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
    console.warn('[hunt] GELBOORU_API_KEY/GELBOORU_USER_ID missing — artwork lookup unavailable.');
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


function safebooruSearchUrl(tag, seriesTag = '') {
  const u = new URL(SAFEBOORU_API_URL);
  u.searchParams.set('page', 'dapi');
  u.searchParams.set('s', 'post');
  u.searchParams.set('q', 'index');
  u.searchParams.set('json', '1');
  u.searchParams.set('limit', '50');
  u.searchParams.set('tags', `${tag}${seriesTag ? ` ${seriesTag}` : ''}`);
  return u.toString();
}
function normalizeSafebooruPost(raw, queryTag) {
  const post = normalizeGelbooruPost(raw, queryTag);
  if (!post) return null;
  post.provider = 'Safebooru';
  post.exact_tag = true;
  // Safebooru is SFW-only; don't reject an omitted/legacy rating field.
  return post;
}
async function fetchSafebooruTagBatch(card, tags, seriesTag = '') {
  const queries = [];
  for (const tag of tags.slice(0, 4)) {
    if (seriesTag) queries.push({ tag, series: seriesTag });
    queries.push({ tag, series: '' });
  }
  const settled = await Promise.all(queries.map(async ({ tag, series }) => {
    const json = await fetchJson(safebooruSearchUrl(tag, series), Math.min(7000, config.hunt.fetchTimeoutMs || 10000), 0, { label: `Safebooru tag ${tag}` });
    return gelbooruPosts(json).map((post) => normalizeSafebooruPost(post, tag)).filter(Boolean);
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
async function searchSafebooruArtwork(card) {
  const direct = gelbooruTagVariants(card);
  const seriesTag = gelbooruSeriesTag(card);
  let found = await fetchSafebooruTagBatch(card, direct.slice(0, 4), seriesTag);
  if (!found.length && direct.length > 4) found = await fetchSafebooruTagBatch(card, direct.slice(4, 8), seriesTag);
  console.log(`[hunt] ${card.name}: Safebooru candidates=${found.length}${found[0] ? ` tag=${found[0].query_tag}` : ''}`);
  return found.slice(0, 8);
}

function normalizeDanbooruPost(raw, queryTag) {
  if (!raw || typeof raw !== 'object') return null;
  const fileUrl = String(raw.file_url || raw.large_file_url || '').trim();
  const sampleUrl = String(raw.preview_file_url || raw.large_file_url || raw.file_url || '').trim();
  if (!fileUrl && !sampleUrl) return null;
  const rating = String(raw.rating || '').toLowerCase();
  // General only. The safe Danbooru host is already conservative, but this
  // keeps the contract explicit for Rimuru's public groups.
  if (rating && rating !== 'g') return null;
  const tags = String(raw.tag_string || '').split(/\s+/).filter(Boolean);
  return {
    id: String(raw.id || ''),
    query_tag: queryTag,
    tags,
    file_url: fileUrl || sampleUrl,
    sample_url: sampleUrl || fileUrl,
    width: Number(raw.image_width || 0),
    height: Number(raw.image_height || 0),
    score: Number(raw.score || 0),
    rating,
    provider: 'DanbooruSafe',
    exact_tag: true,
  };
}
function danbooruPostsUrl(tag) {
  const u = new URL('/posts.json', DANBOORU_SAFE_URL);
  u.searchParams.set('limit', '40');
  u.searchParams.set('tags', `${tag} rating:g`);
  return u.toString();
}
function danbooruTagsUrl(pattern) {
  const u = new URL('/tags.json', DANBOORU_SAFE_URL);
  u.searchParams.set('limit', '20');
  u.searchParams.set('search[fuzzy_name_matches]', pattern);
  u.searchParams.set('search[order]', 'similarity');
  return u.toString();
}
async function discoverDanbooruCharacterTags(card) {
  const direct = gelbooruTagVariants(card);
  const seen = new Set(direct);
  const out = [];
  const patterns = [normalizeGelbooruTag(card && card.name || ''), ...distinctiveNameTokens(card)].filter(Boolean).slice(0, 3);
  for (const pattern of patterns) {
    const json = await fetchJson(danbooruTagsUrl(pattern), Math.min(7000, config.hunt.fetchTimeoutMs || 10000), 0, { label: `Danbooru tag lookup ${pattern}` });
    for (const raw of Array.isArray(json) ? json : []) {
      if (Number(raw.category) !== 4 || raw.is_deprecated) continue;
      const name = String(raw.name || '').trim();
      if (!name || seen.has(name)) continue;
      const normalized = normalizeGelbooruTag(name);
      const hits = distinctiveNameTokens(card).filter((t) => normalized.includes(t)).length;
      if (!hits) continue;
      seen.add(name);
      out.push({ name, count: Number(raw.post_count || 0), hits });
    }
  }
  out.sort((a, b) => (b.hits - a.hits) || (b.count - a.count));
  return [...direct, ...out.map((x) => x.name)].slice(0, 8);
}
async function searchDanbooruSafeArtwork(card) {
  const tags = await discoverDanbooruCharacterTags(card);
  const seen = new Set();
  const out = [];
  for (const tag of tags.slice(0, 6)) {
    const json = await fetchJson(danbooruPostsUrl(tag), Math.min(7000, config.hunt.fetchTimeoutMs || 10000), 0, { label: `DanbooruSafe tag ${tag}` });
    for (const raw of Array.isArray(json) ? json : []) {
      const post = normalizeDanbooruPost(raw, tag);
      if (!post) continue;
      const key = post.file_url || post.sample_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(post);
    }
    if (out.length >= 12) break;
  }
  out.sort((a, b) => artworkRank(b) - artworkRank(a));
  console.log(`[hunt] ${card.name}: DanbooruSafe candidates=${out.length}${out[0] ? ` tag=${out[0].query_tag}` : ''}`);
  return out.slice(0, 8);
}

async function searchArtworkSources(card) {
  const settled = await Promise.allSettled([
    searchDanbooruSafeArtwork(card),
    searchSafebooruArtwork(card),
    searchGelbooruArtwork(card),
  ]);
  const seen = new Set();
  const out = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled' || !Array.isArray(item.value)) continue;
    for (const post of item.value) {
      const key = post.file_url || post.sample_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(post);
    }
  }
  out.sort((a, b) => artworkRank(b) - artworkRank(a));
  console.log(`[hunt] ${card.name}: combined artwork candidates=${out.length} providers=${[...new Set(out.map((x) => x.provider))].join(',') || 'none'}`);
  return out.slice(0, 14);
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
  let referenceData;
  let candidateData;
  try {
    const [refImg, candImg] = await Promise.all([fetchImageBuffer(reference), fetchImageBuffer(candidateUrl)]);
    referenceData = `data:${refImg.contentType};base64,${refImg.buffer.toString('base64')}`;
    candidateData = `data:${candImg.contentType};base64,${candImg.buffer.toString('base64')}`;
  } catch (e) {
    console.warn(`[hunt] vision image download failed (${candidate.provider || 'art'}): ${e.message}`);
    return { ok: false, unavailable: true, confidence: 0, reason: 'image download failed' };
  }
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
        { type: 'image_url', image_url: { url: referenceData } },
        { type: 'image_url', image_url: { url: candidateData } },
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

function candidateHasExactCharacterTag(candidate) {
  if (!candidate || !candidate.exact_tag || !candidate.query_tag) return false;
  const wanted = normalizeGelbooruTag(candidate.query_tag);
  if (!wanted) return false;
  const tags = new Set((candidate.tags || []).map((t) => normalizeGelbooruTag(t)).filter(Boolean));
  return tags.has(wanted);
}

function trustedArtworkRank(candidate) {
  const provider = String(candidate && candidate.provider || '');
  const providerBoost = provider === 'DanbooruSafe' ? 3e15 : provider === 'Safebooru' ? 2e15 : provider === 'Gelbooru' ? 1e15 : 0;
  return providerBoost + artworkRank(candidate || {});
}


// ===================== ANIME-PICTURES CARD ARTWORK =====================
// Cards use Anime-Pictures as their only live fan-art catalogue. Waifu keeps
// its already-approved legacy providers below and is intentionally isolated.
const animePicturesPoolCache = new Map();
let animePicturesRequestChain = Promise.resolve();
let animePicturesLastRequestAt = 0;
const ANIME_PICTURES_CACHE_MS = 6 * 60 * 60 * 1000;
const ANIME_PICTURES_EMPTY_CACHE_MS = 15 * 60 * 1000;
const ANIME_PICTURES_MIN_GAP_MS = 650;

function normalizeAnimePicturesUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('/')) url = `https://anime-pictures.net${url}`;
  // Anime-Pictures preview fields can add a negotiated .webp/.avif suffix to
  // an otherwise normal JPG/PNG URL. The underlying URL is more portable for
  // Sharp/Render, so strip only that final negotiated suffix.
  url = url.replace(/(\.(?:jpe?g|png|gif))\.(?:webp|avif)(?=\?|$)/i, '$1');
  return /^https:\/\//i.test(url) ? url : '';
}

function animePicturesDerivedPreview(post) {
  const md5 = String(post && post.md5 || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(md5)) return '';
  return `https://opreviews.anime-pictures.net/${md5.slice(0, 3)}/${md5}_bp.png`;
}

function animePicturesPreviewUrl(post) {
  return normalizeAnimePicturesUrl(post && (post.big_preview || post.medium_preview || post.small_preview)) || animePicturesDerivedPreview(post);
}

async function animePicturesJson(url, label, retries = 1) {
  const task = async () => {
    const wait = Math.max(0, ANIME_PICTURES_MIN_GAP_MS - (Date.now() - animePicturesLastRequestAt));
    if (wait) await sleep(wait);
    animePicturesLastRequestAt = Date.now();
    return fetchJson(url, Math.max(10000, config.hunt.fetchTimeoutMs || 10000), retries, { label: label || 'Anime-Pictures' });
  };
  const run = animePicturesRequestChain.then(task, task);
  // Keep the queue alive even if a future implementation throws unexpectedly.
  animePicturesRequestChain = run.catch(() => null);
  return run;
}

function simpleTagText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function animePicturesNameVariants(card) {
  const out = [];
  const push = (value) => {
    const clean = stripUrls(value || '').replace(/\s+/g, ' ').trim();
    if (clean && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };
  push(card && card.name);
  for (const alias of Array.isArray(card && card.aliases) ? card.aliases : []) push(alias);

  // Anime-Pictures commonly stores Japanese names family-name first. Add the
  // reversed form without changing the canonical AniList identity.
  for (const value of out.slice()) {
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 4) push([...parts].reverse().join(' '));
  }

  // Common Hepburn long-vowel spelling used by the site's Gojo/Gojou tag and
  // a few similar surnames. Smart-tag search still decides the final match.
  for (const value of out.slice()) {
    push(value.replace(/\bgojo\b/ig, 'gojou'));
  }

  // Parenthetical series qualifiers are common when a short character name is
  // ambiguous (for example "makima (chainsaw man)").
  const series = stripUrls(card && card.series || '').trim();
  if (series) {
    for (const value of out.slice(0, 4)) push(`${value} (${series})`);
  }
  return out.slice(0, 10);
}

function animePicturesTagScore(tag, query, card) {
  if (!tag || Number(tag.type) !== 1) return -Infinity; // category 1 = character
  const name = simpleTagText(tag.tag);
  const fullName = String(tag.tag || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const q = simpleTagText(query);
  if (!name || !q) return -Infinity;
  let score = 0;
  if (name === q) score += 1000;
  else if (name.startsWith(`${q} `) || name.endsWith(` ${q}`)) score += 800;
  else if (name.includes(q) || q.includes(name)) score += 500;

  const qWords = new Set(q.split(' '));
  const nWords = name.split(' ');
  score += nWords.filter((x) => qWords.has(x)).length * 90;
  const series = simpleTagText(card && card.series || '');
  if (series && fullName.includes(series)) score += 160;
  score += Math.min(120, Math.log10(Math.max(1, Number(tag.num_pub || tag.num || 0))) * 25);
  return score;
}

async function resolveAnimePicturesCharacterTag(card) {
  const variants = animePicturesNameVariants(card);
  let best = null;
  let bestScore = -Infinity;
  // Smart tag search is cheap, but cap attempts so a weird AniList alias list
  // cannot turn one /hunt into dozens of upstream requests.
  for (const query of variants.slice(0, 6)) {
    const u = new URL(`${ANIME_PICTURES_API_URL}/tags`);
    u.searchParams.set('tag:smart', query.toLowerCase());
    u.searchParams.set('lang', 'en');
    u.searchParams.set('limit', '20');
    const json = await animePicturesJson(u, `Anime-Pictures tag ${query}`, 1);
    const tags = json && Array.isArray(json.tags) ? json.tags : [];
    for (const tag of tags) {
      const score = animePicturesTagScore(tag, query, card);
      if (score > bestScore) { best = tag; bestScore = score; }
    }
    if (bestScore >= 1000) break;
  }
  if (!best) return null;

  // Alias records point at the canonical tag ID. Resolve it once so post-detail
  // checks can compare identity by ID instead of fragile text alone.
  if (Number(best.alias) > 0) {
    const json = await animePicturesJson(`${ANIME_PICTURES_API_URL}/tags/${Number(best.alias)}`, `Anime-Pictures canonical tag ${best.alias}`, 1);
    if (json && json.tag && Number(json.tag.type) === 1) best = json.tag;
  }
  console.log(`[cards] ${card.name}: Anime-Pictures character tag=${best.tag} id=${best.id} posts=${best.num_pub || best.num || '?'}`);
  return best;
}

async function searchAnimePicturesPosts(tag) {
  if (!tag || !tag.tag) return [];
  const u = new URL(`${ANIME_PICTURES_API_URL}/posts`);
  u.searchParams.set('page', '0');
  u.searchParams.set('search_tag', `${tag.tag}&&single`);
  u.searchParams.set('posts_per_page', '80');
  u.searchParams.set('order_by', 'rating');
  u.searchParams.set('lang', 'en');
  const json = await animePicturesJson(u, `Anime-Pictures posts ${tag.tag}`, 1);
  const rows = json && Array.isArray(json.posts) ? json.posts : [];
  return rows.filter((post) => post && Number(post.erotics || 0) === 0 && Number(post.status == null ? 1 : post.status) === 1);
}

async function fetchAnimePicturesPostDetails(id) {
  const n = Number(id) || 0;
  if (!n) return null;
  return animePicturesJson(`${ANIME_PICTURES_API_URL}/posts/${n}?lang=en&type=json`, `Anime-Pictures post ${n}`, 1);
}

const AP_REJECT_TAGS = new Set([
  '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple girls',
  '2boys', '3boys', '4boys', '5boys', '6+boys', 'multiple boys', 'group',
  'character sheet', 'reference sheet', 'model sheet', 'multiple views', 'collage',
]);
// Composition is deliberately weighted more heavily than popularity for Cards.
// A highly-rated giant-eye crop is still worse T5/T6 material than a clean
// solo upper/full-body illustration. The final `quality` score below is what
// maps the six strongest artworks low→high across T1→T6.
const AP_PREFERRED_TAGS = new Map([
  ['upper body', 2300], ['full body', 2200], ['cowboy shot', 1900], ['portrait', 1500],
  ['solo', 650], ['tall image', 420], ['simple background', 260],
  ['looking at viewer', 180], ['highres', 220],
]);
const AP_COMPOSITION_PENALTIES = new Map([
  ['extreme close-up', 4200], ['extreme close up', 4200],
  ['close-up', 3000], ['close up', 3000], ['eyes', 3300], ['eye', 3300],
  ['face', 1100], ['cropped', 1200], ['headshot', 700],
  ['manga', 700], ['monochrome', 300],
]);

function animePicturesCandidateFromDetails(searchPost, details, targetTag) {
  if (!searchPost || !details || !targetTag) return null;
  const post = details.post || searchPost;
  if (Number(post.erotics || 0) !== 0) return null;
  if (post.status != null && Number(post.status) !== 1) return null;

  const rawTags = Array.isArray(details.tags) ? details.tags : [];
  const tags = rawTags.map((entry) => entry && entry.tag ? entry.tag : entry).filter(Boolean);
  const names = new Set(tags.map((t) => String(t.tag || '').toLowerCase()).filter(Boolean));
  const characterTags = tags.filter((t) => Number(t.type) === 1);
  const targetId = Number(targetTag.id) || 0;
  const canonicalName = String(targetTag.tag || '').toLowerCase();
  const targetPresent = characterTags.some((t) => (targetId && Number(t.id) === targetId) || String(t.tag || '').toLowerCase() === canonicalName);
  if (!targetPresent) return null;
  // The whole point of this source swap is identity reliability. Reject posts
  // with another tagged character even if the site also happens to carry the
  // "single" reference tag.
  if (characterTags.some((t) => !((targetId && Number(t.id) === targetId) || String(t.tag || '').toLowerCase() === canonicalName))) return null;
  if (!names.has('single')) return null;
  for (const tag of AP_REJECT_TAGS) if (names.has(tag)) return null;

  const imageUrl = animePicturesPreviewUrl(post) || animePicturesPreviewUrl(searchPost);
  if (!imageUrl) return null;
  const rating = Number(post.score_number || searchPost.score_number || 0);
  const width = Number(post.width || searchPost.width || 0);
  const height = Number(post.height || searchPost.height || 0);
  let composition = 0;
  let technical = Math.max(0, rating) * 320;

  for (const [tag, bonus] of AP_PREFERRED_TAGS) if (names.has(tag)) composition += bonus;
  for (const [tag, penalty] of AP_COMPOSITION_PENALTIES) if (names.has(tag)) composition -= penalty;

  if (width && height) {
    const megapixels = (width * height) / 1_000_000;
    technical += Math.min(1400, megapixels * 240);
    const wh = width / height;
    const hw = height / width;
    // Portrait/full-body and balanced square art are strongest for the Gen 2
    // contain renderer. Wide banners and needle-thin strips are poor cards.
    if (wh >= 0.52 && wh <= 1.25) composition += 900;
    else if (wh > 1.25 && wh <= 1.65) composition += 300;
    if (hw >= 1.15 && hw <= 2.05) composition += 700;
    if (wh > 2.0 || wh < 0.34) composition -= 1500;
  }

  // Composition dominates. Rating/resolution break ties and reward genuinely
  // premium artwork without allowing popularity to promote a bad crop to T6.
  const quality = composition * 2 + technical;

  return {
    provider: 'AnimePictures',
    post_id: Number(post.id || searchPost.id) || 0,
    file_url: imageUrl,
    sample_url: imageUrl,
    score: Number(post.score_number || searchPost.score_number || 0),
    width,
    height,
    quality,
    composition_score: composition,
    technical_score: technical,
    tags: [...names],
    query_tag: targetTag.tag,
    exact_tag: true,
  };
}

async function buildAnimePicturesArtworkPool(card) {
  const key = String(card && (card.character_id || card.name) || '').toLowerCase();
  const cached = animePicturesPoolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const tag = await resolveAnimePicturesCharacterTag(card);
  if (!tag) {
    animePicturesPoolCache.set(key, { value: [], expiresAt: Date.now() + ANIME_PICTURES_EMPTY_CACHE_MS });
    console.warn(`[cards] ${card.name}: Anime-Pictures character tag not found.`);
    return [];
  }
  const posts = await searchAnimePicturesPosts(tag);
  if (!posts.length) {
    animePicturesPoolCache.set(key, { value: [], expiresAt: Date.now() + ANIME_PICTURES_EMPTY_CACHE_MS });
    console.warn(`[cards] ${card.name}: Anime-Pictures returned no safe single posts for ${tag.tag}.`);
    return [];
  }

  // Inspect a bounded set of high-rated identity matches, then let the explicit
  // composition score decide which artworks deserve the premium T4-T6 slots.
  // A few extras are kept so a dead preview URL can be skipped.
  const ordered = posts.slice().sort((a, b) => {
    const score = Number(b.score_number || 0) - Number(a.score_number || 0);
    return score || (Number(b.id || 0) - Number(a.id || 0));
  });
  const approved = [];
  for (const post of ordered.slice(0, 18)) {
    const details = await fetchAnimePicturesPostDetails(post.id);
    const candidate = animePicturesCandidateFromDetails(post, details, tag);
    if (!candidate) continue;
    approved.push(candidate);
    if (approved.length >= 18) break;
  }
  approved.sort((a, b) => (Number(b.quality) - Number(a.quality)) || (Number(b.post_id) - Number(a.post_id)));
  const value = approved.slice(0, 12);
  animePicturesPoolCache.set(key, { value, expiresAt: Date.now() + (value.length ? ANIME_PICTURES_CACHE_MS : ANIME_PICTURES_EMPTY_CACHE_MS) });
  console.log(`[cards] ${card.name}: Anime-Pictures approved=${value.length}/${posts.length} tag=${tag.tag}`);
  return value;
}

function animePicturesArtworkForTier(card, pool) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const tier = Math.max(1, Math.min(6, Number(cardTierMeta(card).tier) || 1));
  // Reserve the six strongest approved artworks and map them low→high quality:
  // T1 gets slot 1, ... T6 gets the strongest slot. With fewer than six images,
  // proportional mapping keeps every available image useful.
  const six = pool.slice(0, 6).sort((a, b) => (Number(a.quality) - Number(b.quality)) || (Number(a.post_id) - Number(b.post_id)));
  const index = six.length === 1 ? 0 : Math.round(((tier - 1) / 5) * (six.length - 1));
  return { ...six[index], tier_slot: tier, pool_size: six.length };
}

async function selectAnimePicturesArtwork(identity, opts = {}) {
  if (!identity) return null;
  const merged = { ...identity };
  const pool = await buildAnimePicturesArtworkPool(merged);
  const candidate = animePicturesArtworkForTier(merged, pool);
  if (!candidate) return null;
  const displayUrl = await displayUrlForCandidate(candidate);
  if (!displayUrl) {
    // Try another approved image without changing the character identity.
    for (const backup of pool) {
      const url = await displayUrlForCandidate(backup);
      if (!url) continue;
      return {
        ...merged,
        image_url: url,
        image_source: `AnimePictures:T${cardTierMeta(merged).tier}`,
        image_tag: backup.query_tag,
        image_score: backup.score,
        anime_pictures_post_id: backup.post_id,
        artwork_pool_size: Math.min(6, pool.length),
      };
    }
    return null;
  }
  console.log(`[${opts.context || 'cards'}] ${merged.name}: Anime-Pictures post=${candidate.post_id} tier=T${candidate.tier_slot} pool=${candidate.pool_size} composition=${Math.round(candidate.composition_score || 0)} quality=${Math.round(candidate.quality || 0)}`);
  return {
    ...merged,
    image_url: displayUrl,
    image_source: `AnimePictures:T${candidate.tier_slot}`,
    image_tag: candidate.query_tag,
    image_score: candidate.score,
    anime_pictures_post_id: candidate.post_id,
    artwork_pool_size: candidate.pool_size,
  };
}


// ===================== DANBOORU SPECIAL-HUNT ARTWORK =====================
// /shunt stays completely separate from normal /hunt. Normal Cards keep the
// Anime-Pictures + Gen 2 pipeline; Special Hunt uses Danbooru's public JSON
// read API, exact character tags, general-rating posts, solo-only filtering,
// and the Old Gen renderer. No token/API key is required for this path.
const specialDanbooruPoolCache = new Map();
const SPECIAL_DANBOORU_CACHE_MS = 6 * 60 * 60 * 1000;
const SPECIAL_DANBOORU_EMPTY_CACHE_MS = 10 * 60 * 1000;

// Canonical Danbooru character tags for the curated Special Hunt catalogue.
// Dynamic tag discovery remains as a fallback, but these mappings avoid the
// name-order/romanisation failures that hurt the old Zerochan implementation.
const SPECIAL_DANBOORU_TAGS = Object.freeze({
  'Satoru Gojo': 'gojou_satoru',
  'Makima': 'makima_(chainsaw_man)',
  'Power': 'power_(chainsaw_man)',
  'Denji': 'denji_(chainsaw_man)',
  'Aki Hayakawa': 'hayakawa_aki',
  'Rimuru Tempest': 'rimuru_tempest',
  'Sung Jin-Woo': 'sung_jin-woo',
  'Tanjiro Kamado': 'kamado_tanjirou',
  'Nezuko Kamado': 'kamado_nezuko',
  'Kyojuro Rengoku': 'rengoku_kyoujurou',
  'Giyu Tomioka': 'tomioka_giyuu',
  'Mitsuri Kanroji': 'kanroji_mitsuri',
  'Shinobu Kocho': 'kochou_shinobu',
  'Muichiro Tokito': 'tokitou_muichirou',
  'Tengen Uzui': 'uzui_tengen',
  'Naruto Uzumaki': 'uzumaki_naruto',
  'Sasuke Uchiha': 'uchiha_sasuke',
  'Kakashi Hatake': 'hatake_kakashi',
  'Itachi Uchiha': 'uchiha_itachi',
  'Hinata Hyuga': 'hyuuga_hinata',
  'Monkey D. Luffy': 'monkey_d._luffy',
  'Roronoa Zoro': 'roronoa_zoro',
  'Nami': 'nami_(one_piece)',
  'Nico Robin': 'nico_robin',
  'Boa Hancock': 'boa_hancock',
  'Levi Ackerman': 'levi_(shingeki_no_kyojin)',
  'Mikasa Ackerman': 'mikasa_ackerman',
  'Eren Yeager': 'eren_yeager',
  'Historia Reiss': 'historia_reiss',
  'Ichigo Kurosaki': 'kurosaki_ichigo',
  'Rukia Kuchiki': 'kuchiki_rukia',
  'Sosuke Aizen': 'aizen_sousuke',
  'Kirito': 'kirito_(sao)',
  'Asuna Yuuki': 'yuuki_asuna',
  'Sinon': 'sinon_(sao)',
  'Rem': 'rem_(re:zero)',
  'Ram': 'ram_(re:zero)',
  'Emilia': 'emilia_(re:zero)',
  'Zero Two': 'zero_two_(darling_in_the_franxx)',
  'Marin Kitagawa': 'kitagawa_marin',
  'Ai Hoshino': 'hoshino_ai',
  'Aqua Hoshino': 'hoshino_aqua',
  'Megumin': 'megumin',
  'Frieren': 'frieren',
  'Fern': 'fern_(sousou_no_frieren)',
  'Violet Evergarden': 'violet_evergarden',
  'Yor Forger': 'yor_forger',
  'Loid Forger': 'loid_forger',
  'Anya Forger': 'anya_forger',
  'Momo Ayase': 'ayase_momo',
  'Ken Takakura': 'takakura_ken',
  'Ryomen Sukuna': 'ryomen_sukuna',
  'Yuji Itadori': 'itadori_yuuji',
  'Megumi Fushiguro': 'fushiguro_megumi',
  'Nobara Kugisaki': 'kugisaki_nobara',
  'Toji Fushiguro': 'fushiguro_toji',
  'Yuta Okkotsu': 'okkotsu_yuuta',
  'Shoto Todoroki': 'todoroki_shouto',
  'Katsuki Bakugo': 'bakugou_katsuki',
  'Izuku Midoriya': 'midoriya_izuku',
  'Kurisu Makise': 'makise_kurisu',
  'Holo': 'holo_(spice_and_wolf)',
  'Mai Sakurajima': 'sakurajima_mai',
  'Miku Nakano': 'nakano_miku',
});

function specialDanbooruUserAgent() {
  return config.hunt.userAgent || 'RimuruTempestCasino/1.0';
}

function specialDanbooruPostsUrl(tag, page = 1) {
  const u = new URL('/posts.json', DANBOORU_PUBLIC_URL);
  u.searchParams.set('limit', '100');
  u.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  // Keep the anonymous/basic query to two terms. We filter `solo` and every
  // other composition rule locally after receiving the JSON.
  u.searchParams.set('tags', `${tag} rating:g`);
  return u.toString();
}

function specialDanbooruTagsUrl(pattern) {
  const u = new URL('/tags.json', DANBOORU_PUBLIC_URL);
  u.searchParams.set('limit', '25');
  u.searchParams.set('search[fuzzy_name_matches]', pattern);
  u.searchParams.set('search[category]', '4'); // character tags only
  u.searchParams.set('search[order]', 'similarity');
  return u.toString();
}

function specialDanbooruNamePatterns(card) {
  const out = [];
  const push = (value) => {
    const tag = normalizeGelbooruTag(value || '');
    if (tag && !out.includes(tag)) out.push(tag);
  };
  push(card && card.name);
  const aliases = Array.isArray(card && card.aliases) ? card.aliases : [];
  for (const alias of aliases.slice(0, 4)) push(alias);
  for (const token of distinctiveNameTokens(card).slice(0, 3)) push(token);
  return out.slice(0, 8);
}

async function discoverSpecialDanbooruTags(card) {
  const out = [];
  const seen = new Set();
  const push = (name, count = 0, score = 0) => {
    name = String(name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, count: Number(count) || 0, score: Number(score) || 0 });
  };

  const mapped = SPECIAL_DANBOORU_TAGS[String(card && card.name || '').trim()];
  // The curated /shunt catalogue already has canonical tags. Avoid wasting
  // requests on fuzzy tag search when we know the exact identity up front.
  if (mapped) return [mapped];

  const direct = gelbooruTagVariants(card);
  for (const tag of direct.slice(0, 5)) push(tag, 0, 20);

  const tokens = distinctiveNameTokens(card);
  for (const pattern of specialDanbooruNamePatterns(card).slice(0, 4)) {
    const json = await fetchJson(
      specialDanbooruTagsUrl(pattern),
      Math.min(9000, config.hunt.fetchTimeoutMs || 10000),
      1,
      { label: `Danbooru special tag ${pattern}`, headers: { 'User-Agent': specialDanbooruUserAgent() } },
    );
    for (const raw of Array.isArray(json) ? json : []) {
      if (Number(raw.category) !== 4 || raw.is_deprecated) continue;
      const name = String(raw.name || '').trim();
      const normalized = normalizeGelbooruTag(name);
      const hits = tokens.filter((t) => normalized.includes(t)).length;
      if (!hits && !mapped) continue;
      push(name, raw.post_count, hits * 100 + Math.min(99, Number(raw.post_count || 0) / 1000));
    }
  }
  out.sort((a, b) => (b.score - a.score) || (b.count - a.count));
  return out.map((x) => x.name).slice(0, 10);
}

function specialDanbooruQuality(raw, generalTags) {
  const width = Number(raw && raw.image_width) || 0;
  const height = Number(raw && raw.image_height) || 0;
  const megapixels = Math.min(18, (width * height) / 1_000_000);
  let score = megapixels * 1300;
  score += Math.max(0, Number(raw && raw.score) || 0) * 24;
  score += Math.max(0, Number(raw && raw.fav_count) || 0) * 14;
  const tags = new Set(generalTags || []);
  const bonuses = new Map([
    ['full_body', 7000], ['cowboy_shot', 6200], ['upper_body', 5200],
    ['portrait', 3900], ['standing', 2600], ['dynamic_pose', 2600],
    ['looking_at_viewer', 1000], ['official_art', 3400], ['key_visual', 3000],
    ['highres', 2200], ['absurdres', 2600], ['solo', 4000],
  ]);
  const penalties = new Map([
    ['close-up', 6500], ['close_up', 6500], ['extreme_close-up', 9000],
    ['face', 2600], ['cropped', 4800], ['head_out_of_frame', 6500],
    ['out_of_frame', 5200], ['multiple_views', 12000], ['character_sheet', 14000],
    ['reference_sheet', 14000], ['comic', 10000], ['4koma', 10000],
    ['manga', 6500], ['monochrome', 3600], ['screenshot', 9000],
  ]);
  for (const [tag, n] of bonuses) if (tags.has(tag)) score += n;
  for (const [tag, n] of penalties) if (tags.has(tag)) score -= n;
  // Old Gen is full-bleed: reward portrait ratios near the 700x900 canvas.
  if (width > 0 && height > width) {
    const ratio = width / height;
    score += Math.max(0, 4000 - Math.abs(ratio - (700 / 900)) * 9000);
  }
  return score;
}

function specialDanbooruCandidate(raw, exactTag) {
  if (!raw || typeof raw !== 'object') return null;
  if (String(raw.rating || '').toLowerCase() !== 'g') return null;
  const width = Number(raw.image_width) || 0;
  const height = Number(raw.image_height) || 0;
  if (!width || !height || height <= width || width < 650 || height < 850) return null;

  const characterTags = String(raw.tag_string_character || '').split(/\s+/).filter(Boolean);
  const generalTags = String(raw.tag_string_general || '').split(/\s+/).filter(Boolean);
  // This is the identity guarantee for Special Hunt: the exact Danbooru
  // character tag must be present, and it must be the only character depicted.
  if (!characterTags.includes(exactTag) || characterTags.length !== 1) return null;
  if (!generalTags.includes('solo')) return null;

  const generalSet = new Set(generalTags);
  for (const bad of ['multiple_views', 'character_sheet', 'reference_sheet', 'comic', '4koma']) {
    if (generalSet.has(bad)) return null;
  }

  const ext = String(raw.file_ext || '').toLowerCase();
  if (ext && !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return null;
  const imageUrl = String(raw.large_file_url || raw.file_url || '').trim();
  if (!/^https:\/\//i.test(imageUrl)) return null;

  return {
    provider: 'Danbooru',
    post_id: Number(raw.id) || 0,
    file_url: imageUrl,
    sample_url: String(raw.large_file_url || raw.file_url || '').trim(),
    width,
    height,
    score: Number(raw.score) || 0,
    fav_count: Number(raw.fav_count) || 0,
    quality: specialDanbooruQuality(raw, generalTags),
    tags: generalTags,
    character_tags: characterTags,
    query_tag: exactTag,
    source_url: String(raw.source || '').trim(),
  };
}

async function searchSpecialDanbooruTag(tag) {
  const seen = new Set();
  const out = [];
  for (const page of [1, 2]) {
    const json = await fetchJson(
      specialDanbooruPostsUrl(tag, page),
      Math.min(10000, config.hunt.fetchTimeoutMs || 10000),
      1,
      { label: `Danbooru special posts ${tag} p${page}`, headers: { 'User-Agent': specialDanbooruUserAgent() } },
    );
    for (const raw of Array.isArray(json) ? json : []) {
      const candidate = specialDanbooruCandidate(raw, tag);
      if (!candidate) continue;
      const key = candidate.file_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    if (out.length >= 12) break;
  }
  out.sort((a, b) => (Number(b.quality) - Number(a.quality)) || (Number(b.score) - Number(a.score)) || (Number(b.post_id) - Number(a.post_id)));
  return out;
}

async function buildSpecialDanbooruArtworkPool(card) {
  const key = String(card && (card.character_id || card.name) || '').toLowerCase();
  const cached = specialDanbooruPoolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const tags = await discoverSpecialDanbooruTags(card);
  let approved = [];
  let matchedTag = '';
  for (const tag of tags.slice(0, 6)) {
    const rows = await searchSpecialDanbooruTag(tag);
    if (rows.length > approved.length) {
      approved = rows;
      matchedTag = tag;
    }
    if (approved.length >= SPECIAL_MIN_ARTWORKS) break;
  }
  approved.sort((a, b) => (Number(b.quality) - Number(a.quality)) || (Number(b.score) - Number(a.score)) || (Number(b.post_id) - Number(a.post_id)));
  const value = approved.slice(0, 24);
  specialDanbooruPoolCache.set(key, {
    value,
    matchedTag,
    expiresAt: Date.now() + (value.length ? SPECIAL_DANBOORU_CACHE_MS : SPECIAL_DANBOORU_EMPTY_CACHE_MS),
  });
  console.log(`[special-cards] ${card && card.name}: Danbooru approved=${value.length} tag=${matchedTag || 'none'}`);
  return value;
}

function specialDanbooruArtworkForTier(card, pool) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const tier = Math.max(1, Math.min(6, Number(cardTierMeta(card).tier) || 1));
  // Select the best six, then weakest->strongest maps T1->T6.
  const six = pool.slice(0, 6).sort((a, b) => (Number(a.quality) - Number(b.quality)) || (Number(a.post_id) - Number(b.post_id)));
  const index = six.length === 1 ? 0 : Math.round(((tier - 1) / 5) * (six.length - 1));
  return { ...six[index], tier_slot: tier, pool_size: six.length };
}

async function selectDanbooruSpecialArtwork(identity, opts = {}) {
  if (!identity) return null;
  const merged = { ...identity };
  const pool = await buildSpecialDanbooruArtworkPool(merged);
  const minPool = Math.max(1, Number(opts.minPool) || 1);
  if (pool.length < minPool) {
    console.warn(`[${opts.context || 'special-cards'}] ${merged.name}: Danbooru premium pool rejected (${pool.length}/${minPool} required).`);
    return null;
  }
  const candidate = specialDanbooruArtworkForTier(merged, pool);
  if (!candidate) return null;
  const imageUrl = candidate.file_url || candidate.sample_url;
  if (!imageUrl) return null;
  console.log(`[${opts.context || 'special-cards'}] ${merged.name}: Danbooru post=${candidate.post_id} tier=T${candidate.tier_slot} pool=${candidate.pool_size} quality=${Math.round(candidate.quality || 0)}`);
  return {
    ...merged,
    image_url: `${imageUrl}#jtf-oldgen-t${candidate.tier_slot}`,
    image_source: `Danbooru:T${candidate.tier_slot}`,
    danbooru_post_id: candidate.post_id,
    danbooru_tag: candidate.query_tag,
    danbooru_source_url: candidate.source_url,
    artwork_pool_size: candidate.pool_size,
    special_card_style: 'old-gen',
  };
}

async function chooseSpecialCharacter(seed) {
  if (!seed) return null;
  const identity = seed.source === 'AniList' ? seed : await searchAniListCharacter(seed.name || '');
  if (!identity || db.isHuntCharacterClaimed(identity.character_id)) return null;
  const merged = mergeMetadata(identity, [seed]);
  merged.reference_image_url = identity.reference_image_url || identity.image_url;
  try {
    return await selectDanbooruSpecialArtwork(merged, {
      context: 'special-cards',
      minPool: SPECIAL_MIN_ARTWORKS,
    });
  } catch (e) {
    console.warn(`[special-cards] ${merged.name}: Danbooru artwork lookup failed: ${e.message}`);
    return null;
  }
}

async function fetchSpecialSpawnCharacter() {
  // Start from the curated premium catalogue, then require six safe, exact,
  // solo Danbooru artworks before the character is allowed to spawn.
  const names = SPECIAL_CHARACTER_CATALOG.slice().sort(() => Math.random() - 0.5);
  for (const name of names.slice(0, 12)) {
    const card = await chooseSpecialCharacter({ name, source: 'SpecialCatalog' });
    if (card) {
      console.log(`[special-cards] premium Danbooru catalog hit: ${card.name} pool=${Number(card.artwork_pool_size) || 0}`);
      return card;
    }
  }

  const cached = db.getHuntPool(120)
    .filter((c) => String(c.character_id || '').startsWith('anilist-') && !db.isHuntCharacterClaimed(c.character_id))
    .sort(() => Math.random() - 0.5)
    .slice(0, 8);
  for (const row of cached) {
    const card = await chooseSpecialCharacter({ ...row, source: 'AniList', reference_image_url: row.image_url });
    if (card) return card;
  }

  console.warn('[special-cards] no six-image Danbooru character available after catalog + cache attempts.');
  return null;
}

async function selectLegacyWaifuArtwork(identity, opts = {}) {
  if (!identity) return null;
  const merged = { ...identity };
  merged.reference_image_url = identity.reference_image_url || identity.image_url;
  const candidates = await searchArtworkSources(merged);
  if (!candidates.length) {
    console.warn(`[${opts.context || 'waifu'}] ${merged.name}: no booru artwork candidates; AniList display fallback disabled.`);
    return null;
  }

  const hasVision = !!String(process.env.GROQ_API_KEY || '').trim();
  if (hasVision) {
    for (const candidate of candidates.slice(0, 6)) {
      const verdict = await verifyArtworkWithVision(merged, candidate);
      console.log(`[${opts.context || 'waifu'}] ${merged.name}: ${candidate.provider} vision tag=${candidate.query_tag} match=${!!verdict.match} safe=${verdict.safe !== false} confidence=${Number(verdict.confidence || 0).toFixed(2)}`);
      if (!verdict.ok) continue;
      const displayUrl = await displayUrlForCandidate(candidate);
      if (!displayUrl) continue;
      return {
        ...merged,
        image_url: displayUrl,
        image_source: `${candidate.provider}+GroqVision`,
        image_tag: candidate.query_tag,
        image_score: candidate.score,
        vision_confidence: verdict.confidence,
      };
    }
  } else {
    console.warn(`[${opts.context || 'waifu'}] ${merged.name}: GROQ_API_KEY missing; only exact-tag safe artwork can be used.`);
  }

  // Preserve the already-approved Waifu path exactly: if vision does not
  // approve a candidate, Waifu may still use its existing exact-tag fallback.
  for (const candidate of candidates.filter((x) => x.exact_tag).slice(0, 6)) {
    const displayUrl = await displayUrlForCandidate(candidate);
    if (!displayUrl) continue;
    console.warn(`[${opts.context || 'waifu'}] ${merged.name}: using unverified exact-tag ${candidate.provider} artwork (tag=${candidate.query_tag}).`);
    return {
      ...merged,
      image_url: displayUrl,
      image_source: `${candidate.provider}ExactTag`,
      image_tag: candidate.query_tag,
      image_score: candidate.score,
    };
  }
  console.warn(`[${opts.context || 'waifu'}] ${merged.name}: artwork candidates existed but none were usable; AniList display fallback disabled.`);
  return null;
}

async function selectArtworkForIdentity(identity, opts = {}) {
  if (!identity) return null;
  const context = opts.context || 'cards';
  if (context === 'waifu' || context === 'swaifu' || opts.preserveWaifu === true) return selectLegacyWaifuArtwork(identity, opts);

  // v1.0.12 Cards: Anime-Pictures is the sole live artwork catalogue for Hunt.
  // AniList remains the identity/metadata source only; Danbooru/Safebooru/
  // Gelbooru are deliberately not consulted here. The chosen artwork is tied
  // to the card's T1-T6 tier from a six-image solo-character pool.
  try {
    const card = await selectAnimePicturesArtwork(identity, opts);
    if (card) return card;
  } catch (e) {
    console.warn(`[${context}] ${identity.name}: Anime-Pictures artwork lookup failed: ${e.message}`);
  }

  // Keep the game alive during a temporary Anime-Pictures outage. This is not
  // another fan-art provider: the trusted AniList identity portrait is only a
  // last-resort source image inside the generated JTF card and is clearly
  // identified in logs/source metadata.
  const merged = { ...identity };
  const identityUrl = identity.reference_image_url || identity.image_url;
  if (identityUrl) {
    console.warn(`[${context}] ${identity.name}: Anime-Pictures unavailable; using identity portrait fallback inside card.`);
    return { ...merged, image_url: identityUrl, image_source: 'AniListIdentityEmergencyFallback' };
  }
  return null;
}

async function chooseBestCharacter(seed) {
  if (!seed) return null;
  const identity = seed.source === 'AniList' ? seed : await searchAniListCharacter(seed.name || '');
  if (!identity || db.isHuntCharacterClaimed(identity.character_id)) return null;
  const merged = mergeMetadata(identity, [seed]);
  merged.reference_image_url = identity.reference_image_url || identity.image_url;
  return selectArtworkForIdentity(merged, { context: 'cards' });
}

async function fetchSpawnCharacter() {
  const target = rollHuntSpawnTier();

  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = await fetchRandomFromAniList(target);
    if (!seed) continue;
    const card = await chooseBestCharacter(seed);
    if (card) { db.cacheHuntCharacter(card); return card; }
  }

  // Preserve the rolled tier if live lookup has to use cache.
  const pool = db.getHuntPool(220)
    .filter((c) => String(c.character_id || '').startsWith('anilist-'))
    .filter((c) => !db.isHuntCharacterClaimed(c.character_id))
    .filter((c) => huntTierFromFavorites(c.favorites).tier === target.tier);
  for (const cached of pool.sort(() => Math.random() - 0.5).slice(0, 10)) {
    const card = await chooseBestCharacter({ ...cached, source: 'AniList', reference_image_url: cached.image_url });
    if (card) { db.cacheHuntCharacter(card); return card; }
  }

  console.warn(`[cards] rolled T${target.tier} could not be fulfilled; using emergency fallback.`);
  const fallback = pickFallbackCharacter();
  if (fallback) { db.cacheHuntCharacter(fallback); return fallback; }
  console.warn('[cards] no unclaimed character source is currently available.');
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
const renderedCardCache = new Map();
function renderedCardKey(card) {
  const tier = cardTierMeta(card);
  return `${card && (card.character_id || card.id) || 'unknown'}|${card && card.image_url || ''}|T${tier.tier}`;
}
function cacheRenderedCard(key, buffer) {
  if (!key || !Buffer.isBuffer(buffer)) return;
  renderedCardCache.set(key, buffer);
  while (renderedCardCache.size > 8) renderedCardCache.delete(renderedCardCache.keys().next().value);
}
async function renderCardBuffer(card, sourceBuffer) {
  if (!card || !Buffer.isBuffer(sourceBuffer)) return null;
  const key = renderedCardKey(card);
  if (renderedCardCache.has(key)) return renderedCardCache.get(key);
  try {
    const rendered = await cardRenderer.render(card, sourceBuffer);
    if (rendered && Buffer.isBuffer(rendered.buffer)) {
      cacheRenderedCard(key, rendered.buffer);
      return rendered.buffer;
    }
  } catch (e) {
    console.warn(`[cards] render failed for ${card.name || card.character_id}: ${e.message}`);
  }
  return null;
}
async function sendCardPhoto(chatId, card, caption, markup) {
  if (!deps || typeof deps.sendPhoto !== 'function' || !card) return null;
  if (storedSignatureTier(card)) return sendSignatureCardPhoto(chatId, withStoredPresentationTier(card), caption, markup);
  if (storedSpecialTier(card)) return sendSpecialCardPhoto(chatId, withStoredSpecialTier(card), caption, markup);
  const url = card.image_url;
  let downloaded = null;
  try {
    downloaded = await fetchImageBuffer(url);
    const rendered = await renderCardBuffer(card, downloaded.buffer);
    if (rendered) {
      return await deps.sendPhoto(
        chatId,
        rendered,
        { caption, reply_markup: markup },
        { filename: `rimuru-card-${String(card.character_id || 'character').replace(/[^A-Za-z0-9_-]/g, '_')}.png`, contentType: 'image/png' },
      );
    }
  } catch (e) { console.warn('[cards] generated photo:', e.message); }

  // Rendering is presentation only. If sharp cannot load on a platform, keep
  // the game functional by sending the validated source art instead of making
  // /hunt appear empty again.
  if (downloaded && downloaded.buffer) {
    try {
      return await deps.sendPhoto(chatId, downloaded.buffer, { caption, reply_markup: markup }, { filename: 'card-source.jpg', contentType: downloaded.contentType || 'image/jpeg' });
    } catch (e) { console.warn('[cards] source buffer photo:', e.message); }
  }
  try { return await deps.sendPhoto(chatId, url, { caption, reply_markup: markup }); } catch (e) { console.warn('[cards] source URL photo:', e.message); }
  return reply(chatId, caption, { title: '🃏 CARDS', reply_markup: markup, alwaysShowMarkup: true });
}
async function answerCb(text) { if (deps && typeof deps.answerCb === 'function') try { await deps.answerCb(text); } catch (_) {} }


const renderedSpecialCardCache = new Map();
function specialRenderedCardKey(card) {
  const tier = cardTierMeta(card);
  return `oldgen|${card && (card.character_id || card.id) || 'unknown'}|${card && card.image_url || ''}|T${tier.tier}`;
}
function cacheSpecialRenderedCard(key, buffer) {
  if (!key || !Buffer.isBuffer(buffer)) return;
  renderedSpecialCardCache.set(key, buffer);
  while (renderedSpecialCardCache.size > 6) renderedSpecialCardCache.delete(renderedSpecialCardCache.keys().next().value);
}
async function fetchSpecialImageBuffer(url) {
  url = String(url || '').replace(/#jtf-(?:oldgen|signature)-t[1-6]$/i, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(12000, config.hunt.fetchTimeoutMs || 10000));
  timer.unref && timer.unref();
  try {
    const res = await fetch(url, { headers: { Accept: 'image/*', 'User-Agent': specialDanbooruUserAgent() }, signal: ac.signal });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    const arr = await res.arrayBuffer();
    if (arr.byteLength > 24_000_000) throw new Error('premium source image too large');
    return { buffer: Buffer.from(arr), contentType: type };
  } finally { clearTimeout(timer); }
}
async function renderSpecialCardBuffer(card, sourceBuffer) {
  if (!card || !Buffer.isBuffer(sourceBuffer)) return null;
  const key = specialRenderedCardKey(card);
  if (renderedSpecialCardCache.has(key)) return renderedSpecialCardCache.get(key);
  try {
    const rendered = await specialCardRenderer.render(withStoredSpecialTier(card), sourceBuffer);
    if (rendered && Buffer.isBuffer(rendered.buffer)) {
      cacheSpecialRenderedCard(key, rendered.buffer);
      return rendered.buffer;
    }
  } catch (e) { console.warn(`[special-cards] render failed for ${card.name || card.character_id}: ${e.message}`); }
  return null;
}
async function sendSpecialCardPhoto(chatId, card, caption, markup) {
  if (!deps || typeof deps.sendPhoto !== 'function' || !card) return null;
  let downloaded = null;
  try {
    downloaded = await fetchSpecialImageBuffer(card.image_url);
    const rendered = await renderSpecialCardBuffer(card, downloaded.buffer);
    if (rendered) {
      return await deps.sendPhoto(chatId, rendered, { caption, reply_markup: markup }, {
        filename: `jtf-oldgen-${String(card.character_id || 'character').replace(/[^A-Za-z0-9_-]/g, '_')}.png`,
        contentType: 'image/png',
      });
    }
  } catch (e) { console.warn('[special-cards] generated photo:', e.message); }
  // Presentation fallback only: if Sharp fails, still show the verified safe
  // Danbooru source rather than substituting normal Hunt artwork.
  if (downloaded && downloaded.buffer) {
    try { return await deps.sendPhoto(chatId, downloaded.buffer, { caption, reply_markup: markup }, { filename: 'special-card-source.jpg', contentType: downloaded.contentType || 'image/jpeg' }); }
    catch (e) { console.warn('[special-cards] source buffer photo:', e.message); }
  }
  return { ok: false };
}

const renderedSignatureCardCache = new Map();
function signatureRenderedCardKey(card) {
  const tier = cardTierMeta(card);
  return `signature|${card && (card.character_id || card.id) || 'unknown'}|${card && card.image_url || ''}|T${tier.tier}`;
}
function cacheSignatureRenderedCard(key, buffer) {
  if (!key || !Buffer.isBuffer(buffer)) return;
  renderedSignatureCardCache.set(key, buffer);
  while (renderedSignatureCardCache.size > 6) renderedSignatureCardCache.delete(renderedSignatureCardCache.keys().next().value);
}
async function renderSignatureCardBuffer(card, sourceBuffer) {
  if (!card || !Buffer.isBuffer(sourceBuffer)) return null;
  const key = signatureRenderedCardKey(card);
  if (renderedSignatureCardCache.has(key)) return renderedSignatureCardCache.get(key);
  try {
    const rendered = await signatureCardRenderer.render(withStoredPresentationTier(card), sourceBuffer);
    if (rendered && Buffer.isBuffer(rendered.buffer)) {
      cacheSignatureRenderedCard(key, rendered.buffer);
      console.log(`[signature-cards] ${card.name || card.character_id}: mode=${rendered.composition || 'scene'} palette=${(rendered.accents || []).join('→') || 'tier'}`);
      return rendered.buffer;
    }
  } catch (e) { console.warn(`[signature-cards] render failed for ${card.name || card.character_id}: ${e.message}`); }
  return null;
}
async function sendSignatureCardPhoto(chatId, card, caption, markup) {
  if (!deps || typeof deps.sendPhoto !== 'function' || !card) return null;
  let downloaded = null;
  try {
    downloaded = await fetchSpecialImageBuffer(card.image_url);
    const rendered = await renderSignatureCardBuffer(card, downloaded.buffer);
    if (rendered) {
      return await deps.sendPhoto(chatId, rendered, { caption, reply_markup: markup }, {
        filename: `jtf-signature-${String(card.character_id || 'character').replace(/[^A-Za-z0-9_-]/g, '_')}.png`,
        contentType: 'image/png',
      });
    }
  } catch (e) { console.warn('[signature-cards] generated photo:', e.message); }
  if (downloaded && downloaded.buffer) {
    try { return await deps.sendPhoto(chatId, downloaded.buffer, { caption, reply_markup: markup }, { filename: 'signature-card-source.jpg', contentType: downloaded.contentType || 'image/jpeg' }); }
    catch (e) { console.warn('[signature-cards] source buffer photo:', e.message); }
  }
  return { ok: false };
}

function asSignatureCard(card) {
  if (!card) return null;
  const tier = storedSpecialTier(card) || storedSignatureTier(card) || Number(cardTierMeta(card).tier) || 1;
  const cleanUrl = String(card.image_url || '').replace(/#jtf-(?:oldgen|signature)-t[1-6]$/i, '');
  return {
    ...card,
    image_url: `${cleanUrl}#jtf-signature-t${tier}`,
    image_source: `${String(card.image_source || 'Danbooru').replace(/:T[1-6]$/i, '')}:JTFSignature:T${tier}`,
    forced_tier: tier,
    signature_card_style: 'jtf-signature',
  };
}
async function fetchSignatureSpawnCharacter() {
  const card = await fetchSpecialSpawnCharacter();
  return asSignatureCard(card);
}

async function sendOfficialOverrideIfAny(chatId, card, caption, markup) {
  try {
    const tier = Number(card && card.forced_tier) || Number(cardTierMeta(card).tier) || 0;
    const o = tier ? customCards.findOverride(card.name, tier) : null;
    if (!o) return false;
    const buffer = await customCards.download(o.card.storage_path);
    await deps.sendPhoto(chatId, buffer, { caption, reply_markup: markup }, { filename: `${o.card.card_id}.png`, contentType: 'image/png' });
    console.log(`[cards] official custom override used: ${card.name} T${tier} -> ${o.card.card_id}`);
    return true;
  } catch (e) { console.warn('[cards] official override failed:', e.message); return false; }
}

async function spawnSpecial(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'Cards are disabled.' };
  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) return { ok: false, message: `✦ A card is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveHunt();
  const card = await fetchSpecialSpawnCharacter();
  if (!card) return { ok: false, message: '✦ Rimuru could not prepare a premium Old Gen card right now.' };
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveHunt();
  const specialCaption = specialAnnounceCaption(card, row), specialMarkup = claimMarkup();
  if (!(await sendOfficialOverrideIfAny(opts.chatId, card, specialCaption, specialMarkup))) await sendSpecialCardPhoto(opts.chatId, card, specialCaption, specialMarkup);
  return { ok: true, character: card, expiresAt, style: 'old-gen' };
}

async function spawnSignature(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'Cards are disabled.' };
  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) return { ok: false, message: `♦️ A card is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveHunt();
  const card = await fetchSignatureSpawnCharacter();
  if (!card) return { ok: false, message: '♦️ Rimuru could not prepare a JTF Signature card right now.' };
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveHunt();
  const caption = signatureAnnounceCaption(card, row), markup = claimMarkup();
  if (!(await sendOfficialOverrideIfAny(opts.chatId, card, caption, markup))) await sendSignatureCardPhoto(opts.chatId, card, caption, markup);
  return { ok: true, character: card, expiresAt, style: 'jtf-signature' };
}

async function spawn(opts = {}) {
  if (!config.hunt.enabled) return { ok: false, message: 'Cards are disabled.' };
  expireIfNeeded();
  const existing = db.getActiveHunt();
  if (isSpawnClaimable(existing)) return { ok: false, message: `🃏 A card is already up for grabs (${secondsRemaining(existing)}s left).` };
  if (existing) db.clearActiveHunt();
  const card = await fetchSpawnCharacter();
  if (!card) return { ok: false, message: '🃏 Rimuru could not prepare a card right now. Try again shortly.' };
  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, Number(opts.chatId) || 0);
  const row = db.getActiveHunt();
  const normalCaption = announceCaption(card, row), normalMarkup = claimMarkup();
  if (!(await sendOfficialOverrideIfAny(opts.chatId, card, normalCaption, normalMarkup))) await sendCardPhoto(opts.chatId, card, normalCaption, normalMarkup);
  return { ok: true, character: card, expiresAt };
}

async function claim(userId, opts = {}) {
  const answer = typeof opts.answerCb === 'function' ? opts.answerCb : answerCb;
  const row = db.getActiveHunt();
  if (!row) return await answer('No card is up for grabs right now.'), { ok: false, reason: 'no-active-hunt' };
  if (!isSpawnClaimable(row)) return await answer('This card already expired or was claimed.'), { ok: false, reason: 'not-claimable' };
  const char = { character_id: row.character_id, name: row.name, series: row.series, image_url: row.image_url, bio: row.bio, favorites: row.favorites, rarity: row.rarity };
  if (!db.claimHuntCharacter(userId, char)) return await answer('Someone else already claimed this card!'), { ok: false, reason: 'already-claimed' };
  db.clearActiveHunt();
  const user = db.getUser(userId) || {};
  const claimer = user.username ? `@${user.username}` : user.first_name || `user ${userId}`;
  await reply(opts.chatId || row.chat_id, claimedCaption(char, claimer), { title: '🃏 CARD CLAIMED' });
  return { ok: true, character: char, userId };
}
function expireIfNeeded(now = Date.now()) {
  const row = db.getActiveHunt();
  if (!row || isSpawnClaimable(row, now)) return 0;
  db.clearActiveHunt();
  return 1;
}

function parseCharTierQuery(query) {
  const raw = String(query || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/(?:^|\s)t([1-6])$/i);
  if (!match) return { name: raw, tier: 0 };
  return { name: raw.slice(0, match.index).trim(), tier: Number(match[1]) };
}

async function searchAndShow(query, opts = {}) {
  const parsed = parseCharTierQuery(query);
  const q = parsed.name;
  if (!q) return { ok: false, message: 'Usage: /char <name> [t1-t6]' };
  const seed = await searchAniListCharacter(q);
  if (!seed) return { ok: false, message: `No character found for ${stripUrls(q)}.` };
  const merged = mergeMetadata(seed, []);
  merged.reference_image_url = seed.reference_image_url || seed.image_url;
  if (parsed.tier) merged.forced_tier = parsed.tier;

  // Owner-approved custom cards become canonical for the matching name+tier.
  const requestedTier = parsed.tier || Number(cardTierMeta(merged).tier) || 0;
  if (requestedTier) {
    const override = customCards.findOverride(merged.name, requestedTier);
    if (override) {
      try {
        const buffer = await customCards.download(override.card.storage_path);
        await deps.sendPhoto(opts.chatId, buffer, { caption: detailCaption({ ...merged, forced_tier: requestedTier }) }, { filename: `${override.card.card_id}.png`, contentType: 'image/png' });
        return { ok: true, character: merged, previewTier: requestedTier, style: 'custom-official', customCardId: override.card.card_id };
      } catch (e) { console.warn(`[char] official custom override ${override.card.card_id} failed: ${e.message}`); }
    }
  }

  // v1.0.18: /char is now the premium showcase. Try the Old Gen + Danbooru
  // pipeline first so /char makima and /char gojo t5 render like /shunt.
  // Keep a Gen 2 fallback for obscure characters that do not have six safe,
  // exact, solo Danbooru artworks; a lookup should never become unusable just
  // because the premium catalogue is narrower than AniList.
  let card = null;
  try {
    card = await selectDanbooruSpecialArtwork(merged, {
      context: parsed.tier ? `char-oldgen-t${parsed.tier}` : 'char-oldgen',
      minPool: SPECIAL_MIN_ARTWORKS,
    });
  } catch (e) {
    console.warn(`[char] ${merged.name}: Old Gen Danbooru preview failed: ${e.message}`);
  }

  let style = 'old-gen';
  if (!card) {
    style = 'gen2-fallback';
    card = await selectArtworkForIdentity(merged, {
      context: parsed.tier ? `char-gen2-fallback-t${parsed.tier}` : 'char-gen2-fallback',
    });
  }
  if (!card) return { ok: false, message: `Found ${stripUrls(seed.name)}, but no usable image could be prepared.` };

  // /char is a presentation lookup. Do not let a premium preview overwrite
  // the normal spawn/cache metadata or change how an already-claimed card is
  // stored. The Old Gen marker on this in-memory card is enough for rendering.
  await sendCardPhoto(opts.chatId, card, detailCaption(card), null);
  return { ok: true, character: card, previewTier: parsed.tier || null, style };
}

function rollAutoSpawnStyle(random = Math.random) {
  return Number(random()) < 0.70 ? 'old-gen' : 'gen2';
}

async function autoSpawnTick(env = {}) {
  expireIfNeeded();
  if (isSpawnClaimable(db.getActiveHunt())) return;
  const groups = (typeof env.getChatIds === 'function' ? env.getChatIds() : []).filter((id) => Number(id) < 0);
  if (!groups.length) return;

  // Each hourly drop independently rolls its generation: 70% Special Old Gen
  // (Danbooru), 30% normal Gen 2 (Anime-Pictures). Manual /hunt and /shunt
  // remain deterministic and are not affected by this roll.
  const rolledStyle = rollAutoSpawnStyle();
  let style = rolledStyle;
  let card = rolledStyle === 'old-gen' ? await fetchSpecialSpawnCharacter() : await fetchSpawnCharacter();

  // Keep the hourly event alive if the chosen source has a temporary outage or
  // cannot satisfy its pool rules. This is only a reliability fallback; the
  // original 70/30 roll is still logged so production behaviour is observable.
  if (!card) {
    const fallbackStyle = rolledStyle === 'old-gen' ? 'gen2' : 'old-gen';
    console.warn(`[cards-auto] rolled ${rolledStyle} but no card was available; trying ${fallbackStyle} fallback.`);
    style = fallbackStyle;
    card = fallbackStyle === 'old-gen' ? await fetchSpecialSpawnCharacter() : await fetchSpawnCharacter();
  }
  if (!card) {
    console.warn(`[cards-auto] hourly spawn failed after ${rolledStyle} roll and alternate-source fallback.`);
    return;
  }

  const expiresAt = Date.now() + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, groups[0]);
  const row = db.getActiveHunt();
  console.log(`[cards-auto] rolled=${rolledStyle} delivered=${style} character=${card.name || card.character_id}`);
  for (const gid of groups) {
    if (style === 'old-gen') await sendSpecialCardPhoto(gid, card, specialAnnounceCaption(card, row), claimMarkup());
    else await sendCardPhoto(gid, card, announceCaption(card, row), claimMarkup());
  }
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
  console.log(`[cards-signature] /hunt=Gen2; /shunt=OldGen; /card=JTF Signature; /crender=3 renderers; signature=${signatureCardRenderer.available() ? 'sharp' : 'source'}`);
  return autoSpawnKickoff;
}
function state() { return { activeSpawn: db.getActiveHunt() || null, enabled: config.hunt.enabled }; }

module.exports = {
  RARITY_TIERS, HUNT_TIER_TARGETS, SPECIAL_CHARACTER_CATALOG, SPECIAL_MIN_ARTWORKS, rarityFor, rarityMeta, cardTierMeta, huntTierFromFavorites, rollHuntSpawnTier, isSpawnClaimable, secondsRemaining, seriesNameOf,
  animeListOf, truncateBio, announceCaption, claimedCaption, detailCaption, collectionCaption,
  leaderboardCaption, claimMarkup, normalizeJikan, normalizeAniList, normalizeKitsu,
  fetchRandomFromJikan, searchJikanCharacter, searchAniListCharacter, searchKitsuCharacter,
  fetchJikanPictures, fetchRandomFromAniList, fetchAniListById, fetchSpawnCharacter, resolveCharacter,
  attach, spawn, spawnSpecial, spawnSignature, claim, expireIfNeeded, searchAndShow, startAutoSpawn, autoSpawnTick, rollAutoSpawnStyle, state, sendCardPhoto, sendSpecialCardPhoto, sendSignatureCardPhoto, renderCardBuffer, renderSpecialCardBuffer, renderSignatureCardBuffer,
  FALLBACK_POOL, fallbackCard, pickFallbackCharacter, mergeMetadata, probeImage, fancy, sanitizeApiText,
  normalizeGelbooruTag, gelbooruTagVariants, gelbooruSeriesTag, discoverGelbooruTags, searchGelbooruArtwork,
  searchSafebooruArtwork, searchDanbooruSafeArtwork, searchArtworkSources, selectArtworkForIdentity, verifyArtworkWithVision,
  candidateHasExactCharacterTag, trustedArtworkRank,
  normalizeAnimePicturesUrl, animePicturesNameVariants, animePicturesTagScore, resolveAnimePicturesCharacterTag,
  searchAnimePicturesPosts, fetchAnimePicturesPostDetails, animePicturesCandidateFromDetails, buildAnimePicturesArtworkPool,
  animePicturesArtworkForTier, selectAnimePicturesArtwork, parseCharTierQuery,
  SPECIAL_DANBOORU_TAGS, specialDanbooruNamePatterns, discoverSpecialDanbooruTags, specialDanbooruQuality, specialDanbooruCandidate, searchSpecialDanbooruTag, buildSpecialDanbooruArtworkPool, specialDanbooruArtworkForTier, selectDanbooruSpecialArtwork, chooseSpecialCharacter, fetchSpecialSpawnCharacter, fetchSignatureSpawnCharacter, asSignatureCard, specialAnnounceCaption, signatureAnnounceCaption, storedSignatureTier,
  _clear: () => db.clearActiveHunt(),
};
