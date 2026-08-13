'use strict';
/**
 * Delayed-write regression test — the audit's scenario I.
 *
 * A stale instance's mirror arrives LATE (after a newer write has already
 * landed in Postgres). The permanent fix under test: the STRICT version guard
 * (`updated_at < EXCLUDED.updated_at`, DB-grounded) must reject the stale
 * delayed write so the newer value survives.
 *
 * Run: node tests/delayed-write-test.js  (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client } = require('pg');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const USER = 888999;

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-delayed-bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('⏱ Delayed-write test (stale delayed mirror cannot overwrite newer data)\n');

  const db = freshDb(path.join(os.tmpdir(), `rimuru-delayed-${Date.now()}.db`));
  await db.initPersistence();
  await db.acquireInstanceLock(0x52494d55);
  db.setSyncEnabled(true);
  db.getOrCreateUser(USER, { first_name: 'Delayed', username: 'delayed' });
  db.setWallet(USER, 100000);
  await new Promise((r) => setTimeout(r, 700));

  // A NEWER write lands directly in PG (the primary's fresh op).
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  const newerStamp = Date.now() + 60 * 1000; // clearly newer than the local stamp
  await admin.query('UPDATE users SET wallet=$1, updated_at=$2 WHERE user_id=$3', [555000, newerStamp, USER]);

  // The stale instance's LOCAL cache still holds the OLD value (100000, older
  // stamp). Its delayed mirror fires now — the strict guard must reject it.
  db.mirrorTable('users');
  await new Promise((r) => setTimeout(r, 700));

  const { rows } = await admin.query('SELECT wallet, updated_at FROM users WHERE user_id=$1', [USER]);
  assert.strictEqual(Number(rows[0].wallet), 555000, 'newer PG value survives a stale delayed mirror');
  assert.strictEqual(Number(rows[0].updated_at), newerStamp, 'newer PG version survives a stale delayed mirror');
  console.log('  ✅ stale delayed mirror rejected — newer data preserved');

  await admin.end();
  db.close();
  console.log('\n✅ DELAYED-WRITE TEST PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ DELAYED-WRITE TEST FAILED:', e.message);
  process.exit(1);
});
