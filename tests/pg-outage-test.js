'use strict';
/**
 * PG outage test — the audit's scenario G (unreachable PG -> fail-closed).
 *
 * Points DATABASE_URL at a dead port so Postgres is unreachable. The permanent
 * fix under test: while PG is configured, the write pipeline must remain
 * DISABLED (fail-closed), initPersistence must report disabled (not silently
 * pretend persistence is on), and the bot must keep serving local SQLite
 * writes WITHOUT emitting any phantom PG writes. Recovery (re-hydrate + resume
 * mirror once PG is back) is covered by hydrate-pg-test.js + boot-cycle-test.js.
 *
 * Run: node tests/pg-outage-test.js
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

// Port 59999 — nothing listens here, so connection is refused fast.
const DEAD_URL = 'postgresql://postgres:postgres@127.0.0.1:59999/postgres';

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-outage-bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.DATABASE_URL = DEAD_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('📡 PG outage test (unreachable PG -> fail-closed, no phantom writes)\n');

  const db = freshDb(path.join(os.tmpdir(), `rimuru-outage-${Date.now()}.db`));

  // FAIL-CLOSED: PG is configured, so writes default OFF until a lock is held.
  assert.strictEqual(db.isSyncEnabled(), false, 'write pipeline fail-closed while PG is configured');

  const persisted = await db.initPersistence();
  assert.strictEqual(persisted.enabled, false, 'initPersistence reports disabled on unreachable PG');
  assert.strictEqual(db.syncInfo().ready, false, 'pgReady stays false on unreachable PG');
  assert.strictEqual(db.syncInfo().connected, false, 'connectivity reported as NOT connected');

  // No lock to fight over and no dual-writer risk (nobody can write to a down
  // PG) — the instance is the sole SQLite owner, but mirroring is still a no-op.
  const got = await db.acquireInstanceLock(0x52494d55);
  assert.strictEqual(got, true, 'sole owner when PG is unreachable (no dual-writer risk)');

  // Local SQLite writes keep the bot alive during the outage.
  db.getOrCreateUser(777001, { first_name: 'Outage', username: 'outage' });
  db.setWallet(777001, 424242);
  assert.strictEqual(db.getUser(777001).wallet, 424242, 'local SQLite write works during outage');

  const info = db.syncInfo();
  assert.strictEqual(info.writesOk, 0, 'zero phantom PG writes during the outage');
  assert.strictEqual(info.writesFailed, 0, 'zero phantom PG write attempts during the outage');
  console.log('  ✅ unreachable PG -> fail-closed, local writes OK, zero phantom PG writes');

  db.close();
  console.log('\n✅ PG OUTAGE TEST PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ PG OUTAGE TEST FAILED:', e.message);
  process.exit(1);
});
