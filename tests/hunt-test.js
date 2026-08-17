'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-hunt-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const db = require('../src/db');
const hunt = require('../src/hunt');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name} — ${e.message}`);
  }
}

console.log(`⚔️ Rimuru Anime Hunt tests\n`);

// ===================== RARITY =====================

test('hunt: rarityFor is data-driven from favorites', () => {
  assert.strictEqual(hunt.rarityFor(0), 'common');
  assert.strictEqual(hunt.rarityFor(499), 'common');
  assert.strictEqual(hunt.rarityFor(500), 'rare');
  assert.strictEqual(hunt.rarityFor(4999), 'rare');
  assert.strictEqual(hunt.rarityFor(5000), 'epic');
  assert.strictEqual(hunt.rarityFor(20000), 'legendary');
  assert.strictEqual(hunt.rarityFor(50000), 'mythic');
  assert.strictEqual(hunt.rarityFor(999999), 'mythic');
});

test('hunt: rarityMeta labels + emoji', () => {
  assert.strictEqual(hunt.rarityMeta('common').emoji, '⚪');
  assert.strictEqual(hunt.rarityMeta('rare').emoji, '🔵');
  assert.strictEqual(hunt.rarityMeta('epic').emoji, '🟣');
  assert.strictEqual(hunt.rarityMeta('legendary').emoji, '🟠');
  assert.strictEqual(hunt.rarityMeta('mythic').emoji, '🔴');
  assert.strictEqual(hunt.rarityMeta('mythic').label, 'MYTHIC');
});

// ===================== NORMALIZE =====================

test('hunt: normalizeJikan builds a canonical card', () => {
  const raw = {
    mal_id: 12345,
    name: 'Gojo Satoru',
    images: { jpg: { image_url: 'https://cdn.myanimelist.net/img/gojo.jpg' } },
    favorites: 75000,
    about: 'The strongest sorcerer.',
    anime: [{ anime: { mal_id: 1, name: 'Jujutsu Kaisen' } }],
  };
  const card = hunt.normalizeJikan(raw);
  assert.ok(card, 'card built');
  assert.strictEqual(card.character_id, '12345');
  assert.strictEqual(card.name, 'Gojo Satoru');
  assert.strictEqual(card.rarity, 'mythic');
  assert.strictEqual(card.favorites, 75000);
  assert.ok(Array.isArray(card.anime));
  assert.strictEqual(hunt.normalizeJikan(null), null);
  assert.strictEqual(hunt.normalizeJikan({}), null, 'no mal_id/image → null');
});

// ===================== SPAWN EXPIRY =====================

test('hunt: spawn expiry helpers', () => {
  const now = Date.now();
  assert.strictEqual(hunt.isSpawnClaimable(null, now), false, 'null spawn');
  assert.strictEqual(hunt.isSpawnClaimable({ claimed: 0, expires_at: now + 1000 }, now), true, 'unclaimed + future expiry → claimable');
  assert.strictEqual(hunt.isSpawnClaimable({ claimed: 0, expires_at: now - 1 }, now), false, 'expired → not claimable');
  assert.strictEqual(hunt.isSpawnClaimable({ claimed: 1, expires_at: now + 1000 }, now), false, 'claimed → not claimable');
  assert.strictEqual(hunt.secondsRemaining({ expires_at: now + 5000 }, now), 5);
});

// ===================== DB ROUND-TRIP =====================

test('hunt: setActiveHunt + getActiveHunt round-trip', () => {
  hunt._clear();
  const now = Date.now();
  const card = hunt.normalizeJikan({ mal_id: 999, name: 'Nezuko', images: { jpg: { image_url: 'https://cdn/n.png' } }, favorites: 100 });
  const expiresAt = now + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, -1001234567);
  const spawn = db.getActiveHunt();
  assert.ok(spawn, 'hunt spawn exists');
  assert.strictEqual(spawn.character_id, '999');
  assert.strictEqual(spawn.claimed, 0);
  assert.strictEqual(spawn.chat_id, -1001234567);
  assert.strictEqual(hunt.isSpawnClaimable(spawn, now), true);
});

// ===================== CLAIM UNIQUENESS =====================

test('hunt: claimHuntCharacter persists once and is unique', () => {
  hunt._clear();
  const uid = 9101;
  const char = { character_id: 'h-uniq', name: 'Rem', series: 'Re:Zero', image_url: 'https://img/rem.png', rarity: 'legendary' };
  const row = db.claimHuntCharacter(uid, char);
  assert.ok(row, 'first claim succeeds');
  assert.strictEqual(db.isHuntCharacterClaimed('h-uniq'), true);
  const dup = db.claimHuntCharacter(uid + 1, char);
  assert.strictEqual(dup, null, 'duplicate claim rejected');
});

// ===================== COLLECTION + LEADERBOARD =====================

test('hunt: collection + leaderboard + index lookup', () => {
  const a = { character_id: 'h-a', name: 'Gojo', series: 'JJK', image_url: 'https://img/a.png', rarity: 'mythic' };
  const b = { character_id: 'h-b', name: 'Asuna', series: 'SAO', image_url: 'https://img/b.png', rarity: 'rare' };
  db.claimHuntCharacter(9102, a);
  db.claimHuntCharacter(9102, b);
  const col = db.getHuntCollection(9102);
  assert.strictEqual(col.length, 2, 'two claimed');
  const first = db.getHuntCharacterByIndex(9102, 1);
  assert.ok(first, 'index 1 exists');
  assert.strictEqual(db.getHuntCharacterByIndex(9102, 99), null, 'out of range → null');
  const lb = db.getHuntLeaderboard(10);
  assert.ok(lb.length >= 1, 'leaderboard has rows');
  assert.strictEqual(lb[0].count, 2, 'most collections first');
});

// ===================== CACHE + POOL =====================

test('hunt: cache + pool excludes claimed characters', () => {
  const card = hunt.normalizeJikan({ mal_id: 4242, name: 'Holo', images: { jpg: { image_url: 'https://cdn/h.png' } }, favorites: 300 });
  db.cacheHuntCharacter(card);
  const cached = db.getCachedHuntCharacter('4242');
  assert.ok(cached, 'cached');
  assert.strictEqual(cached.name, 'Holo');
  const pool = db.getHuntPool(5);
  assert.ok(Array.isArray(pool), 'pool array');
  assert.ok(!pool.some((c) => c.character_id === 'h-a'), 'claimed never re-pooled');
});

// ===================== EXPIRE =====================

test('hunt: expireIfNeeded clears stale spawn', () => {
  hunt._clear();
  const now = Date.now();
  const card = hunt.normalizeJikan({ mal_id: 777, name: 'Zero Two', images: { jpg: { image_url: 'https://cdn/z.png' } }, favorites: 40000 });
  db.setActiveHunt(card, now + 1000, -100);
  assert.strictEqual(hunt.expireIfNeeded(now + 5000), 1, 'expired hunt cleared');
  assert.strictEqual(db.getActiveHunt(), null);
});

// ===================== CAPTIONS =====================

test('hunt: announce/claimed/detail/collection captions render without leaking', () => {
  const card = hunt.normalizeJikan({
    mal_id: 888,
    name: 'Mikasa',
    images: { jpg: { image_url: 'https://cdn/m.png' } },
    favorites: 60000,
    about: 'Fights titans.',
    anime: [{ anime: { mal_id: 1, name: 'Attack on Titan' } }],
  });
  const spawn = { expires_at: Date.now() + 10000, claimed: 0 };
  const announce = hunt.announceCaption(card, spawn);
  assert.ok(announce.includes('ANIME HUNT'), 'themed title');
  assert.ok(announce.includes('Mikasa'), 'name shown');
  assert.ok(announce.includes('10s'), 'countdown shown');

  const claimed = hunt.claimedCaption(card, '@user');
  assert.ok(claimed.includes('CHARACTER CLAIMED'), 'claim title');
  assert.ok(claimed.includes('MYTHIC'), 'rarity label');
  assert.ok(claimed.includes('@user'), 'claimer');

  const detail = hunt.detailCaption(card);
  assert.ok(detail.includes('Character ID: 888'), 'id line');
  assert.ok(detail.includes('Attack on Titan'), 'appears in');
  assert.ok(detail.includes('MYTHIC'), 'rarity');
  assert.ok(!detail.includes('http'), 'no links leak into captions');

  const empty = hunt.collectionCaption([]);
  assert.ok(empty.includes('collection'), 'empty hint');

  const full = hunt.collectionCaption([
    { name: 'Rem', series: 'Re:Zero', rarity: 'legendary' },
    { name: 'Asuna', series: 'SAO', rarity: 'rare' },
  ]);
  assert.ok(full.includes('1.'), 'numbered');
  assert.ok(full.includes('2.'), 'numbered');
});

// ===================== CLAIM MARKUP =====================

test('hunt: claim markup has CLAIM CHARACTER button', () => {
  const mk = hunt.claimMarkup();
  assert.strictEqual(mk.inline_keyboard[0][0].text, '⚔️ CLAIM CHARACTER');
  assert.strictEqual(mk.inline_keyboard[0][0].callback_data, 'hunt:claim');
});

// ===================== FALLBACK POOL =====================

test('hunt: FALLBACK_POOL has 10+ entries with CDN images', () => {
  assert.ok(Array.isArray(hunt.FALLBACK_POOL), 'pool is an array');
  assert.ok(hunt.FALLBACK_POOL.length >= 10, 'at least 10 fallback characters');
  for (const entry of hunt.FALLBACK_POOL) {
    assert.ok(entry.character_id, `entry has character_id: ${entry.name}`);
    assert.ok(entry.name, `entry has name`);
    assert.ok(entry.series, `entry has series`);
    assert.ok(entry.image_url, `entry has image_url`);
    assert.ok(entry.image_url.startsWith('https://'), `image_url is https: ${entry.name}`);
    assert.ok(typeof entry.favorites === 'number' && entry.favorites > 0, `favorites is positive number: ${entry.name}`);
  }
});

test('hunt: fallbackCard builds a valid canonical card', () => {
  const entry = hunt.FALLBACK_POOL[0];
  const card = hunt.fallbackCard(entry);
  assert.strictEqual(card.character_id, entry.character_id);
  assert.strictEqual(card.name, entry.name);
  assert.strictEqual(card.series, entry.series);
  assert.strictEqual(card.image_url, entry.image_url);
  assert.strictEqual(card.favorites, entry.favorites);
  assert.ok(card.rarity, 'rarity computed');
  assert.ok(Array.isArray(card.anime), 'anime array');
  assert.strictEqual(card.anime[0].anime.name, entry.series);
});

test('hunt: pickFallbackCharacter returns unclaimed character only', () => {
  // Claim one fallback character
  const first = hunt.FALLBACK_POOL[0];
  db.claimHuntCharacter(9999, {
    character_id: first.character_id,
    name: first.name,
    series: first.series,
    image_url: first.image_url,
    rarity: 'common',
  });

  // pickFallbackCharacter should never return the claimed one
  for (let i = 0; i < 20; i++) {
    const picked = hunt.pickFallbackCharacter();
    assert.ok(picked, 'picked a character');
    assert.notStrictEqual(picked.character_id, first.character_id, 'claimed character not picked');
  }
});

test('hunt: fetchSpawnCharacter never throws and returns a card', async () => {
  // This tests the full chain: cached pool → Jikan → fallback
  // In the test environment Jikan is unreachable, so it should fall back to the pool
  const card = await hunt.fetchSpawnCharacter();
  assert.ok(card, 'fetchSpawnCharacter returned a card');
  assert.ok(card.character_id, 'card has character_id');
  assert.ok(card.name, 'card has name');
  assert.ok(card.image_url, 'card has image_url');
  assert.ok(card.rarity, 'card has rarity');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL HUNT TESTS PASSED ✅');
