'use strict';
/**
 * Lock-loss regression test — the audit's scenario F.
 *
 * Simulates the advisory lock being DROPPED out from under the primary (e.g.
 * the dedicated lock session is killed by a network blip, pooler recycle, or
 * pg_terminate_backend). The permanent fix under test: the moment the dedicated
 * lock client's connection dies, the process must FAIL CLOSED — flip
 * syncEnabled to false and stop mirroring — so a stale process can never keep
 * writing old data once it no longer holds the single-writer lock.
 *
 * Run: node tests/lock-loss-test.js  (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client } = require('pg');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const LOCK_KEY = 0x52494d55; // "RIMU" — must match src/index.js

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-lockloss-bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('🔐 Lock-loss test (lock dropped -> fail-closed write pipeline)\n');

  const db = freshDb(path.join(os.tmpdir(), `rimuru-lockloss-${Date.now()}.db`));
  await db.initPersistence();
  assert.strictEqual(db.syncInfo().ready, true, 'PG ready');

  const got = await db.acquireInstanceLock(LOCK_KEY);
  assert.strictEqual(got, true, 'primary acquires the lock');
  assert.strictEqual(db.syncInfo().lockHeld, true, 'lockHeld=true after acquire');
  db.setSyncEnabled(true);
  assert.strictEqual(db.isSyncEnabled(), true, 'write pipeline enabled after lock');

  // Find the backend pid holding our advisory lock, then kill that session.
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  const objid = LOCK_KEY & 0xffffffff; // low 32 bits of the bigint advisory key
  const { rows } = await admin.query(
    `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted=true AND objid=$1 AND pid != pg_backend_pid()`,
    [objid]
  );
  assert.ok(rows.length > 0, 'advisory lock row found in pg_locks');
  const pid = rows[0].pid;
  console.log(`  lock held by backend pid=${pid} — terminating the session`);
  await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  await admin.end();

  // Wait for the client 'error'/'end' event -> onLockLost -> syncEnabled=false.
  await new Promise((r) => setTimeout(r, 800));

  assert.strictEqual(db.syncInfo().lockHeld, false, 'lockHeld=false after the session is dropped');
  assert.strictEqual(db.isSyncEnabled(), false, 'write pipeline disabled (fail-closed) after lock loss');
  console.log('  ✅ lock dropped -> syncEnabled flipped to false (writes stopped)');

  db.close();
  console.log('\n✅ LOCK-LOSS TEST PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ LOCK-LOSS TEST FAILED:', e.message);
  process.exit(1);
});
