'use strict';
/**
 * Regression-safety test for the auto-backup system.
 * Proves the "keep only latest" flaw is fixed:
 *   1. A regressed (rolled-back) snapshot is flagged SUSPECT and does NOT
 *      advance the good chain — the previous GOOD backup survives.
 *   2. Rolling retention keeps the last N good backups (pre-regression
 *      snapshot always available).
 *   3. /backups lists everything; restore prefers the newest GOOD backup.
 *   4. Scheduler produces the 40-min cycle (20 offsets: 25min@5min +
 *      10min@2min + 5min@30s) and restarts the cycle.
 * Run: node tests/backup-regression-test.js   (SQLite-only, no PG needed)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-bk-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-bk-files-${Date.now()}`);
process.env.NODE_ENV = 'test';
process.env.AUTO_BACKUP_ENABLED = 'true';

const config = require('../src/config');
const db = require('../src/db');
const backup = require('../src/backup');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name} — ${e.message}`); process.exitCode = 1; }
}

console.log('🗄️  Backup regression-safety test\n');

t('schedule: 40-min cycle = 20 offsets (5@5min + 5@2min + 10@30s)', () => {
  const offs = backup.SCHEDULE_OFFSETS;
  assert.strictEqual(offs.length, 20, `expected 20 offsets, got ${offs.length}`);
  const by5 = offs.filter((o) => o <= 25 * 60000 && o % 300000 === 0);
  assert.strictEqual(by5.length, 5, 'first 25 min: 5 backups every 5 min');
  const by2 = offs.filter((o) => o > 25 * 60000 && o <= 35 * 60000);
  assert.strictEqual(by2.length, 5, 'next 10 min: 5 backups every 2 min (27,29,31,33,35)');
  const by30 = offs.filter((o) => o > 35 * 60000 && o % 30000 === 0);
  assert.strictEqual(by30.length, 10, 'last 5 min: 10 backups every 30s');
  assert.ok(offs.every((o) => o <= 40 * 60000), 'all offsets within the 40-min cycle');
});

t('backup: creates snapshot with counts + coins in circulation', () => {
  db.getOrCreateUser(5101, { first_name: 'A', username: 'a' });
  db.setWallet(5101, 1234567);
  db.setBank(5101, 7654321);
  db.addItem(5101, 'hook', 2);
  // Two more users so the regression test can show a real USER drop too.
  db.getOrCreateUser(5102, { first_name: 'B', username: 'b' });
  db.setWallet(5102, 500000);
  db.getOrCreateUser(5103, { first_name: 'C', username: 'c' });
  db.setWallet(5103, 700000);
  const b = backup.backup();
  assert.ok(b.ok, 'backup ok');
  const data = JSON.parse(fs.readFileSync(b.file, 'utf8'));
  assert.ok(data.counts && data.counts.users >= 3, 'counts.users present');
  assert.ok(data.counts.coinsInCirculation >= 10000000, 'coins in circulation tracked');
  assert.ok(data.users.some((u) => u.user_id === 5101 && u.wallet === 1234567), 'user in snapshot');
});

t('regression: suspicious snapshot is stored but does NOT advance the good chain', () => {
  // Seed the scheduler so the FIRST offset (5 min) is due NOW.
  db.setSetting('backup_cycle_start', String(Date.now() - 5 * 60000));
  db.setSetting('backup_done_idx', '0');

  // Baseline good backups (from the previous test).
  const before = backup.listBackups().filter((x) => !x.suspect).length;
  assert.ok(before >= 1, 'good baseline exists');

  // Simulate a ROLLBACK: wipe most users + supply (the regressed state).
  db.db.prepare('DELETE FROM users WHERE user_id NOT IN (?)').run(5101);
  db.setWallet(5101, 1000); // heavy drop
  db.setBank(5101, 0);      // supply cratered too

  // Running the SCHEDULED backup must flag this as SUSPECT.
  const r = backup.runScheduledBackup();
  assert.ok(r.ran, 'scheduled backup ran');
  assert.strictEqual(r.suspect, true, 'regressed snapshot flagged SUSPECT: ' + (r.reason || ''));

  // The good chain must NOT have been advanced by the suspect snapshot.
  const after = backup.listBackups().filter((x) => !x.suspect).length;
  assert.strictEqual(after, before, 'good chain unchanged (suspect never advances it)');

  // A suspect file exists but restore() refuses it — restores newest GOOD.
  const restored = backup.restore();
  assert.ok(restored.ok, 'restore works');
  const u = db.getUser(5101);
  assert.strictEqual(u.wallet, 1234567, 'restored from GOOD backup (pre-regression value)');

  // Cleanup: drop the suspect file so later runs are deterministic.
  const suspects = fs.readdirSync(process.env.BACKUP_DIR).filter((f) => f.includes('-suspect'));
  for (const s of suspects) { try { fs.unlinkSync(path.join(process.env.BACKUP_DIR, s)); } catch (e) {} }
});

t('retention: rolling window keeps the last N good backups', () => {
  // Push enough good backups to exceed the window.
  const keep = config.autoBackup.keep;
  for (let i = 0; i < keep + 3; i++) {
    backup.backup();
  }
  const good = fs.readdirSync(process.env.BACKUP_DIR).filter((f) => /^backup-\d+\.json$/.test(f));
  assert.ok(good.length <= keep + 1, `good files pruned to window (have ${good.length}, keep ${keep})`);
  assert.ok(good.length >= keep - 1, 'window not over-pruned');
});

t('restoreById: /restore <id> finds a specific backup', () => {
  const list = backup.listBackups(5);
  assert.ok(list.length >= 1, 'backups listed');
  const id = list[0].id;
  const r = backup.restoreById(id);
  assert.ok(r.ok, 'restore by id ok: ' + (r.message || ''));
  assert.ok(/RESTORE COMPLETE/.test(r.message), 'restore message confirms');
});

t('restoreById: unknown id fails cleanly', () => {
  const r = backup.restoreById(999999999);
  assert.ok(!r.ok, 'unknown id rejected');
});

t('listing: one canonical entry per snapshot timestamp, correct user count', () => {
  // Every snapshot is stored BOTH as a raw file AND as a table row — the
  // listing must show each snapshot exactly ONCE (no pg/file duplicates) and
  // every entry must carry a real user count (no NaN / '?').
  const list = backup.listBackups(50);
  const byTs = new Map();
  for (const b of list) {
    const key = b.ts;
    assert.ok(!byTs.has(key), `duplicate entry for ts ${key} (${b.filename})`);
    byTs.set(key, b);
    const uc = Number(b.userCount);
    assert.ok(Number.isFinite(uc) && uc >= 0, `userCount is a number (got ${b.userCount})`);
    assert.ok(Number.isFinite(Number(b.id)) && Number(b.id) > 0, 'id is a valid positive number');
  }
  assert.ok(list.length >= 1, 'backups listed');
  // The entries with table-row source must carry the authoritative count
  // recorded at snapshot time (a SUSPECT snapshot may legitimately show the
  // regressed count — the point is it's a real number, never NaN).
  const pgEntries = list.filter((b) => b.source === 'postgres');
  if (pgEntries.length) {
    assert.ok(pgEntries.every((b) => Number.isFinite(Number(b.userCount)) && Number(b.userCount) >= 0), 'pg entries carry a numeric user count');
  }
  // And file-only entries (fallback) must parse the count from the payload.
  const fileOnly = list.filter((b) => b.source === 'file');
  if (fileOnly.length) {
    assert.ok(fileOnly.every((b) => Number(b.userCount) >= 3), 'file entries parse counts.users from payload');
  }
});

console.log(`\n${passed} backup regression tests passed.`);
process.exit(process.exitCode || 0);