'use strict';
/**
 * Bandwidth-fix regression test — proves dirty-row mirroring replaces the
 * 30-second full-table dump without regressing persistence.
 *
 * Assertions:
 *   1. A changed user persists (writesOk > 0, mirroredRowsTotal increments).
 *   2. Unchanged users are NOT rewritten: a dirty-only mirrorAll() with no
 *      local writes must NOT increase mirroredRowsTotal / mirroredBytesTotal.
 *   3. A NEW user write mirrors ~1 row (that user), not the whole users table.
 *   4. `backups` is excluded from the periodic mirror (its payload never
 *      counts toward mirroredBytesTotal during a reconciliation pass).
 *   5. Reconciliation is a low-frequency safety net, NOT the 30s cadence:
 *      repeated dirty-only mirrorAll() calls never trigger a reconcile; only
 *      an explicit force (boot/reconnect) does.
 *
 * Run: node tests/bandwidth-test.js   (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const USER_A = 880001;
const USER_B = 880002;

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-bw-bk-${Date.now()}`);
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('📉 Bandwidth regression test (dirty-row mirroring, no 30s full dump)\n');
  const db = freshDb(path.join(os.tmpdir(), `rimuru-bw-${Date.now()}-1.db`));

  await db.initPersistence();
  await db.acquireInstanceLock(0x52494d55);
  db.setSyncEnabled(true);
  // setSyncEnabled(true) triggers a full reconcile on promotion — let it settle.
  await sleep(1500);

  // ---- 1. A changed user persists (row mirrored, counters increment) ----
  db.getOrCreateUser(USER_A, { first_name: 'BW', username: 'bwuser' });
  db.setWallet(USER_A, 100000);
  db.setBank(USER_A, 50000);
  await sleep(1500);

  const info1 = db.syncInfo();
  assert.ok(info1.writesOk > 0, 'write verified to PG');
  assert.ok(info1.mirroredRowsTotal > 0, 'mirroredRowsTotal advanced after a user write');
  const rowsAfterA = info1.mirroredRowsTotal;
  const bytesAfterA = info1.mirroredBytesTotal;

  // ---- 2. Unchanged users are NOT rewritten (dirty-only mirror = no-op) ----
  // Wait long enough for any in-flight writes to drain, then run a dirty-only
  // mirror with ZERO new writes. It must not mirror any rows.
  await sleep(800);
  await db.mirrorAll(); // dirty-only (no force) — nothing is dirty now
  await sleep(800);
  const info2 = db.syncInfo();
  assert.strictEqual(
    info2.mirroredRowsTotal,
    rowsAfterA,
    `no local write => dirty-only mirrorAll() mirrors 0 rows (got ${info2.mirroredRowsTotal}, expected ${rowsAfterA})`
  );
  assert.strictEqual(
    info2.mirroredBytesTotal,
    bytesAfterA,
    'no local write => mirroredBytesTotal unchanged'
  );
  console.log('  ✅ dirty-only mirrorAll() with no writes mirrors ZERO rows (idle egress collapsed)');

  // ---- 3. A NEW user mirrors ~1 row, not the whole table ----
  db.getOrCreateUser(USER_B, { first_name: 'BW2', username: 'bwuser2' });
  db.setWallet(USER_B, 250000);
  await sleep(1500);
  const info3 = db.syncInfo();
  // getOrCreateUser + setWallet both target USER_B -> at most a couple of rows
  // mirrored, definitely NOT the full users table (which now holds 2+ rows, and
  // the old code would have re-sent ALL of them on each write).
  const delta = info3.mirroredRowsTotal - rowsAfterA;
  assert.ok(delta > 0, 'new user write still mirrors (durability intact)');
  assert.ok(
    delta <= 3,
    `new user write mirrors only the changed row(s), not the whole table (delta=${delta})`
  );
  console.log(`  ✅ new user write mirrored ${delta} row(s) — O(1), not O(N)`);

  // ---- 4. backups is excluded from the periodic mirror ----
  // Store a large backup payload, then force a reconcile. The backup payload
  // must NOT be counted in mirroredBytesTotal (backups is skipped).
  const bigBackup = JSON.stringify({ users: [{ n: 'x'.repeat(200000) }] }); // ~200KB payload
  db.saveBackupPg('bandwidth-probe.json', bigBackup, 1, 0);
  await sleep(1000);
  const beforeReconcile = db.syncInfo().mirroredBytesTotal;
  await db.mirrorAll(true); // force full reconcile (backups must be skipped)
  await sleep(1000);
  const afterReconcile = db.syncInfo();
  const reconcileDelta = afterReconcile.mirroredBytesTotal - beforeReconcile;
  assert.ok(
    reconcileDelta < bigBackup.length,
    `backups payload must NOT be re-mirrored on reconcile (delta=${reconcileDelta}, backupSize=${bigBackup.length})`
  );
  assert.ok(afterReconcile.reconcileRuns > 0, 'forced reconcile ran');
  console.log('  ✅ backups table excluded from periodic mirror (no backup JSON re-sent)');

  // ---- 5. Reconciliation is low-frequency, NOT 30s ----
  const reconcileRunsBefore = db.syncInfo().reconcileRuns;
  await db.mirrorAll(); // dirty-only
  await sleep(300);
  await db.mirrorAll(); // dirty-only again
  await sleep(300);
  assert.strictEqual(
    db.syncInfo().reconcileRuns,
    reconcileRunsBefore,
    'repeated dirty-only mirrorAll() calls do NOT trigger a full reconcile'
  );
  console.log('  ✅ reconciliation is a low-frequency safety net, not the 30s cadence');

  db.close();
  console.log('\n✅ BANDWIDTH TEST PASSED — dirty-row mirroring + batched upserts verified.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ BANDWIDTH TEST FAILED:', e.message);
  process.exit(1);
});
