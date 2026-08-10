'use strict';
/**
 * Rimuru Tempest Casino — backup & restore 🛟
 * /backup  (owner only) — dump ALL user data (balances, status, hidden,
 *            inventory) to backups/backup-<timestamp>.json committed to repo.
 * /restore (owner only) — read the NEWEST backups/backup-*.json and restore
 *            balances/user data from it. Restores exactly what the backup
 *            contains — never touches users/items not present in the file.
 *
 * Safety: restore is UPSERT-only (existing rows keep newer data only where
 * the backup explicitly has values — wallet/bank/status are set from the
 * backup, nothing is deleted). It is a safety net for when Supabase fails.
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
 * /backup — dump every user (with inventory) to backups/backup-<ts>.json.
 * @returns { ok, message, file? }
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
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return {
      ok: true,
      file,
      message:
        `\ud83d\udce6 <b>BACKUP COMPLETE</b>\n\n` +
        `\ud83d\udc65 Users: <b>${fmt(users.length)}</b>\n` +
        `\ud83d\udcc1 File: <code>backups/backup-${ts}.json</code>\n\n` +
        `The safety net is in place. Restore with <code>/restore</code> if the vault ever fails.`,
    };
  } catch (e) {
    return { ok: false, message: `\u274c Backup failed: ${e.message}` };
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

/**
 * /restore — restore from the newest backup file.
 * Upserts every user in the backup (wallet/bank/status/inventory).
 * @returns { ok, message }
 */
function restore() {
  try {
    const file = newestBackupFile();
    if (!file) {
      return { ok: false, message: '\u274c No backups found. Run <code>/backup</code> first to create one.' };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const users = Array.isArray(data.users) ? data.users : [];
    if (!users.length) {
      return { ok: false, message: '\u274c That backup contains no users.' };
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
      message:
        `\u267b\ufe0f <b>RESTORE COMPLETE</b>\n\n` +
        `\ud83d\udcc1 File: <code>${safeName(path.basename(file))}</code>\n` +
        `\ud83d\udc65 Users restored: <b>${fmt(restored)}</b>\n\n` +
        `The vault has been rebuilt from the backup.`,
    };
  } catch (e) {
    return { ok: false, message: `\u274c Restore failed: ${e.message}` };
  }
}

module.exports = { backup, restore, newestBackupFile };
