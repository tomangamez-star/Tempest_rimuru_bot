'use strict';
/**
 * Rimuru v1.0.3 persistence hardening shim.
 *
 * Loaded before src/index.js from package.json. It keeps the existing db.js
 * architecture intact while fixing the production durability gap:
 *   - user timestamps are normalized to epoch milliseconds
 *   - balance/rank/status mutations are mirrored to Postgres immediately
 *   - user upserts only replace an older/equal Postgres row
 *   - boot hydration keeps a surviving SQLite row only when it is newer
 *   - the periodic users mirror is timestamp-aware instead of blind
 *
 * Other tables continue to use the existing db.js mirror implementation.
 */
const db = require('./db');

const USER_COLS = [
  'user_id', 'username', 'first_name', 'wallet', 'bank', 'networth', 'rank',
  'rank_valid_matches', 'rank_consecutive_losses', 'created_at', 'updated_at',
  'status', 'status_reason', 'status_until', 'hidden_until', 'last_seen',
];

const OTHER_MIRROR_TABLES = [
  'game_history', 'cooldowns', 'admin_users', 'chat_logs', 'activity_feed',
  'audit_log', 'lottery', 'heists', 'inventory', 'game_sessions', 'backup_meta',
  'backup_data', 'backups', 'broadcast_queue', 'events', 'mission_progress',
  'redeem_codes', 'redeem_claims', 'redeem_redemptions', 'waifu_cache',
  'waifu_spawn', 'hunt_cache', 'hunt_spawn',
  'bot_memory', 'settings',
];

// Collection claims are durable append-only records. They intentionally use a
// dedicated write path instead of the generic table mirror: local AUTOINCREMENT
// ids can restart on an ephemeral Render filesystem, while character_id is the
// stable identity that must never be overwritten by a later deployment.
const CLAIM_TABLES = {
  waifu_claims: {
    mutationNames: ['claimWaifuCharacter', 'claimCharacter'],
  },
  hunt_claims: {
    mutationNames: ['claimHuntCharacter'],
  },
};
const CLAIM_COLS = ['user_id', 'character_id', 'name', 'series', 'image_url', 'rarity', 'claimed_at'];

function epoch(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const s = String(value).trim();
  if (/^\d{10,16}$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLocalUser(userId, stampIfMissing = false) {
  const row = db.getUser(Number(userId));
  if (!row) return null;
  const now = Date.now();
  const created = epoch(row.created_at, stampIfMissing ? now : 0) || now;
  const updated = epoch(row.updated_at, stampIfMissing ? now : created) || created;
  try {
    db.db.prepare('UPDATE users SET created_at = ?, updated_at = ? WHERE user_id = ?')
      .run(created, updated, Number(userId));
  } catch (e) {
    console.warn('[persist-v1.0.3] timestamp normalize failed:', e.message);
  }
  return db.getUser(Number(userId));
}

function stampLocalUser(userId) {
  const id = Number(userId);
  const now = Date.now();
  try {
    db.db.prepare('UPDATE users SET updated_at = ? WHERE user_id = ?').run(now, id);
  } catch (e) {
    console.warn('[persist-v1.0.3] timestamp stamp failed:', e.message);
  }
  return normalizeLocalUser(id, true);
}

function persistenceWritable() {
  try {
    const info = db.syncInfo ? db.syncInfo() : {};
    return !!(info.configured && info.ready && info.connected && info.writable &&
      info.instanceLockHeld && info.syncEnabled);
  } catch (_) {
    return false;
  }
}

function userParams(row) {
  const now = Date.now();
  const created = epoch(row.created_at, now) || now;
  const updated = epoch(row.updated_at, created) || created;
  return [
    Number(row.user_id), row.username || '', row.first_name || '',
    Number(row.wallet) || 0, Number(row.bank) || 0,
    Number(row.networth != null ? row.networth : (Number(row.wallet) || 0) + (Number(row.bank) || 0)),
    row.rank || 'bronze', Number(row.rank_valid_matches) || 0,
    Number(row.rank_consecutive_losses) || 0, created, updated,
    row.status || '', row.status_reason || '', Number(row.status_until) || 0,
    Number(row.hidden_until) || 0, Number(row.last_seen) || 0,
  ];
}

async function syncUserRow(row) {
  if (!row || !persistenceWritable() || !db.pgRun) return false;
  const params = userParams(row);
  // Existing installs may have updated_at as BIGINT or legacy TEXT. Casting to
  // text first makes the guard compatible with both. Numeric epoch strings are
  // compared numerically; unknown legacy formats are treated as old and are
  // safely replaced by the normalized current row.
  const sql = `
    INSERT INTO users (${USER_COLS.join(', ')})
    VALUES (${USER_COLS.map((_, i) => `$${i + 1}`).join(', ')})
    ON CONFLICT (user_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      wallet = EXCLUDED.wallet,
      bank = EXCLUDED.bank,
      networth = EXCLUDED.networth,
      rank = EXCLUDED.rank,
      rank_valid_matches = EXCLUDED.rank_valid_matches,
      rank_consecutive_losses = EXCLUDED.rank_consecutive_losses,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      status_until = EXCLUDED.status_until,
      hidden_until = EXCLUDED.hidden_until,
      last_seen = EXCLUDED.last_seen
    WHERE
      CASE
        WHEN users.updated_at::text ~ '^\\d+$' THEN users.updated_at::text::numeric
        ELSE 0
      END
      <= EXCLUDED.updated_at::text::numeric`;
  return db.pgRun('users', sql, params);
}

async function syncUserId(userId) {
  const row = normalizeLocalUser(userId, true);
  return row ? syncUserRow(row) : false;
}

async function syncAllUsers() {
  if (!persistenceWritable()) return 0;
  let rows = [];
  try { rows = db.getAllUsers ? db.getAllUsers() : []; } catch (_) { return 0; }
  let ok = 0;
  for (const row of rows) {
    normalizeLocalUser(row.user_id, true);
    if (await syncUserRow(db.getUser(row.user_id))) ok++;
  }
  return ok;
}

function snapshotUsers() {
  try {
    return (db.getAllUsers ? db.getAllUsers() : []).map((r) => ({ ...r }));
  } catch (_) {
    return [];
  }
}

function snapshotClaims() {
  const out = {};
  for (const table of Object.keys(CLAIM_TABLES)) {
    try {
      out[table] = db.db.prepare(`SELECT ${CLAIM_COLS.join(', ')} FROM ${table}`).all().map((r) => ({ ...r }));
    } catch (_) {
      out[table] = [];
    }
  }
  return out;
}

function restoreClaimSnapshots(snapshot) {
  if (!snapshot) return 0;
  let restored = 0;
  for (const table of Object.keys(CLAIM_TABLES)) {
    const rows = snapshot[table] || [];
    if (!rows.length) continue;
    const insert = db.db.prepare(
      `INSERT OR IGNORE INTO ${table} (${CLAIM_COLS.join(', ')}) VALUES (${CLAIM_COLS.map(() => '?').join(', ')})`
    );
    for (const row of rows) {
      try {
        const info = insert.run(...CLAIM_COLS.map((c) => row[c] == null ? null : row[c]));
        restored += Number(info.changes) || 0;
      } catch (_) { /* preserve the durable/local union best-effort */ }
    }
  }
  return restored;
}

async function syncClaimRow(table, row) {
  if (!row || !persistenceWritable() || !db.pgRun || !CLAIM_TABLES[table]) return false;
  const values = CLAIM_COLS.map((c) => row[c] == null ? null : row[c]);
  const placeholders = CLAIM_COLS.map((_, i) => `$${i + 1}`).join(', ');
  // character_id is the durable identity. Postgres installs that never had a
  // local SQLite-style `id` column must work exactly the same as newer ones.
  const sql = `
    INSERT INTO ${table} (${CLAIM_COLS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (character_id) DO NOTHING`;
  return db.pgRun(table, sql, values);
}

async function syncAllClaims() {
  if (!persistenceWritable()) return 0;
  let ok = 0;
  for (const table of Object.keys(CLAIM_TABLES)) {
    let rows = [];
    try { rows = db.db.prepare(`SELECT ${CLAIM_COLS.join(', ')} FROM ${table}`).all(); } catch (_) { continue; }
    for (const row of rows) if (await syncClaimRow(table, row)) ok++;
  }
  return ok;
}

function restoreNewerLocal(snapshot) {
  if (!snapshot || !snapshot.length) return 0;
  let restored = 0;
  const cols = USER_COLS;
  const placeholders = cols.map(() => '?').join(', ');
  const insert = db.db.prepare(`INSERT OR REPLACE INTO users (${cols.join(', ')}) VALUES (${placeholders})`);
  for (const before of snapshot) {
    const after = db.getUser(Number(before.user_id));
    const beforeStamp = epoch(before.updated_at, 0);
    const afterStamp = after ? epoch(after.updated_at, 0) : 0;
    if (beforeStamp > afterStamp) {
      const normalized = { ...before, created_at: epoch(before.created_at, beforeStamp), updated_at: beforeStamp };
      insert.run(...USER_COLS.map((c) => normalized[c] == null ? null : normalized[c]));
      restored++;
    }
  }
  return restored;
}

function normalizeAllLocalUsers() {
  let rows = [];
  try { rows = db.getAllUsers ? db.getAllUsers() : []; } catch (_) { return; }
  for (const row of rows) normalizeLocalUser(row.user_id, true);
}

// Preserve a newer surviving local row during boot hydration. On Render free
// tier the local DB is normally fresh/empty, so Postgres naturally wins.
const originalInitPersistence = db.initPersistence && db.initPersistence.bind(db);
if (originalInitPersistence) {
  db.initPersistence = async function hardenedInitPersistence(...args) {
    const before = snapshotUsers();
    const claimBefore = snapshotClaims();
    const result = await originalInitPersistence(...args);
    const restored = restoreNewerLocal(before);
    const claimsRestored = restoreClaimSnapshots(claimBefore);
    normalizeAllLocalUsers();
    if (restored) console.warn(`[persist-v1.0.3] preserved ${restored} newer local user row(s) after hydration`);
    if (claimsRestored) console.warn(`[persist-collections-v1.0.8] preserved ${claimsRestored} local claim(s) after hydration`);
    return result;
  };
}

const originalHydrate = db.hydrateFromPg && db.hydrateFromPg.bind(db);
if (originalHydrate) {
  db.hydrateFromPg = async function hardenedHydrate(...args) {
    const before = snapshotUsers();
    const claimBefore = snapshotClaims();
    const result = await originalHydrate(...args);
    const restored = restoreNewerLocal(before);
    const claimsRestored = restoreClaimSnapshots(claimBefore);
    normalizeAllLocalUsers();
    if (restored) console.warn(`[persist-v1.0.3] preserved ${restored} newer local user row(s) after re-hydration`);
    if (claimsRestored) console.warn(`[persist-collections-v1.0.8] preserved ${claimsRestored} local claim(s) after re-hydration`);
    return result;
  };
}

function wrapUserMutation(name, idsFromArgs) {
  const original = db[name];
  if (typeof original !== 'function') return;
  db[name] = function hardenedUserMutation(...args) {
    const result = original.apply(db, args);
    let ids = [];
    try { ids = idsFromArgs ? idsFromArgs(args, result) : [args[0]]; } catch (_) { ids = [args[0]]; }
    ids = [...new Set((ids || []).filter((v) => v != null).map(Number))];
    for (const id of ids) {
      stampLocalUser(id);
      // Fire-and-forget by design; the safe periodic reconcile retries failures.
      syncUserId(id).catch((e) => console.warn('[persist-v1.0.3] immediate user sync failed:', e.message));
    }
    return result;
  };
}

for (const name of [
  'getOrCreateUser', 'addWallet', 'addBank', 'setNetworth', 'setWallet', 'setBank',
  'setRankStats', 'setStatus', 'clearStatus', 'setHidden',
]) wrapUserMutation(name);

function wrapClaimMutation(name, table) {
  const original = db[name];
  if (typeof original !== 'function') return;
  db[name] = function hardenedClaimMutation(...args) {
    const row = original.apply(db, args);
    if (row) {
      // Immediate direct write: claims should not wait for the 30-second mirror.
      syncClaimRow(table, row).catch((e) => console.warn(`[persist-collections-v1.0.8] immediate ${table} sync failed:`, e.message));
    }
    return row;
  };
}
for (const [table, cfg] of Object.entries(CLAIM_TABLES)) {
  for (const name of cfg.mutationNames) wrapClaimMutation(name, table);
}

if (typeof db.expirePenalties === 'function') {
  const originalExpire = db.expirePenalties.bind(db);
  db.expirePenalties = function hardenedExpire(...args) {
    const result = originalExpire(...args);
    for (const item of result || []) {
      if (item && item.user_id != null) {
        stampLocalUser(item.user_id);
        syncUserId(item.user_id).catch(() => {});
      }
    }
    return result;
  };
}

// Replace only the exported periodic mirror entry points. Other table mirror
// behavior stays in db.js; the users table uses the timestamp-aware path here.
const originalMirrorTable = db.mirrorTable && db.mirrorTable.bind(db);
if (originalMirrorTable) {
  db.mirrorTable = async function hardenedMirrorTable(table) {
    if (table === 'users') return syncAllUsers();
    return originalMirrorTable(table);
  };
}

const originalDrain = db.drainMirrorQueue && db.drainMirrorQueue.bind(db);
let mirrorLoopStarted = false;
db.fullMirror = async function hardenedFullMirror() {
  if (!persistenceWritable()) return;
  await syncAllUsers();
  await syncAllClaims();
  if (originalMirrorTable) {
    for (const table of OTHER_MIRROR_TABLES) {
      try { await originalMirrorTable(table); } catch (e) { console.warn(`[persist-v1.0.3] mirror ${table}:`, e.message); }
    }
  }
};

db.startMirrorLoop = async function hardenedStartMirrorLoop() {
  if (mirrorLoopStarted) return;
  mirrorLoopStarted = true;
  const intervalMs = 30000;
  const drainTimer = setInterval(() => {
    if (originalDrain) originalDrain().catch((e) => console.warn('[persist-v1.0.3] queue drain:', e.message));
  }, 1000);
  const mirrorTimer = setInterval(() => {
    db.fullMirror().catch((e) => console.warn('[persist-v1.0.3] full mirror:', e.message));
  }, intervalMs);
  drainTimer.unref && drainTimer.unref();
  mirrorTimer.unref && mirrorTimer.unref();
};

console.log('[persist-v1.0.3] persistence hardening loaded');
console.log('[persist-collections-v1.0.8] waifu/hunt claim durability + schema compatibility loaded');

module.exports = {
  epoch, syncUserRow, syncUserId, syncAllUsers, restoreNewerLocal,
  snapshotClaims, restoreClaimSnapshots, syncClaimRow, syncAllClaims,
};
