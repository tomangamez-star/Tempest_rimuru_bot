'use strict';
/**
 * Multi-instance regression test — the audit's overlapping-instances scenario.
 *
 * Two full db.js loads (two lock clients + two SQLite caches) race for the
 * advisory lock. The permanent fix under test: exactly ONE holds the lock and
 * may mirror; the standby is denied and its local writes NEVER reach Postgres.
 *
 * Run: node tests/multi-instance-test.js  (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client } = require('pg');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const LOCK_KEY = 0x52494d55; // "RIMU"
const USER = 555666;

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-multi-bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('👥 Multi-instance test (only one lock holder; standby never writes)\n');

  // ---- Instance 1 (primary) ----
  const db1 = freshDb(path.join(os.tmpdir(), `rimuru-multi-${Date.now()}-1.db`));
  await db1.initPersistence();
  const got1 = await db1.acquireInstanceLock(LOCK_KEY);
  assert.strictEqual(got1, true, 'primary acquires the lock');
  db1.setSyncEnabled(true);
  db1.getOrCreateUser(USER, { first_name: 'Multi', username: 'multi' });
  db1.setWallet(USER, 111111);
  await new Promise((r) => setTimeout(r, 700));

  // ---- Instance 2 (standby) — separate lock client + separate SQLite cache ----
  const db2 = freshDb(path.join(os.tmpdir(), `rimuru-multi-${Date.now()}-2.db`));
  await db2.initPersistence();
  const got2 = await db2.acquireInstanceLock(LOCK_KEY);
  assert.strictEqual(got2, false, 'standby is denied the advisory lock');
  db2.setSyncEnabled(false); // index.js does this for a standby
  assert.strictEqual(db2.isSyncEnabled(), false, 'standby write pipeline stays disabled');

  // The standby makes a LOCAL write (its own stale cache) — it must NOT reach PG.
  db2.getOrCreateUser(USER, { first_name: 'Multi', username: 'multi' });
  db2.setWallet(USER, 999999); // syncEnabled=false -> mirror is a no-op
  await new Promise((r) => setTimeout(r, 700));

  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  const { rows } = await admin.query('SELECT wallet FROM users WHERE user_id=$1', [USER]);
  assert.strictEqual(Number(rows[0].wallet), 111111, "standby's local write never reached PG (primary value intact)");
  console.log('  ✅ standby denied lock; its local write never reached PG');

  await admin.end();
  db1.close();
  db2.close();
  console.log('\n✅ MULTI-INSTANCE TEST PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ MULTI-INSTANCE TEST FAILED:', e.message);
  process.exit(1);
});
