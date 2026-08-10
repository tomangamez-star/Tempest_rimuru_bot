#!/usr/bin/env node
/**
 * One-time migration: local SQLite (better-sqlite3) -> Postgres (Supabase).
 *
 * Reads every table from the bot's SQLite cache and upserts it into the
 * matching Postgres table using the exact schema/columns created by
 * src/db.js (PG_SCHEMA). Idempotent: safe to re-run (ON CONFLICT upserts).
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/migrate-sqlite-to-pg.js [--sqlite <path>] [--dry-run]
 *
 *   --sqlite <path>  Path to the SQLite DB file (default: ./data/rimuru.db,
 *                    or the DB_PATH env var).
 *   --dry-run        Connect, create schema, but do NOT write rows (prints
 *                    what WOULD be migrated).
 *
 * The connection string is read ONLY from the DATABASE_URL (or SUPABASE_URL)
 * environment variable. Never hardcode it.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ---- Resolve SQLite path (never auto-create the DB for a migration) ----
const argSqlite = (() => {
  const i = process.argv.indexOf('--sqlite');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const DRY_RUN = process.argv.includes('--dry-run');

const sqlitePath = argSqlite
  ? path.resolve(argSqlite)
  : path.resolve(process.env.DB_PATH || './data/rimuru.db');

const DATABASE_URL = (process.env.DATABASE_URL || process.env.SUPABASE_URL || '').trim();

if (!DATABASE_URL) {
  console.error('✖ DATABASE_URL is not set. Set it to your Postgres/Supabase connection string and re-run.');
  console.error('  Example: DATABASE_URL="postgresql://user:pass@host:5432/db" node scripts/migrate-sqlite-to-pg.js');
  process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`✖ SQLite DB not found at: ${sqlitePath}`);
  console.error('  If Render wiped the ephemeral disk, the old SQLite data is unrecoverable.');
  console.error('  Pass a valid file with --sqlite <path>, or set DB_PATH.');
  process.exit(1);
}

// ---- Load deps (pg + better-sqlite3 from the repo root) ----
const { Pool } = require('pg');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('✖ better-sqlite3 is not installed. Run: npm install');
  process.exit(1);
}

// ---- The exact Postgres schema used by src/db.js (must stay in sync) ----
// Kept here (not required from src/db.js) so the script runs standalone and
// never boots the full bot / never touches the live SQLite cache the bot uses.
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

/** Column list per table — mirrors TABLE_COLS in src/db.js (order matters). */
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

/**
 * Primary-key columns per table — used as the ON CONFLICT target.
 * Defaults to the first column; cooldowns has a COMPOSITE key (user_id, action).
 */
const PK_COLS = {
  users: ['user_id'],
  cooldowns: ['user_id', 'action'],
  lottery: ['id'],
  heists: ['leader_id'],
  chat_logs: ['id'],
  game_history: ['id'],
  admin_users: ['user_id'],
  bot_events: ['id'],
  broadcasts: ['id'],
  activity_feed: ['id'],
  audit_log: ['id'],
  inventory: ['user_id', 'item_id'],
};

/** Normalize a SQLite value for Postgres (BIGINT/BIGSERIAL/SMALLINT safety). */
function toPgValue(value, col) {
  if (value === null || value === undefined) return null;
  // IDs and numeric columns -> integers (SQLite may hand us JS numbers or bigints)
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
    return value; // beyond safe range -> keep as string (pg casts to bigint)
  }
  // booleans -> 0/1 for SMALLINT columns
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value; // TEXT stays TEXT
}

function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  SQLite → Postgres migration (Rimuru Tempest casino bot)');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  SQLite:   ${sqlitePath}`);
  console.log(`  Postgres: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`  Mode:     ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE (upsert all rows)'}`);
  console.log('');

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: DATABASE_URL.includes('supabase.co')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  const results = [];
  let failed = false;

  pool
    .connect()
    .then(async (client) => {
      try {
        // 1) Create schema (idempotent) — ensures the same tables exist.
        await client.query(PG_SCHEMA);
        console.log('✔ Postgres schema ready (tables created if missing).\n');

        // 2) Check which tables exist in SQLite.
        const sqliteTables = new Set(
          sqlite
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map((r) => r.name)
        );

        // 3) Migrate each known table that exists in SQLite.
        for (const [table, colsStr] of Object.entries(TABLE_COLS)) {
          if (!sqliteTables.has(table)) {
            console.log(`  ⚠ ${table.padEnd(14)} — not present in SQLite, skipping.`);
            results.push({ table, rows: 0, skipped: true });
            continue;
          }

          const cols = colsStr.split(', ');
          const pkCols = PK_COLS[table] || [cols[0]]; // primary key column(s)
          const rows = sqlite.prepare(`SELECT ${colsStr} FROM ${table}`).all();

          if (!rows.length) {
            console.log(`  • ${table.padEnd(14)} — 0 rows (nothing to migrate).`);
            results.push({ table, rows: 0 });
            continue;
          }

          if (DRY_RUN) {
            console.log(`  • ${table.padEnd(14)} — would migrate ${rows.length} rows (dry-run).`);
            results.push({ table, rows: rows.length, dryRun: true });
            continue;
          }

          // Upsert with a single multi-row statement per table (fast + atomic).
          const placeholders = rows
            .map((_, i) => `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(', ')})`)
            .join(', ');
          const conflictTarget = pkCols.join(', ');
          const updateCols = cols
            .filter((c) => !pkCols.includes(c))
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(', ');
          const values = [];
          for (const row of rows) {
            for (const c of cols) values.push(toPgValue(row[c], c));
          }

          await client.query('BEGIN');
          try {
            await client.query(
              `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}
               ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateCols}`,
              values
            );
            await client.query('COMMIT');
            console.log(`  ✔ ${table.padEnd(14)} — ${rows.length} rows upserted.`);
            results.push({ table, rows: rows.length });
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          }
        }

        // 4) Verify final counts vs SQLite.
        console.log('\n── Verification ──────────────────────────────────────');
        for (const [table, colsStr] of Object.entries(TABLE_COLS)) {
          if (!sqliteTables.has(table)) continue;
          const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
          if (DRY_RUN) continue;
          const { rows: pgRows } = await client.query(`SELECT COUNT(*) AS c FROM ${table}`);
          const pgCount = Number(pgRows[0].c);
          const ok = sqliteCount === pgCount;
          if (!ok) failed = true;
          console.log(
            `  ${ok ? '✔' : '✖'} ${table.padEnd(14)} sqlite=${sqliteCount}  postgres=${pgCount}  ${ok ? 'MATCH' : 'MISMATCH!'}`
          );
        }
      } finally {
        client.release();
      }
    })
    .then(() => {
      sqlite.close();
      return pool.end();
    })
    .then(() => {
      console.log('');
      if (DRY_RUN) {
        console.log('DRY-RUN complete — no rows were written. Remove --dry-run to migrate for real.');
      } else if (failed) {
        console.log('⚠ Migration finished WITH MISMATCHES — check the table rows above.');
        process.exitCode = 1;
      } else {
        console.log('✔ Migration complete. All tables match SQLite → Postgres.');
      }
      const total = results.reduce((s, r) => s + (r.rows || 0), 0);
      console.log(`  Total rows migrated: ${total}`);
    })
    .catch((err) => {
      console.error('\n✖ Migration failed:', err.message);
      sqlite.close();
      pool.end().catch(() => {});
      process.exit(1);
    });
}

main();
