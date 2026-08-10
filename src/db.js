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
  created_at INTEGER NOT NULL
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
`);

/* ================= Postgres (durable store) ================= */

const DATABASE_URL = (config.databaseUrl || '').trim();
const pgEnabled = DATABASE_URL.length > 0;
let pool = null;

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
  created_at    BIGINT NOT NULL
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
`;

/** Create Postgres tables (idempotent). Returns true on success. */
async function initPg() {
  if (!pool) return false;
  try {
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
 * Simple async queue so a single slow pg query never blocks the process.
 * Failures are counted so we can detect "configured but unreachable" and
 * surface it loudly in logs + /health + /debug.
 */
let pgReady = false;
let pgQueue = Promise.resolve();
let pgInitPromise = null;
let pgFailures = 0;
let pgLastError = '';
let pgLastErrorAt = 0;
let pgConnectivity = 'unknown'; // unknown | connecting | connected | degraded
const PG_CRITICAL_FAILURES = 3;

function queuePg(task) {
  pgQueue = pgQueue.then(task).catch((err) => {
    pgFailures++;
    const code = err && err.code ? ` [${err.code}]` : '';
    pgLastError = String((err && err.message) || err) + code;
    pgLastErrorAt = Date.now();
    pgConnectivity = 'degraded';
    if (pgFailures === PG_CRITICAL_FAILURES || pgFailures % 10 === 0) {
      console.error(
        `[db] ⚠ Postgres mirror failures: ${pgFailures} (last: ${pgLastError}). ` +
        'Data is NOT persisting to Postgres right now — check DATABASE_URL and connectivity.'
      );
    } else {
      console.error('[db] pg mirror error:', err.message);
    }
  });
}

/**
 * Run one raw SQL on Postgres (fire-and-forget, queued). If the pool is not
 * initialized yet (init still in flight) the query is simply skipped — the
 * periodic full-sync re-mirrors everything shortly after boot.
 */
function pgRun(sql, params = []) {
  if (!pool || !pgReady) return;
  queuePg(() => pool.query(sql, params));
}

/* ================= Table mirror helpers ================= */

const TABLE_COLS = {
  users: 'user_id, username, first_name, wallet, bank, status, status_reason, status_until, created_at',
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
};

function mirrorTable(table) {
  if (!pool || !pgReady) return;
  const rows = sqliteRows(table);
  if (!rows.length) return;
  queuePg(async () => {
    const cols = TABLE_COLS[table].split(', ');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const pkCols = TABLE_PKS[table] || [cols[0]];
        const updateCols = cols.filter((c) => !pkCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
        if (!updateCols) continue; // nothing to update (all-PK row) — skip
        await client.query(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${pkCols.join(', ')}) DO UPDATE SET ${updateCols}`,
          cols.map((c) => row[c])
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}

/** Full mirror: push every SQLite table to Postgres (called on boot + periodically). */
function mirrorAll() {
  if (!pool || !pgReady) return;
  for (const table of Object.keys(TABLE_COLS)) mirrorTable(table);
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
    created_at: Number(row.created_at) || 0,
  };
}

/* ---------------- Users ---------------- */

function getOrCreateUser(userId, meta = {}) {
  let row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (row) {
    if (meta.username || meta.first_name) {
      db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?')
        .run(meta.username || row.username, meta.first_name || row.first_name, userId);
      const updated = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      mirrorTable('users');
      return mapUser(updated);
    }
    return mapUser(row);
  }
  db.prepare('INSERT INTO users (user_id, username, first_name, wallet, bank, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, meta.username || '', meta.first_name || '', config.startBalance, 0, 'active', Date.now());
  mirrorTable('users');
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

function setWallet(userId, amount) {
  db.prepare('UPDATE users SET wallet = ? WHERE user_id = ?').run(amount, userId);
  mirrorTable('users');
}

function setBank(userId, amount) {
  db.prepare('UPDATE users SET bank = ? WHERE user_id = ?').run(amount, userId);
  mirrorTable('users');
}

/** Atomically add to wallet (positive or negative). Returns new wallet. */
function addWallet(userId, delta) {
  db.prepare('UPDATE users SET wallet = wallet + ? WHERE user_id = ?').run(delta, userId);
  mirrorTable('users');
  return getUser(userId).wallet;
}

/** Atomically add to bank. Returns new bank. */
function addBank(userId, delta) {
  db.prepare('UPDATE users SET bank = bank + ? WHERE user_id = ?').run(delta, userId);
  mirrorTable('users');
  return getUser(userId).bank;
}

function setStatus(userId, status, reason, until = 0) {
  db.prepare('UPDATE users SET status = ?, status_reason = ?, status_until = ? WHERE user_id = ?')
    .run(status, reason || '', until, userId);
  mirrorTable('users');
}

/** /hide — vanish from rob/heist targeting until `untilTs` (ms epoch). */
function setHidden(userId, untilTs) {
  db.prepare('UPDATE users SET hidden_until = ? WHERE user_id = ?').run(untilTs || 0, userId);
  pgRun('UPDATE users SET hidden_until = $1 WHERE user_id = $2', [untilTs || 0, userId]);
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
  db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0 WHERE user_id = ?").run(userId);
  mirrorTable('users');
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
    `INSERT INTO cooldowns (user_id, action, until) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, action) DO UPDATE SET until = EXCLUDED.until`,
    [userId, action, until]
  );
}

function clearCooldown(userId, action) {
  db.prepare('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
  pgRun('DELETE FROM cooldowns WHERE user_id = $1 AND action = $2', [userId, action]);
}

/** Delete ALL cooldowns (used by /restart). */
function clearAllCooldowns() {
  db.prepare('DELETE FROM cooldowns').run();
  pgRun('DELETE FROM cooldowns');
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
    `INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (leader_id) DO UPDATE SET leader_name = EXCLUDED.leader_name, target_id = EXCLUDED.target_id,
       target_name = EXCLUDED.target_name, members = EXCLUDED.members, started_at = EXCLUDED.started_at, status = EXCLUDED.status`,
    [heist.leader_id, heist.leader_name, heist.target_id, heist.target_name, JSON.stringify(heist.members), heist.started_at, heist.status]
  );
}

function updateHeistMembers(leaderId, members) {
  db.prepare('UPDATE heists SET members = ? WHERE leader_id = ?').run(JSON.stringify(members), leaderId);
  pgRun('UPDATE heists SET members = $1 WHERE leader_id = $2', [JSON.stringify(members), leaderId]);
}

function updateHeistStatus(leaderId, status) {
  db.prepare('UPDATE heists SET status = ? WHERE leader_id = ?').run(status, leaderId);
  pgRun('UPDATE heists SET status = $1 WHERE leader_id = $2', [status, leaderId]);
}

function deleteHeist(leaderId) {
  db.prepare('DELETE FROM heists WHERE leader_id = ?').run(leaderId);
  pgRun('DELETE FROM heists WHERE leader_id = $1', [leaderId]);
}

/* ---------------- Dashboard: chat logs ---------------- */

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
  // Mirror only the newest row (the id is bigserial — newest row is max id).
  queuePg(() => {
    if (!pool || !pgReady) return Promise.resolve();
    const row = db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 1').get();
    if (!row) return Promise.resolve();
    return pool.query(
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
  queuePg(() => {
    if (!pool || !pgReady) return Promise.resolve();
    const row = db.prepare('SELECT * FROM game_history ORDER BY id DESC LIMIT 1').get();
    if (!row) return Promise.resolve();
    return pool.query(
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
    `INSERT INTO admin_users (user_id, username, role, password, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, role = EXCLUDED.role, password = EXCLUDED.password, created_at = EXCLUDED.created_at`,
    [userId, username || '', role || 'mod', password || '', Date.now()]
  );
}

function removeAdminUser(userId) {
  db.prepare('DELETE FROM admin_users WHERE user_id = ?').run(userId);
  pgRun('DELETE FROM admin_users WHERE user_id = $1', [userId]);
}

function listAdminUsers() {
  return db.prepare('SELECT user_id, username, role, created_at, last_login FROM admin_users ORDER BY role DESC, user_id')
    .all().map(mapAdminUser);
}

function setAdminLastLogin(userId) {
  db.prepare('UPDATE admin_users SET last_login = ? WHERE user_id = ?').run(Date.now(), userId);
  pgRun('UPDATE admin_users SET last_login = $1 WHERE user_id = $2', [Date.now(), userId]);
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
  mirrorTable('bot_events');
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
  mirrorTable('bot_events');
  return mapEvent(db.prepare('SELECT * FROM bot_events WHERE id = ?').get(id));
}

function deleteEvent(id) {
  db.prepare('DELETE FROM bot_events WHERE id = ?').run(id);
  pgRun('DELETE FROM bot_events WHERE id = $1', [id]);
}

function incrementEventCompletions(id) {
  db.prepare('UPDATE bot_events SET completions = completions + 1 WHERE id = ?').run(id);
  pgRun('UPDATE bot_events SET completions = completions + 1 WHERE id = $1', [id]);
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
  queuePg(() => {
    if (!pool || !pgReady) return Promise.resolve();
    return pool.query(
      `INSERT INTO broadcasts (id, message, target, sent_count, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [created.id, created.message, created.target, created.sent_count, created.created_by, created.created_at]
    );
  });
  return mapBroadcast(created);
}

function updateBroadcastCount(id, count) {
  db.prepare('UPDATE broadcasts SET sent_count = ? WHERE id = ?').run(count, id);
  pgRun('UPDATE broadcasts SET sent_count = $1 WHERE id = $2', [count, id]);
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
  queuePg(() => {
    if (!pool || !pgReady) return Promise.resolve();
    const row = db.prepare('SELECT * FROM activity_feed ORDER BY id DESC LIMIT 1').get();
    if (!row) return Promise.resolve();
    return pool.query(
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
  queuePg(() => {
    if (!pool || !pgReady) return Promise.resolve();
    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
    if (!row) return Promise.resolve();
    return pool.query(
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

/* ---------------- Cleanup ---------------- */

/** Clear expired temporary penalties (mute/suspend) — called periodically. */
function expirePenalties() {
  const now = Date.now();
  const expired = db.prepare(`
    SELECT user_id, status FROM users
    WHERE status IN ('muted','suspected') AND status_until > 0 AND status_until <= ?
  `).all(now);
  for (const u of expired) {
    db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0 WHERE user_id = ?").run(u.user_id);
  }
  if (expired.length) mirrorTable('users');
  return expired.map((u) => ({ ...u, user_id: Number(u.user_id) }));
}

/* ================= Postgres → SQLite rehydration ================= */

/**
 * Copy Postgres rows back into SQLite (used on boot so the cache starts from
 * the durable store). Idempotent; skips rows already present.
 */
async function hydrateFromPg() {
  if (!pool) return 0;
  let restored = 0;
  try {
    const client = await pool.connect();
    try {
      for (const [table, colsStr] of Object.entries(TABLE_COLS)) {
        const cols = colsStr.split(', ');
        const pk = cols[0];
        const { rows } = await client.query(`SELECT ${colsStr} FROM ${table}`);
        if (!rows.length) continue;
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        );
        for (const r of rows) {
          const vals = cols.map((c) => r[c]);
          if (table === 'users') {
            // keep newest row on conflict for users (INSERT OR IGNORE keeps existing — fine)
          }
          insert.run(...vals);
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
    dbSyncIntervalMs: config.dbSyncIntervalMs,
  };
}

/* ================= Boot / periodic mirror ================= */

let lastMirrorAt = 0;
let syncTimer = null;
let reinitTimer = null;
const PG_RETRY_MS = 15000; // background reconnect/hydrate retry when PG is configured but unreachable

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
      console.log('[db] Postgres ready — hydrating SQLite cache from Postgres…');
      const hydrated = await hydrateFromPg();
      console.log(`[db] Hydrated ${hydrated} rows from Postgres into SQLite.`);
      // Push any local-only rows (new users created before pg connected) up.
      mirrorAll();
      // Periodic full mirror so big tables (chat_logs, game_history) converge.
      syncTimer = setInterval(() => {
        lastMirrorAt = Date.now();
        mirrorAll();
      }, Math.max(config.dbSyncIntervalMs, 500));
      syncTimer.unref && syncTimer.unref();
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
        console.log('[db] ✅ Postgres connection restored — hydrating SQLite from Postgres…');
        const hydrated = await hydrateFromPg();
        console.log(`[db] Re-hydrated ${hydrated} rows from Postgres.`);
        pgInitPromise = null;
        mirrorAll();
        // Restart the periodic full-sync loop if it is not running.
        if (!syncTimer) {
          syncTimer = setInterval(() => {
            lastMirrorAt = Date.now();
            mirrorAll();
          }, Math.max(config.dbSyncIntervalMs, 500));
          syncTimer.unref && syncTimer.unref();
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
  if (syncTimer) clearInterval(syncTimer);
  if (reinitTimer) clearTimeout(reinitTimer);
  db.close();
}

module.exports = {
  db,
  getOrCreateUser,
  getUser,
  getNetWorth,
  setWallet,
  setBank,
  addWallet,
  addBank,
  setStatus,
  clearStatus,
  setHidden,
  isHidden,
  getAllUsers,
  leaderboard,
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
  // Persistence
  initPersistence,
  syncInfo,
  close,
};