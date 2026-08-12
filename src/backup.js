'use strict';
/**
 * Rimuru Tempest Casino — backup & restore 📦
 *
 * /backup   (owner only) — dump ALL user data to backups/backup-<ts>.json AND
 *            to the `backups` table in Postgres (survives redeploys).
 * /restore  (owner only) — restore from the NEWEST GOOD backup (Postgres copy
 *            preferred; falls back to a local file). /restore <id> targets a
 *            specific backup (staff, with owner confirmation).
 * /backups  (staff)       — list available backups (id, time, users, coins,
 *            suspect flag, source).
 *
 * AUTO-BACKUP (hidden safety net, wired in src/index.js):
 *   Runs a 40-minute cycle — every 5 min for the first 25 min, every 2 min
 *   for the next 10 min, every 30 s for the last 5 min = 20 backups/cycle.
 *
 * REGRESSION-SAFE RETENTION (the "what if it backs up a regressed
 * leaderboard?" design answer):
 *   The naive "keep ONLY the latest backup" scheme is fundamentally flawed:
 *   if the bot backs up a REGRESSED (rolled-back) state and that is the only
 *   file kept, the backup IS the bad state — there is no good snapshot to
 *   restore. The whole point of a backup is a PREVIOUS GOOD state.
 *   Therefore:
 *     1. ROLLING WINDOW — we keep the last N GOOD backups (default 5), so a
 *        pre-regression snapshot always survives.
 *     2. REGRESSION DETECTION — before a scheduled backup becomes the new
 *        "good latest", we compare total coins in circulation + user count
 *        against the previous good backup. A sharp unexplained drop in BOTH
 *        (a rollback reverts users AND supply together) flags the new
 *        snapshot as SUSPECT: it is stored (never lose data) but it does NOT
 *        advance the good chain and does NOT delete the older good backups.
 *        Legitimate loss events (bets/robs/purchases) drop supply but not
 *        user count — and an explicit mass-reset/broadcast event in the
 *        activity feed suppresses the flag.
 *   Only timestamp/version ordering decides what is "newer" — never value
 *   comparison (a lower balance is never automatically stale).
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { fmt, ensureDir } = require('./utils');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const GOOD_RE = /^backup-(\d+)\.json$/;
const SUSPECT_RE = /^backup-(\d+)-suspect\.json$/;
const SUSPECT_KEEP = 10;           // cap on suspect files kept
const PG_KEEP_MARGIN = 15;         // extra PG rows kept beyond the good window

/* ---------------- Auto-backup schedule (40-min cycle, 20 backups) ----------------
 *   Phase 1 (min 0-25): every 5 min  -> backups at 5,10,15,20,25         (5)
 *   Phase 2 (min 25-35): every 2 min  -> backups at 27,29,31,33,35        (5)
 *   Phase 3 (min 35-40): every 30 s   -> backups at 35.5..40 step 0.5    (10)
 *   Total: 20 backups per 40-min cycle, then the cycle restarts.
 */
const SCHEDULE_OFFSETS = (() => {
  const offs = [];
  for (let m = 5; m <= 25; m += 5) offs.push(m * 60000);                 // 5
  for (let m = 27; m <= 35; m += 2) offs.push(m * 60000);                // 5
  for (let i = 1; i <= 10; i++) offs.push((35 + i * 0.5) * 60000);       // 10 (35.5..40)
  return [...new Set(offs)].sort((a, b) => a - b);
})();

/* ---------------- small helpers ---------------- */

/** Sanitize a filename so only [a-z0-9._-] survives. */
function safeName(s) {
  return String(s || '').replace(/[^a-z0-9._-]/gi, '_');
}

/** Build the full backup object for one user (balances + status + hidden + inventory). */
function userSnapshot(u) {
  const inv = db.getInventory(u.user_id).map((r) => ({ item_id: r.item_id, quantity: r.quantity }));
  return {
    user_id: u.user_id,
    username: u.username || '',
    first_name: u.first_name || '',
    wallet: u.wallet || 0,
    bank: u.bank || 0,
    status: u.status || 'active',
    status_reason: u.status_reason || '',
    status_until: u.status_until || 0,
    hidden_until: u.hidden_until || 0,
    created_at: u.created_at || 0,
    updated_at: u.updated_at || 0,
    inventory: inv,
  };
}

/** Total coins in circulation for a backup payload (wallet + bank, all users). */
function coinsOf(data) {
  if (!data || !Array.isArray(data.users)) return 0;
  return data.users.reduce((sum, u) => sum + (Number(u.wallet) || 0) + (Number(u.bank) || 0), 0);
}

/* Monotonic snapshot timestamp guard: rapid backups (e.g. a burst of
 * /backup calls, or the 30s-phase of the auto cycle) can land on the SAME
 * Date.now() millisecond, which would make two snapshots share one filename
 * and silently overwrite each other — collapsing the retention window.
 * Every snapshot ts is strictly greater than the previous one. */
let lastSnapshotTs = 0;
function nextSnapshotTs() {
  const now = Date.now();
  lastSnapshotTs = Math.max(now, lastSnapshotTs + 1);
  return lastSnapshotTs;
}

/** Build a snapshot of the CURRENT sqlite state. */
function buildSnapshot() {
  const users = db.getAllUsers();
  const ts = nextSnapshotTs();
  const data = {
    exported_at: new Date().toISOString(),
    ts,
    version: 2,
    counts: { users: users.length, coinsInCirculation: coinsOf({ users }) },
    users: users.map(userSnapshot),
  };
  return { ts, data };
}

/** Parse a backup payload (either from a file or from Postgres). */
function parseBackupData(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(data.users) ? data.users : [];
}

/* ---------------- File helpers ---------------- */

function listFiles(re) {
  ensureDir(BACKUP_DIR);
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => re.test(f))
    .map((f) => {
      const m = f.match(/(\d+)/);
      return { file: path.join(BACKUP_DIR, f), ts: Number(m[1]), suspect: f.includes('-suspect') };
    })
    .sort((a, b) => b.ts - a.ts);
}

/** Newest backup file in backups/ (null if none). Good files only. */
function newestBackupFile() {
  const files = listFiles(GOOD_RE);
  return files.length ? files[0].file : null;
}

/* ---------------- Postgres helpers ---------------- */

/** Newest GOOD backup stored in Postgres (null if none) — skips suspects.
 *  Fetches the FULL row including `data` (db.listBackupsPg strips it). */
function newestGoodBackupPg() {
  try {
    const rows = db.db.prepare(
      'SELECT id, filename, data, user_count, created_by, created_at FROM backups ORDER BY id DESC LIMIT 50'
    ).all();
    const good = rows.find((r) => !String(r.filename || '').includes('-suspect'));
    return good || null;
  } catch (e) {
    return null;
  }
}

/** Newest backup stored in Postgres (any, incl. suspect) — used by db.newestBackupPg tests. */
function newestBackupPg() {
  return db.newestBackupPg();
}

/* ---------------- Regression detection ---------------- */

/** Look for a legitimate mass-loss / reset event in the recent activity feed
 *  (an explicit broadcast/reset makes a supply drop expected, not a rollback). */
function recentMassLossEvent() {
  try {
    const now = Date.now();
    const recent = db.getActivity(80).filter((a) => now - (Number(a.created_at) || 0) < 10 * 60 * 1000);
    return recent.some((a) => {
      const t = String(a.text || '') + ' ' + String(a.type || '');
      return /mass|reset|wipe|clear|rollback|restore/i.test(t);
    });
  } catch (e) {
    return false;
  }
}

/**
 * Regression check for a scheduled backup: compare total coins + user count
 * against the previous GOOD backup. A rollback reverts BOTH (users disappear
 * AND supply drops); legitimate losses drop supply only. Returns
 * { suspicious, reason }.
 */
function regressionCheck(data) {
  const prev = newestGoodBackupPg() || null;
  let prevData = null;
  if (prev && prev.data) {
    try { prevData = JSON.parse(prev.data); } catch (e) { prevData = null; }
  }
  if (!prevData) {
    // No previous good baseline yet — nothing to regress against.
    return { suspicious: false, reason: '' };
  }
  const prevUsers = Number(prevData.counts && prevData.counts.users) || (Array.isArray(prevData.users) ? prevData.users.length : 0);
  const prevCoins = Number(prevData.counts && prevData.counts.coinsInCirculation) || coinsOf(prevData);
  const newUsers = Array.isArray(data.users) ? data.users.length : 0;
  const newCoins = coinsOf(data);
  if (!prevUsers || !prevCoins) return { suspicious: false, reason: '' };
  const userDrop = 1 - newUsers / prevUsers;
  const coinDrop = 1 - newCoins / prevCoins;
  // A rollback reverts users AND supply together; use a small user-drop
  // threshold + the configured coin-drop threshold.
  if (userDrop > 0.05 && coinDrop > config.autoBackup.regressionPct) {
    if (recentMassLossEvent()) {
      return { suspicious: false, reason: 'mass-loss event logged — drop expected' };
    }
    return {
      suspicious: true,
      reason: `users ${prevUsers}->${newUsers} (${(userDrop * 100).toFixed(1)}%), ` +
              `supply ${fmt(prevCoins)}->${fmt(newCoins)} (${(coinDrop * 100).toFixed(1)}%)`,
    };
  }
  return { suspicious: false, reason: '' };
}

/* ---------------- Snapshot save / retention ---------------- */

/** Persist a snapshot to disk + Postgres, then prune the rolling window. */
function saveSnapshot(ts, data, suspect) {
  ensureDir(BACKUP_DIR);
  const filename = suspect ? `backup-${ts}-suspect.json` : `backup-${ts}.json`;
  const file = path.join(BACKUP_DIR, filename);
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, json, 'utf8');
  let pgStored = false;
  try {
    db.saveBackupPg(filename, json, data.counts ? data.counts.users : data.users.length, 0);
    pgStored = true;
  } catch (e) {
    console.error('[backup] PG snapshot store failed (local file kept):', e.message);
  }
  prune(suspect);
  return { file, pg: pgStored };
}

/** Does the backups table still hold a canonical row for this timestamp?
 *  (Used as the ordering guard: a raw file is only deleted when its
 *  canonical metadata record is safely retained.) */
function pgHasBackupForTs(ts) {
  try {
    return !!db.db.prepare('SELECT 1 FROM backups WHERE filename LIKE ? LIMIT 1').get(`backup-${ts}%`);
  } catch (e) {
    return false;
  }
}

/** Rolling-window retention: keep the last N GOOD backups (pre-regression
 *  snapshots always survive), cap suspects, and prune old PG rows. */
function prune(lastWasSuspect) {
  try {
    const keep = config.autoBackup.keep;
    const deleted = []; // audit trail: { kind, id, filename?, reason }
    const good = listFiles(GOOD_RE);
    for (const g of good.slice(keep)) {
      if (pgHasBackupForTs(g.ts)) {
        try {
          fs.unlinkSync(g.file);
          deleted.push({ kind: 'file', id: g.ts, filename: path.basename(g.file), reason: `rolling-window prune (kept last ${keep} GOOD backups)` });
        } catch (e) { /* non-fatal */ }
      } else {
        console.warn(`[backup] kept file backup-${g.ts}.json: no canonical metadata row retained (only copy)`);
      }
    }
    const suspects = listFiles(SUSPECT_RE);
    for (const s of suspects.slice(SUSPECT_KEEP)) {
      if (pgHasBackupForTs(s.ts)) {
        try {
          fs.unlinkSync(s.file);
          deleted.push({ kind: 'suspect-file', id: s.ts, filename: path.basename(s.file), reason: `suspect cap (${SUSPECT_KEEP} kept)` });
        } catch (e) { /* non-fatal */ }
      } else {
        console.warn(`[backup] kept suspect file backup-${s.ts}-suspect.json: no canonical metadata row retained (only copy)`);
      }
    }
    // Prune PG backups beyond (good window + margin). The newest PG row is
    // always preserved, so restore()/tests never find an empty store.
    try {
      const cap = keep + PG_KEEP_MARGIN;
      const victims = db.db.prepare(
        'SELECT id, filename FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)'
      ).all(cap);
      for (const v of victims) {
        deleted.push({ kind: 'pg-row', id: Number(v.id), filename: v.filename, reason: `PG retention cap (${cap} rows kept)` });
      }
      if (victims.length) {
        db.db.prepare(
          'DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)'
        ).run(cap);
      }
    } catch (e) { /* non-fatal */ }
    // Audit log: exactly which backup ids were deleted and why — so the user
    // can see it's expected rolling-window pruning, not data loss.
    if (deleted.length) {
      const detail = deleted
        .map((d) => `${d.kind}:${d.id}${d.filename ? ` (${d.filename})` : ''} [${d.reason}]`)
        .join('; ');
      try {
        db.logAudit(0, 'auto-backup', 'backup_prune', 0, detail);
      } catch (e) { /* non-fatal */ }
      console.log(`[backup] cleanup: pruned ${deleted.length} stale backup(s) — ${deleted.map((d) => `${d.kind}:${d.id}`).join(', ')}`);
    }
    if (lastWasSuspect) {
      console.warn('[backup] ⚠ new snapshot flagged SUSPECT — previous GOOD backups kept (rolling window intact).');
    }
  } catch (e) {
    console.error('[backup] prune failed:', e.message);
  }
}

/* ---------------- Manual /backup ---------------- */

/**
 * /backup — dump every user (with inventory) to a local JSON file AND to
 * Postgres (backups table) so the snapshot survives redeploys.
 * Manual backups are always saved as GOOD (explicit owner intent).
 * @returns { ok, message, file?, pg? }
 */
function backup() {
  try {
    const { ts, data } = buildSnapshot();
    const saved = saveSnapshot(ts, data, false);
    const reg = regressionCheck(data);
    return {
      ok: true,
      file: saved.file,
      pg: saved.pg,
      suspect: reg.suspicious,
      message:
        `📦 <b>BACKUP COMPLETE</b>\n\n` +
        `👥 Users: <b>${fmt(data.counts.users)}</b>\n` +
        `💰 Coins in circulation: <b>${fmt(data.counts.coinsInCirculation)}</b>\n` +
        `📄 File: <code>backups/backup-${ts}.json</code>\n` +
        (saved.pg
          ? `🗄️ <b>Postgres copy: SAVED</b> — survives redeploys.\n\n`
          : `⚠️ <b>Postgres copy FAILED</b> — only the local file was written (ephemeral).\n\n`) +
        (reg.suspicious
          ? `⚠️ <b>Regression WARNING</b>: ${reg.reason} — inspect before restoring.\n\n`
          : '') +
        `The safety net is in place. Restore with <code>/restore</code> if the vault ever fails.`,
    };
  } catch (e) {
    return { ok: false, message: `❌ Backup failed: ${e.message}` };
  }
}

/* ---------------- Restore ---------------- */

/** Upsert a parsed backup payload into the DB (never deletes anything). */
function applyRestore(users) {
  let restored = 0;
  for (const u of users) {
    const id = Number(u.user_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    db.getOrCreateUser(id, { username: u.username || '', first_name: u.first_name || '' });
    if (Number.isFinite(Number(u.wallet))) db.setWallet(id, Number(u.wallet) || 0);
    if (Number.isFinite(Number(u.bank))) db.setBank(id, Number(u.bank) || 0);
    if (u.status) db.setStatus(id, u.status, u.status_reason || '', Number(u.status_until) || 0);
    if (Number.isFinite(Number(u.hidden_until))) db.setHidden(id, Number(u.hidden_until) || 0);
    if (Array.isArray(u.inventory)) {
      for (const it of u.inventory) {
        const qty = Math.max(0, Math.floor(Number(it.quantity) || 0));
        if (qty > 0) db.addItem(id, String(it.item_id), qty);
      }
    }
    restored++;
  }
  return restored;
}

/**
 * /restore — restore from the NEWEST GOOD backup, preferring the Postgres
 * copy (survives redeploys); falls back to the newest local backups/*.json.
 * Suspect (possibly regressed) snapshots are NEVER auto-selected.
 */
function restore() {
  try {
    let source = 'postgres';
    let users = [];

    // 1) Prefer the newest GOOD backup stored in Postgres.
    try {
      const pgBackup = newestGoodBackupPg();
      if (pgBackup && pgBackup.data) {
        users = parseBackupData(pgBackup.data);
      }
    } catch (e) {
      console.error('[restore] PG backup read failed (falling back to file):', e.message);
    }

    // 2) Fall back to a local GOOD file when no PG backup exists.
    if (!users.length) {
      const file = newestBackupFile();
      if (file) {
        source = 'file';
        users = parseBackupData(fs.readFileSync(file, 'utf8'));
      }
    }

    if (!users.length) {
      return {
        ok: false,
        message:
          '❌ No backups found (Postgres or local). Run <code>/backup</code> first to create one.',
      };
    }

    const restored = applyRestore(users);
    return {
      ok: true,
      source,
      message:
        `♻️ <b>RESTORE COMPLETE</b>\n\n` +
        `📦 Source: <b>${source === 'postgres' ? '🗄️ Postgres (latest GOOD snapshot)' : '📄 local backup file'}</b>\n` +
        `👥 Users restored: <b>${fmt(restored)}</b>\n\n` +
        `The vault has been rebuilt from the backup.`,
    };
  } catch (e) {
    return { ok: false, message: `❌ Restore failed: ${e.message}` };
  }
}

/** Find a specific backup by id (Postgres row id) or timestamp (filename). */
function findBackup(idOrTs) {
  const key = Number(idOrTs);
  if (!Number.isFinite(key) || key <= 0) return null;
  try {
    const rows = db.db.prepare(
      'SELECT id, filename, data, user_count, created_by, created_at FROM backups ORDER BY id DESC LIMIT 100'
    ).all();
    const pgRow = rows.find((r) => Number(r.id) === key);
    if (pgRow && pgRow.data) {
      return { source: 'postgres', id: Number(pgRow.id), ts: Number(pgRow.created_at) || key, data: pgRow.data, filename: pgRow.filename };
    }
  } catch (e) { /* fall through to files */ }
  const files = [...listFiles(GOOD_RE), ...listFiles(SUSPECT_RE)];
  const fileMatch = files.find((f) => f.ts === key);
  if (fileMatch) {
    return { source: 'file', id: key, ts: key, data: fs.readFileSync(fileMatch.file, 'utf8'), filename: path.basename(fileMatch.file) };
  }
  return null;
}

/**
 * /restore <id> — restore a SPECIFIC backup (staff). Caller must confirm the
 * id first; this function applies it. Returns { ok, message, source }.
 */
function restoreById(idOrTs) {
  try {
    const found = findBackup(idOrTs);
    if (!found) {
      return { ok: false, message: `❌ No backup found for id <code>${idOrTs}</code>. Use <code>/backups</code> to list them.` };
    }
    const users = parseBackupData(found.data);
    const restored = applyRestore(users);
    return {
      ok: true,
      source: found.source,
      message:
        `♻️ <b>RESTORE COMPLETE</b>\n\n` +
        `📦 Source: <b>${found.source === 'postgres' ? '🗄️ Postgres' : '📄 file'}</b> — <code>${found.filename || 'backup'}</code>\n` +
        `👥 Users restored: <b>${fmt(restored)}</b>\n\n` +
        `The vault has been rebuilt from backup <code>${idOrTs}</code>.`,
    };
  } catch (e) {
    return { ok: false, message: `❌ Restore failed: ${e.message}` };
  }
}

/* ---------------- /backups listing ---------------- */

/** Normalize a snapshot's user count: prefer counts.users (v2 payload),
 *  fall back to the users array length. Returns 0 when unreadable. */
function countUsersInFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.counts && Number.isFinite(Number(data.counts.users))) return Number(data.counts.users);
    if (Array.isArray(data.users)) return data.users.length;
  } catch (e) { /* ignore */ }
  return 0;
}

/** Extract the canonical snapshot timestamp from a backup filename
 *  (backup-<ts>.json / backup-<ts>-suspect.json). 0 when unparseable. */
function tsFromFilename(filename) {
  const m = String(filename || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Merged backup list — ONE canonical entry per snapshot timestamp, newest
 * first. Every snapshot is stored BOTH as a raw file (backups/*.json) AND as
 * a row in the `backups` table (mirrored to Postgres). The table row is the
 * canonical record (it carries the authoritative user_count); the raw file is
 * only listed as a fallback when no table row exists for that timestamp.
 * Fixes: duplicate entries for the same snapshot + "NaN users" (the file
 * entries read a field that doesn't exist — user_count lives on the table row
 * and in the payload's counts.users).
 */
function listBackups(limit = 20) {
  const out = new Map(); // key: canonical snapshot timestamp
  try {
    for (const r of db.listBackupsPg(100)) {
      const ts = tsFromFilename(r.filename) || Number(r.created_at) || 0;
      out.set(`ts:${ts}`, {
        id: Number(r.id),
        ts,
        filename: r.filename || '',
        userCount: Number(r.user_count) || 0,
        suspect: String(r.filename || '').includes('-suspect'),
        source: 'postgres',
      });
    }
  } catch (e) { /* non-fatal */ }
  for (const f of [...listFiles(GOOD_RE), ...listFiles(SUSPECT_RE)]) {
    // The table row is canonical — never duplicate the same snapshot.
    if (out.has(`ts:${f.ts}`)) continue;
    out.set(`ts:${f.ts}`, {
      id: f.ts,
      ts: f.ts,
      filename: path.basename(f.file),
      userCount: countUsersInFile(f.file),
      suspect: f.suspect,
      source: 'file',
    });
  }
  return [...out.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/* ---------------- Scheduled auto-backup ---------------- */

// In-memory scheduler state (cycle start + how many offsets of this cycle ran).
let cycleStartMs = 0;
let doneIdx = 0;
let runCount = 0;
let suspectCount = 0;

function persistState() {
  try {
    db.setSetting('backup_cycle_start', String(cycleStartMs));
    db.setSetting('backup_done_idx', String(doneIdx));
  } catch (e) { /* non-fatal */ }
}

function loadState() {
  try {
    cycleStartMs = Number(db.getSetting('backup_cycle_start')) || 0;
    doneIdx = Number(db.getSetting('backup_done_idx')) || 0;
    runCount = Number(db.getSetting('backup_run_count')) || 0;
    suspectCount = Number(db.getSetting('backup_suspect_count')) || 0;
  } catch (e) { /* ignore */ }
}

/**
 * Scheduled backup tick — called by src/index.js every config.autoBackup.checkMs.
 * Runs exactly one backup per schedule offset; the cycle restarts every 40 min.
 * A regressed snapshot is stored as SUSPECT and never advances the good chain.
 * @returns { ok, ran, suspect, reason? } — ran=false when nothing is due.
 */
function runScheduledBackup() {
  if (!config.autoBackup.enabled) return { ok: false, ran: false, reason: 'disabled' };
  if (!cycleStartMs) {
    loadState();
    if (!cycleStartMs) {
      cycleStartMs = Date.now();
      persistState();
    }
  }
  const now = Date.now();
  const elapsed = now - cycleStartMs;
  if (elapsed >= config.autoBackup.cycleMs) {
    // Cycle complete — restart it.
    cycleStartMs = now;
    doneIdx = 0;
    persistState();
  }
  // Any offset due and not yet run?
  let due = -1;
  while (due + 1 < SCHEDULE_OFFSETS.length && SCHEDULE_OFFSETS[due + 1] <= elapsed) due++;
  const targetIdx = Math.min(due, SCHEDULE_OFFSETS.length - 1);
  if (targetIdx < 0 || targetIdx < doneIdx) return { ok: false, ran: false };
  // Only one backup per tick (the next offset runs on a later tick).
  const idx = doneIdx;
  if (idx > targetIdx) return { ok: false, ran: false };

  try {
    const { ts, data } = buildSnapshot();
    const reg = regressionCheck(data);
    // Regression gate: a suspicious snapshot is stored but does NOT become the
    // new good reference (the good chain keeps the previous backups).
    const saved = saveSnapshot(ts, data, reg.suspicious);
    if (reg.suspicious) {
      suspectCount++;
      db.setSetting('backup_suspect_count', String(suspectCount));
      console.warn(`[backup] ⚠ auto-backup ${ts} flagged SUSPECT (${reg.reason}) — stored separately; good chain intact.`);
    } else {
      runCount++;
      db.setSetting('backup_run_count', String(runCount));
    }
    doneIdx = idx + 1;
    persistState();
    console.log(
      `[backup] auto-backup #${idx + 1}/${SCHEDULE_OFFSETS.length} done (users=${data.counts.users}, coins=${fmt(data.counts.coinsInCirculation)}${reg.suspicious ? ', SUSPECT' : ''})`
    );
    return { ok: true, ran: true, suspect: reg.suspicious, reason: reg.reason, ts };
  } catch (e) {
    console.error('[backup] scheduled backup failed:', e.message);
    return { ok: false, ran: false, reason: e.message };
  }
}

/** Current auto-backup state for /debug. */
function getBackupState() {
  if (!runCount && !suspectCount) loadState();
  return {
    enabled: config.autoBackup.enabled,
    cycleMs: config.autoBackup.cycleMs,
    keep: config.autoBackup.keep,
    regressionPct: config.autoBackup.regressionPct,
    scheduleOffsets: SCHEDULE_OFFSETS.length,
    doneIdx,
    runCount,
    suspectCount,
    lastBackupAt: Number(db.getSetting('backup_last_ts')) || 0,
    cycleStartAt: cycleStartMs || 0,
  };
}

module.exports = {
  backup,
  restore,
  restoreById,
  findBackup,
  listBackups,
  newestBackupFile,
  newestBackupPg,
  parseBackupData,
  runScheduledBackup,
  getBackupState,
  SCHEDULE_OFFSETS,
  regressionCheck,
};