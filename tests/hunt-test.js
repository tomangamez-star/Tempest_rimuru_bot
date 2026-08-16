'use strict';
/**
 * Rimuru Tempest Casino — Anime Hunt feature tests.
 * Pure logic + DB integration (rarity/spawn/claim/expiry/collection) WITHOUT
 * touching Telegram or making outbound network calls. Jikan payloads are
 * exercised via normalizeJikan on sample shapes, so no external network is
 * required (the sandbox egress proxy blocks api.jikan.moe anyway).
 */
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

console.log('⚔️ Rimuru Anime Hunt tests\n');

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

test('hunt: spawn expiry helpers', () => {
  const now = Date.now();
  assert.strictEqual(hunt.isSpawnClaimable(null, now), false, 'null spawn');
  assert.strictEqual(
    hunt.isSpawnClaimable({ claimed: 0, expires_at: now + 1000 }, now),
    true,
    'unclaimed + future expiry → claimable'
  );
  assert.strictEqual(
    hunt.isSpawnClaimable({ claimed: 0, expires_at: now - 1 }, now),
    false,
    'expired → not claimable'
  );
  assert.strictEqual(
    hunt.isSpawnClaimable({ claimed: 1, expires_at: now + 1000 }, now),
    false,
    'claimed → not claimable'
  );
  assert.strictEqual(hunt.secondsRemaining({ expires_at: now + 5000 }, now), 5);
});

test('hunt: setActiveHunt + getActiveHunt round-trip', () => {
  hunt._clear();
  const now = Date.now();
  const card = hunt.normalizeJikan({
    mal_id: 999, name: 'Nezuko', images: { jpg: { image_url: 'https://cdn/n.png' } }, favorites: 100,
  });
  const expiresAt = now + config.hunt.claimWindowMs;
  db.setActiveHunt(card, expiresAt, -1001234567);
  const spawn = db.getActiveHunt();
  assert.ok(spawn, 'hunt spawn exists');
  assert.strictEqual(spawn.character_id, '999');
  assert.strictEqual(spawn.claimed, 0);
  assert.strictEqual(spawn.chat_id, -1001234567);
  assert.strictEqual(hunt.isSpawnClaimable(spawn, now), true);
});

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

test('hunt: collection + leaderboard + index lookup', () => {
  const uid = 9102;
  const a = { character_id: 'h-a', name: 'Gojo', series: 'JJK', image_url: 'https://img/a.png', rarity: 'mythic' };
  const b = { character_id: 'h-b', name: 'Asuna', series: 'SAO', image_url: 'https://img/b.png', rarity: 'rare' };
  db.claimHuntCharacter(uid, a);
  db.claimHuntCharacter(uid, b);

  const col = db.getHuntCollection(uid);
  assert.strictEqual(col.length, 2, 'two claimed');
  const first = db.getHuntCharacterByIndex(uid, 1);
  assert.ok(first, 'index 1 exists');
  assert.strictEqual(db.getHuntCharacterByIndex(uid, 99), null, 'out of range → null');

  const lb = db.getHuntLeaderboard(10);
  assert.ok(lb.length >= 1, 'leaderboard has rows');
  assert.strictEqual(lb[0].count, 2, 'most collections first');
});

test('hunt: cache + pool excludes claimed characters', () => {
  const card = hunt.normalizeJikan({
    mal_id: 4242, name: 'Holo', images: { jpg: { image_url: 'https://cdn/h.png' } }, favorites: 300,
  });
  db.cacheHuntCharacter(card);
  const cached = db.getCachedHuntCharacter('4242');
  assert.ok(cached, 'cached');
  assert.strictEqual(cached.name, 'Holo');

  const pool = db.getHuntPool(5);
  assert.ok(Array.isArray(pool), 'pool array');
  assert.ok(!pool.some((c) => c.character_id === 'h-a'), 'claimed never re-pooled');
});

test('hunt: expireIfNeeded clears stale spawn', () => {
  hunt._clear();
  const now = Date.now();
  const card = hunt.normalizeJikan({
    mal_id: 777, name: 'Zero Two', images: { jpg: { image_url: 'https://cdn/z.png' } }, favorites: 40000,
  });
  db.setActiveHunt(card, now + 1000, -100);
  assert.strictEqual(hunt.expireIfNeeded(now + 5000), 1, 'expired hunt cleared');
  assert.strictEqual(db.getActiveHunt(), null);
});

test('hunt: announce/claimed/detail/collection captions render without leaking', () => {
  const card = hunt.normalizeJikan({
    mal_id: 888, name: 'Mikasa', images: { jpg: { image_url: 'https://cdn/m.png' } },
    favorites: 60000, about: 'Fights titans.', anime: [{ anime: { mal_id: 1, name: 'Attack on Titan' } }],
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
  assert.ok(empty.toLowerCase().includes('collection'), 'empty hint');
  const full = hunt.collectionCaption([{ name: 'Rem', series: 'Re:Zero', rarity: 'legendary' }, { name: 'Asuna', series: 'SAO', rarity: 'rare' }]);
  assert.ok(full.includes('1.'), 'numbered');
  assert.ok(full.includes('2.'), 'numbered');
});

test('hunt: claim markup has CLAIM CHARACTER button', () => {
  const mk = hunt.claimMarkup();
  assert.strictEqual(mk.inline_keyboard[0][0].text, '⚔️ CLAIM CHARACTER');
  assert.strictEqual(mk.inline_keyboard[0][0].callback_data, 'hunt:claim');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL HUNT TESTS PASSED ✅');
