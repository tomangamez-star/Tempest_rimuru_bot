'use strict';
/**
 * Rimuru Tempest Casino — hybrid data layer.
 *
 * SQLite (better-sqlite3) stays the hot synchronous cache — every game,
 * economy and dashboard module calls these functions synchronously, so we
 * keep that exact API. When DATABASE_URL (Supabase/Postgres) is configured,
 * every mutation is ALSO mirrored to Postgres (async, batched), and on boot
 * the SQLite cache is rehydrated from Postgres — so balances, leaderboard,
 * moderators and the economy SURVIVE every redeploy/restart on Render.
 *
 * Tables (same schema in SQLite and Postgres): users, cooldowns, lottery,
 * heists, chat_logs, game_history, admin_users, bot_events, broadcasts,
 * activity_feed, audit_log.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { ensureDir } = require('./utils');

/* ================= SQLite (hot cache) ================= */

ensureDir(path.dirname(config.dbPath));

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('[db] better-sqlite3 failed to load:', e.message);
  console.error('[db] Run: npm install');
  process.exit(1);
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  wallet     INTEGER NOT NULL DEFAULT 0,
  bank       INTEGER NOT NULL DEFAULT 0,
  status     TEXT DEFAULT 'active',      -- active | muted | suspected | banned
  status_reason TEXT DEFAULT '',
  status_until INTEGER DEFAULT 0,         -- 0 = permanent
  hidden_until INTEGER DEFAULT 0,         -- hide-in-shadows expiry (ms epoch)
  rank        TEXT DEFAULT 'bronze',      -- rank ladder (see src/rank.js)
  rank_valid_matches INTEGER DEFAULT 0,   -- valid matches played (bet >= 10% balance)
  rank_consecutive_losses INTEGER DEFAULT 0, -- current losing streak (7 → demote)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0  -- version stamp: ONLY timestamp ordering decides which state wins
);

CREATE TABLE IF NOT EXISTS time_wallet (
  user_id    INTEGER PRIMARY KEY,
  amount     INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,  -- ms epoch; 0 = no expiry
  source     TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id  INTEGER NOT NULL,
  action   TEXT NOT NULL,
  until    INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);

CREATE TABLE IF NOT EXISTS lottery (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pot        INTEGER NOT NULL DEFAULT 0,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  tickets    TEXT NOT NULL DEFAULT '[]'   -- JSON array of {user_id, count}
);

CREATE TABLE IF NOT EXISTS heists (
  leader_id    INTEGER PRIMARY KEY,
  leader_name  TEXT DEFAULT '',
  target_id    INTEGER NOT NULL,
  target_name  TEXT DEFAULT '',
  members      TEXT NOT NULL DEFAULT '[]',   -- JSON [{user_id, name}]
  started_at   INTEGER NOT NULL,
  status       TEXT DEFAULT 'open'            -- open | running
);

-- ===================== DASHBOARD TABLES =====================
CREATE TABLE IF NOT EXISTS chat_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  chat_id    INTEGER NOT NULL,
  chat_title TEXT DEFAULT '',
  text       TEXT DEFAULT '',
  is_command INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  username    TEXT DEFAULT '',
  game        TEXT NOT NULL,        -- slots, dice, bj, mines, race, rob, ...
  bet         INTEGER DEFAULT 0,
  result      TEXT DEFAULT '',      -- win | lose | push | success | fail | ...
  amount      INTEGER DEFAULT 0,    -- net change (+/-)
  meta        TEXT DEFAULT '{}',    -- JSON extra (reels, multiplier, ...)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  user_id     INTEGER PRIMARY KEY,  -- Telegram user ID
  username    TEXT DEFAULT '',
  role        TEXT DEFAULT 'mod',   -- owner | mod
  password    TEXT DEFAULT '',      -- dashboard login password (owner + mods)
  created_at  INTEGER NOT NULL,
  last_login  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'mission',  -- mission | event | giveaway | trivia
  reward      INTEGER DEFAULT 0,       -- coin reward on completion
  starts_at   INTEGER DEFAULT 0,
  ends_at     INTEGER DEFAULT 0,       -- 0 = forever
  active      INTEGER DEFAULT 1,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  completions INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  target      TEXT DEFAULT 'all',    -- all | users | groups
  sent_count  INTEGER DEFAULT 0,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_feed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT DEFAULT 'event',  -- event | user | game | mod | broadcast
  text        TEXT NOT NULL,
  meta        TEXT DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,
  actor_name  TEXT DEFAULT '',
  action      TEXT NOT NULL,         -- give | deduct | ban | unban | ...
  target_id   INTEGER DEFAULT 0,
  detail      TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id  INTEGER NOT NULL,
  item_id  TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code       TEXT PRIMARY KEY,
  amount     INTEGER NOT NULL,
  max_uses   INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,           -- Telegram user ID of the creator
  creator_role TEXT DEFAULT 'owner',     -- owner | mod (mods are capped at 50M)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_redemptions (
  code       TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  data       TEXT NOT NULL,              -- full JSON snapshot (users + inventory)
  user_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// ---- Safe migration for EXISTING SQLite DBs (CREATE IF NOT EXISTS won't add the column) ----
// Every user-data write now stamps updated_at, so stale snapshots can NEVER
// overwrite newer data in either direction (SQLite <-> Postgres).
const USER_COLS = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!USER_COLS.includes('updated_at')) {
  db.exec('ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  // Backfill legacy rows with a sensible timestamp (their creation time).
  db.exec("UPDATE users SET updated_at = created_at WHERE updated_at = 0");
}
// Rank system columns (idempotent — CREATE IF NOT EXISTS won't add them to an
// existing users table, so migrate in place without touching any data).
if (!USER_COLS.includes('rank')) {
  db.exec("ALTER TABLE users ADD COLUMN rank TEXT DEFAULT 'bronze'");
}
if (!USER_COLS.includes('rank_valid_matches')) {
  db.exec('ALTER TABLE users ADD COLUMN rank_valid_matches INTEGER NOT NULL DEFAULT 0');
}
if (!USER_COLS.includes('rank_consecutive_losses')) {
  db.exec('ALTER TABLE users ADD COLUMN rank_consecutive_losses INTEGER NOT NULL DEFAULT 0');
}

/* ================= Postgres (durable store) ================= */

const DATABASE_URL = (config.databaseUrl || '').trim();
const pgEnabled = DATABASE_URL.length > 0;
let pool = null;

// Primary-writer advisory-lock state. PostgreSQL advisory locks are SESSION-scoped,
// so the owning client MUST remain checked out for the lifetime of the process.
let instanceLockClient = null;
let instanceLockKey = null;
let instanceLockHeld = false;
let instanceLockHeartbeat = null;

// Derived connection info for health/logging (password always redacted).
let pgHost = '';
let pgPort = 0;
try {
  if (pgEnabled) {
    const u = new URL(DATABASE_URL.replace(/^postgres:\/\//i, 'postgresql://'));
    pgHost = u.hostname || '';
    pgPort = Number(u.port) || 5432;
  }
} catch (e) {
  console.error('[db] Could not parse DATABASE_URL:', e.message);
}

if (pgEnabled) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      // Server-side timeout: PostgreSQL itself stops executing a statement
      // once this limit is reached.
      statement_timeout: 10000,
      // Supabase requires SSL for its Postgres (direct :5432 AND pooler :6543).
      // Use sslmode=require (present in pooler URLs) when available, otherwise
      // default to TLS with cert validation relaxed for supabase.co hosts.
      ssl:
        /\bsslmode=require\b/i.test(DATABASE_URL)
          ? { rejectUnauthorized: false }
          : /supabase\.co/i.test(DATABASE_URL)
            ? { rejectUnauthorized: false }
            : undefined,
    });
    pool.on('error', (err) => {
      console.error('[db] Postgres pool error:', err && err.message ? err.message : err);
      recordPgFailure(err || new Error('unknown pg pool error'), 'pool');
    });
  } catch (e) {
    console.error('[db] Invalid DATABASE_URL — falling back to SQLite-only:', e.message);
    pool = null;
    pgLastError = `bad DATABASE_URL: ${(e.message || String(e)).slice(0, 300)}`;
    pgLastErrorAt = Date.now();
    pgConnectivity = 'degraded';
  }
}

if (!pgEnabled) {
  console.warn(
    '[db] ⚠ DATABASE_URL not set — running SQLite-only (ephemeral). ' +
    'Balances will RESET on redeploy. Set DATABASE_URL (Supabase/Postgres) for durable persistence.'
  );
} else {
  console.log(`[db] Postgres mirror CONFIGURED (${pgHost}:${pgPort}) — waiting for connection…`);
}

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id       BIGINT PRIMARY KEY,
  username      TEXT DEFAULT '',
  first_name    TEXT DEFAULT '',
  wallet        BIGINT NOT NULL DEFAULT 0,
  bank          BIGINT NOT NULL DEFAULT 0,
  status        TEXT DEFAULT 'active',
  status_reason TEXT DEFAULT '',
  status_until  BIGINT DEFAULT 0,
  hidden_until  BIGINT DEFAULT 0,
  rank          TEXT DEFAULT 'bronze',
  rank_valid_matches BIGINT DEFAULT 0,
  rank_consecutive_losses BIGINT DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL DEFAULT 0  -- version stamp: ONLY timestamp ordering decides which state wins
);
CREATE TABLE IF NOT EXISTS time_wallet (
  user_id    BIGINT PRIMARY KEY,
  amount     BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL DEFAULT 0,
  source     TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id BIGINT NOT NULL,
  action  TEXT NOT NULL,
  until   BIGINT NOT NULL,
  PRIMARY KEY (user_id, action)
);
CREATE TABLE IF NOT EXISTS lottery (
  id           SMALLINT PRIMARY KEY CHECK (id = 1),
  pot          BIGINT NOT NULL DEFAULT 0,
  ticket_count BIGINT NOT NULL DEFAULT 0,
  tickets      TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS heists (
  leader_id   BIGINT PRIMARY KEY,
  leader_name TEXT DEFAULT '',
  target_id   BIGINT NOT NULL,
  target_name TEXT DEFAULT '',
  members     TEXT NOT NULL DEFAULT '[]',
  started_at  BIGINT NOT NULL,
  status      TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS chat_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  chat_id    BIGINT NOT NULL,
  chat_title TEXT DEFAULT '',
  text       TEXT DEFAULT '',
  is_command SMALLINT DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_history (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  username   TEXT DEFAULT '',
  game       TEXT NOT NULL,
  bet        BIGINT DEFAULT 0,
  result     TEXT DEFAULT '',
  amount     BIGINT DEFAULT 0,
  meta       TEXT DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_users (
  user_id    BIGINT PRIMARY KEY,
  username   TEXT DEFAULT '',
  role       TEXT DEFAULT 'mod',
  password   TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  last_login BIGINT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_events (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'mission',
  reward      BIGINT DEFAULT 0,
  starts_at   BIGINT DEFAULT 0,
  ends_at     BIGINT DEFAULT 0,
  active      SMALLINT DEFAULT 1,
  created_by  BIGINT DEFAULT 0,
  created_at  BIGINT NOT NULL,
  completions BIGINT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id         BIGSERIAL PRIMARY KEY,
  message    TEXT NOT NULL,
  target     TEXT DEFAULT 'all',
  sent_count BIGINT DEFAULT 0,
  created_by BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_feed (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT DEFAULT 'event',
  text       TEXT NOT NULL,
  meta       TEXT DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT NOT NULL,
  actor_name TEXT DEFAULT '',
  action     TEXT NOT NULL,
  target_id  BIGINT DEFAULT 0,
  detail     TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id    BIGINT NOT NULL,
  item_id    TEXT NOT NULL,
  quantity   BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  code         TEXT PRIMARY KEY,
  amount       BIGINT NOT NULL,
  max_uses     BIGINT NOT NULL,
  used_count   BIGINT NOT NULL DEFAULT 0,
  created_by   BIGINT NOT NULL,
  creator_role TEXT DEFAULT 'owner',
  created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS redeem_redemptions (
  code        TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  redeemed_at BIGINT NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE TABLE IF NOT EXISTS backups (
  id         BIGSERIAL PRIMARY KEY,
  filename   TEXT NOT NULL,
  data       TEXT NOT NULL,
  user_count BIGINT NOT NULL DEFAULT 0,
  created_by BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
`;

// Safe migration for EXISTING Postgres DBs (CREATE TABLE IF NOT EXISTS is
// a no-op when the table already exists, so the new column must be added
// explicitly). Failures are tolerated — a fresh deploy of the new code will
// stamp updated_at on every write anyway.
const PG_ALTERS = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0",
  "UPDATE users SET updated_at = created_at WHERE updated_at = 0",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT 'bronze'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_valid_matches BIGINT NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_consecutive_losses BIGINT NOT NULL DEFAULT 0",
];

/** Create Postgres tables (idempotent). Returns true on success. */
async function initPg() {
  if (!pool) return false;
  try {
    // Migrate existing tables first (add updated_at to users on old DBs),
    // then create any missing tables.
    for (const stmt of PG_ALTERS) {
      try {
        await pool.query(stmt);
      } catch (e) {
        console.error('[db] pg migration skipped:', stmt.split(' ').slice(0, 2).join(' '), '->', e.message);
      }
    }
    await pool.query(PG_SCHEMA);
    return true;
  } catch (e) {
    // Capture the EXACT reason (auth failed / timeout / blocked port / bad host)
    // so /health, /debug and boot logs show why the connection is failing.
    const code = e.code ? ` [${e.code}]` : '';
    const detail = (e.message || String(e)).slice(0, 300);
    pgLastError = `init failed${code}: ${detail}`;
    pgLastErrorAt = Date.now();
    pgConnectivity = 'degraded';
    pgFailures++;
    console.error('[db] Postgres schema init failed (continuing SQLite-only):', detail);
    return false;
  }
}

/**
 * Postgres write pipeline — STRICT write-through with verification.
 *
 * Every mutation to SQLite is ALSO written to Postgres, and the write is
 * READ BACK from Postgres before it is considered verified. Writes for the
 * same table are strictly ordered (a later write to user X can never land
 * before an earlier one and be overwritten by stale data), and every query
 * runs under a hard timeout so a hung pooler connection can NEVER wedge the
 * pipeline silently.
 *
 * The old design scheduled fire-and-forget mirrors on one serialized promise
 * chain with NO timeout: a single dropped session-pooler connection left one
 * hung query blocking the whole queue forever, while /health kept showing
 * "✅ connected (mirrors: running)" because lastMirrorAt was stamped at
 * SCHEDULE time, not completion. Balances then reverted to stale values on
 * every rehydrate. This rewrite removes that entire failure class.
 */
let pgReady = false;
let pgInitPromise = null;
let pgFailures = 0;
let pgLastError = '';
let pgLastErrorAt = 0;
let pgConnectivity = 'unknown'; // unknown | connecting | connected | degraded
let pgLastWriteAt = 0;          // when the last pg write SUCCEEDED (ms)
let pgLastVerifyAt = 0;         // when the last read-back verification passed (ms)
let pgWritesOk = 0;             // total verified writes
let pgWritesFailed = 0;         // total failed writes
let lastMirrorAt = 0;           // when the periodic full-sync last RAN (completed)
let persistenceDegraded = false;
let fullMirrorInFlight = false;
const PG_CRITICAL_FAILURES = 3;
const PG_QUERY_TIMEOUT_MS = 10000; // hard per-query timeout — a hung pooler never wedges the pipeline

/* ================= Dirty-tracking (bandwidth fix) =================
 * The 30s full `mirrorAll()` re-sent every row of every table even when the
 * bot was idle — the dominant egress cost. We now track WHICH tables/rows
 * actually changed and mirror only those. The v4 durability architecture
 * (advisory lock, hydration, fail-closed fencing, version ordering) is
 * untouched: this only changes the *sync payload shape + cadence*.
 */
const SYNC_SKIP_TABLES = new Set(['backups']); // backups already write once via saveBackupPg()
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;  // safety-net full reconciliation cadence
const dirtyTables = new Set();                  // tables with unsynced local changes
const dirtyRowKeys = new Map();                 // table -> Set of single-PK key strings
let rowsMirrored = 0;                           // cumulative rows upserted to Postgres
let bytesMirrored = 0;                          // cumulative estimated payload bytes
let mirrorAllRuns = 0;                          // dirty-sync runs (periodic)
let reconcileRuns = 0;                          // full reconciliation runs
let lastFullReconcileAt = 0;                    // when the last full reconciliation completed
let lastMirrorRows = 0;
let lastMirrorBytes = 0;
let lastMirrorTables = 0;

/** Mark a table (and optionally one row, for single-PK tables) as changed. */
function markDirty(table, pkValue = null) {
  dirtyTables.add(table);
  if (pkValue != null && TABLE_PKS[table] && TABLE_PKS[table].length === 1) {
    if (!dirtyRowKeys.has(table)) dirtyRowKeys.set(table, new Set());
    dirtyRowKeys.get(table).add(String(pkValue));
  }
}

/** Atomically take + clear the dirty markers for one table. */
function captureDirty(table) {
  const keys = dirtyRowKeys.get(table) || null;
  dirtyRowKeys.delete(table);
  dirtyTables.delete(table);
  return keys;
}

/** Select rows for a single-PK table by primary-key values (inside the queue). */
function selectRowsBySinglePk(table, pkValues) {
  const cols = TABLE_COLS[table].split(', ');
  const pkCol = TABLE_PKS[table][0];
  const placeholders = pkValues.map(() => '?').join(', ');
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${pkCol} IN (${placeholders})`).all(...pkValues);
}

/**
 * Immediately mirror ONE changed row (single-PK tables) with a batched upsert.
 * This is the O(1)-per-write replacement for `mirrorTable('users')`: it marks
 * the row dirty, pushes only that row, and clears the marker on success. If the
 * push fails (degraded mode), the marker REMAINS so the periodic loop or the
 * reconnect reconcile retries it — durability is preserved, egress is collapsed.
 */
function mirrorChangedRow(table, pkValue) {
  if (!TABLE_PKS[table] || TABLE_PKS[table].length !== 1) {
    // No single PK → can't target one row; fall back to a dirty whole-table mirror.
    markDirty(table);
    return mirrorTable(table);
  }
  const key = String(pkValue);
  markDirty(table, pkValue);
  return queuePgWrite(table, async () => {
    if (!pool || !pgReady || !syncEnabled || persistenceDegraded) return 0;
    if (pgEnabled && !instanceLockHeld) return 0;
    const rows = selectRowsBySinglePk(table, [key]);
    if (!rows.length) return 0;
    const client = await pool.connect();
    try {
      const written = await upsertRowsBatched(client, table, rows);
      // Clear this row's dirty marker only after a successful push.
      const dk = dirtyRowKeys.get(table);
      if (dk) {
        dk.delete(key);
        if (dk.size === 0) {
          dirtyRowKeys.delete(table);
          dirtyTables.delete(table);
        }
      }
      rowsMirrored += written;
      bytesMirrored += rows.reduce((n, r) => n + JSON.stringify(r).length + 8, 0);
      return written;
    } finally {
      client.release();
    }
  });
}

// Per-table write chain so writes to the same table stay strictly ordered.
const pgChains = {};
function tableChain(table) {
  if (!pgChains[table]) pgChains[table] = Promise.resolve();
  return pgChains[table];
}

/** Human-readable elapsed time helper for health output. */
function agoLabel(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  if (ms < 1000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s ago`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m ago`;
}

/**
 * Run one query on Postgres under a hard timeout. Rejects on timeout/error;
 * the caller decides what to surface. Uses the pool directly so the query is
 * independent of any chain state.
 */
async function pgQueryWithTimeout(sql, params = [], client = null) {
  const runner = client || pool;
  if (!runner) throw new Error('Postgres client/pool unavailable');
  let timer;
  try {
    return await Promise.race([
      runner.query(sql, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`pg query timeout after ${PG_QUERY_TIMEOUT_MS}ms`)), PG_QUERY_TIMEOUT_MS);
        timer.unref && timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for the Postgres pool to be READY (pgReady true) and the schema/hydration
 * to complete. Used by the advisory-lock path so it can never fire before
 * initPersistence() has flipped pgReady. Returns true when PG is ready.
 */
async function ensurePgReady() {
  if (!pgEnabled || !pool) return false;
  if (pgReady) return true;
  if (pgInitPromise) {
    try { await pgInitPromise; } catch (e) { /* init failures leave pgReady false */ }
  }
  return pgReady === true;
}

/**
 * Record a pg failure (shared by all write paths). Sets connectivity to
 * 'degraded' and surfaces the EXACT reason in /debug + /health.
 */
function recordPgFailure(err, label) {
  pgFailures++;
  const code = err && err.code ? ` [${err.code}]` : '';
  pgLastError = `${label || 'pg'}: ${String((err && err.message) || err).slice(0, 300)}${code}`;
  pgLastErrorAt = Date.now();
  pgConnectivity = 'degraded';
  persistenceDegraded = true;

  // IMPORTANT: do NOT terminate the Render process on transient Postgres
  // connection failures. A hard process exit creates a restart/502 loop and
  // makes diagnosis harder. Instead, fence the write pipeline, keep /health
  // alive, and recover the durable connection in the background.
  syncEnabled = false;
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

  if (pgFailures >= PG_CRITICAL_FAILURES) {
    console.error(
      `[db] ❌ Postgres write failures reached ${pgFailures} (last: ${pgLastError}). ` +
      'Persistence is degraded; economic writes are fenced and background recovery is active.'
    );
  } else {
    console.error('[db] pg write error:', pgLastError);
  }

  // Mark the pool as not ready so queued writes stop immediately and the
  // existing reconnect path can re-establish the connection and rehydrate.
  pgReady = false;
  schedulePgRetry();
}


/**
 * Execute a pg write on the table's ordered chain. The query runs under the
 * hard timeout; on success lastWriteAt/lastVerifyAt are stamped, on failure
 * the error is recorded (never swallowed) and the chain continues so the
 * NEXT write for that table can still go through.
 */
function queuePgWrite(table, task) {
  if (!pool || !pgReady || !syncEnabled || persistenceDegraded) return Promise.resolve(false);
  if (pgEnabled && !instanceLockHeld) return Promise.resolve(false);
  const chain = tableChain(table);
  const run = chain.then(async () => {
    try {
      const result = await task();
      pgWritesOk++;
      pgLastWriteAt = Date.now();
      // A single successful queued write does not immediately clear a degraded
      // state. Recovery is finalized only after the reconnect path completes a
      // fresh init + hydration + lock check. This prevents a late success from
      // re-enabling writes while the connection is still unstable.
      return result;
    } catch (err) {
      pgWritesFailed++;
      recordPgFailure(err, `write ${table}`);
      return null;
    }
  });
  // Keep the chain alive even when a task rejects (already caught above, but
  // belt-and-braces so a buggy task can never wedge the table's pipeline).
  pgChains[table] = run.catch(() => {});
  return run;
}

/**
 * Run one raw SQL on Postgres (write-through, ordered per table).
 * Returns a Promise<boolean> — true when the write SUCCEEDED (and was
 * verified by the caller when requested). Never throws; failures are
 * surfaced via recordPgFailure() and /health + /debug.
 */
function pgRun(table, sql, params = []) {
  if (!pool || !pgReady) return Promise.resolve(false);
  return queuePgWrite(table, () => pgQueryWithTimeout(sql, params));
}

/* ================= Table mirror helpers ================= */

const TABLE_COLS = {
  users: 'user_id, username, first_name, wallet, bank, status, status_reason, status_until, hidden_until, rank, rank_valid_matches, rank_consecutive_losses, created_at, updated_at',
  time_wallet: 'user_id, amount, expires_at, source, created_at, updated_at',
  cooldowns: 'user_id, action, until',
  lottery: 'id, pot, ticket_count, tickets',
  heists: 'leader_id, leader_name, target_id, target_name, members, started_at, status',
  admin_users: 'user_id, username, role, password, created_at, last_login',
  bot_events: 'id, title, description, type, reward, starts_at, ends_at, active, created_by, created_at, completions',
  broadcasts: 'id, message, target, sent_count, created_by, created_at',
  activity_feed: 'id, type, text, meta, created_at',
  audit_log: 'id, actor_id, actor_name, action, target_id, detail, created_at',
  chat_logs: 'id, user_id, username, first_name, chat_id, chat_title, text, is_command, created_at',
  game_history: 'id, user_id, username, game, bet, result, amount, meta, created_at',
  inventory: 'user_id, item_id, quantity, updated_at',
  redeem_codes: 'code, amount, max_uses, used_count, created_by, creator_role, created_at',
  redeem_redemptions: 'code, user_id, redeemed_at',
  backups: 'id, filename, data, user_count, created_by, created_at',
  settings: 'key, value, updated_at',
};

function sqliteRows(table) {
  try {
    return db.prepare(`SELECT ${TABLE_COLS[table]} FROM ${table}`).all();
  } catch (e) {
    return [];
  }
}

/** Replace Postgres table contents with the SQLite cache (upsert-all). */
const TABLE_PKS = {
  users: ['user_id'],
  time_wallet: ['user_id'],
  cooldowns: ['user_id', 'action'], // composite primary key
  lottery: ['id'],
  heists: ['leader_id'],
  admin_users: ['user_id'],
  bot_events: ['id'],
  broadcasts: ['id'],
  activity_feed: ['id'],
  audit_log: ['id'],
  chat_logs: ['id'],
  game_history: ['id'],
  inventory: ['user_id', 'item_id'], // composite primary key
  redeem_codes: ['code'],
  redeem_redemptions: ['code', 'user_id'], // composite primary key
  backups: ['id'],
  settings: ['key'],
};

/**
 * Batch-upsert a set of rows into Postgres as ONE multi-row statement, then
 * READ BACK the first row to VERIFY the write landed. Runs inside the caller's
 * serialized queue task (a dedicated client + transaction). Returns rows written.
 * This is the bandwidth fix: one round-trip for N rows instead of N round-trips.
 */
async function upsertRowsBatched(client, table, rows) {
  if (!rows.length) return 0;
  const cols = TABLE_COLS[table].split(', ');
  const pkCols = TABLE_PKS[table] || [cols[0]];
  const updateCols = cols.filter((c) => !pkCols.includes(c));
  if (!updateCols.length) return 0;

  const versioned = VERSIONED_TABLES.has(table) && cols.includes('updated_at');
  const whereClause = versioned
    ? ` WHERE ${table}.updated_at < EXCLUDED.updated_at`
    : '';

  const colList = cols.join(', ');
  const colCount = cols.length;
  const valueGroups = [];
  const params = [];
  for (const row of rows) {
    const placeholders = cols.map((_, i) => `$${params.length + i + 1}`).join(', ');
    valueGroups.push(`(${placeholders})`);
    for (const c of cols) params.push(row[c]);
  }

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL statement_timeout = ${PG_QUERY_TIMEOUT_MS}`);
    await client.query(
      `INSERT INTO ${table} (${colList}) VALUES ${valueGroups.join(', ')}
       ON CONFLICT (${pkCols.join(', ')}) DO UPDATE SET ${updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}${whereClause}`,
      params
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }

  // Read-back verification on the SAME connection after commit.
  const first = rows[0];
  const where = pkCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
  const vals = pkCols.map((c) => first[c]);
  const rb = await client.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, vals);
  const found = Number((rb.rows && rb.rows[0] && rb.rows[0].c) || 0);
  if (found > 0) {
    pgLastVerifyAt = Date.now();
  } else {
    throw new Error(`read-back found 0 rows for ${table} pk=${JSON.stringify(vals)} — write did not land`);
  }

  return rows.length;
}

/**
 * Upsert the SQLite cache of one table into Postgres (batched), then VERIFY.
 * `rowKeys` (optional) limits the mirror to specific single-PK rows that
 * actually changed — the whole-table re-send is only used by the low-frequency
 * reconciliation pass. Returns the number of rows written.
 */
function mirrorTable(table, rowKeys = null) {
  if (!pool || !pgReady || !syncEnabled || (pgEnabled && !instanceLockHeld)) return 0;

  // IMPORTANT: capture the SQLite snapshot INSIDE the serialized task, not when
  // mirrorTable() is called. This prevents a stale snapshot from waiting in the
  // queue for seconds and then being written after newer local state exists.
  return queuePgWrite(table, async () => {
    if (pgEnabled && !instanceLockHeld) return 0;
    // Single-PK dirty-row mirror: select only the changed rows (still inside the task).
    let rows;
    if (rowKeys && rowKeys.size && TABLE_PKS[table] && TABLE_PKS[table].length === 1) {
      rows = selectRowsBySinglePk(table, Array.from(rowKeys));
    } else {
      rows = sqliteRows(table);
    }
    if (!rows.length) return 0;

    const client = await pool.connect();
    try {
      const written = await upsertRowsBatched(client, table, rows);
      // Lightweight telemetry so we can prove the payload drop in production.
      rowsMirrored += written;
      const approxBytes = rows.reduce((n, r) => n + JSON.stringify(r).length + 8, 0);
      bytesMirrored += approxBytes;
      return written;
    } finally {
      client.release();
    }
  });
}

/**
 * Mirror dirty tables (and, for single-PK tables, only their changed rows).
 * Once every RECONCILE_INTERVAL_MS (and always on boot/reconnect), fall back
 * to a FULL reconciliation that pushes every table as a safety net — so a
 * missed dirty flag can never cause permanent divergence. `force` is set by
 * boot / reconnect paths.
 */
async function mirrorAll(force = false) {
  if (!pool || !pgReady || !syncEnabled || persistenceDegraded || fullMirrorInFlight) return;
  fullMirrorInFlight = true;
  try {
    const now = Date.now();
    const doReconcile = force || (now - lastFullReconcileAt >= RECONCILE_INTERVAL_MS);

    const tasks = [];
    for (const table of Object.keys(TABLE_COLS)) {
      if (!pgReady || !syncEnabled || persistenceDegraded) break;
      if (SYNC_SKIP_TABLES.has(table)) continue; // backups written once by saveBackupPg()
      if (!doReconcile && !dirtyTables.has(table)) continue; // skip clean tables
      let rowKeys = null;
      if (doReconcile) {
        // Full reconciliation mirrors the ENTIRE table, not just dirty rows,
        // and clears any markers (the pass below covers everything).
        dirtyRowKeys.delete(table);
        dirtyTables.delete(table);
      } else {
        rowKeys = captureDirty(table);
      }
      const task = mirrorTable(table, rowKeys);
      if (task && typeof task.then === 'function') tasks.push(task);
    }
    await Promise.allSettled(tasks);

    if (doReconcile) {
      lastFullReconcileAt = now;
      reconcileRuns++;
      // Any rows that changed DURING the reconcile pass above stay marked for
      // the next cycle — they are intentionally NOT cleared by captureDirty's
      // per-table grab for tables that weren't in this pass, but to be safe we
      // leave any new markers intact (markDirty re-adds as writes land).
    } else {
      mirrorAllRuns++;
    }
  } finally {
    fullMirrorInFlight = false;
  }
}

/* ================= User row helpers ================= */

function mapUser(row) {
  if (!row) return row;
  return {
    user_id: Number(row.user_id),
    username: row.username || '',
    first_name: row.first_name || '',
    wallet: Number(row.wallet) || 0,
    bank: Number(row.bank) || 0,
    status: row.status || 'active',
    status_reason: row.status_reason || '',
    status_until: Number(row.status_until) || 0,
    hidden_until: Number(row.hidden_until) || 0,
    rank: row.rank || 'bronze',
    rank_valid_matches: Number(row.rank_valid_matches) || 0,
    rank_consecutive_losses: Number(row.rank_consecutive_losses) || 0,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/* ---------------- Versioned writes (rollback fix) ---------------- */

/**
 * Tables that carry an `updated_at` version column and therefore use
 * TIMESTAMP-ORDERED merging in BOTH directions (SQLite <-> Postgres).
 * ONLY timestamp ordering decides which state wins — never value comparison
 * (legitimate purchases/bets/losses can decrease balances).
 *  - users:      the rollback target (balances/bank/status/hidden).
 *  - inventory:  item quantities are user state — same rollback risk.
 *  - settings:   bot_paused & friends — must never regress either.
 */
const VERSIONED_TABLES = new Set(['users', 'inventory', 'settings']);

// Monotonic version clock: every call returns a timestamp STRICTLY greater
// than every previous call, so a rapid sequence of writes can never share the
// same updated_at and make the versioned merge ambiguous. (Date.now() can
// return the same millisecond for two writes in the same tick.)
let lastStamp = 0;
function nowStamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/** Stamp `updated_at` on a user row — always NEWER than any previous write. */
function touchUser(userId, stamp = nowStamp()) {
  db.prepare('UPDATE users SET updated_at = ? WHERE user_id = ?').run(stamp, userId);
  return stamp;
}

/**
 * Diagnostic logging for every persistent user-data write:
 * timestamp, user id, operation, previous value, new value, source function.
 * (Added during the rollback investigation — observability, never a write blocker.)
 */
function logDbWrite(userId, op, prevVal, newVal, src) {
  try {
    console.log(`[db-write] t=${Date.now()} user=${userId} op=${op} prev=${prevVal} new=${newVal} src=${src}`);
  } catch (e) { /* logging must never break a write */ }
}

/* ---------------- Users ---------------- */

function getOrCreateUser(userId, meta = {}) {
  let row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (row) {
    // Versioning-hardening fix: only stamp updated_at when a profile field
    // ACTUALLY changes. The old code stamped on every call, so a trivial
    // touch (e.g. any /balance with meta) could fabricate a "newest" timestamp
    // that would then beat a REAL wallet write from another instance during a
    // versioned merge. No real change -> no version bump.
    const newUsername = meta.username || row.username;
    const newFirstName = meta.first_name || row.first_name;
    if (newUsername !== row.username || newFirstName !== row.first_name) {
      const stamp = nowStamp();
      db.prepare('UPDATE users SET username = ?, first_name = ?, updated_at = ? WHERE user_id = ?')
        .run(newUsername, newFirstName, stamp, userId);
      const updated = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      logDbWrite(userId, 'updateProfile', '', 'meta', 'getOrCreateUser');
      mirrorChangedRow('users', userId);
      return mapUser(updated);
    }
    return mapUser(row);
  }
  const now = nowStamp();
  db.prepare('INSERT INTO users (user_id, username, first_name, wallet, bank, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, meta.username || '', meta.first_name || '', config.startBalance, 0, 'active', now, now);
  logDbWrite(userId, 'createUser', 0, config.startBalance, 'getOrCreateUser');
  mirrorChangedRow('users', userId);
  return mapUser(db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId));
}

function getUser(userId) {
  return mapUser(db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId));
}

function getNetWorth(userId) {
  const u = getUser(userId);
  if (!u) return 0;
  return u.wallet + u.bank;
}

function setWallet(userId, amount, src = 'setWallet') {
  const prev = getUser(userId);
  db.prepare('UPDATE users SET wallet = ?, updated_at = ? WHERE user_id = ?').run(amount, nowStamp(), userId);
  logDbWrite(userId, 'setWallet', prev ? prev.wallet : 0, amount, src);
  mirrorChangedRow('users', userId);
}

function setBank(userId, amount, src = 'setBank') {
  const prev = getUser(userId);
  db.prepare('UPDATE users SET bank = ?, updated_at = ? WHERE user_id = ?').run(amount, nowStamp(), userId);
  logDbWrite(userId, 'setBank', prev ? prev.bank : 0, amount, src);
  mirrorChangedRow('users', userId);
}

/** Set the ENTIRE networth in one atomic write: wallet = amount, bank = 0.
 *  /sb N means "make this user's total coins exactly N" — so the bank is
 *  reset to 0 (not left untouched) and the wallet becomes N. */
function setNetworth(userId, amount, src = 'setNetworth') {
  const prev = getUser(userId);
  db.prepare('UPDATE users SET wallet = ?, bank = 0, updated_at = ? WHERE user_id = ?')
    .run(amount, nowStamp(), userId);
  logDbWrite(userId, 'setNetworth', prev ? prev.wallet + prev.bank : 0, amount, src);
  mirrorChangedRow('users', userId);
}

/** Atomically add to wallet (positive or negative). Returns new wallet. */
function addWallet(userId, delta, src = 'addWallet') {
  const prev = getUser(userId);
  db.prepare('UPDATE users SET wallet = wallet + ?, updated_at = ? WHERE user_id = ?').run(delta, nowStamp(), userId);
  const after = getUser(userId).wallet;
  logDbWrite(userId, 'addWallet', prev ? prev.wallet : 0, after, src);
  mirrorChangedRow('users', userId);
  return after;
}

/** Atomically add to bank. Returns new bank. */
function addBank(userId, delta, src = 'addBank') {
  const prev = getUser(userId);
  db.prepare('UPDATE users SET bank = bank + ?, updated_at = ? WHERE user_id = ?').run(delta, nowStamp(), userId);
  const after = getUser(userId).bank;
  logDbWrite(userId, 'addBank', prev ? prev.bank : 0, after, src);
  mirrorChangedRow('users', userId);
  return after;
}

function setStatus(userId, status, reason, until = 0) {
  db.prepare('UPDATE users SET status = ?, status_reason = ?, status_until = ?, updated_at = ? WHERE user_id = ?')
    .run(status, reason || '', until, nowStamp(), userId);
  logDbWrite(userId, 'setStatus', '', status, 'setStatus');
  mirrorChangedRow('users', userId);
}

/** /hide — vanish from rob/heist targeting until `untilTs` (ms epoch). */
function setHidden(userId, untilTs) {
  const stamp = nowStamp();
  db.prepare('UPDATE users SET hidden_until = ?, updated_at = ? WHERE user_id = ?').run(untilTs || 0, stamp, userId);
  logDbWrite(userId, 'setHidden', '', untilTs || 0, 'setHidden');
  // Versioning-hardening fix: the PG write must ALSO be versioned — only land
  // when the local stamp is NOT older than what Postgres already has. The old
  // code wrote PG with no WHERE clause, so a stale setHidden could clobber a
  // newer row written by another instance in between.
  pgRun(
    'users',
    'UPDATE users SET hidden_until = $1, updated_at = $2 WHERE user_id = $3 AND updated_at < $2',
    [untilTs || 0, stamp, userId]
  );
}

/** True while the user's hide is still active. */
function isHidden(userId) {
  const u = getUser(userId);
  if (!u) return false;
  return u.hidden_until > Date.now();
}

/** All users (full rows) — used by the /backup command. */
function getAllUsers() {
  return db.prepare('SELECT * FROM users').all().map(mapUser);
}

function clearStatus(userId) {
  db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0, updated_at = ? WHERE user_id = ?").run(nowStamp(), userId);
  logDbWrite(userId, 'clearStatus', '', 'active', 'clearStatus');
  mirrorChangedRow('users', userId);
}

/** Top 10 by net worth (wallet + bank). */
function leaderboard(limit = 10) {
  return db.prepare(`
    SELECT user_id, username, first_name, wallet, bank, (wallet + bank) AS networth
    FROM users
    ORDER BY networth DESC
    LIMIT ?
  `).all(limit).map((r) => ({ ...r, user_id: Number(r.user_id), wallet: Number(r.wallet), bank: Number(r.bank), networth: Number(r.networth) }));
}

/* ---------------- Rank tracking / time-wallet ---------------- */

/** Persist rank progress (dirty-row mirrored through the normal pipeline). */
function setRankStats(userId, rank, validMatches, consecutiveLosses) {
  db.prepare(
    'UPDATE users SET rank = ?, rank_valid_matches = ?, rank_consecutive_losses = ?, updated_at = ? WHERE user_id = ?'
  ).run(rank, validMatches, consecutiveLosses, nowStamp(), userId);
  mirrorChangedRow('users', userId);
}

/** Add coins to the time-wallet (safe, unrobbable, expires). */
function addTimeWallet(userId, amount, expiresAt = 0, source = '') {
  const now = nowStamp();
  db.prepare(`INSERT INTO time_wallet (user_id, amount, expires_at, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               amount = time_wallet.amount + excluded.amount,
               expires_at = MAX(time_wallet.expires_at, excluded.expires_at),
               updated_at = excluded.updated_at`)
    .run(userId, Math.floor(amount) || 0, Math.floor(expiresAt) || 0, String(source || ''), now, now);
  markDirty('time_wallet', userId);
  mirrorChangedRow('time_wallet', userId);
  return getTimeWalletBalance(userId);
}

/** Current time-wallet balance (expired rows count as 0). */
function getTimeWalletBalance(userId, now = Date.now()) {
  const row = db.prepare('SELECT amount, expires_at FROM time_wallet WHERE user_id = ?').get(userId);
  if (!row) return 0;
  const exp = Number(row.expires_at) || 0;
  if (exp > 0 && exp <= now) return 0;
  return Number(row.amount) || 0;
}

/** Full time-wallet row (for display). */
function getTimeWalletRow(userId, now = Date.now()) {
  const row = db.prepare('SELECT * FROM time_wallet WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    user_id: Number(row.user_id),
    amount: getTimeWalletBalance(userId, now),
    expires_at: Number(row.expires_at) || 0,
    source: row.source || '',
  };
}

/**
 * Spend from the time-wallet FIRST (oldest expiry first). Returns
 * { spent, remaining } — the caller then charges the regular wallet for
 * the rest. Drains only what hasn't expired yet.
 */
function spendTimeWallet(userId, amount, now = Date.now()) {
  const row = db.prepare('SELECT amount, expires_at FROM time_wallet WHERE user_id = ?').get(userId);
  if (!row) return { spent: 0, remaining: Math.max(0, Number(amount) || 0) };
  const exp = Number(row.expires_at) || 0;
  const bal = exp > 0 && exp <= now ? 0 : Number(row.amount) || 0;
  const spend = Math.min(bal, Math.max(0, Number(amount) || 0));
  if (spend > 0) {
    const left = bal - spend;
    if (left > 0) {
      db.prepare('UPDATE time_wallet SET amount = ?, updated_at = ? WHERE user_id = ?').run(left, nowStamp(), userId);
      mirrorChangedRow('time_wallet', userId);
    } else {
      db.prepare('DELETE FROM time_wallet WHERE user_id = ?').run(userId);
      mirrorRowDelete('time_wallet', userId);
    }
    markDirty('time_wallet', userId);
  }
  return { spent: spend, remaining: Math.max(0, (Number(amount) || 0) - spend) };
}

/** Mirror a single-row DELETE to Postgres (time-wallet cleanup). */
function mirrorRowDelete(table, pkValue) {
  if (!TABLE_PKS[table] || TABLE_PKS[table].length !== 1) return Promise.resolve(false);
  const pkCol = TABLE_PKS[table][0];
  return pgRun(table, `DELETE FROM ${table} WHERE ${pkCol} = $1`, [pkValue]);
}

/** Remove expired time-wallet rows. Returns count removed. */
function sweepExpiredTimeWallet(now = Date.now()) {
  const rows = db.prepare('SELECT user_id FROM time_wallet WHERE expires_at > 0 AND expires_at <= ?').all(now);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.user_id);
  db.prepare(`DELETE FROM time_wallet WHERE expires_at > 0 AND expires_at <= ?`).run(now);
  for (const id of ids) {
    markDirty('time_wallet', id);
    mirrorRowDelete('time_wallet', id);
  }
  return ids.length;
}

/* ---------------- Cooldowns ---------------- */

function getCooldown(userId, action) {
  const row = db.prepare('SELECT until FROM cooldowns WHERE user_id = ? AND action = ?').get(userId, action);
  return row ? row.until : 0;
}

function setCooldown(userId, action, until) {
  db.prepare(`
    INSERT INTO cooldowns (user_id, action, until) VALUES (?, ?, ?)
    ON CONFLICT(user_id, action) DO UPDATE SET until = excluded.until
  `).run(userId, action, until);
  pgRun(
    'cooldowns',
    `INSERT INTO cooldowns (user_id, action, until) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, action) DO UPDATE SET until = EXCLUDED.until`,
    [userId, action, until]
  );
}

function clearCooldown(userId, action) {
  db.prepare('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
  pgRun('cooldowns', 'DELETE FROM cooldowns WHERE user_id = $1 AND action = $2', [userId, action]);
}

/** Delete ALL cooldowns (used by /restart). */
function clearAllCooldowns() {
  db.prepare('DELETE FROM cooldowns').run();
  pgRun('cooldowns', 'DELETE FROM cooldowns');
}

/* ---------------- Raw-ish query helpers (formerly db.db.prepare call sites) ---------------- */

function mapHeistRow(row) {
  if (!row) return row;
  return {
    leader_id: Number(row.leader_id),
    leader_name: row.leader_name || '',
    target_id: Number(row.target_id),
    target_name: row.target_name || '',
    members: typeof row.members === 'string' ? JSON.parse(row.members || '[]') : row.members,
    started_at: Number(row.started_at) || 0,
    status: row.status || 'open',
  };
}

/** All open heists (any user's). */
function getOpenHeists() {
  return db.prepare("SELECT * FROM heists WHERE status = 'open'").all().map(mapHeistRow);
}

/** All distinct chat_ids the bot has seen (for broadcasts). */
function getSeenChatIds() {
  return db.prepare('SELECT DISTINCT chat_id FROM chat_logs WHERE chat_id IS NOT NULL').all()
    .map((r) => Number(r.chat_id));
}

/** Look up a user by exact lowercased username. */
function findUserByUsername(username) {
  const row = db.prepare('SELECT user_id FROM users WHERE LOWER(username) = ? LIMIT 1').get(String(username || '').toLowerCase());
  return row ? { user_id: Number(row.user_id) } : null;
}

/** Count of active cooldown rows. */
function getCooldownCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM cooldowns').get().c;
}

/** Dashboard users list (ordered by net worth, paginated). */
function listUsersByNetWorth(limit = 50, offset = 0) {
  return db.prepare('SELECT * FROM users ORDER BY (wallet + bank) DESC LIMIT ? OFFSET ?').all(limit, offset)
    .map((r) => ({ ...r, user_id: Number(r.user_id), wallet: Number(r.wallet), bank: Number(r.bank) }));
}

/**
 * Read-only targeting helper for the attack/security system. Returns users
 * with net worth >= minNetWorth as { user_id, username, first_name, wallet,
 * bank, networth }. Sorted ascending so weighted selection is stable & testable.
 * Deliberately READ-ONLY \u2014 it never mutates state or touches the mirror layer.
 */
function getAttackEligibleUsers(minNetWorth = 250000000000) {
  return db.prepare(`
    SELECT user_id, username, first_name, wallet, bank, (wallet + bank) AS networth
    FROM users
    WHERE (wallet + bank) >= ?
    ORDER BY networth ASC
  `).all(minNetWorth).map((r) => ({
    user_id: Number(r.user_id),
    username: r.username || '',
    first_name: r.first_name || '',
    wallet: Number(r.wallet) || 0,
    bank: Number(r.bank) || 0,
    networth: Number(r.networth) || 0,
  }));
}

/** Dashboard users search (id/username/first_name, ordered by net worth). */
function searchUsers(q, limit = 50, offset = 0) {
  const like = `%${q}%`;
  return db.prepare(`
    SELECT * FROM users
    WHERE CAST(user_id AS TEXT) LIKE ? OR LOWER(username) LIKE ? OR LOWER(first_name) LIKE ?
    ORDER BY (wallet + bank) DESC LIMIT ? OFFSET ?
  `).all(like, like, like, limit, offset)
    .map((r) => ({ ...r, user_id: Number(r.user_id), wallet: Number(r.wallet), bank: Number(r.bank) }));
}

/** A user's cooldown rows. */
function getUserCooldowns(userId) {
  return db.prepare('SELECT action, until FROM cooldowns WHERE user_id = ?').all(userId)
    .map((r) => ({ ...r, until: Number(r.until) }));
}

/* ---------------- Lottery ---------------- */

function getLottery() {
  let row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO lottery (id, pot, ticket_count, tickets) VALUES (1, ?, 0, ?)')
      .run(config.lottery.baseJackpot, '[]');
    row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  }
  row.tickets = JSON.parse(row.tickets || '[]');
  row.pot = Number(row.pot) || 0;
  row.ticket_count = Number(row.ticket_count) || 0;
  return row;
}

function saveLottery(pot, ticketCount, tickets) {
  db.prepare('UPDATE lottery SET pot = ?, ticket_count = ?, tickets = ? WHERE id = 1')
    .run(pot, ticketCount, JSON.stringify(tickets));
  pgRun(
    'lottery',
    `INSERT INTO lottery (id, pot, ticket_count, tickets) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET pot = EXCLUDED.pot, ticket_count = EXCLUDED.ticket_count, tickets = EXCLUDED.tickets`,
    [pot, ticketCount, JSON.stringify(tickets)]
  );
}

/* ---------------- Heists ---------------- */

function getHeist(leaderId) {
  const row = db.prepare('SELECT * FROM heists WHERE leader_id = ?').get(leaderId);
  if (!row) return null;
  row.members = JSON.parse(row.members || '[]');
  return row;
}

function createHeist(heist) {
  db.prepare('INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(heist.leader_id, heist.leader_name, heist.target_id, heist.target_name, JSON.stringify(heist.members), heist.started_at, heist.status);
  pgRun(
    'heists',
    `INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (leader_id) DO UPDATE SET leader_name = EXCLUDED.leader_name, target_id = EXCLUDED.target_id,
       target_name = EXCLUDED.target_name, members = EXCLUDED.members, started_at = EXCLUDED.started_at, status = EXCLUDED.status`,
    [heist.leader_id, heist.leader_name, heist.target_id, heist.target_name, JSON.stringify(heist.members), heist.started_at, heist.status]
  );
}

function updateHeistMembers(leaderId, members) {
  db.prepare('UPDATE heists SET members = ? WHERE leader_id = ?').run(JSON.stringify(members), leaderId);
  pgRun('heists', 'UPDATE heists SET members = $1 WHERE leader_id = $2', [JSON.stringify(members), leaderId]);
}

function updateHeistStatus(leaderId, status) {
  db.prepare('UPDATE heists SET status = ? WHERE leader_id = ?').run(status, leaderId);
  pgRun('heists', 'UPDATE heists SET status = $1 WHERE leader_id = $2', [status, leaderId]);
}

function deleteHeist(leaderId) {
  db.prepare('DELETE FROM heists WHERE leader_id = ?').run(leaderId);
  pgRun('heists', 'DELETE FROM heists WHERE leader_id = $1', [leaderId]);
}

/* ---------------- Dashboard: chat logs ---------------- */

// OOM fix: cap the unbounded log tables so they cannot grow forever.
// chat_logs + game_history are written on EVERY message/game, mirrored to
// Postgres every 1.5s, and read back in full by hydration — with no cap they
// were the dominant heap consumer and the reason the process hit
// "JavaScript heap out of memory" after ~20 min of uptime. Keep the newest
// rows only (dashboard queries already use ORDER BY id DESC LIMIT).
const CHAT_LOGS_CAP = 5000;
const GAME_HISTORY_CAP = 5000;

// Prune is gated on a write counter (every N writes) — deterministic and
// cheap, unlike a Date.now() modulo gate which can skip for long stretches.
let logWriteCounter = 0;
const LOG_PRUNE_EVERY = 100;

function pruneLogTables() {
  try {
    db.prepare('DELETE FROM chat_logs WHERE id NOT IN (SELECT id FROM chat_logs ORDER BY id DESC LIMIT ?)').run(CHAT_LOGS_CAP);
    db.prepare('DELETE FROM game_history WHERE id NOT IN (SELECT id FROM game_history ORDER BY id DESC LIMIT ?)').run(GAME_HISTORY_CAP);
  } catch (e) { /* non-fatal */ }
}

function maybePruneLogs() {
  if (++logWriteCounter % LOG_PRUNE_EVERY !== 0) return;
  pruneLogTables();
}

function logChat(msg) {
  if (!msg || !msg.from) return;
  const text = String(msg.text || msg.caption || '');
  if (!text) return;
  db.prepare(`INSERT INTO chat_logs (user_id, username, first_name, chat_id, chat_title, text, is_command, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      msg.from.id,
      msg.from.username || '',
      msg.from.first_name || '',
      msg.chat ? msg.chat.id : 0,
      (msg.chat && msg.chat.title) || '',
      text,
      text.startsWith('/') ? 1 : 0,
      Date.now()
    );
  // OOM fix: keep the table bounded (deterministic every-N-writes prune).
  maybePruneLogs();
  // Mirror only the newest row (the id is bigserial — newest row is max id).
  queuePgWrite('chat_logs', async () => {
    const row = db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    return pgQueryWithTimeout(
      `INSERT INTO chat_logs (id, user_id, username, first_name, chat_id, chat_title, text, is_command, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.user_id, row.username, row.first_name, row.chat_id, row.chat_title, row.text, row.is_command, row.created_at]
    );
  });
}

function getChatLogs(limit = 100, userId = null) {
  const rows = userId
    ? db.prepare('SELECT * FROM chat_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), chat_id: Number(r.chat_id) }));
}

/* ---------------- Dashboard: game history ---------------- */

function logGameHistory(entry) {
  db.prepare(`INSERT INTO game_history (user_id, username, game, bet, result, amount, meta, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      entry.user_id,
      entry.username || '',
      entry.game,
      entry.bet || 0,
      entry.result || '',
      entry.amount || 0,
      JSON.stringify(entry.meta || {}),
      Date.now()
    );
  // OOM fix: keep the table bounded (deterministic every-N-writes prune).
  maybePruneLogs();
  queuePgWrite('game_history', async () => {
    const row = db.prepare('SELECT * FROM game_history ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    return pgQueryWithTimeout(
      `INSERT INTO game_history (id, user_id, username, game, bet, result, amount, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.user_id, row.username, row.game, row.bet, row.result, row.amount, row.meta, row.created_at]
    );
  });
}

function getGameHistory(limit = 100, userId = null) {
  const rows = userId
    ? db.prepare('SELECT * FROM game_history WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM game_history ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id) }));
}

/* ---------------- Dashboard: moderators ---------------- */

function mapAdminUser(row) {
  if (!row) return row;
  return {
    user_id: Number(row.user_id),
    username: row.username || '',
    role: row.role || 'mod',
    password: row.password || '',
    created_at: Number(row.created_at) || 0,
    last_login: Number(row.last_login) || 0,
  };
}

function getAdminUser(userId) {
  return mapAdminUser(db.prepare('SELECT * FROM admin_users WHERE user_id = ?').get(userId));
}

function addAdminUser(userId, username, role, password) {
  db.prepare(`INSERT INTO admin_users (user_id, username, role, password, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, role = excluded.role, password = excluded.password`)
    .run(userId, username || '', role || 'mod', password || '', Date.now());
  pgRun(
    'admin_users',
    `INSERT INTO admin_users (user_id, username, role, password, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, role = EXCLUDED.role, password = EXCLUDED.password, created_at = EXCLUDED.created_at`,
    [userId, username || '', role || 'mod', password || '', Date.now()]
  );
}

function removeAdminUser(userId) {
  db.prepare('DELETE FROM admin_users WHERE user_id = ?').run(userId);
  pgRun('admin_users', 'DELETE FROM admin_users WHERE user_id = $1', [userId]);
}

function listAdminUsers() {
  return db.prepare('SELECT user_id, username, role, created_at, last_login FROM admin_users ORDER BY role DESC, user_id')
    .all().map(mapAdminUser);
}

function setAdminLastLogin(userId) {
  db.prepare('UPDATE admin_users SET last_login = ? WHERE user_id = ?').run(Date.now(), userId);
  pgRun('admin_users', 'UPDATE admin_users SET last_login = $1 WHERE user_id = $2', [Date.now(), userId]);
}

/* ---------------- Dashboard: events / missions ---------------- */

function mapEvent(row) {
  if (!row) return row;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    type: row.type || 'mission',
    reward: Number(row.reward) || 0,
    starts_at: Number(row.starts_at) || 0,
    ends_at: Number(row.ends_at) || 0,
    active: Number(row.active) || 0,
    created_by: Number(row.created_by) || 0,
    created_at: Number(row.created_at) || 0,
    completions: Number(row.completions) || 0,
  };
}

function listEvents(activeOnly = false) {
  const rows = activeOnly
    ? db.prepare('SELECT * FROM bot_events WHERE active = 1 ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM bot_events ORDER BY id DESC').all();
  return rows.map(mapEvent);
}

function createEvent(ev) {
  db.prepare(`INSERT INTO bot_events (title, description, type, reward, starts_at, ends_at, active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ev.title, ev.description || '', ev.type || 'mission', ev.reward || 0,
      ev.starts_at || 0, ev.ends_at || 0, ev.active === false ? 0 : 1,
      ev.created_by || 0, Date.now());
  const created = db.prepare('SELECT * FROM bot_events ORDER BY id DESC LIMIT 1').get();
  mirrorChangedRow('bot_events', created.id);
  return mapEvent(created);
}

function updateEvent(id, fields) {
  const ev = db.prepare('SELECT * FROM bot_events WHERE id = ?').get(id);
  if (!ev) return null;
  db.prepare(`UPDATE bot_events SET title = ?, description = ?, type = ?, reward = ?, active = ?, ends_at = ?
             WHERE id = ?`)
    .run(
      fields.title !== undefined ? fields.title : ev.title,
      fields.description !== undefined ? fields.description : ev.description,
      fields.type !== undefined ? fields.type : ev.type,
      fields.reward !== undefined ? fields.reward : ev.reward,
      fields.active !== undefined ? (fields.active ? 1 : 0) : ev.active,
      fields.ends_at !== undefined ? fields.ends_at : ev.ends_at,
      id
    );
  mirrorChangedRow('bot_events', id);
  return mapEvent(db.prepare('SELECT * FROM bot_events WHERE id = ?').get(id));
}

function deleteEvent(id) {
  db.prepare('DELETE FROM bot_events WHERE id = ?').run(id);
  pgRun('bot_events', 'DELETE FROM bot_events WHERE id = $1', [id]);
}

function incrementEventCompletions(id) {
  db.prepare('UPDATE bot_events SET completions = completions + 1 WHERE id = ?').run(id);
  pgRun('bot_events', 'UPDATE bot_events SET completions = completions + 1 WHERE id = $1', [id]);
}

/** Get the currently active event/mission for the bot to announce. */
function activeEvents() {
  const now = Date.now();
  return db.prepare(`SELECT * FROM bot_events WHERE active = 1 AND (starts_at = 0 OR starts_at <= ?) AND (ends_at = 0 OR ends_at > ?) ORDER BY id DESC`)
    .all(now, now).map(mapEvent);
}

/* ---------------- Dashboard: broadcasts ---------------- */

function mapBroadcast(row) {
  if (!row) return row;
  return {
    id: Number(row.id),
    message: row.message,
    target: row.target || 'all',
    sent_count: Number(row.sent_count) || 0,
    created_by: Number(row.created_by) || 0,
    created_at: Number(row.created_at) || 0,
  };
}

function createBroadcast(message, target, createdBy) {
  db.prepare(`INSERT INTO broadcasts (message, target, sent_count, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)`)
    .run(message, target || 'all', 0, createdBy || 0, Date.now());
  const created = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1').get();
  queuePgWrite('broadcasts', async () => {
    return pgQueryWithTimeout(
      `INSERT INTO broadcasts (id, message, target, sent_count, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [created.id, created.message, created.target, created.sent_count, created.created_by, created.created_at]
    );
  });
  return mapBroadcast(created);
}

function updateBroadcastCount(id, count) {
  db.prepare('UPDATE broadcasts SET sent_count = ? WHERE id = ?').run(count, id);
  pgRun('broadcasts', 'UPDATE broadcasts SET sent_count = $1 WHERE id = $2', [count, id]);
}

function listBroadcasts(limit = 50) {
  return db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?').all(limit).map(mapBroadcast);
}

/* ---------------- Dashboard: activity feed ---------------- */

function logActivity(type, text, meta = {}) {
  db.prepare(`INSERT INTO activity_feed (type, text, meta, created_at) VALUES (?, ?, ?, ?)`)
    .run(type || 'event', text, JSON.stringify(meta), Date.now());
  // keep the feed lean (last 500 entries)
  db.prepare('DELETE FROM activity_feed WHERE id NOT IN (SELECT id FROM activity_feed ORDER BY id DESC LIMIT 500)').run();
  queuePgWrite('activity_feed', async () => {
    const row = db.prepare('SELECT * FROM activity_feed ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    return pgQueryWithTimeout(
      `INSERT INTO activity_feed (id, type, text, meta, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.type, row.text, row.meta, row.created_at]
    );
  });
}

function getActivity(limit = 100) {
  return db.prepare('SELECT * FROM activity_feed ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

/* ---------------- Dashboard: audit log ---------------- */

function logAudit(actorId, actorName, action, targetId, detail) {
  db.prepare(`INSERT INTO audit_log (actor_id, actor_name, action, target_id, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
    .run(actorId, actorName || '', action, targetId || 0, detail || '', Date.now());
  queuePgWrite('audit_log', async () => {
    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    return pgQueryWithTimeout(
      `INSERT INTO audit_log (id, actor_id, actor_name, action, target_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.actor_id, row.actor_name, row.action, row.target_id, row.detail, row.created_at]
    );
  });
}

function getAuditLog(limit = 100) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

/* ---------------- Dashboard: stats ---------------- */

function dashboardStats() {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c;
  const banned = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'").get().c;
  const muted = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status IN ('muted','suspected')").get().c;
  const groups = db.prepare('SELECT COUNT(DISTINCT chat_id) AS c FROM chat_logs WHERE chat_id < 0').get().c;
  const coins = db.prepare('SELECT COALESCE(SUM(wallet),0) AS w, COALESCE(SUM(bank),0) AS b FROM users').get();
  const totalCoins = (Number(coins.w) || 0) + (Number(coins.b) || 0);
  const games = db.prepare('SELECT COUNT(*) AS c FROM game_history').get().c;
  const msgs = db.prepare('SELECT COUNT(*) AS c FROM chat_logs').get().c;
  const lottery = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  const lot = lottery ? lottery.pot : 0;
  return {
    totalUsers: users,
    activeUsers,
    bannedUsers: banned,
    mutedUsers: muted,
    totalGroups: groups,
    coinsInCirculation: totalCoins,
    coinsWallet: Number(coins.w) || 0,
    coinsBank: Number(coins.b) || 0,
    totalGames: games,
    totalMessages: msgs,
    lotteryPot: lot,
    topUsers: leaderboard(10),
  };
}

/* ---------------- Shop / Inventory ---------------- */

function mapInvRow(row) {
  if (!row) return row;
  return {
    user_id: Number(row.user_id),
    item_id: String(row.item_id),
    quantity: Number(row.quantity) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/** All items a user owns: [{ item_id, quantity }]. */
function getInventory(userId) {
  return db.prepare('SELECT user_id, item_id, quantity, updated_at FROM inventory WHERE user_id = ? AND quantity > 0')
    .all(userId).map(mapInvRow);
}

/** Quantity owned of one item (0 if none). */
function getItemQty(userId, itemId) {
  const row = db.prepare('SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  return row ? Number(row.quantity) || 0 : 0;
}

/** Add (or subtract, if delta negative) quantity of an item. Never goes below 0. */
function addItem(userId, itemId, delta = 1) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO inventory (user_id, item_id, quantity, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      quantity = MAX(0, quantity + excluded.quantity),
      updated_at = excluded.updated_at
  `).run(userId, itemId, delta, now);
  pgRun(
    'inventory',
    `INSERT INTO inventory (user_id, item_id, quantity, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, item_id) DO UPDATE SET
       quantity = GREATEST(0, inventory.quantity + EXCLUDED.quantity),
       updated_at = EXCLUDED.updated_at`,
    [userId, itemId, delta, now]
  );
  return getItemQty(userId, itemId);
}

/** Remove `qty` of an item (returns new qty; clamps at 0). */
function removeItem(userId, itemId, qty = 1) {
  return addItem(userId, itemId, -qty);
}

/** True if the user owns at least `qty` of `itemId`. */
function hasItem(userId, itemId, qty = 1) {
  return getItemQty(userId, itemId) >= qty;
}

/* ---------------- Redeem codes ---------------- */

/** Create a redeem code. Returns the row or null on duplicate. */
function createRedeemCode(code, amount, maxUses, createdBy, creatorRole = 'owner') {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  try {
    db.prepare(`INSERT INTO redeem_codes (code, amount, max_uses, used_count, created_by, creator_role, created_at)
               VALUES (?, ?, ?, 0, ?, ?, ?)`)
      .run(c, amount, maxUses, createdBy, creatorRole || 'owner', Date.now());
  } catch (e) {
    return null; // duplicate code (PRIMARY KEY)
  }
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(c);
  pgRun(
    'redeem_codes',
    `INSERT INTO redeem_codes (code, amount, max_uses, used_count, created_by, creator_role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (code) DO UPDATE SET amount = EXCLUDED.amount, max_uses = EXCLUDED.max_uses,
       created_by = EXCLUDED.created_by, creator_role = EXCLUDED.creator_role` ,
    [c, amount, maxUses, 0, createdBy, creatorRole || 'owner', Date.now()]
  );
  return row;
}

/** Look up a redeem code (null if missing). */
function getRedeemCode(code) {
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(String(code || '').trim().toUpperCase());
  if (!row) return null;
  return {
    code: row.code,
    amount: Number(row.amount) || 0,
    max_uses: Number(row.max_uses) || 0,
    used_count: Number(row.used_count) || 0,
    created_by: Number(row.created_by) || 0,
    creator_role: row.creator_role || 'owner',
    created_at: Number(row.created_at) || 0,
  };
}

/** All active codes (newest first). */
function listRedeemCodes() {
  return db.prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC').all()
    .map((row) => ({
      code: row.code,
      amount: Number(row.amount) || 0,
      max_uses: Number(row.max_uses) || 0,
      used_count: Number(row.used_count) || 0,
      created_by: Number(row.created_by) || 0,
      creator_role: row.creator_role || 'owner',
      created_at: Number(row.created_at) || 0,
    }));
}

/** Delete a redeem code. Returns true if a row was removed. */
function deleteRedeemCode(code) {
  const c = String(code || '').trim().toUpperCase();
  const r = db.prepare('DELETE FROM redeem_codes WHERE code = ?').run(c);
  pgRun('redeem_codes', 'DELETE FROM redeem_codes WHERE code = $1', [c]);
  return r.changes > 0;
}

/** Has this user already redeemed this code? */
function hasRedeemed(userId, code) {
  const row = db.prepare('SELECT 1 FROM redeem_redemptions WHERE code = ? AND user_id = ?')
    .get(String(code || '').trim().toUpperCase(), userId);
  return !!row;
}

/** Record a redemption (code + user). Returns true if newly recorded. */
function recordRedemption(userId, code) {
  const c = String(code || '').trim().toUpperCase();
  try {
    db.prepare('INSERT INTO redeem_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)')
      .run(c, userId, Date.now());
  } catch (e) {
    return false; // already redeemed (PRIMARY KEY)
  }
  // bump used_count on the code
  db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?').run(c);
  pgRun(
    'redeem_redemptions',
    `INSERT INTO redeem_redemptions (code, user_id, redeemed_at) VALUES ($1, $2, $3)
     ON CONFLICT (code, user_id) DO NOTHING`,
    [c, userId, Date.now()]
  );
  pgRun('redeem_codes', 'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = $1', [c]);
  return true;
}

/* ---------------- Backups (Postgres snapshot store) ---------------- */

/** Save a backup snapshot to BOTH the local file (legacy) and Postgres. */
function saveBackupPg(filename, data, userCount, createdBy) {
  db.prepare(`INSERT INTO backups (filename, data, user_count, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)`)
    .run(filename, data, userCount, createdBy || 0, Date.now());
  const row = db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  pgRun(
    'backups',
    `INSERT INTO backups (id, filename, data, user_count, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [row.id, row.filename, row.data, row.user_count, row.created_by, row.created_at]
  );
  return row;
}

/** The NEWEST backup stored in Postgres (null if none). */
function newestBackupPg() {
  const row = db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return {
    id: Number(row.id),
    filename: row.filename,
    data: row.data,
    user_count: Number(row.user_count) || 0,
    created_by: Number(row.created_by) || 0,
    created_at: Number(row.created_at) || 0,
  };
}

/** All backups stored (newest first) \u2014 used by /backup list. */
function listBackupsPg(limit = 10) {
  return db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit)
    .map((row) => ({
      id: Number(row.id),
      filename: row.filename,
      user_count: Number(row.user_count) || 0,
      created_by: Number(row.created_by) || 0,
      created_at: Number(row.created_at) || 0,
    }));
}

/* ---------------- Settings / pause flag ---------------- */

const SETTINGS_KEYS = ['bot_paused'];

/**
 * Read a persisted setting. Returns null when absent.
 * Local SQLite is the hot cache; the value is mirrored to Postgres on write.
 */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Write a setting (upsert) and mirror it to Postgres via the pipeline. */
function setSetting(key, value) {
  const now = Date.now();
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value == null ? '' : value), now);
  pgRun(
    'settings',
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, String(value == null ? '' : value), now]
  );
}

/** True while the bot is paused for maintenance (/stop). Persisted — survives redeploys. */
function getBotPaused() {
  const v = getSetting('bot_paused');
  return v === '1' || v === 'true';
}

/** Pause (/stop) or resume (/run) the bot. Persisted to SQLite + Postgres. */
function setBotPaused(paused) {
  setSetting('bot_paused', paused ? '1' : '0');
}

/* ---------------- Cleanup ---------------- */

/** Clear expired temporary penalties (mute/suspend) — called periodically. */
function expirePenalties() {
  const now = Date.now();
  const expired = db.prepare(`
    SELECT user_id, status FROM users
    WHERE status IN ('muted','suspected') AND status_until > 0 AND status_until <= ?
  `).all(now);
  for (const u of expired) {
    db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0, updated_at = ? WHERE user_id = ?").run(nowStamp(), u.user_id);
  }
  if (expired.length) {
    for (const u of expired) mirrorChangedRow('users', u.user_id);
  }
  return expired.map((u) => ({ ...u, user_id: Number(u.user_id) }));
}

/* ---------------- Single-instance advisory lock ---------------- */

/**
 * HARD single-instance guard. PostgreSQL advisory locks are session-scoped, so
 * the connection that acquires the lock is kept checked out for the lifetime
 * of this process. Losing that connection fences the process immediately.
 */
async function acquireInstanceLock(key) {
  if (!pgEnabled || !pool) {
    console.warn('[db] advisory lock skipped — Postgres not configured (SQLite-only development mode).');
    instanceLockHeld = true;
    return true;
  }

  const ready = await ensurePgReady();
  if (!ready) {
    console.error('[db] advisory lock unavailable — Postgres is not ready. Refusing primary/write ownership.');
    instanceLockHeld = false;
    return false;
  }

  if (instanceLockHeld && instanceLockClient && instanceLockKey === Number(key)) return true;

  try {
    const client = await pool.connect();
    const result = await pgQueryWithTimeout('SELECT pg_try_advisory_lock($1) AS locked', [Number(key)], client);
    const locked = result.rows && result.rows[0] && result.rows[0].locked === true;
    if (!locked) {
      client.release();
      instanceLockHeld = false;
      console.warn(`[db] advisory lock ${Number(key)} is already owned by another session.`);
      return false;
    }

    instanceLockClient = client;
    instanceLockKey = Number(key);
    instanceLockHeld = true;

    if (instanceLockHeartbeat) clearInterval(instanceLockHeartbeat);
    instanceLockHeartbeat = setInterval(async () => {
      if (!instanceLockClient || !instanceLockHeld) return;
      try {
        await pgQueryWithTimeout('SELECT 1', [], instanceLockClient);
      } catch (e) {
        console.error('[db] ❌ advisory-lock heartbeat lost:', e.message);
        const lostKey = instanceLockKey;
        instanceLockHeld = false;
        persistenceDegraded = true;
        syncEnabled = false;
        if (syncTimer) {
          clearInterval(syncTimer);
          syncTimer = null;
        }
        try { instanceLockClient.release(); } catch (_) {}
        instanceLockClient = null;
        // Keep the process alive for Render health, but fence all writes.
        // Recovery will reconnect Postgres and attempt to reacquire this lock.
        if (lostKey != null) schedulePgRetry();
      }
    }, 10000);
    instanceLockHeartbeat.unref && instanceLockHeartbeat.unref();

    console.log(`[db] advisory lock ${Number(key)} acquired and pinned to dedicated PG session.`);
    return true;
  } catch (e) {
    instanceLockHeld = false;
    console.error('[db] advisory lock acquisition failed:', e.message);
    return false;
  }
}

/** Release the advisory lock on the SAME PostgreSQL session that acquired it. */
async function releaseInstanceLock(key) {
  if (!instanceLockClient) {
    instanceLockHeld = false;
    return;
  }
  const client = instanceLockClient;
  instanceLockHeld = false;
  syncEnabled = false;
  if (instanceLockHeartbeat) {
    clearInterval(instanceLockHeartbeat);
    instanceLockHeartbeat = null;
  }
  try {
    await pgQueryWithTimeout('SELECT pg_advisory_unlock($1)', [Number(key)], client);
  } catch (e) {
    console.warn('[db] advisory unlock failed:', e.message);
  } finally {
    try { client.release(); } catch (_) {}
    instanceLockClient = null;
    instanceLockKey = null;
  }
}

function isInstanceLockHeld() {
  return !pgEnabled || instanceLockHeld === true;
}

/* ================= Postgres → SQLite rehydration ================= */

/**
 * Copy Postgres rows back into SQLite (used on boot so the cache starts from
 * the durable store). Postgres is the SOURCE OF TRUTH for persistence: rows
 * that exist in Postgres OVERWRITE any local SQLite row (INSERT OR REPLACE),
 * so a stale local snapshot can never win over newer Postgres data. Rows that
 * only exist locally are kept and pushed up by mirrorAll() right after.
 *
 * FIX (Task 5): the old implementation kept the local SQLite row whenever it
 * already existed (INSERT OR IGNORE semantics) — i.e. the STALE cache beat the
 * fresh Postgres data on every boot. That is exactly why balances kept
 * reverting to old digits even though writes were verified (writesOk > 0):
 * the write pipeline was healthy, but the READ path was overwriting fresh
 * data with the stale cache on boot.
 */
/**
 * Copy Postgres rows back into SQLite (used on boot so the cache starts from
 * the durable store). VERSIONED MERGE:
 *
 *  - For tables with an `updated_at` column (VERSIONED_TABLES), a PG row is
 *    applied ONLY when its updated_at is NEWER than the local SQLite row's.
 *    If the LOCAL row is newer, the local value is kept (it will be pushed
 *    back up by the periodic mirror — no data is lost in either direction).
 *  - ONLY timestamp ordering decides which state wins — NEVER value
 *    comparison: legitimate purchases, bets, losses and withdrawals can
 *    legitimately DECREASE balances, so a lower balance is never treated as
 *    stale.
 *  - Non-versioned tables keep the previous upsert behavior (they are
 *    append-only logs / singleton rows where conflict is harmless).
 *
 * This is the permanent fix for the periodic rollback: the old implementation
 * used INSERT OR REPLACE on every boot, so a boot racing the 1.5s sync loop
 * could overwrite a fresh balance with a PG snapshot that was one mirror tick
 * stale.
 */
async function hydrateFromPg() {
  if (!pool) return 0;
  let restored = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = ${PG_QUERY_TIMEOUT_MS}`);
      for (const [table, colsStr] of Object.entries(TABLE_COLS)) {
        const cols = colsStr.split(', ');
        const { rows } = await client.query(`SELECT ${colsStr} FROM ${table}`);
        if (!rows.length) continue;
        const versioned = VERSIONED_TABLES.has(table) && cols.includes('updated_at');
        for (const r of rows) {
          const pkCols = TABLE_PKS[table] || [cols[0]];
          const local = db.prepare(
            `SELECT ${cols.join(', ')} FROM ${table} WHERE ${pkCols.map((c) => `${c} = ?`).join(' AND ')}`
          ).get(...pkCols.map((c) => r[c]));
          if (versioned && local) {
            // Merge by version: only apply the PG row if it is NEWER than the
            // local row. Never overwrite newer local data with older PG data.
            const pgStamp = Number(r.updated_at) || 0;
            const localStamp = Number(local.updated_at) || 0;
            if (pgStamp <= localStamp) {
              continue; // local copy is newer/equal — keep it (mirror will push it up)
            }
          }
          const upsert = db.prepare(
            `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
          );
          upsert.run(...cols.map((c) => r[c]));
          restored++;
        }
      }
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[db] hydrate failed (continuing with current cache):', e.message);
  }
  return restored;
}

/** Health info for /debug + /health: persistence status, connectivity, last error. */
function syncInfo() {
  return {
    postgres: pgEnabled && pool !== null,
    configured: pgEnabled,
    ready: pgReady,
    connected: pgReady && pgConnectivity !== 'degraded',
    connectivity: pgConnectivity,
    host: pgHost,
    port: pgPort,
    failures: pgFailures,
    lastPgError: pgLastError || null,
    lastPgErrorAt: pgLastErrorAt || null,
    lastMirrorAt: lastMirrorAt || 0,
    // NEW — verified write-through stats (Task A: durable persistence)
    lastWriteAt: pgLastWriteAt || 0,
    lastVerifyAt: pgLastVerifyAt || 0,
    writesOk: pgWritesOk || 0,
    writesFailed: pgWritesFailed || 0,
    instanceLockHeld: !pgEnabled || instanceLockHeld,
    instanceLockPinned: !!instanceLockClient,
    persistenceDegraded,
    writable: (!pgEnabled || (pgReady && pgConnectivity !== 'degraded' && syncEnabled && instanceLockHeld)),
    dbSyncIntervalMs: config.dbSyncIntervalMs,
    // Bandwidth telemetry — proves dirty-row mirroring replaces the 30s full dump.
    mirroredRowsTotal: rowsMirrored,
    mirroredBytesTotal: bytesMirrored,
    mirrorAllRuns,
    reconcileRuns,
    lastFullReconcileAt: lastFullReconcileAt || 0,
  };
}

/** DB round-trip latency in ms (local SQLite read — meaningful bot responsiveness). */
function ping() {
  const t0 = Date.now();
  try {
    db.prepare('SELECT 1').get();
  } catch (e) { /* still report the elapsed time */ }
  return Date.now() - t0;
}

/* ================= Boot / periodic mirror ================= */

let syncTimer = null;
let reinitTimer = null;
const PG_RETRY_MS = 15000; // background reconnect/hydrate retry when PG is configured but unreachable

// WRITE-PIPELINE GATE (rollback root cause): the periodic mirror loop and the
// background hydration/mirror-on-reconnect may ONLY run on the instance that
// OWNS the Postgres advisory lock (the primary). A standby/secondary instance
// (Render deploy overlap, stale process) must never mirror its local SQLite
// up to Postgres — its cache may be stale, and pushing it would overwrite the
// primary's fresh writes with older values. index.js acquires the lock and
// calls setSyncEnabled(false) for standby BEFORE initPersistence()'s
// hydration finishes; see db.setSyncEnabled().
// FAIL-CLOSED when Postgres is configured: writes stay OFF until index.js
// confirms this instance owns the advisory lock. SQLite-only mode (no
// DATABASE_URL) has no dual-writer risk, so a single local instance is the
// sole owner and writes are enabled by default.
let syncEnabled = !pgEnabled;

/**
 * Rollback-fix guard: while a hydration is in flight this flag is set so the
 * periodic sync loop can NEVER fire mid-hydration and push a half-merged
 * cache up to Postgres. hydrationToken is compared-and-swapped so concurrent
 * callers (boot + reconnect) cannot double-hydrate.
 */
let hydrating = false;
let hydrationToken = 0;

/** Run a hydration, keeping `hydrating` set for its whole duration. */
async function runHydration(label) {
  const token = ++hydrationToken;
  hydrating = true;
  try {
    const hydrated = await hydrateFromPg();
    console.log(`[db] ${label}: hydrated ${hydrated} rows from Postgres into SQLite.`);
    return hydrated;
  } finally {
    if (token === hydrationToken) hydrating = false;
  }
}

/** True while a hydration is running (sync loop must wait). */
function isHydrating() {
  return hydrating;
}

/**
 * Start the periodic full-sync loop. It refuses to start while a hydration is
 * in flight, so the SQLite cache is always fully merged before anything is
 * pushed up to Postgres.
 */
function startSyncLoop() {
  if (syncTimer || hydrating || !syncEnabled) return syncTimer;
  syncTimer = setInterval(() => {
    if (hydrating || !syncEnabled) return; // belt-and-braces: never push mid-hydration or as standby
    lastMirrorAt = Date.now();
    mirrorAll();
  }, Math.max(config.dbSyncIntervalMs, 500));
  syncTimer.unref && syncTimer.unref();
  return syncTimer;
}

/**
 * Enable/disable the SQLite→Postgres write pipeline. index.js calls this
 * AFTER acquiring the advisory lock: primary → setSyncEnabled(true), standby
 * → setSyncEnabled(false) so a stale secondary instance can never push old
 * rows up over the primary's fresh writes (the periodic rollback source).
 * When disabled, hydration (PG→SQLite reads) still runs — reads are safe —
 * but every mirror/write is skipped. Defaults to true (local dev).
 */
function setSyncEnabled(v) {
  syncEnabled = pgEnabled ? (!!v && instanceLockHeld === true) : !!v;
  if (!syncEnabled && syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log('[db] sync loop stopped (standby instance — no SQLite→PG writes).');
  } else if (syncEnabled && !syncTimer && pgReady) {
    startSyncLoop();
    // Push any local-only rows up immediately (rather than waiting for the
    // first periodic tick) so a freshly-promoted primary converges at once.
    // `true` forces a FULL reconciliation on promotion/boot (safe: a freshly
    // promoted primary must converge its whole cache, not just dirty rows).
    mirrorAll(true);
  }
  return syncEnabled;
}

/** True while the write pipeline is allowed (primary instance owns the lock). */
function isSyncEnabled() {
  return syncEnabled;
}

/**
 * Init the Postgres mirror: create tables, hydrate SQLite from Postgres, then
 * start the periodic full-sync loop. Call once from src/index.js before the
 * bot starts. Resolves { enabled, hydrated }.
 *
 * FAIL-LOUD: if DATABASE_URL is set but Postgres cannot be reached, this does
 * NOT silently leave the bot on ephemeral SQLite — it logs a prominent
 * warning and keeps retrying in the background until the connection works,
 * then hydrates and resumes mirroring.
 */
async function initPersistence() {
  if (!pgEnabled || !pool) {
    if (pgEnabled && !pool) {
      console.error('[db] ❌ DATABASE_URL is set but the pool could not be created — persistence DISABLED.');
    }
    return { enabled: false, hydrated: 0 };
  }
  if (pgInitPromise) return pgInitPromise;
  pgInitPromise = (async () => {
    try {
      const ok = await initPg();
      if (!ok) {
        // initPg() swallows the error internally — surface it here so the
        // fail-loud path (below) triggers instead of pretending persistence is on.
        throw new Error(pgLastError || 'Postgres schema init failed (unknown error)');
      }
      pgReady = true;
      pgConnectivity = 'connected';
      pgFailures = 0;
      pgLastError = '';
      persistenceDegraded = false;
      console.log('[db] Postgres ready — hydrating SQLite cache from Postgres…');
      // Hydration MUST fully complete BEFORE the sync loop starts (rollback
      // fix): the loop can never push a half-merged cache up to Postgres.
      const hydrated = await runHydration('Hydrated');
      // IMPORTANT: do not mirror or start the write loop here. The process does
      // not own the single-writer lock yet. index.js acquires the dedicated
      // advisory-lock session and then explicitly enables synchronization.
      return { enabled: true, hydrated };
    } catch (e) {
      console.error(
        `[db] ❌ Postgres is configured (DATABASE_URL set) but UNREACHABLE: ${e.message}\n` +
        'Data is NOT being persisted to Postgres — redeploys will RESET balances.\n' +
        'Check the connection string (direct :5432 vs pooler :6543) and network access.\n' +
        `Retrying every ${PG_RETRY_MS / 1000}s in the background…`
      );
      pgReady = false;
      pgConnectivity = 'degraded';
      schedulePgRetry();
      return { enabled: false, hydrated: 0 };
    }
  })();
  return pgInitPromise;
}

/** Background retry: keep trying to init Postgres until it connects. */
function schedulePgRetry() {
  if (reinitTimer) return;
  reinitTimer = setTimeout(async () => {
    reinitTimer = null;
    try {
      const ok = await initPg();
      if (ok) {
        pgReady = true;
        pgConnectivity = 'connected';
        pgFailures = 0;
        pgLastError = '';
        // Prove the pool can execute a real query before re-enabling writes.
        await pgQueryWithTimeout('SELECT 1');
        console.log('[db] ✅ Postgres connection restored — reconciling durable state…');
        // Never hydrate a live cache while it is simultaneously allowed to
        // write. Fence the write pipeline for the whole reconciliation window.
        const wasSyncEnabled = syncEnabled;
        syncEnabled = false;
        await runHydration('Re-hydrated');

        // If the previous dedicated lock session survived the transient pool
        // outage, reuse it. If heartbeat lost the session, reacquire the lock
        // before restoring write ownership.
        if (instanceLockKey != null && !instanceLockHeld) {
          try {
            await acquireInstanceLock(instanceLockKey);
          } catch (e) {
            console.warn('[db] primary lock reacquisition deferred:', e.message);
          }
        }

        pgInitPromise = null;
        persistenceDegraded = false;
        if (instanceLockHeld) {
          syncEnabled = true;
          startSyncLoop();
          mirrorAll(true); // full reconcile after recovery (re-hydration may have changed rows)
          console.log('[db] ✅ persistence recovered — write pipeline re-enabled.');
        }
      } else {
        // initPg() failed — retry later (initPg already logged the reason).
        pgConnectivity = 'degraded';
        schedulePgRetry();
      }
    } catch (e) {
      console.error(`[db] ❌ Postgres still unreachable: ${e.message} — retrying…`);
      schedulePgRetry();
    }
  }, PG_RETRY_MS);
  reinitTimer.unref && reinitTimer.unref();
}

function close() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (reinitTimer) { clearTimeout(reinitTimer); reinitTimer = null; }
  if (instanceLockHeartbeat) { clearInterval(instanceLockHeartbeat); instanceLockHeartbeat = null; }
  instanceLockHeld = false;
  syncEnabled = false;
  // Destroy the dedicated lock session synchronously. Closing the PostgreSQL
  // session releases its advisory lock even if shutdown is already in flight.
  if (instanceLockClient) {
    try { instanceLockClient.release(true); } catch (_) {}
    instanceLockClient = null;
    instanceLockKey = null;
  }
  db.close();
}

module.exports = {
  db,
  getOrCreateUser,
  getUser,
  getNetWorth,
  setWallet,
  setBank,
  setNetworth,
  addWallet,
  addBank,
  setStatus,
  clearStatus,
  setHidden,
  isHidden,
  getAllUsers,
  leaderboard,
  // Rank tracking / time-wallet
  setRankStats,
  addTimeWallet,
  getTimeWalletBalance,
  getTimeWalletRow,
  spendTimeWallet,
  sweepExpiredTimeWallet,
  mirrorRowDelete,
  getCooldown,
  setCooldown,
  clearCooldown,
  clearAllCooldowns,
  getOpenHeists,
  getSeenChatIds,
  findUserByUsername,
  getCooldownCount,
  listUsersByNetWorth,
  searchUsers,
  getAttackEligibleUsers,
  getUserCooldowns,
  getLottery,
  saveLottery,
  getHeist,
  createHeist,
  updateHeistMembers,
  updateHeistStatus,
  deleteHeist,
  expirePenalties,
  // Dashboard
  logChat,
  getChatLogs,
  logGameHistory,
  getGameHistory,
  getAdminUser,
  addAdminUser,
  removeAdminUser,
  listAdminUsers,
  setAdminLastLogin,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  incrementEventCompletions,
  activeEvents,
  createBroadcast,
  updateBroadcastCount,
  listBroadcasts,
  logActivity,
  getActivity,
  logAudit,
  getAuditLog,
  dashboardStats,
  // Shop / Inventory
  getInventory,
  getItemQty,
  addItem,
  removeItem,
  hasItem,
  // Redeem codes
  createRedeemCode,
  getRedeemCode,
  listRedeemCodes,
  deleteRedeemCode,
  hasRedeemed,
  recordRedemption,
  // Backups (Postgres snapshot store)
  saveBackupPg,
  newestBackupPg,
  listBackupsPg,
  // Settings / pause flag (/stop, /run — persisted across redeploys)
  getSetting,
  setSetting,
  getBotPaused,
  setBotPaused,
  // Persistence
  initPersistence,
  hydrateFromPg,
  startSyncLoop,
  setSyncEnabled,
  isSyncEnabled,
  mirrorTable,
  mirrorAll,
  pgRun,
  syncInfo,
  ping,
  close,
  // Single-instance guard
  acquireInstanceLock,
  releaseInstanceLock,
};