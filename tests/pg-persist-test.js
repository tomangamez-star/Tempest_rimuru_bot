'use strict';
/**
 * Integration test for Task 4 — backups stored in Postgres survive redeploys,
 * and Task 1 — redeem codes persist to Postgres via the write pipeline.
 * Run: node tests/pg-persist-test.js   (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const DB1 = path.join(os.tmpdir(), `rimuru-pgp-${Date.now()}-1.db`);

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-pgp-bk-${Date.now()}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

async function main() {
  console.log('🧪 PG persistence integration test (backups + redeem codes)\n');
  const db = freshDb(DB1);
  await db.initPersistence();
  // New boot order: primary acquires the lock + enables the write pipeline.
  await db.acquireInstanceLock(0x52494d55);
  db.setSyncEnabled(true);
  const backup = require('../src/backup');
  const redeem = require('../src/redeem');
  const config = require('../src/config');

  // ---- Task 4: backup lands in the PG `backups` table ----
  db.getOrCreateUser(999100, { first_name: 'PG', username: 'pgbackup' });
  db.setWallet(999100, 1234567);
  db.setBank(999100, 7654321);
  db.addItem(999100, 'hook', 3);
  await new Promise((r) => setTimeout(r, 1000));

  const b = backup.backup();
  assert.ok(b.ok && b.pg === true, 'backup stored locally AND to PG: ' + JSON.stringify(b));
  await new Promise((r) => setTimeout(r, 1200));

  const pgB = db.newestBackupPg();
  assert.ok(pgB && pgB.data, 'newestBackupPg returns the snapshot');
  const parsed = JSON.parse(pgB.data);
  assert.ok(parsed.users.some((u) => u.user_id === 999100 && u.wallet === 1234567), 'PG backup has wallet');
  assert.ok(db.listBackupsPg().length >= 1, 'listBackupsPg non-empty');
  console.log('  ✅ /backup snapshot written to Postgres backups table');

  // ---- Task 1: redeem code + redemption persist to PG ----
  const CODE = `PGCODE${Date.now().toString().slice(-6)}`;
  const c = redeem.createCode(config.ownerId, [CODE, '500000', '3'], { username: 'king' });
  assert.ok(c.ok, 'code created: ' + (c.message || ''));
  db.getOrCreateUser(999101, { first_name: 'Redeemer', username: 'redeemer' });
  db.setBank(999101, 0);
  const r = redeem.redeemCode(999101, CODE, { username: 'redeemer' });
  assert.ok(r.ok, 'redeem ok: ' + (r.message || ''));
  assert.strictEqual(db.getUser(999101).bank, 500000, 'bank credited');
  await new Promise((t) => setTimeout(t, 1200));
  console.log('  ✅ redeem code + redemption mirrored to Postgres');

  // ---- "Redeploy": fresh SQLite hydrates redeem tables from PG ----
  const DB2 = path.join(os.tmpdir(), `rimuru-pgp-${Date.now()}-2.db`);
  const db2 = freshDb(DB2);
  await db2.initPersistence();
  const rec = db2.getRedeemCode(CODE);
  assert.ok(rec, 'redeem code survives redeploy via PG');
  assert.strictEqual(rec.used_count, 1, 'used_count survives redeploy via PG');
  const redone = db2.hasRedeemed(999101, CODE);
  assert.ok(redone, 'redemption record survives redeploy via PG');
  const pgB2 = db2.newestBackupPg();
  assert.ok(pgB2 && pgB2.data.includes('1234567'), 'backup survives redeploy via PG');
  console.log('  ✅ redeem + backup data survive "redeploy" (rehydrated from PG)');

  db.close();
  db2.close();
  // cleanup test backup files (PG copy is the durable store; files are scratch)
  const fs = require('fs');
  const path2 = require('path');
  try {
    const dir = path2.join(__dirname, '..', 'backups');
    for (const f of fs.readdirSync(dir)) {
      if (/^backup-\d+\.json$/.test(f)) fs.unlinkSync(path2.join(dir, f));
    }
  } catch (e) { /* non-fatal */ }
  console.log('\n✅ PG PERSISTENCE TEST VERIFIED — backups + redeem codes survive redeploys.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ PG PERSISTENCE TEST FAILED:', e.message);
  process.exit(1);
});
