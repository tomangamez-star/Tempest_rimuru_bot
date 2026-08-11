'use strict';
/**
 * Rimuru Tempest Casino — backup & restore 📦
 * /backup  (owner only) — dump ALL user data (balances, status, hidden,
 *            inventory) to backups/backup-<timestamp>.json AND to the
 *            `backups` table in Postgres (survives redeploys).
 * /restore (owner only) — restore from the NEWEST backup, preferring the
 *            Postgres copy (survives Render's ephemeral disk); falls back
 *            to a local backups/*.json file if no PG backup exists yet.
 *
 * Safety: restore is UPSERT-only (wallet/bank/status/inventory are set from
 * the backup; nothing is deleted; rows not present in the backup are never
 * touched). It is a safety net for when Supabase fails.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { fmt, ensureDir } = require('./utils');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

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
    inventory: inv,
  };
}

/**
 * /backup — dump every user (with inventory) to a local JSON file AND to
 * Postgres (backups table) so the snapshot survives redeploys.
 * @returns { ok, message, file?, pg? }
 */
function backup() {
  try {
    ensureDir(BACKUP_DIR);
    const users = db.getAllUsers();
    const ts = Date.now();
    const file = path.join(BACKUP_DIR, `backup-${ts}.json`);
    const data = {
      exported_at: new Date().toISOString(),
      ts,
      version: 1,
      counts: { users: users.length },
      users: users.map(userSnapshot),
    };
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, json, 'utf8');
    // NEW: also persist the snapshot to Postgres (survives redeploys).
    let pgStored = false;
    try {
      db.saveBackupPg(`backup-${ts}.json`, json, users.length, 0);
      pgStored = true;
    } catch (e) {
      console.error('[backup] PG snapshot store failed (local file kept):', e.message);
    }
    return {
      ok: true,
      file,
      pg: pgStored,
      message:
        `📦 <b>BACKUP COMPLETE</b>\n\n` +
        `👥 Users: <b>${fmt(users.length)}</b>\n` +
        `📄 File: <code>backups/backup-${ts}.json</code>\n` +
        (pgStored
          ? `🗄️ <b>Postgres copy: SAVED</b> — survives redeploys.\n\n`
          : `⚠️ <b>Postgres copy FAILED</b> — only the local file was written (ephemeral).\n\n`) +
        `The safety net is in place. Restore with <code>/restore</code> if the vault ever fails.`,
    };
  } catch (e) {
    return { ok: false, message: `❌ Backup failed: ${e.message}` };
  }
}

/** Newest backup file in backups/ (null if none). */
function newestBackupFile() {
  ensureDir(BACKUP_DIR);
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^backup-\d+\.json$/.test(f))
    .sort()
    .reverse();
  return files.length ? path.join(BACKUP_DIR, files[0]) : null;
}

/** Parse a backup payload (either from a file or from Postgres). */
function parseBackupData(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(data.users) ? data.users : [];
}

/**
 * /restore — restore from the NEWEST backup, preferring the Postgres copy
 * (survives redeploys); falls back to the newest local backups/*.json file.
 * Upserts every user in the backup (wallet/bank/status/inventory).
 * @returns { ok, message, source? }
 */
function restore() {
  try {
    let source = 'postgres';
    let users = [];

    // 1) Prefer the newest backup stored in Postgres.
    try {
      const pgBackup = db.newestBackupPg();
      if (pgBackup && pgBackup.data) {
        users = parseBackupData(pgBackup.data);
      }
    } catch (e) {
      console.error('[restore] PG backup read failed (falling back to file):', e.message);
    }

    // 2) Fall back to a local file when no PG backup exists (or is unreadable).
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
    return {
      ok: true,
      source,
      message:
        `♻️ <b>RESTORE COMPLETE</b>\n\n` +
        `📦 Source: <b>${source === 'postgres' ? '🗄️ Postgres (latest snapshot)' : '📄 local backup file'}</b>\n` +
        `👥 Users restored: <b>${fmt(restored)}</b>\n\n` +
        `The vault has been rebuilt from the backup.`,
    };
  } catch (e) {
    return { ok: false, message: `❌ Restore failed: ${e.message}` };
  }
}

module.exports = { backup, restore, newestBackupFile };
