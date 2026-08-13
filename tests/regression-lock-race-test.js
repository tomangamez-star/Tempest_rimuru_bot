'use strict';
/**
 * Regression test for the "state still regresses on redeploy" root cause.
 *
 * The permanent fixes under test:
 *   1. FAIL-CLOSED advisory lock: acquireInstanceLock() must NOT return
 *      `true` just because pgReady was still false (the old race where every
 *      instance concluded it was the primary). It must await PG readiness and
 *      return the REAL lock result. A second instance must be told STANDby.
 *   2. FAIL-CLOSED write pipeline: syncEnabled must default to OFF when
 *      Postgres is configured, so a standby can never mirror stale rows
 *      upstream before the lock is decided.
 *   3. Monotonic version guard: mirrorTable('users') must use a STRICT
 *      `updated_at < EXCLUDED.updated_at` guard, so a stale local snapshot can
 *      never overwrite a newer Postgres row even if mirroring were enabled.
 *
 * Run: node tests/regression-lock-race-test.js  (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client } = require('pg');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const LOCK_KEY = 0x52494d55; // "RIMU" — must match src/index.js
const USER = 737373;

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-lock-bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function pgRow(pool, userId) {
  const { rows } = await pool.query('SELECT wallet, updated_at FROM users WHERE user_id = $1', [userId]);
  return rows[0];
}

async function main() {
  console.log('🔐 Lock-race regression test (fail-closed advisory lock + strict version guard)\n');
  let passed = 0;
  function ok(name) { passed++; console.log(`  ✅ ${name}`); }

  // ── Primary instance ────────────────────────────────────────────────
  const db1 = freshDb(path.join(os.tmpdir(), `rimuru-lock-${Date.now()}-1.db`));

  // syncEnabled must already be OFF before the lock is decided (fail-closed).
  assert.strictEqual(db1.isSyncEnabled(), false, 'write pipeline defaults to DISABLED while PG is configured');
  ok('write pipeline is fail-closed (syncEnabled=false) before the lock is decided');

  await db1.initPersistence();
  assert.strictEqual(db1.syncInfo().ready, true, 'primary PG ready after initPersistence');
  ok('primary initPersistence completed (pgReady=true)');

  // Now acquire the lock — this is the order index.js now uses.
  const got1 = await db1.acquireInstanceLock(LOCK_KEY);
  assert.strictEqual(got1, true, 'primary acquires the advisory lock');
  ok('primary acquires the advisory lock (returns true)');

  db1.setSyncEnabled(true);
  assert.strictEqual(db1.isSyncEnabled(), true, 'primary write pipeline enabled after lock');
  ok('primary enables the write pipeline only AFTER acquiring the lock');

  // Seed the primary's state.
  db1.getOrCreateUser(USER, { first_name: 'Lock', username: 'lockrace' });
  db1.setWallet(USER, 100000);
  await new Promise((r) => setTimeout(r, 600));

  // ── Secondary instance (Render deploy overlap / stale process) ──────
  const db2 = freshDb(path.join(os.tmpdir(), `rimuru-lock-${Date.now()}-2.db`));
  assert.strictEqual(db2.isSyncEnabled(), false, 'secondary write pipeline also disabled before lock');
  await db2.initPersistence();

  const got2 = await db2.acquireInstanceLock(LOCK_KEY);
  assert.strictEqual(got2, false, 'secondary instance is correctly told it is STANDBY (lock not granted)');
  ok('secondary instance correctly reports STANDBY (acquireInstanceLock returns false)');

  db2.setSyncEnabled(false); // index.js does this for standby
  assert.strictEqual(db2.isSyncEnabled(), false, 'secondary write pipeline stays disabled');
  ok('secondary write pipeline stays disabled (standby cannot mirror)');

  // ── Strict version guard (SQLite -> PG mirror) ──────────────────────
  // A NEWER value is written directly to PG (simulating the primary's fresh
  // write). Then the SECONDARY's stale local cache (older updated_at) tries to
  // mirror — even if we force-enable sync, the strict guard must reject it.
  const pool = await pgClient();
  const newerStamp = Date.now() + 5 * 60 * 1000; // clearly in the future vs local
  await pool.query(
    'UPDATE users SET wallet = $1, updated_at = $2 WHERE user_id = $3',
    [555555, newerStamp, USER]
  );
  // The secondary's local cache is OLDER (its seed above used now()).
  const localBefore = db2.getUser(USER);
  assert.ok(Number(localBefore.updated_at) < newerStamp, 'secondary local row is older than the primary PG write');
  ok('secondary local row is stale (older updated_at) vs primary PG write');

  // Force-enable the secondary's mirror to prove the STRICT guard rejects it.
  db2.setSyncEnabled(true);
  db2.mirrorTable('users');
  await new Promise((r) => setTimeout(r, 800));

  const after = await pgRow(pool, USER);
  assert.strictEqual(Number(after.wallet), 555555, 'newer PG wallet survives a stale mirror attempt');
  assert.strictEqual(Number(after.updated_at), newerStamp, 'newer PG updated_at survives a stale mirror attempt');
  ok('strict version guard: stale local mirror cannot overwrite newer PG state');

  // ── Strict version guard (PG -> SQLite hydration) ───────────────────
  // The primary's local row is NEWER than PG; re-hydrating from the OLDER PG
  // snapshot must NOT revert the local value.
  const localNewer = newerStamp + 1000;
  const raw = db1.db;
  raw.prepare('UPDATE users SET wallet = ?, updated_at = ? WHERE user_id = ?').run(999999, localNewer, USER);
  await db1.hydrateFromPg(); // PG has older stamp — must be skipped
  const hydrated = db1.getUser(USER);
  assert.strictEqual(Number(hydrated.wallet), 999999, 'newer local balance survives hydration from an older PG snapshot');
  ok('strict version guard: older PG snapshot cannot revert a newer local balance on hydration');

  db1.close();
  db2.close();
  await pool.end();

  console.log(`\n✅ LOCK-RACE TEST PASSED (${passed} assertions).`);
  process.exit(0);
}

async function pgClient() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}

main().catch((e) => {
  console.error('\n❌ LOCK-RACE TEST FAILED:', e.message);
  process.exit(1);
});
