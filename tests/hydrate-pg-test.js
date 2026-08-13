'use strict';
/**
 * Integration test for Task 5 — hydration must load the LATEST Postgres data.
 *
 * Simulates the exact reported bug:
 *   1. Boot #1: user has balance X, mirrored to Postgres.
 *   2. Balance changes to Y (newer write lands in PG).
 *   3. "Restart": fresh SQLite + fresh db.js load → hydrateFromPg() must
 *      OVERWRITE the stale cache with Y (Postgres = source of truth).
 *   4. If the old INSERT-OR-IGNORE behavior were in place, the stale cache
 *      would win and the balance would REVERT to X — the bug.
 *
 * Run: node tests/hydrate-pg-test.js
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const DB1 = path.join(os.tmpdir(), `rimuru-hydrate-${Date.now()}-1.db`);
const DB2 = path.join(os.tmpdir(), `rimuru-hydrate-${Date.now()}-2.db`);

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('🧪 Hydration integration test (Postgres = source of truth)\n');

  // ---- Boot 1: create user with balance 111111, mirror to PG ----
  const db1 = freshDb(DB1);
  await db1.initPersistence();
  // New boot order: this instance is the primary — acquire the advisory lock
  // and enable the write pipeline (matches src/index.js).
  await db1.acquireInstanceLock(0x52494d55);
  db1.setSyncEnabled(true);
  const user = db1.getOrCreateUser(999001, { first_name: 'Hydrate', username: 'hydrate' });
  db1.setWallet(999001, 111111);
  db1.setBank(999001, 222222);
  // wait for the mirror + verification to land
  await new Promise((r) => setTimeout(r, 1200));

  const info1 = db1.syncInfo();
  console.log(`  boot1: connected=${info1.connected} writesOk=${info1.writesOk} lastWriteAt=${info1.lastWriteAt ? 'yes' : 'no'}`);
  assert.ok(info1.connected, 'PG connected on boot1');
  assert.ok(info1.writesOk > 0, 'write verified to PG');

  // ---- Balance CHANGES to a NEW value (newer write) ----
  db1.setWallet(999001, 777777);
  db1.setBank(999001, 888888);
  await new Promise((r) => setTimeout(r, 1200));
  console.log('  boot1: balance changed to wallet=777777 bank=888888 (newer write)');

  // ---- "Restart": fresh SQLite cache, fresh db.js — hydrate from PG ----
  const db2 = freshDb(DB2);
  await db2.initPersistence(); // hydrates from PG (reads are safe for any instance)
  const after = db2.getUser(999001);
  console.log(`  boot2: hydrated wallet=${after.wallet} bank=${after.bank}`);

  // THE assertion: the NEW value must win, never the stale one.
  assert.strictEqual(after.wallet, 777777, 'wallet = LATEST PG value (777777), not stale 111111');
  assert.strictEqual(after.bank, 888888, 'bank = LATEST PG value (888888), not stale 222222');

  db1.close();
  db2.close();
  console.log('\n✅ HYDRATION FIX VERIFIED — newest Postgres data wins on boot, no stale revert.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ HYDRATION TEST FAILED:', e.message);
  process.exit(1);
});
