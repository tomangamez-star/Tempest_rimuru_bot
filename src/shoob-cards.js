'use strict';

// Shoob's public card catalogue is exposed through the same Socket.IO event
// used by https://shoob.gg/cards. This adapter only reads catalogue data and
// downloads the already-completed card image; it never edits Shoob artwork.
const SHOOB_ORIGIN = 'https://shoob.gg';
const SHOOB_IMAGE_ORIGIN = 'https://api.shoob.gg';
const QUERY_TTL_MS = 10 * 60 * 1000;
const IMAGE_TTL_MS = 30 * 60 * 1000;
const MAX_IMAGE_CACHE = 48;
const queryCache = new Map();
const imageCache = new Map();

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tierOf(card) {
  const raw = card && (card.tier ?? card.category ?? card.card_tier);
  const match = String(raw == null ? '' : raw).match(/[1-6]/);
  return match ? Number(match[0]) : 0;
}

function cardIdOf(card) {
  return String(card && (card._id || card.cardid || card.id) || '').trim();
}

function seriesOf(card) {
  const raw = card && (card.anime || card.series || card.source);
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw.name === 'string') return raw.name.trim();
  if (raw && typeof raw.title === 'string') return raw.title.trim();
  return '';
}

function imageUrl(card) {
  const id = cardIdOf(card);
  return id ? `${SHOOB_IMAGE_ORIGIN}/site/api/cardr/${encodeURIComponent(id)}?size=700` : '';
}

function exactCandidates(docs, name, requestedTier = 0) {
  const wanted = normalizeName(name);
  return (Array.isArray(docs) ? docs : [])
    .filter((card) => normalizeName(card && (card.name || card.card_name)) === wanted)
    .filter((card) => !requestedTier || tierOf(card) === Number(requestedTier))
    .filter((card) => cardIdOf(card))
    .sort((a, b) => tierOf(b) - tierOf(a)
      || Number(b.version || 0) - Number(a.version || 0)
      || cardIdOf(a).localeCompare(cardIdOf(b)));
}

function cached(map, key, now = Date.now()) {
  const hit = map.get(key);
  if (!hit || hit.expiresAt <= now) {
    if (hit) map.delete(key);
    return null;
  }
  return hit.value;
}

function loadCataloguePage(name, tier, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 18000;
  const socketFactory = options.socketFactory || (() => {
    let io;
    try { ({ io } = require('socket.io-client')); }
    catch (_) { throw new Error('socket.io-client is not installed'); }
    return io(SHOOB_ORIGIN, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: timeoutMs,
      forceNew: true,
    });
  });
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket) socket.close(); } catch (_) {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Shoob catalogue timed out')), timeoutMs + 1500);
    try { socket = socketFactory(); }
    catch (error) { finish(error); return; }
    socket.on('connect_error', (error) => finish(new Error(`Shoob catalogue connection failed: ${error.message}`)));
    socket.on('cardindexres', (payload) => {
      const data = payload && payload.data || payload || {};
      finish(null, Array.isArray(data.docs) ? data.docs : []);
    });
    socket.on('connect', () => socket.emit('cardindex', {
      page: 1,
      category: tier ? String(tier) : null,
      search: String(name || '').trim(),
      series: null,
    }));
  });
}

async function findExact(name, requestedTier = 0, options = {}) {
  const tier = Number(requestedTier) || 0;
  const key = `${normalizeName(name)}|${tier}`;
  const hit = cached(queryCache, key);
  if (hit !== null) return hit;
  const docs = await loadCataloguePage(name, tier, options);
  const match = exactCandidates(docs, name, tier)[0] || null;
  queryCache.set(key, { value: match, expiresAt: Date.now() + QUERY_TTL_MS });
  return match;
}

async function fetchImage(card, options = {}) {
  const url = imageUrl(card);
  if (!url) throw new Error('Shoob card has no public card ID');
  const hit = cached(imageCache, url);
  if (hit) return hit;
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'image/*', 'User-Agent': 'Rimuru-JTF/1.0' } });
    if (!response.ok) throw new Error(`Shoob image HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || 'image/png').split(';')[0];
    if (!contentType.startsWith('image/')) throw new Error(`Shoob returned ${contentType}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Shoob returned an empty image');
    const value = { buffer, contentType, url };
    imageCache.set(url, { value, expiresAt: Date.now() + IMAGE_TTL_MS });
    while (imageCache.size > MAX_IMAGE_CACHE) imageCache.delete(imageCache.keys().next().value);
    return value;
  } finally { clearTimeout(timer); }
}

function clearCaches() { queryCache.clear(); imageCache.clear(); }

module.exports = {
  SHOOB_ORIGIN, SHOOB_IMAGE_ORIGIN, normalizeName, tierOf, cardIdOf, seriesOf,
  imageUrl, exactCandidates, loadCataloguePage, findExact, fetchImage, clearCaches,
};
