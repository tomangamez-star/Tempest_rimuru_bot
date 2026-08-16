'use strict';
/**
 * Rimuru Tempest Casino — Waifu collection feature tests.
 * Pure logic + DB integration (spawn/claim/expiry/collection) WITHOUT
 * touching Telegram or making outbound network calls. The API fetch is
 * exercised indirectly via injected fake responses (waifu._clear + db
 * helpers), so no external network is required.
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-waifu-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const db = require('../src/db');
const waifu = require('../src/waifu');

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

console.log('💝 Rimuru Waifu collection tests\n');

test('waifu: characterIdFor is stable and derived from image URL', () => {
  const a = waifu.characterIdFor('https://x/y.png');
  const b = waifu.characterIdFor('https://x/y.png');
  const c = waifu.characterIdFor('https://x/z.png');
  assert.strictEqual(a, b, 'same URL → same id');
  assert.notStrictEqual(a, c, 'different URL → different id');
  assert.ok(a.length > 0 && a.length <= 24);
});

test('waifu: normalizeCharacter handles nekos and waifu.pics payloads', () => {
  const nekos = waifu.normalizeCharacter(
    { url: 'https://img/1.png', artist_name: 'Artist', artist_href: 'https://x', source_url: 'https://pixiv/1' },
    'nekos'
  );
  assert.ok(nekos, 'nekos card');
  assert.strictEqual(nekos.name, 'Artist');
  assert.strictEqual(nekos.series, 'https://pixiv/1');

  const wp = waifu.normalizeCharacter({ url: 'https://img/2.png' }, 'waifupics');
  assert.ok(wp, 'waifu.pics card');
  assert.strictEqual(wp.name, 'Unknown Waifu');
  assert.strictEqual(wp.series, '');

  assert.strictEqual(waifu.normalizeCharacter({}, 'nekos'), null, 'no url → null');
});

test('waifu: spawn expiry helpers', () => {
  const now = Date.now();
  assert.strictEqual(waifu.isSpawnClaimable(null, now), false, 'null spawn');
  assert.strictEqual(
    waifu.isSpawnClaimable({ claimed: 0, expires_at: now + 1000 }, now),
    true,
    'unclaimed + future expiry → claimable'
  );
  assert.strictEqual(
    waifu.isSpawnClaimable({ claimed: 0, expires_at: now - 1 }, now),
    false,
    'expired → not claimable'
  );
  assert.strictEqual(
    waifu.isSpawnClaimable({ claimed: 1, expires_at: now + 1000 }, now),
    false,
    'claimed → not claimable'
  );
  assert.strictEqual(waifu.secondsRemaining({ expires_at: now + 5000 }, now), 5);
});

test('waifu: setActiveSpawn + getActiveSpawn round-trip', () => {
  waifu._clear();
  const now = Date.now();
  const char = waifu.normalizeCharacter({ url: 'https://img/3.png', artist_name: 'Tester' }, 'nekos');
  const expiresAt = now + config.waifu.claimWindowMs;
  db.setActiveSpawn(char, expiresAt);
  const spawn = db.getActiveSpawn();
  assert.ok(spawn, 'spawn exists');
  assert.strictEqual(spawn.character_id, char.character_id);
  assert.strictEqual(spawn.claimed, 0);
  assert.strictEqual(waifu.isSpawnClaimable(spawn, now), true);
});

test('waifu: claimCharacter persists once and is unique', () => {
  waifu._clear();
  const uid = 9001;
  const char = { character_id: 'c-uniq', name: 'Holo', series: 'Spice & Wolf', image_url: 'https://img/holo.png' };
  const row = db.claimCharacter(uid, char);
  assert.ok(row, 'first claim succeeds');
  assert.strictEqual(db.isCharacterClaimed('c-uniq'), true);

  // Second claim of the SAME id must fail (unique pool).
  const dup = db.claimCharacter(uid + 1, char);
  assert.strictEqual(dup, null, 'duplicate claim rejected');
});

test('waifu: collection + character lookup', () => {
  const uid = 9002;
  const a = { character_id: 'c-a', name: 'Rem', series: 'Re:Zero', image_url: 'https://img/rem.png' };
  const b = { character_id: 'c-b', name: 'Mikasa', series: 'AOT', image_url: 'https://img/mikasa.png' };
  db.claimCharacter(uid, a);
  db.claimCharacter(uid, b);

  const col = db.getUserCollection(uid);
  assert.strictEqual(col.length, 2, 'two claimed');
  const found = db.getCharacterByName(uid, 'rem');
  assert.ok(found, 'case-insensitive name lookup');
  assert.strictEqual(found.character_id, 'c-a');
  assert.strictEqual(db.getCharacterByName(uid, 'nope'), null);
});

test('waifu: expireIfNeeded clears stale spawn', () => {
  waifu._clear();
  const now = Date.now();
  const char = waifu.normalizeCharacter({ url: 'https://img/expire.png' }, 'waifupics');
  db.setActiveSpawn(char, now + 1000);
  assert.strictEqual(waifu.expireIfNeeded(now + 5000), 1, 'expired spawn cleared');
  assert.strictEqual(db.getActiveSpawn(), null);
});

test('waifu: collectionCaption + detailCaption render', () => {
  const empty = waifu.collectionCaption([]);
  assert.ok(empty.includes('waifu'), 'empty hint mentions /waifu');
  const rows = [{ name: 'Rem', series: 'Re:Zero', image_url: 'https://img/r.png', claimed_at: Date.now(), character_id: 'r', user_id: 1 }];
  const full = waifu.collectionCaption(rows);
  assert.ok(full.includes('Rem'), 'lists name');
  assert.ok(full.includes('Re:Zero'), 'lists series');
  const detail = waifu.detailCaption(rows[0]);
  assert.ok(detail.includes('Rem'), 'detail name');
  assert.ok(detail.includes('https://img/r.png'), 'detail image link');
});

test('waifu: claim markup has gameplay-critical Claim button', () => {
  const mk = waifu.claimMarkup();
  assert.strictEqual(mk.inline_keyboard[0][0].text, '💝 Claim');
  assert.strictEqual(mk.inline_keyboard[0][0].callback_data, 'waifu:claim');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL WAIFU TESTS PASSED ✅');
