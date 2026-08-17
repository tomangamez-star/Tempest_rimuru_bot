'use strict';
/**
 * Regression-safety test for the auto-backup system.
 * Proves the "keep only latest" flaw is fixed:
 *   1. A regressed (rolled-back) snapshot is flagged SUSPECT and does NOT
 *      advance the good chain — the previous GOOD backup survives.
 *   2. Rolling retention keeps the last N good backups (pre-regression
 *      snapshot always available).
 *   3. /backups lists everything; restore prefers the newest GOOD backup.
 *   4. Scheduler produces the flat every-5-min schedule (single offset, no
 *      cycle bursts) and runs when the 5-min interval elapses.
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

t('schedule: flat every-5-min = 1 offset, no burst phases', () => {
  const offs = backup.SCHEDULE_OFFSETS;
  assert.strictEqual(offs.length, 1, `expected 1 offset (flat 5 min), got ${offs.length}`);
  assert.strictEqual(offs[0], 5 * 60000, 'single offset = 5 minutes');
  assert.strictEqual(backup.BACKUP_INTERVAL_MS, 5 * 60 * 1000, 'interval constant = 5 min');
});

t('backup: creates snapshot with counts + coins in circulation', () => {
  db.getOrCreateUser(5101, { first_name: 'A', username: 'a' });
  db.setWallet(5101, 1234567);
  db.setBank(5101, 7654321);
  db.addInventory(5101, 'hook', 2);
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
  // Seed the scheduler so the 5-min interval is due NOW: the flat schedule
  // anchors on backup_last_ts, so backdate it by 5 minutes.
  db.setSetting('backup_last_ts', String(Date.now() - 5 * 60000));

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

t('clearAllBackups: wipes files + rows, resets anchor, next backup due', () => {
  const before = backup.getBackupCount();
  assert.ok(before.files >= 1, `expect files on disk, got ${before.files}`);
  assert.ok(before.rows >= 1, `expect table rows, got ${before.rows}`);
  const r = backup.clearAllBackups();
  assert.ok(r.ok, 'clearAllBackups ok');
  const after = backup.getBackupCount();
  assert.strictEqual(after.files, 0, `all backup files deleted (left ${after.files})`);
  assert.strictEqual(after.rows, 0, `all backup rows deleted (left ${after.rows})`);
  // Anchor reset -> the scheduler is due immediately (next tick).
  const st = backup.getBackupState();
  assert.strictEqual(st.anchorValid, true, 'anchor valid after reset');
  assert.ok(st.nextDueInMs <= backup.BACKUP_INTERVAL_MS, 'next backup due within one interval');
  // The scheduler actually fires again after the wipe (5-min interval bypassed
  // via a fresh anchor): a new snapshot is created and stored.
  const now = Date.now();
  db.setSetting('backup_last_ts', String(now - backup.BACKUP_INTERVAL_MS - 1));
  const r2 = backup.runScheduledBackup();
  assert.ok(r2.ok, 'scheduler resumes after clear');
  assert.strictEqual(r2.ran, true, 'backup ran on next tick after clear');
  assert.ok(backup.getBackupCount().files >= 1, 'new snapshot stored after clear');
});

console.log(`\n${passed} backup regression tests passed.`);
process.exit(process.exitCode || 0);