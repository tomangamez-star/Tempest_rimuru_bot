'use strict';
/**
 * Rimuru Tempest Casino — database layer.
 * SQLite (better-sqlite3) is the fast read/write store; Postgres mirrors it
 * for durable persistence across Render redeploys.
 *
 * STARTUP ORDER (index.js drives it):
 *   1. initPg()                  — connect to Postgres
 *   2. ensurePgTables()          — create mirror tables if missing
 *   3. hydrateFromPg()           — HYDRATE SQLite FROM Postgres (durability!).
 *                                  Never let a fresh SQLite cache overwrite
 *                                  durable PG rows.
 *   4. acquireInstanceLock()     — advisory lock; only the lock holder may
 *                                  run the SQLite→PG mirror.
 *   5. setSyncEnabled(true)      — enable the write pipeline on the primary.
 *
 * The mirror (SQLite→PG) is gated on pgWritable && pgLockHeld && syncEnabled.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'rimuru.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ===================== Postgres setup ===================== */

let pgPool = null;
let pgClient = null; // dedicated session for advisory lock
let pgReady = false;
let pgConnected = false;
let pgWritable = true;
let pgHost = '';
let pgPort = 0;
let pgLastError = null;
let pgWritesOk = 0;
let pgWritesFailed = 0;
let pgLastWriteAt = null;
let pgLastVerifyAt = null;
let pgLastMirrorAt = null;
let pgMirrorQueue = [];
let pgMirrorRunning = false;
let pgRecoveryTimer = null;
let pgHeartbeatTimer = null;
let pgLockHeld = false;
let pgDegraded = false;
let syncEnabled = true; // SQLite writes allowed (mirror pipeline on)
let pgHydrated = false; // Postgres → SQLite hydration completed

const PG_CONFIGURED = !!config.databaseUrl;

if (PG_CONFIGURED) {
  try {
    const { Pool } = require('pg');
    const url = new URL(config.databaseUrl);
    pgHost = url.hostname;
    pgPort = Number(url.port || 5432);
    // Auto-enable TLS for supabase.co hosts
    const ssl = pgHost.includes('supabase.co') ? { rejectUnauthorized: false } : false;
    pgPool = new Pool({
      connectionString: config.databaseUrl,
      ssl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pgPool.on('error', (err) => {
      console.error('[db] PG pool error:', err.message);
      pgLastError = err;
      pgConnected = false;
      pgReady = false;
      pgWritable = false;
      pgDegraded = true;
    });
  } catch (e) {
    console.error('[db] PG init error:', e.message);
    pgLastError = e;
  }
}

/* ===================== TABLE REGISTRATION ===================== */

const TABLE_COLS = {
  users: 'user_id, username, first_name, wallet, bank, networth, rank, rank_valid_matches, rank_consecutive_losses, created_at, updated_at, status, status_reason, status_until, hidden_until, last_seen',
  game_history: 'id, user_id, username, game, bet, result, amount, played_at',
  cooldowns: 'user_id, action, expires_at',
  admin_users: 'user_id, username, role, password, added_by, added_at',
  chat_logs: 'id, user_id, username, first_name, chat_id, chat_title, text, is_command, created_at',
  activity_feed: 'id, type, message, data, created_at',
  audit_log: 'id, user_id, username, action, amount, details, created_at',
  lottery: 'id, pot, ticket_count, tickets',
  heists: 'leader_id, leader_name, target_id, target_name, members, started_at, status, expires_at, created_at',
  inventory: 'user_id, item_id, quantity',
  game_sessions: 'user_id, game, state, expires_at',
  backup_meta: 'id, filename, ts, user_count, total_coins, suspect, source',
  backup_data: 'id, backup_id, table_name, row_count, data',
  backups: 'id, filename, data, user_count, created_by, created_at',
  broadcast_queue: 'id, message, target, status, sent_count, created_by, created_at',
  events: 'id, title, description, type, reward, active, completions, starts_at, ends_at, created_by, created_at',
  mission_progress: 'user_id, mission_id, attempts, completed, last_attempt',
  redeem_codes: 'code, amount, used_count, max_uses, created_by, creator_role, created_at',
  redeem_claims: 'id, code, user_id, claimed_at',
  redeem_redemptions: 'code, user_id, redeemed_at',
  waifu_cache: 'character_id, name, series, image_url, bio, favorites, rarity, cached_at',
  waifu_claims: 'user_id, character_id, name, series, image_url, rarity, claimed_at',
  waifu_spawn: 'character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed',
  hunt_cache: 'character_id, name, series, image_url, bio, favorites, rarity, cached_at',
  hunt_claims: 'user_id, character_id, name, series, image_url, rarity, claimed_at',
  hunt_spawn: 'character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed',
  bot_memory: 'key, value, category, updated_at',
  settings: 'key, value, updated_at',
};

const TABLE_PKS = {
  users: 'user_id',
  game_history: 'id',
  cooldowns: 'user_id, action',
  admin_users: 'user_id',
  chat_logs: 'id',
  activity_feed: 'id',
  audit_log: 'id',
  lottery: 'id',
  heists: 'leader_id',
  inventory: 'user_id, item_id',
  game_sessions: 'user_id, game',
  backup_meta: 'id',
  backup_data: 'id',
  backups: 'id',
  broadcast_queue: 'id',
  events: 'id',
  mission_progress: 'user_id, mission_id',
  redeem_codes: 'code',
  redeem_claims: 'id',
  redeem_redemptions: 'code, user_id',
  waifu_cache: 'character_id',
  waifu_claims: 'character_id',
  waifu_spawn: 'character_id',
  hunt_cache: 'character_id',
  hunt_claims: 'character_id',
  hunt_spawn: 'character_id',
  bot_memory: 'key',
  settings: 'key',
};

/* ===================== SCHEMA (auto-create tables) ===================== */

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      wallet INTEGER DEFAULT 500000,
      bank INTEGER DEFAULT 0,
      networth INTEGER DEFAULT 500000,
      rank TEXT DEFAULT 'bronze',
      rank_valid_matches INTEGER DEFAULT 0,
      rank_consecutive_losses INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT '',
      status_reason TEXT DEFAULT '',
      status_until INTEGER DEFAULT 0,
      hidden_until INTEGER DEFAULT 0,
      last_seen INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT DEFAULT '',
      game TEXT,
      bet INTEGER DEFAULT 0,
      result TEXT,
      amount INTEGER DEFAULT 0,
      played_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cooldowns (
      user_id INTEGER,
      action TEXT,
      expires_at INTEGER,
      PRIMARY KEY (user_id, action)
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      user_id INTEGER PRIMARY KEY,
      username TEXT DEFAULT '',
      role TEXT DEFAULT 'mod',
      password TEXT DEFAULT '',
      added_by INTEGER,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      chat_id INTEGER NOT NULL DEFAULT 0,
      chat_title TEXT DEFAULT '',
      text TEXT DEFAULT '',
      is_command INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity_feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      message TEXT,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT DEFAULT '',
      action TEXT,
      amount INTEGER DEFAULT 0,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lottery (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pot INTEGER NOT NULL DEFAULT 0,
      ticket_count INTEGER NOT NULL DEFAULT 0,
      tickets TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS heists (
      leader_id INTEGER PRIMARY KEY,
      leader_name TEXT DEFAULT '',
      target_id INTEGER,
      target_name TEXT DEFAULT '',
      members TEXT DEFAULT '[]',
      started_at INTEGER,
      status TEXT DEFAULT 'open',
      expires_at INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inventory (
      user_id INTEGER,
      item_id TEXT,
      quantity INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS game_sessions (
      user_id INTEGER,
      game TEXT,
      state TEXT,
      expires_at INTEGER,
      PRIMARY KEY (user_id, game)
    );
    CREATE TABLE IF NOT EXISTS backup_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      ts INTEGER,
      user_count INTEGER,
      total_coins INTEGER,
      suspect INTEGER DEFAULT 0,
      source TEXT DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS backup_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_id INTEGER,
      table_name TEXT,
      row_count INTEGER,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      data TEXT NOT NULL,
      user_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS broadcast_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT,
      target TEXT DEFAULT 'all',
      status TEXT DEFAULT 'pending',
      sent_count INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      description TEXT DEFAULT '',
      type TEXT DEFAULT 'mission',
      reward INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      completions INTEGER DEFAULT 0,
      starts_at INTEGER DEFAULT 0,
      ends_at INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mission_progress (
      user_id INTEGER,
      mission_id INTEGER,
      attempts INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      last_attempt INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, mission_id)
    );
    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      amount INTEGER,
      used_count INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 1,
      created_by INTEGER,
      creator_role TEXT DEFAULT 'owner',
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS redeem_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      user_id INTEGER,
      claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS redeem_redemptions (
      code TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code, user_id)
    );
    CREATE TABLE IF NOT EXISTS waifu_cache (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      cached_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS waifu_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      character_id TEXT UNIQUE,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      rarity TEXT DEFAULT 'common',
      claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS waifu_spawn (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      expires_at INTEGER DEFAULT 0,
      chat_id INTEGER DEFAULT 0,
      claimed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hunt_cache (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      cached_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hunt_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      character_id TEXT UNIQUE,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      rarity TEXT DEFAULT 'common',
      claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hunt_spawn (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      expires_at INTEGER DEFAULT 0,
      chat_id INTEGER DEFAULT 0,
      claimed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bot_memory (
      key TEXT PRIMARY KEY,
      value TEXT,
      category TEXT DEFAULT 'general',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS time_wallet (
      user_id INTEGER,
      expires_at INTEGER DEFAULT 0,
      amount INTEGER DEFAULT 0,
      label TEXT DEFAULT '',
      PRIMARY KEY (user_id, expires_at)
    );
  `);

  // Add status_reason column to existing installs (idempotent migration).
  try {
    db.exec(`ALTER TABLE users ADD COLUMN status_reason TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  // Add rank_consecutive_losses column to existing installs (idempotent).
  try {
    db.exec(`ALTER TABLE users ADD COLUMN rank_consecutive_losses INTEGER DEFAULT 0`);
  } catch (e) { /* already exists */ }
  // Add sent_count column to existing broadcast_queue tables (idempotent).
  try {
    db.exec(`ALTER TABLE broadcast_queue ADD COLUMN sent_count INTEGER DEFAULT 0`);
  } catch (e) { /* already exists */ }
  // Add label column to existing time_wallet tables (idempotent).
  try {
    db.exec(`ALTER TABLE time_wallet ADD COLUMN label TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  // Add username/password columns to existing admin_users tables (idempotent).
  try {
    db.exec(`ALTER TABLE admin_users ADD COLUMN username TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE admin_users ADD COLUMN password TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  // Add events columns to existing installs (idempotent).
  try {
    db.exec(`ALTER TABLE events ADD COLUMN active INTEGER DEFAULT 1`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN completions INTEGER DEFAULT 0`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN starts_at INTEGER DEFAULT 0`);
  } catch (e) { /* already exists */ }
  // Chat logs schema drift fix: add missing columns (idempotent).
  try {
    db.exec(`ALTER TABLE chat_logs ADD COLUMN first_name TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE chat_logs ADD COLUMN chat_title TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE chat_logs ADD COLUMN text TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE chat_logs ADD COLUMN is_command INTEGER DEFAULT 0`);
  } catch (e) { /* already exists */ }
  // Copy legacy chat_logs.message into text where text is empty (idempotent, safe).
  try {
    db.exec(`UPDATE chat_logs SET text = message WHERE (text IS NULL OR text = '') AND message IS NOT NULL AND message != ''`);
  } catch (e) { /* column may not exist on fresh installs */ }
}

createTables();

/* ===================== HELPER: prepared statements ===================== */

function prep(sql) {
  return db.prepare(sql);
}

/* ===================== USER / ECONOMY ===================== */

function getOrCreateUser(userId, meta = {}) {
  const row = prep('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (row) {
    // Update mutable display fields only when provided; keep economy intact.
    const updates = [];
    const params = [];
    if (meta.username && meta.username !== row.username) {
      updates.push('username = ?');
      params.push(meta.username);
    }
    if (meta.first_name && meta.first_name !== row.first_name) {
      updates.push('first_name = ?');
      params.push(meta.first_name);
    }
    if (updates.length) {
      params.push(userId);
      prep(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`).run(...params);
    }
    return prep('SELECT * FROM users WHERE user_id = ?').get(userId);
  }
  prep(
    'INSERT INTO users (user_id, username, first_name, wallet, bank, networth) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, meta.username || '', meta.first_name || '', config.startBalance, 0, config.startBalance);
  return prep('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function getUser(userId) {
  return prep('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function addWallet(userId, amount) {
  prep('UPDATE users SET wallet = wallet + ?, networth = networth + ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
}

function addBank(userId, amount) {
  prep('UPDATE users SET bank = bank + ?, networth = networth + ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
}

function setNetworth(userId, amount) {
  prep('UPDATE users SET wallet = ?, bank = 0, networth = ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
}

function setWallet(userId, amount) {
  prep('UPDATE users SET wallet = ?, networth = bank + ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
}

function setBank(userId, amount) {
  prep('UPDATE users SET bank = ?, networth = wallet + ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
}

function getNetWorth(userId) {
  const u = prep('SELECT networth, wallet, bank FROM users WHERE user_id = ?').get(userId);
  return u ? (u.networth || u.wallet + u.bank) : 0;
}

function findUserByUsername(username) {
  return prep('SELECT * FROM users WHERE lower(username) = lower(?) LIMIT 1').get(username);
}

function leaderboard(limit = 10) {
  return prep('SELECT * FROM users ORDER BY networth DESC LIMIT ?').all(limit);
}

function leaderboardCount(limit = 100) {
  return prep('SELECT * FROM users ORDER BY networth DESC LIMIT ?').all(limit);
}

function dashboardStats() {
  const users = prep('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers = prep("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c;
  const banned = prep("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'").get().c;
  const muted = prep("SELECT COUNT(*) AS c FROM users WHERE status IN ('muted','suspected')").get().c;
  let groups = 0;
  try {
    groups = prep('SELECT COUNT(DISTINCT chat_id) AS c FROM chat_logs WHERE chat_id < 0').get().c;
  } catch (e) { /* chat_id may be non-numeric on some rows */ }
  const coins = prep('SELECT COALESCE(SUM(wallet),0) AS w, COALESCE(SUM(bank),0) AS b FROM users').get();
  const totalCoins = (Number(coins.w) || 0) + (Number(coins.b) || 0);
  const games = prep('SELECT COUNT(*) AS c FROM game_history').get().c;
  const msgs = prep('SELECT COUNT(*) AS c FROM chat_logs').get().c;
  const lottery = prep('SELECT * FROM lottery WHERE id = 1').get();
  const lot = lottery ? Number(lottery.pot) || 0 : 0;
  const topUsers = prep('SELECT * FROM users ORDER BY networth DESC LIMIT 10').all().map((r) => ({
    user_id: Number(r.user_id),
    username: r.username || '',
    first_name: r.first_name || '',
    wallet: Number(r.wallet) || 0,
    bank: Number(r.bank) || 0,
    networth: Number(r.networth) || 0,
  }));
  return {
    totalUsers: Number(users) || 0,
    activeUsers: Number(activeUsers) || 0,
    bannedUsers: Number(banned) || 0,
    mutedUsers: Number(muted) || 0,
    totalGroups: Number(groups) || 0,
    coinsInCirculation: totalCoins,
    coinsWallet: Number(coins.w) || 0,
    coinsBank: Number(coins.b) || 0,
    totalGames: Number(games) || 0,
    totalMessages: Number(msgs) || 0,
    lotteryPot: lot,
    topUsers,
    // legacy aliases (some callers use the old shape)
    users: Number(users) || 0,
    totalCoins,
  };
}

function getCooldownCount() {
  return prep('SELECT COUNT(*) AS c FROM cooldowns').get().c;
}

function getAllUsers() {
  return prep('SELECT * FROM users ORDER BY networth DESC').all();
}

function listUsersByNetWorth(limit = 100) {
  return prep('SELECT * FROM users ORDER BY networth DESC LIMIT ?').all(limit);
}

function searchUsers(q, limit = 20) {
  const like = `%${String(q || '').toLowerCase()}%`;
  return prep('SELECT * FROM users WHERE lower(username) LIKE ? OR lower(first_name) LIKE ? OR CAST(user_id AS TEXT) LIKE ? ORDER BY networth DESC LIMIT ?')
    .all(like, like, like, limit);
}

function getUserCooldowns(userId) {
  return prep('SELECT * FROM cooldowns WHERE user_id = ? ORDER BY expires_at DESC').all(userId);
}

function setRankStats(userId, rank, validMatches, losses) {
  prep('UPDATE users SET rank = ?, rank_valid_matches = ?, rank_consecutive_losses = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
    .run(rank, validMatches || 0, losses || 0, userId);
}

/* ===================== ADMIN / PENALTIES ===================== */

function isAdminUser(userId) {
  const row = prep('SELECT * FROM admin_users WHERE user_id = ?').get(userId);
  return !!row;
}

function addAdminUser(userId, username, role, password, addedBy) {
  prep('INSERT INTO admin_users (user_id, username, role, password, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, role = excluded.role, password = excluded.password')
    .run(userId, username || '', role || 'mod', password || '', addedBy || 0);
}

function getAdminUser(userId) {
  return prep('SELECT * FROM admin_users WHERE user_id = ?').get(userId);
}

function listAdminUsers() {
  return prep('SELECT * FROM admin_users ORDER BY added_at DESC').all();
}

function setAdminLastLogin(userId) {
  prep('UPDATE admin_users SET added_at = datetime(\'now\') WHERE user_id = ?').run(userId);
}

function removeAdminUser(userId) {
  prep('DELETE FROM admin_users WHERE user_id = ?').run(userId);
}

function getUserStatus(userId) {
  return prep('SELECT status, status_until, status_reason FROM users WHERE user_id = ?').get(userId);
}

function setStatus(userId, status, reason, until = 0) {
  prep('UPDATE users SET status = ?, status_until = ?, status_reason = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
    .run(status, until, reason || '', userId);
}

function clearStatus(userId) {
  prep('UPDATE users SET status = \'\', status_until = 0, status_reason = \'\', updated_at = datetime(\'now\') WHERE user_id = ?').run(userId);
}

function expirePenalties() {
  const rows = prep('SELECT user_id, status, status_until FROM users WHERE status != \'\' AND status_until > 0 AND status_until <= ?').all(Date.now());
  const expired = [];
  for (const r of rows) {
    prep('UPDATE users SET status = \'\', status_until = 0, status_reason = \'\' WHERE user_id = ?').run(r.user_id);
    expired.push({ user_id: r.user_id, status: r.status });
  }
  return expired;
}

/* ===================== COOLDOWNS ===================== */

function getCooldown(userId, action) {
  const row = prep('SELECT expires_at FROM cooldowns WHERE user_id = ? AND action = ?').get(userId, action);
  if (!row) return 0;
  const until = Number(row.expires_at) || 0;
  if (until > 0 && until <= Date.now()) {
    prep('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
    return 0;
  }
  return until;
}

function setCooldown(userId, action, expiresAt) {
  prep('INSERT INTO cooldowns (user_id, action, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id, action) DO UPDATE SET expires_at = excluded.expires_at').run(userId, action, expiresAt);
}

function clearAllCooldowns() {
  prep('DELETE FROM cooldowns').run();
}

function clearCooldown(userId, action) {
  prep('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
  pgRun('cooldowns', 'DELETE FROM cooldowns WHERE user_id = $1 AND action = $2', [userId, action]);
}

/* ===================== LOTTERY ===================== */

function getLottery() {
  let row = prep('SELECT * FROM lottery WHERE id = 1').get();
  if (!row) {
    prep('INSERT INTO lottery (id, pot, ticket_count, tickets) VALUES (1, ?, 0, ?)').run(config.lottery.baseJackpot || 5000000, '[]');
    row = prep('SELECT * FROM lottery WHERE id = 1').get();
  }
  row.tickets = JSON.parse(row.tickets || '[]');
  row.pot = Number(row.pot) || 0;
  row.ticket_count = Number(row.ticket_count) || 0;
  return row;
}

function saveLottery(pot, ticketCount, tickets) {
  prep('UPDATE lottery SET pot = ?, ticket_count = ?, tickets = ? WHERE id = 1')
    .run(pot, ticketCount, JSON.stringify(tickets || []));
  queuePgWrite('lottery', [1, pot, ticketCount, JSON.stringify(tickets || [])]);
}

/* ===================== HEISTS ===================== */

function getOpenHeists() {
  return prep('SELECT * FROM heists WHERE status = \'open\'').all().map((row) => {
    try { row.members = JSON.parse(row.members || '[]'); } catch (e) { row.members = []; }
    return row;
  });
}

function getHeist(leaderId) {
  const row = prep('SELECT * FROM heists WHERE leader_id = ?').get(leaderId);
  if (!row) return null;
  try { row.members = JSON.parse(row.members || '[]'); } catch (e) { row.members = []; }
  return row;
}

function saveHeist(leaderId, targetId, members, status, expiresAt) {
  prep('INSERT INTO heists (leader_id, target_id, members, status, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(leader_id) DO UPDATE SET target_id = excluded.target_id, members = excluded.members, status = excluded.status, expires_at = excluded.expires_at')
    .run(leaderId, targetId, JSON.stringify(members || []), status || 'open', expiresAt || 0);
}

function createHeist(heist) {
  prep('INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(leader_id) DO UPDATE SET leader_name = excluded.leader_name, target_id = excluded.target_id, target_name = excluded.target_name, members = excluded.members, started_at = excluded.started_at, status = excluded.status')
    .run(
      heist.leader_id,
      heist.leader_name || '',
      heist.target_id,
      heist.target_name || '',
      JSON.stringify(heist.members || []),
      heist.started_at || Date.now(),
      heist.status || 'open'
    );
  queuePgWrite('heists', [
    heist.leader_id,
    heist.leader_name || '',
    heist.target_id,
    heist.target_name || '',
    JSON.stringify(heist.members || []),
    heist.started_at || Date.now(),
    heist.status || 'open',
    heist.expires_at || 0,
    null, // created_at (PG column exists via TABLE_COLS)
  ]);
}

function updateHeistMembers(leaderId, members) {
  prep('UPDATE heists SET members = ? WHERE leader_id = ?').run(JSON.stringify(members || []), leaderId);
}

function updateHeistStatus(leaderId, status) {
  prep('UPDATE heists SET status = ? WHERE leader_id = ?').run(status, leaderId);
}

function deleteHeist(leaderId) {
  prep('DELETE FROM heists WHERE leader_id = ?').run(leaderId);
}

/* ===================== INVENTORY ===================== */

function getInventory(userId) {
  return prep('SELECT * FROM inventory WHERE user_id = ?').all(userId);
}

function addInventory(userId, itemId, qty = 1) {
  prep('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + ?').run(userId, itemId, qty, qty);
}

function removeInventory(userId, itemId, qty = 1) {
  const row = prep('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  if (!row) return false;
  if (row.quantity <= qty) {
    prep('DELETE FROM inventory WHERE user_id = ? AND item_id = ?').run(userId, itemId);
  } else {
    prep('UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?').run(qty, userId, itemId);
  }
  return true;
}

function hasItem(userId, itemId) {
  const row = prep('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  return !!row;
}

function getItemQty(userId, itemId) {
  const row = prep('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  return row ? row.quantity : 0;
}

function addItem(userId, itemId, qty = 1) {
  addInventory(userId, itemId, qty);
}

/* ===================== GAME SESSIONS ===================== */

function getGameSession(userId, game) {
  const row = prep('SELECT * FROM game_sessions WHERE user_id = ? AND game = ?').get(userId, game);
  if (!row) return null;
  if (row.expires_at > 0 && row.expires_at <= Date.now()) {
    prep('DELETE FROM game_sessions WHERE user_id = ? AND game = ?').run(userId, game);
    return null;
  }
  try { row.state = JSON.parse(row.state); } catch (e) {}
  return row;
}

function setGameSession(userId, game, state, expiresAt = 0) {
  prep('INSERT INTO game_sessions (user_id, game, state, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, game) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at')
    .run(userId, game, JSON.stringify(state || {}), expiresAt);
}

function deleteGameSession(userId, game) {
  prep('DELETE FROM game_sessions WHERE user_id = ? AND game = ?').run(userId, game);
}

/* ===================== LOGGING ===================== */

function logGameHistory(data) {
  prep('INSERT INTO game_history (user_id, username, game, bet, result, amount) VALUES (?, ?, ?, ?, ?, ?)')
    .run(data.user_id, data.username || '', data.game || '', data.bet || 0, data.result || '', data.amount || 0);
}

function logActivity(type, message, data = {}) {
  prep('INSERT INTO activity_feed (type, message, data) VALUES (?, ?, ?)').run(type, message, JSON.stringify(data || {}));
}

function logAudit(userId, username, action, amount, details) {
  prep('INSERT INTO audit_log (user_id, username, action, amount, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId, username || '', action || '', amount || 0, details || '');
}

function logChat(msg) {
  if (!msg || !msg.from) return;
  const text = String(msg.text || msg.caption || '');
  if (!text) return;
  prep('INSERT INTO chat_logs (user_id, username, first_name, chat_id, chat_title, text, is_command) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      msg.from.id || 0,
      msg.from.username || '',
      msg.from.first_name || '',
      msg.chat ? msg.chat.id : 0,
      msg.chat ? (msg.chat.title || '') : '',
      text.slice(0, 500),
      text.startsWith('/') ? 1 : 0
    );
}

function getChatLogs(limit = 100, userId = null) {
  const rows = userId
    ? prep('SELECT * FROM chat_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    : prep('SELECT * FROM chat_logs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), chat_id: Number(r.chat_id), is_command: Number(r.is_command) || 0 }));
}

function getGameHistory(limit = 100) {
  return prep('SELECT * FROM game_history ORDER BY id DESC LIMIT ?').all(limit);
}

function getAuditLog(limit = 100) {
  return prep('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

function getActivity(limit = 100) {
  return prep('SELECT * FROM activity_feed ORDER BY id DESC LIMIT ?').all(limit);
}

/* ===================== SEEN CHAT IDS ===================== */

function getSeenChatIds() {
  return prep('SELECT DISTINCT chat_id FROM chat_logs WHERE chat_id IS NOT NULL').all().map((r) => r.chat_id);
}

/* ===================== BROADCAST ===================== */

function createBroadcast(message, target, createdBy) {
  const info = prep('INSERT INTO broadcast_queue (message, target, status, created_by) VALUES (?, ?, \'pending\', ?)').run(message, target || 'all', createdBy || 0);
  return { id: Number(info.lastInsertRowid), message, target: target || 'all', status: 'pending', created_by: createdBy || 0 };
}

function getPendingBroadcasts() {
  return prep('SELECT * FROM broadcast_queue WHERE status = \'pending\' ORDER BY id ASC').all();
}

function markBroadcastDone(id) {
  prep('UPDATE broadcast_queue SET status = \'done\' WHERE id = ?').run(id);
}

function listBroadcasts(limit = 50) {
  return prep('SELECT * FROM broadcast_queue ORDER BY id DESC LIMIT ?').all(limit);
}

function updateBroadcastCount(id, count) {
  prep('UPDATE broadcast_queue SET sent_count = ? WHERE id = ?').run(count || 0, id);
}

/* ===================== EVENTS ===================== */

function createEvent(data) {
  const info = prep('INSERT INTO events (title, description, type, reward, active, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      data.title || '',
      data.description || '',
      data.type || 'mission',
      data.reward || 0,
      data.active === undefined ? 1 : (data.active ? 1 : 0),
      data.starts_at || 0,
      data.ends_at || 0,
      data.created_by || 0
    );
  return prep('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid));
}

function mapEvent(row) {
  if (!row) return row;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    type: row.type || 'mission',
    reward: Number(row.reward) || 0,
    active: row.active === undefined ? 1 : Number(row.active),
    completions: Number(row.completions) || 0,
    starts_at: Number(row.starts_at) || 0,
    ends_at: Number(row.ends_at) || 0,
    created_by: Number(row.created_by) || 0,
    created_at: row.created_at,
  };
}

function getActiveEvents() {
  const now = Date.now();
  return prep('SELECT * FROM events WHERE active = 1 AND (starts_at = 0 OR starts_at <= ?) AND (ends_at = 0 OR ends_at > ?) ORDER BY id DESC').all(now, now).map(mapEvent);
}

function activeEvents() {
  return getActiveEvents();
}

function listEvents(limit = 50) {
  return prep('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map(mapEvent);
}

function updateEvent(id, data) {
  const ev = prep('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) return null;
  prep(`UPDATE events SET title = ?, description = ?, type = ?, reward = ?, active = ?, starts_at = ?, ends_at = ? WHERE id = ?`)
    .run(
      data.title !== undefined ? data.title : ev.title,
      data.description !== undefined ? data.description : ev.description,
      data.type !== undefined ? data.type : ev.type,
      data.reward !== undefined ? data.reward : ev.reward,
      data.active !== undefined ? (data.active ? 1 : 0) : ev.active,
      data.starts_at !== undefined ? data.starts_at : ev.starts_at,
      data.ends_at !== undefined ? data.ends_at : ev.ends_at,
      id
    );
  return mapEvent(prep('SELECT * FROM events WHERE id = ?').get(id));
}

function deleteEvent(id) {
  prep('DELETE FROM events WHERE id = ?').run(id);
  pgRun('events', 'DELETE FROM events WHERE id = $1', [id]);
}

function incrementEventCompletions(id) {
  prep('UPDATE events SET completions = completions + 1 WHERE id = ?').run(id);
  pgRun('events', 'UPDATE events SET completions = completions + 1 WHERE id = $1', [id]);
}

function activeEvents() {
  return getActiveEvents();
}

/* ===================== MISSION PROGRESS ===================== */

function getMissionProgress(userId, missionId) {
  return prep('SELECT * FROM mission_progress WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
}

function upsertMissionProgress(userId, missionId, data) {
  const row = prep('SELECT * FROM mission_progress WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
  if (row) {
    prep('UPDATE mission_progress SET attempts = ?, completed = ?, last_attempt = ? WHERE user_id = ? AND mission_id = ?')
      .run(data.attempts !== undefined ? data.attempts : row.attempts, data.completed !== undefined ? data.completed : row.completed, Date.now(), userId, missionId);
  } else {
    prep('INSERT INTO mission_progress (user_id, mission_id, attempts, completed, last_attempt) VALUES (?, ?, ?, ?, ?)')
      .run(userId, missionId, data.attempts || 0, data.completed || 0, Date.now());
  }
}

/* ===================== REDEEM CODES ===================== */

function getRedeemCode(code) {
  const row = prep('SELECT * FROM redeem_codes WHERE code = ?').get(String(code || '').trim().toUpperCase());
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

function createRedeemCode(code, amount, maxUses, createdBy, creatorRole = 'owner') {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  try {
    prep('INSERT INTO redeem_codes (code, amount, max_uses, used_count, created_by, creator_role, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .run(c, amount, maxUses || 1, createdBy || 0, creatorRole || 'owner', Date.now());
  } catch (e) {
    return null; // duplicate code (PRIMARY KEY)
  }
  const row = prep('SELECT * FROM redeem_codes WHERE code = ?').get(c);
  queuePgWrite('redeem_codes', [c, amount, 0, maxUses || 1, createdBy || 0, creatorRole || 'owner', Date.now()]);
  return row;
}

function useRedeemCode(code) {
  const row = getRedeemCode(code);
  if (!row) return null;
  if (row.used_count >= row.max_uses) return null;
  prep('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  return getRedeemCode(code);
}

function deleteRedeemCode(code) {
  const c = String(code || '').trim().toUpperCase();
  const r = prep('DELETE FROM redeem_codes WHERE code = ?').run(c);
  pgRun('redeem_codes', 'DELETE FROM redeem_codes WHERE code = $1', [c]);
  return r.changes > 0;
}

function listRedeemCodes() {
  return prep('SELECT * FROM redeem_codes ORDER BY created_at DESC').all().map((row) => ({
    code: row.code,
    amount: Number(row.amount) || 0,
    max_uses: Number(row.max_uses) || 0,
    used_count: Number(row.used_count) || 0,
    created_by: Number(row.created_by) || 0,
    creator_role: row.creator_role || 'owner',
    created_at: Number(row.created_at) || 0,
  }));
}

function addRedeemClaim(code, userId) {
  const c = String(code || '').trim().toUpperCase();
  try {
    prep('INSERT INTO redeem_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').run(c, userId, Date.now());
    prep('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?').run(c);
    pgRun(
      'redeem_redemptions',
      `INSERT INTO redeem_redemptions (code, user_id, redeemed_at) VALUES ($1, $2, $3) ON CONFLICT (code, user_id) DO NOTHING`,
      [c, userId, Date.now()]
    );
    pgRun('redeem_codes', 'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = $1', [c]);
    return true;
  } catch (e) {
    return false; // already redeemed (PRIMARY KEY)
  }
}

function hasRedeemClaim(code, userId) {
  return !!prep('SELECT 1 FROM redeem_redemptions WHERE code = ? AND user_id = ?').get(String(code || '').trim().toUpperCase(), userId);
}

/* ===================== REDEEM: legacy aliases ===================== */

function hasRedeemed(userId, code) {
  return hasRedeemClaim(code, userId);
}

function recordRedemption(userId, code) {
  return addRedeemClaim(code, userId);
}

/* ===================== TIME WALLET (timed rank rewards) ===================== */

function addTimeWallet(userId, amount, expiresAt, label) {
  prep('INSERT INTO time_wallet (user_id, amount, expires_at, label) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, expires_at) DO UPDATE SET amount = amount + ?')
    .run(userId, amount, expiresAt || 0, label || '', amount);
}

function getTimeWalletRow(userId, now) {
  const rows = prep('SELECT * FROM time_wallet WHERE user_id = ?').all(userId);
  let amount = 0;
  const ts = now == null ? Date.now() : now;
  for (const r of rows) {
    if (r.expires_at > 0 && r.expires_at <= ts) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
    } else {
      amount += r.amount;
    }
  }
  return { user_id: userId, amount };
}

function getTimeWalletBalance(userId, now) {
  const row = getTimeWalletRow(userId, now);
  return row ? row.amount : 0;
}

function spendTimeWallet(userId, amount, now) {
  const rows = prep('SELECT * FROM time_wallet WHERE user_id = ? ORDER BY expires_at ASC').all(userId);
  let remaining = amount;
  let spent = 0;
  const ts = now == null ? Date.now() : now;
  for (const r of rows) {
    if (remaining <= 0) break;
    if (r.expires_at > 0 && r.expires_at <= ts) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
      continue;
    }
    const use = Math.min(r.amount, remaining);
    remaining -= use;
    spent += use;
    if (r.amount - use <= 0) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
    } else {
      prep('UPDATE time_wallet SET amount = amount - ? WHERE user_id = ? AND expires_at = ?').run(use, userId, r.expires_at);
    }
  }
  return { spent, remaining };
}

function sweepExpiredTimeWallet(now) {
  const ts = now == null ? Date.now() : now;
  const info = prep('DELETE FROM time_wallet WHERE expires_at > 0 AND expires_at <= ?').run(ts);
  return Number(info.changes) || 0;
}

/* ===================== WAIFU / HUNT SPAWN (alias to active-card API) ===================== */

function getActiveSpawn() {
  return getActiveWaifu();
}

function setActiveSpawn(card, expiresAt, chatId) {
  setActiveWaifu(card, expiresAt, chatId);
}

function clearActiveSpawn() {
  clearActiveWaifu();
}

function claimCharacter(userId, char) {
  return claimWaifuCharacter(userId, char);
}

function isCharacterClaimed(characterId) {
  return isWaifuCharacterClaimed(characterId);
}

/* ===================== WAIFU COLLECTION ===================== */

function getActiveWaifu() {
  const row = prep('SELECT * FROM waifu_spawn WHERE claimed = 0 AND expires_at > ? ORDER BY expires_at ASC LIMIT 1').get(Date.now());
  return row || null;
}

function setActiveWaifu(card, expiresAt, chatId) {
  prep('INSERT INTO waifu_spawn (character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(character_id) DO UPDATE SET name = excluded.name, series = excluded.series, image_url = excluded.image_url, bio = excluded.bio, favorites = excluded.favorites, rarity = excluded.rarity, expires_at = excluded.expires_at, chat_id = excluded.chat_id, claimed = excluded.claimed')
    .run(card.character_id || card.id, card.name || '', card.series || '', card.image_url || '', card.bio || '', card.favorites || 0, card.rarity || 'common', expiresAt || 0, chatId || 0);
}

function clearActiveWaifu() {
  prep('DELETE FROM waifu_spawn').run();
}

function claimWaifuCharacter(userId, char) {
  const characterId = char.character_id || char.id;
  if (!characterId) return null;
  const now = Date.now();
  let row;
  try {
    prep('INSERT INTO waifu_claims (user_id, character_id, name, series, image_url, rarity, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, characterId, char.name || '', char.series || '', char.image_url || '', char.rarity || 'common', now);
    row = prep('SELECT * FROM waifu_claims WHERE character_id = ?').get(characterId);
  } catch (e) {
    return null; // duplicate claim (UNIQUE on character_id)
  }
  try { prep('UPDATE waifu_spawn SET claimed = 1 WHERE character_id = ?').run(characterId); } catch (e) { /* non-fatal */ }
  return row;
}

function getUserCollection(userId) {
  return prep('SELECT * FROM waifu_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
}

function getUserCharacters(userId) {
  return getUserCollection(userId);
}

function getUserCharacterByIndex(userId, index) {
  const rows = prep('SELECT * FROM waifu_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
  const i = (index || 1) - 1;
  return rows[i] || null;
}

function getCharacterByName(userId, name) {
  return prep('SELECT * FROM waifu_claims WHERE user_id = ? AND lower(name) LIKE lower(?) LIMIT 1').get(userId, `%${name}%`);
}

function getWaifuLeaderboard(limit = 10) {
  return prep('SELECT w.user_id, u.username, u.first_name, COUNT(*) AS count FROM waifu_claims w LEFT JOIN users u ON u.user_id = w.user_id GROUP BY w.user_id ORDER BY count DESC LIMIT ?').all(limit);
}

function isWaifuCharacterClaimed(characterId) {
  return !!prep('SELECT * FROM waifu_claims WHERE character_id = ?').get(characterId);
}

/* ===================== HUNT COLLECTION ===================== */

function getActiveHunt() {
  const row = prep('SELECT * FROM hunt_spawn WHERE claimed = 0 AND expires_at > ? ORDER BY expires_at ASC LIMIT 1').get(Date.now());
  return row || null;
}

function setActiveHunt(card, expiresAt, chatId) {
  prep('INSERT INTO hunt_spawn (character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(character_id) DO UPDATE SET name = excluded.name, series = excluded.series, image_url = excluded.image_url, bio = excluded.bio, favorites = excluded.favorites, rarity = excluded.rarity, expires_at = excluded.expires_at, chat_id = excluded.chat_id, claimed = excluded.claimed')
    .run(card.character_id || card.id, card.name || '', card.series || '', card.image_url || '', card.bio || '', card.favorites || 0, card.rarity || 'common', expiresAt || 0, chatId || 0);
}

function clearActiveHunt() {
  prep('DELETE FROM hunt_spawn').run();
}

function claimHuntCharacter(userId, char) {
  const characterId = char.character_id || char.id;
  if (!characterId) return null;
  const now = Date.now();
  let row;
  try {
    prep('INSERT INTO hunt_claims (user_id, character_id, name, series, image_url, rarity, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, characterId, char.name || '', char.series || '', char.image_url || '', char.rarity || 'common', now);
    row = prep('SELECT * FROM hunt_claims WHERE character_id = ?').get(characterId);
  } catch (e) {
    return null; // duplicate claim (UNIQUE on character_id)
  }
  try { prep('UPDATE hunt_spawn SET claimed = 1 WHERE character_id = ?').run(characterId); } catch (e) { /* non-fatal */ }
  return row;
}

function getHuntCollection(userId) {
  return prep('SELECT * FROM hunt_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
}

function getUserHuntCharacters(userId) {
  return getHuntCollection(userId);
}

function getHuntCharacterByIndex(userId, index) {
  const rows = prep('SELECT * FROM hunt_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
  const i = (index || 1) - 1;
  return rows[i] || null;
}

function getHuntLeaderboard(limit = 10) {
  return prep('SELECT h.user_id, u.username, u.first_name, COUNT(*) AS count FROM hunt_claims h LEFT JOIN users u ON u.user_id = h.user_id GROUP BY h.user_id ORDER BY count DESC LIMIT ?').all(limit);
}

function isHuntCharacterClaimed(characterId) {
  return !!prep('SELECT * FROM hunt_claims WHERE character_id = ?').get(characterId);
}

function cacheHuntCharacter(card) {
  prep('INSERT INTO hunt_cache (character_id, name, series, image_url, bio, favorites, rarity) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET name = excluded.name, series = excluded.series, image_url = excluded.image_url, bio = excluded.bio, favorites = excluded.favorites, rarity = excluded.rarity')
    .run(card.character_id || card.id, card.name || '', card.series || '', card.image_url || '', card.bio || '', card.favorites || 0, card.rarity || 'common');
}

function getCachedHuntCharacter(characterId) {
  return prep('SELECT * FROM hunt_cache WHERE character_id = ?').get(characterId);
}

function getHuntPool(limit = 10) {
  return prep('SELECT * FROM hunt_cache ORDER BY favorites DESC LIMIT ?').all(limit);
}

/* ===================== ATTACK ===================== */

function getAttackEligibleUsers() {
  const now = Date.now();
  return prep('SELECT * FROM users WHERE status = \'\' AND (hidden_until = 0 OR hidden_until <= ?) AND last_seen > ? ORDER BY networth DESC')
    .all(now, now - 7 * 24 * 3600 * 1000);
}

/* ===================== BOT MEMORY ===================== */

function setMemory(key, value, category = 'general') {
  prep('INSERT INTO bot_memory (key, value, category, updated_at) VALUES (?, ?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = datetime(\'now\')')
    .run(key, value, category);
}

function getMemory(key) {
  return prep('SELECT * FROM bot_memory WHERE key = ?').get(key);
}

function getMemoriesByCategory(category) {
  return prep('SELECT * FROM bot_memory WHERE category = ? ORDER BY updated_at DESC').all(category);
}

function deleteMemory(key) {
  prep('DELETE FROM bot_memory WHERE key = ?').run(key);
}

/* ===================== BOT STATE ===================== */

function setBotPaused(paused) {
  setSetting('bot_paused', paused ? '1' : '0');
}

function getBotPaused() {
  const v = getSetting('bot_paused');
  return v === '1' || v === 'true';
}

function getSetting(key) {
  const row = prep('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const now = Date.now();
  prep('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, String(value == null ? '' : value), now);
  pgRun(
    'settings',
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, String(value == null ? '' : value), now]
  );
}

/* ===================== HIDE ===================== */

function setHidden(userId, until) {
  prep('UPDATE users SET hidden_until = ? WHERE user_id = ?').run(until, userId);
}

function isHidden(userId) {
  const row = prep('SELECT hidden_until FROM users WHERE user_id = ?').get(userId);
  return row && row.hidden_until > Date.now();
}

/* ===================== PING ===================== */

function ping() {
  const start = Date.now();
  prep('SELECT 1').get();
  return Date.now() - start;
}

/* ===================== POSTGRES MIRROR ===================== */

function syncInfo() {
  return {
    configured: PG_CONFIGURED,
    ready: pgReady,
    connected: pgConnected,
    writable: pgWritable,
    host: pgHost,
    port: pgPort,
    lastPgError: pgLastError ? pgLastError.message : null,
    writesOk: pgWritesOk,
    writesFailed: pgWritesFailed,
    lastWriteAt: pgLastWriteAt,
    lastVerifyAt: pgLastVerifyAt,
    lastMirrorAt: pgLastMirrorAt,
    degraded: pgDegraded,
    lockHeld: pgLockHeld,
    instanceLockHeld: pgLockHeld,
    hydrated: pgHydrated,
    syncEnabled,
  };
}

const PG_LOCK_KEY = 0x52494d55; // "RIMU" — must match index.js

async function acquireInstanceLock(lockKey = PG_LOCK_KEY) {
  if (!PG_CONFIGURED || !pgPool) return false;
  try {
    pgClient = await pgPool.connect();
    const res = await pgClient.query('SELECT pg_try_advisory_lock($1) as locked', [Number(lockKey)]);
    pgLockHeld = res.rows[0]?.locked === true;
    if (pgLockHeld) {
      console.log('[db] PG advisory lock acquired');
      // Start heartbeat
      if (pgHeartbeatTimer) clearInterval(pgHeartbeatTimer);
      pgHeartbeatTimer = setInterval(async () => {
        try {
          await pgClient.query('SELECT 1');
        } catch (e) {
          console.error('[db] PG heartbeat lost:', e.message);
          pgLockHeld = false;
          pgWritable = false;
          pgDegraded = true;
        }
      }, 10000);
      pgHeartbeatTimer.unref && pgHeartbeatTimer.unref();
    } else {
      console.warn('[db] PG advisory lock NOT acquired — another instance holds it');
      pgClient.release();
      pgClient = null;
    }
    return pgLockHeld;
  } catch (e) {
    console.error('[db] acquireInstanceLock error:', e.message);
    pgLastError = e;
    return false;
  }
}

async function releaseInstanceLock(lockKey = PG_LOCK_KEY) {
  if (pgHeartbeatTimer) { clearInterval(pgHeartbeatTimer); pgHeartbeatTimer = null; }
  if (pgClient) {
    try {
      await pgClient.query('SELECT pg_advisory_unlock($1)', [Number(lockKey)]);
      pgClient.release();
    } catch (e) { /* non-fatal */ }
    pgClient = null;
  }
  pgLockHeld = false;
}

async function initPg() {
  if (!PG_CONFIGURED || !pgPool) {
    console.log('[db] Postgres not configured — running SQLite-only');
    return false;
  }
  try {
    const client = await pgPool.connect();
    pgConnected = true;
    pgLastError = null;
    console.log('[db] Postgres connected:', pgHost + ':' + pgPort);
    client.release();
    pgReady = true;
    pgWritable = true;
    pgDegraded = false;
    return true;
  } catch (e) {
    console.error('[db] Postgres connection failed:', e.message);
    pgLastError = e;
    pgConnected = false;
    pgReady = false;
    pgWritable = false;
    pgDegraded = true;
    return false;
  }
}

async function ensurePgTables() {
  if (!pgReady || !pgPool) return;
  for (const [table, cols] of Object.entries(TABLE_COLS)) {
    const colDefs = cols.split(', ').map((c) => {
      const [name] = c.split(' ');
      if (name === 'id' && (table === 'waifu_claims' || table === 'hunt_claims')) return 'id BIGINT';
      if (name === 'id') return 'id SERIAL PRIMARY KEY';
      if (name === 'user_id' && table === 'users') return 'user_id BIGINT PRIMARY KEY';
      if (name === 'code' && table === 'redeem_codes') return 'code TEXT PRIMARY KEY';
      if (name === 'character_id' && (table.includes('waifu') || table.includes('hunt'))) return 'character_id TEXT PRIMARY KEY';
      if (name === 'key' && table === 'bot_memory') return 'key TEXT PRIMARY KEY';
      if (name === 'key' && table === 'settings') return 'key TEXT PRIMARY KEY';
      if (c.includes('INTEGER') || c.includes('INT')) return `${name} BIGINT`;
      if (c.includes('TEXT')) return `${name} TEXT`;
      if (/^(id|user_id|wallet|bank|networth|amount|bet|reward|pot|ticket_count|quantity|favorites|expires_at|started_at|claimed_at|created_at|updated_at|status_until|hidden_until|last_seen|rank_valid_matches|rank_consecutive_losses|sent_count|completions|starts_at|used_count|max_uses|attempts|completed|last_attempt|claimed|is_command|added_at|played_at|cached_at|ts|user_count|total_coins|suspect|row_count|backup_id|chat_id|expires_at|until)$/.test(name)) return `${name} BIGINT`;
      return `${name} TEXT`;
    });
    const pk = TABLE_PKS[table];
    // The single-column PKs are already injected inline above (`... PRIMARY KEY`);
    // appending `PRIMARY KEY (pk)` again would make Postgres throw
    // "multiple primary keys for table ... are not allowed" and the table
    // would NEVER be created (→ hydrateFromPg "relation does not exist" →
    // permanent standby). Only append the table-level clause for COMPOSITE
    // primary keys (cooldowns, inventory, game_sessions, mission_progress,
    // redeem_redemptions, time_wallet, ...) which cannot be inline.
    const isSingleColPk = pk.split(', ').length === 1;
    const inlinePkCols = new Set(['id', 'user_id', 'code', 'character_id', 'key']);
    const inlinePk = isSingleColPk && inlinePkCols.has(pk.split(', ')[0]);
    try {
      const ddl = inlinePk
        ? `CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(', ')})`
        : `CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(', ')}, PRIMARY KEY (${pk}))`;
      await pgPool.query(ddl);
    } catch (e) {
      console.warn(`[db] ensurePgTables ${table}:`, e.message);
    }
  }
  // Reconcile PRE-EXISTING Postgres tables (created by older bot versions)
  // against the CURRENT schema: add any missing columns and copy legacy
  // column data across renames. Non-destructive — never drops or alters
  // existing columns/rows. Without this, hydrateFromPg's SELECT fails on a
  // missing column (e.g. `networth`) and the bot stays stuck in standby /
  // read-only forever (never acquires the advisory lock, never responds).
  await migratePgColumns();
}

/* Per-column PG type/defaults for `ADD COLUMN IF NOT EXISTS` on legacy tables.
 * Keyed by column NAME (applies to any table that has it). Only columns that
 * may be missing on old installs are listed; everything else falls back to a
 * plain BIGINT/TEXT add. */
const PG_COLUMN_DEFAULTS = {
  networth: 'BIGINT', // added nullable, backfilled from wallet+bank below
  rank: "TEXT DEFAULT 'bronze'",
  rank_valid_matches: 'BIGINT DEFAULT 0',
  rank_consecutive_losses: 'BIGINT DEFAULT 0',
  status: "TEXT DEFAULT ''",
  status_reason: "TEXT DEFAULT ''",
  status_until: 'BIGINT DEFAULT 0',
  hidden_until: 'BIGINT DEFAULT 0',
  last_seen: 'BIGINT DEFAULT 0',
  wallet: 'BIGINT DEFAULT 0',
  bank: 'BIGINT DEFAULT 0',
  username: "TEXT DEFAULT ''",
  first_name: "TEXT DEFAULT ''",
  role: "TEXT DEFAULT 'mod'",
  password: "TEXT DEFAULT ''",
  sent_count: 'BIGINT DEFAULT 0',
  active: 'BIGINT DEFAULT 1',
  completions: 'BIGINT DEFAULT 0',
  starts_at: 'BIGINT DEFAULT 0',
  used_count: 'BIGINT DEFAULT 0',
  creator_role: "TEXT DEFAULT ''",
  leader_name: "TEXT DEFAULT ''",
  target_name: "TEXT DEFAULT ''",
  started_at: 'BIGINT DEFAULT 0',
  chat_title: "TEXT DEFAULT ''",
  text: "TEXT DEFAULT ''",
  is_command: 'BIGINT DEFAULT 0',
  created_at: 'BIGINT DEFAULT 0',
  expires_at: 'BIGINT DEFAULT 0',
  claimed: 'BIGINT DEFAULT 0',
  amount: 'BIGINT DEFAULT 0',
  max_uses: 'BIGINT DEFAULT 1',
  favorites: 'BIGINT DEFAULT 0',
  quantity: 'BIGINT DEFAULT 1',
  ticket_count: 'BIGINT DEFAULT 0',
  pot: 'BIGINT DEFAULT 0',
  tickets: "TEXT DEFAULT '[]'",
};

/* Idempotent, non-destructive Postgres schema migration:
 *  1. `ADD COLUMN IF NOT EXISTS` for every TABLE_COLS column that may be
 *     missing on a legacy table (Postgres 9.6+ native — safe on every boot).
 *  2. Backfill legacy column data across renames the old bot used, so no
 *     pre-existing value is stranded or lost. Each statement is guarded: if
 *     the legacy column doesn't exist it throws and is skipped (no-op).
 */
async function migratePgColumns() {
  if (!pgReady || !pgPool) return;
  for (const [table, cols] of Object.entries(TABLE_COLS)) {
    const pkCols = new Set((TABLE_PKS[table] || '').split(', ').map((s) => s.trim()));
    for (const c of cols.split(', ')) {
      const [name] = c.split(' ');
      if (pkCols.has(name)) continue; // PK columns already exist by definition
      const def = PG_COLUMN_DEFAULTS[name] || (c.includes('INTEGER') || c.includes('INT') ? `BIGINT` : `TEXT`);
      try {
        await pgPool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${def}`);
      } catch (e) {
        // Column may exist with a different type, or the table is locked —
        // non-fatal; hydration's null-safe row mapping covers the gap.
        console.warn(`[db] migratePgColumns ${table}.${name}:`, e.message);
      }
    }
  }
  // ---- Legacy data reconciliation (each guarded; no-op when the legacy
  // column doesn't exist on this install) ----
  try {
    // users.networth: legacy rows never wrote it → net worth = wallet + bank.
    await pgPool.query(`UPDATE users SET networth = COALESCE(networth, wallet + bank, 500000) WHERE networth IS NULL`);
  } catch (e) { console.warn('[db] networth backfill skipped:', e.message); }
  try {
    // chat_logs.message → text (old schema named it `message`).
    await pgPool.query(`UPDATE chat_logs SET text = message WHERE (text IS NULL OR text = '') AND message IS NOT NULL AND message != ''`);
  } catch (e) { console.warn('[db] chat_logs message→text copy skipped:', e.message); }
  try {
    const legacyRedeem = await pgPool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'redeem_codes' AND column_name = 'uses'`);
    if (legacyRedeem.rowCount) await pgPool.query(`UPDATE redeem_codes SET used_count = uses WHERE (used_count IS NULL OR used_count = 0) AND uses IS NOT NULL AND uses > 0`);
  } catch (e) { console.warn('[db] redeem legacy reconciliation:', e.message); }
  try {
    const legacyLottery = await pgPool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lottery' AND column_name IN ('jackpot','buyers','entries')`);
    const have = new Set(legacyLottery.rows.map((r) => r.column_name));
    if (have.has('jackpot') && have.has('buyers') && have.has('entries')) await pgPool.query(`UPDATE lottery SET pot = jackpot, ticket_count = buyers, tickets = entries WHERE (pot IS NULL OR pot = 0) AND jackpot IS NOT NULL`);
  } catch (e) { console.warn('[db] lottery legacy reconciliation:', e.message); }
}

async function mirrorTable(table) {
  if (!pgReady || !pgWritable || !pgLockHeld || !syncEnabled || !pgPool) return;
  const cols = TABLE_COLS[table];
  const pk = TABLE_PKS[table];
  if (!cols || !pk) return;
  try {
    const rows = db.prepare(`SELECT ${cols} FROM ${table}`).all();
    if (!rows.length) return;
    const colNames = cols.split(', ').map((c) => c.split(' ')[0]);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
    const upsertCols = colNames.filter((c) => !pk.split(', ').includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const pkCols = pk.split(', ');
    const conflictTarget = pkCols.join(', ');
    const sql = `INSERT INTO ${table} (${colNames.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (${conflictTarget})
      DO UPDATE SET ${upsertCols}`;
    for (const row of rows) {
      // Values for ALL columns (placeholders = colNames.length). The old code
      // only sent pkCols values → bind-message count mismatch → every periodic
      // fullMirror upsert silently failed and NO periodic write ever reached
      // Postgres (only direct queuePgWrite drains worked).
      const values = colNames.map((c) => row[c]);
      try {
        await pgPool.query(sql, values);
        pgWritesOk++;
      } catch (e) {
        pgWritesFailed++;
        pgLastError = e;
      }
    }
    pgLastWriteAt = Date.now();
    pgLastMirrorAt = Date.now();
  } catch (e) {
    console.warn(`[db] mirrorTable ${table}:`, e.message);
  }
}

async function fullMirror() {
  if (!pgReady || !pgWritable || !pgLockHeld || !syncEnabled) return;
  if (pgMirrorRunning) return;
  pgMirrorRunning = true;
  try {
    for (const table of Object.keys(TABLE_COLS)) {
      await mirrorTable(table);
    }
    pgLastVerifyAt = Date.now();
  } finally {
    pgMirrorRunning = false;
  }
}

function queuePgWrite(table, data) {
  if (!PG_CONFIGURED) return;
  pgMirrorQueue.push({ table, data });
}

async function drainMirrorQueue() {
  if (!pgReady || !pgWritable || !pgLockHeld || !syncEnabled || !pgPool) return;
  if (pgMirrorRunning) return;
  pgMirrorRunning = true;
  try {
    while (pgMirrorQueue.length > 0) {
      const item = pgMirrorQueue.shift();
      const cols = TABLE_COLS[item.table];
      const pk = TABLE_PKS[item.table];
      if (!cols || !pk) continue;
      const colNames = cols.split(', ').map((c) => c.split(' ')[0]);
      const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
      const upsertCols = colNames.filter((c) => !pk.split(', ').includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      const pkCols = pk.split(', ');
      const conflictTarget = pkCols.join(', ');
      const sql = `INSERT INTO ${item.table} (${colNames.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT (${conflictTarget})
        DO UPDATE SET ${upsertCols}`;
      try {
        await pgPool.query(sql, item.data);
        pgWritesOk++;
      } catch (e) {
        pgWritesFailed++;
        pgLastError = e;
      }
    }
    pgLastWriteAt = Date.now();
  } finally {
    pgMirrorRunning = false;
  }
}

async function startMirrorLoop() {
  if (!PG_CONFIGURED || !pgPool) return;
  setInterval(async () => {
    try {
      await drainMirrorQueue();
    } catch (e) {
      console.error('[db] mirror drain error:', e.message);
    }
  }, 1000);
  setInterval(async () => {
    try {
      await fullMirror();
    } catch (e) {
      console.error('[db] full mirror error:', e.message);
    }
  }, config.dbSyncIntervalMs || 30000);
}

async function startRecoveryLoop() {
  if (!PG_CONFIGURED || !pgPool) return;
  if (pgRecoveryTimer) return;
  pgRecoveryTimer = setInterval(async () => {
    if (pgReady && pgWritable) return;
    try {
      const client = await pgPool.connect();
      await client.query('SELECT 1');
      client.release();
      pgConnected = true;
      pgReady = true;
      pgWritable = true;
      pgDegraded = false;
      pgLastError = null;
      console.log('[db] Postgres recovered');
    } catch (e) {
      pgLastError = e;
      pgConnected = false;
      pgReady = false;
      pgWritable = false;
      pgDegraded = true;
    }
  }, 15000);
}

/* ===================== HYDRATION (Postgres → SQLite) ===================== */

/**
 * Pull every mirror table from Postgres into SQLite. This is the durability
 * step: without it, a fresh SQLite cache would be empty and the first mirror
 * would push an empty DB over real Postgres rows (the rollback bug).
 *
 * Table-by-table: wipe the SQLite table, then insert PG rows.
 * Returns { enabled, hydrated } — hydrated = total rows copied.
 */
/* Null-safe fallbacks for hydration rows: columns that may be MISSING or NULL
 * on legacy Postgres rows get sane defaults so the whole hydration never
 * aborts on one bad value. */
const PG_ROW_FALLBACKS = {
  networth: (r) => (r.wallet != null && r.bank != null ? Number(r.wallet) + Number(r.bank) : 500000),
  rank: () => 'bronze',
  rank_valid_matches: () => 0,
  rank_consecutive_losses: () => 0,
  status: () => '',
  status_reason: () => '',
  status_until: () => 0,
  hidden_until: () => 0,
  last_seen: () => 0,
  wallet: () => 0,
  bank: () => 0,
  username: () => '',
  first_name: () => '',
  role: () => 'mod',
  password: () => '',
  sent_count: () => 0,
  active: () => 1,
  completions: () => 0,
  starts_at: () => 0,
  used_count: () => 0,
  creator_role: () => '',
  leader_name: () => '',
  target_name: () => '',
  started_at: () => 0,
  chat_title: () => '',
  text: () => '',
  is_command: () => 0,
  created_at: () => 0,
  expires_at: () => 0,
  claimed: () => 0,
  amount: () => 0,
  max_uses: () => 1,
  favorites: () => 0,
  quantity: () => 1,
  ticket_count: () => 0,
  pot: () => 0,
  tickets: () => '[]',
};

async function hydrateFromPg() {
  if (!PG_CONFIGURED || !pgPool || !pgReady) {
    return { enabled: false, hydrated: 0 };
  }
  let hydrated = 0;
  try {
    for (const table of Object.keys(TABLE_COLS)) {
      const cols = TABLE_COLS[table];
      const pk = TABLE_PKS[table];
      if (!cols || !pk) continue;
      const colNames = cols.split(', ').map((c) => c.split(' ')[0]);
      try {
        const res = await pgPool.query(`SELECT ${colNames.join(', ')} FROM ${table}`);
        if (!res.rows.length) continue;
        prep(`DELETE FROM ${table}`).run();
        const placeholders = colNames.map(() => '?').join(', ');
        // INSERT OR REPLACE: Postgres (source of truth) always wins over a stale
        // local cache row. Plain INSERT would fail/duplicate; OR REPLACE keeps
        // the durable PG value authoritative on every hydration.
        const insert = prep(`INSERT OR REPLACE INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders})`);
        for (const row of res.rows) {
          try {
            const values = colNames.map((c) => {
              const v = row[c];
              if (v === null || v === undefined) {
                const fb = PG_ROW_FALLBACKS[c];
                return fb ? fb(row) : null;
              }
              return v;
            });
            insert.run(...values);
            hydrated++;
          } catch (e) {
            // Row-level conflict (e.g. legacy PK) — skip, non-fatal.
          }
        }
      } catch (e) {
        // Table-level failure (e.g. a column still missing): log and continue
        // with the other tables — never abort the whole hydration. The DELETE
        // above runs only after a successful SELECT, so a failed table keeps
        // its current local rows.
        console.warn(`[db] hydrateFromPg ${table}:`, e.message);
        if (table === 'users') {
          // The critical table failed — stay read-only (fail-closed): a stale
          // SQLite users cache must never be mirrored over durable PG rows.
          console.error('[db] hydrateFromPg users FAILED — keeping the bot read-only (no mirror) to protect Postgres data.');
          pgHydrated = false;
          return { enabled: false, hydrated };
        }
      }
    }
    pgHydrated = true;
    console.log(`[db] Hydrated SQLite from Postgres (${hydrated} rows).`);
    return { enabled: true, hydrated };
  } catch (e) {
    console.error('[db] hydrateFromPg failed:', e.message);
    pgLastError = e;
    pgHydrated = false;
    return { enabled: false, hydrated: 0 };
  }
}

/**
 * Compatibility entry point expected by index.js. Restores the original
 * boot flow: connect → ensure tables → HYDRATE → ready.
 * Returns { enabled, hydrated }.
 */
async function initPersistence() {
  const ok = await initPg();
  if (!ok) {
    // SQLite-only mode — no PG, nothing to hydrate from.
    pgHydrated = true;
    return { enabled: false, hydrated: 0 };
  }
  await ensurePgTables();
  const h = await hydrateFromPg();
  return { enabled: h.enabled, hydrated: h.hydrated };
}

function setSyncEnabled(v) {
  syncEnabled = !!v;
  if (!syncEnabled) {
    pgWritable = false;
  } else if (pgReady) {
    pgWritable = true;
  }
}

function isSyncEnabled() {
  return syncEnabled && pgWritable;
}

/* ===================== BACKUPS (PG snapshots) ===================== */

function saveBackupPg(filename, data, userCount, createdBy) {
  prep('INSERT INTO backups (filename, data, user_count, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(filename, data, userCount || 0, createdBy || 0, Date.now());
  const row = prep('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
  // Mirror to Postgres (fire-and-forget; the mirror loop drains it).
  if (pgPool && pgReady) {
    const colNames = ['id', 'filename', 'data', 'user_count', 'created_by', 'created_at'];
    queuePgWrite('backups', [row.id, row.filename, row.data, row.user_count, row.created_by, row.created_at]);
  }
  return row;
}

function listBackupsPg(limit = 10) {
  return prep('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit)
    .map((row) => ({
      id: Number(row.id),
      filename: row.filename,
      user_count: Number(row.user_count) || 0,
      created_by: Number(row.created_by) || 0,
      created_at: Number(row.created_at) || 0,
    }));
}

function newestBackupPg() {
  const row = prep('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get();
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

async function pgRun(table, sql, params = []) {
  if (!pgPool || !pgReady) return Promise.resolve(false);
  try {
    await pgPool.query(sql, params);
    return true;
  } catch (e) {
    pgLastError = e;
    return false;
  }
}

/* ===================== CLOSE ===================== */

function close() {
  if (pgHeartbeatTimer) clearInterval(pgHeartbeatTimer);
  if (pgRecoveryTimer) clearInterval(pgRecoveryTimer);
  if (pgClient) {
    try { pgClient.release(); } catch (e) {}
  }
  if (pgPool) {
    try { pgPool.end(); } catch (e) {}
  }
  db.close();
}

/* ===================== EXPORTS ===================== */

module.exports = {
  // User / economy
  getOrCreateUser, getUser, addWallet, addBank, setNetworth, setWallet, setBank,
  getNetWorth, findUserByUsername, leaderboard, leaderboardCount, dashboardStats,
  getCooldownCount, getAllUsers, listUsersByNetWorth, searchUsers,
  getUserCooldowns, setRankStats,
  // Admin / penalties
  isAdminUser, addAdminUser, getAdminUser, listAdminUsers, setAdminLastLogin,
  removeAdminUser, getUserStatus, setStatus, clearStatus, expirePenalties,
  // Cooldowns
  getCooldown, setCooldown, clearCooldown, clearAllCooldowns,
  // Lottery
  getLottery, saveLottery,
  // Heists
  getOpenHeists, getHeist, saveHeist, deleteHeist, createHeist,
  updateHeistMembers, updateHeistStatus,
  // Inventory
  getInventory, addInventory, removeInventory, hasItem, getItemQty, addItem,
  // Game sessions
  getGameSession, setGameSession, deleteGameSession,
  // Logging
  logGameHistory, logActivity, logAudit, logChat, getChatLogs,
  getGameHistory, getAuditLog, getActivity,
  // Seen chat IDs
  getSeenChatIds,
  // Broadcast
  createBroadcast, getPendingBroadcasts, markBroadcastDone, listBroadcasts,
  updateBroadcastCount,
  // Events
  createEvent, getActiveEvents, listEvents, updateEvent, deleteEvent,
  activeEvents, incrementEventCompletions,
  // Missions
  getMissionProgress, upsertMissionProgress,
  // Backups (PG snapshots)
  saveBackupPg, newestBackupPg, listBackupsPg, pgRun,
  // Redeem codes
  getRedeemCode, createRedeemCode, useRedeemCode, deleteRedeemCode,
  listRedeemCodes, addRedeemClaim, hasRedeemClaim, hasRedeemed, recordRedemption,
  // Time wallet
  addTimeWallet, getTimeWalletRow, getTimeWalletBalance, spendTimeWallet,
  sweepExpiredTimeWallet,
  // Waifu
  getActiveWaifu, setActiveWaifu, clearActiveWaifu, claimWaifuCharacter,
  getUserCollection, getUserCharacters, getUserCharacterByIndex, getCharacterByName,
  getWaifuLeaderboard, isWaifuCharacterClaimed,
  // Waifu/Hunt spawn aliases
  getActiveSpawn, setActiveSpawn, clearActiveSpawn, claimCharacter,
  isCharacterClaimed,
  // Hunt
  getActiveHunt, setActiveHunt, clearActiveHunt, claimHuntCharacter,
  getHuntCollection, getUserHuntCharacters, getHuntCharacterByIndex,
  getHuntLeaderboard, isHuntCharacterClaimed, cacheHuntCharacter,
  getCachedHuntCharacter, getHuntPool,
  // Attack
  getAttackEligibleUsers,
  // Memory
  setMemory, getMemory, getMemoriesByCategory, deleteMemory,
  // Bot state
  setBotPaused, getBotPaused,
  getSetting, setSetting,
  // Hide
  setHidden, isHidden,
  // Ping
  ping,
  // Postgres + hydration
  syncInfo, initPg, ensurePgTables, acquireInstanceLock, releaseInstanceLock,
  startMirrorLoop, startRecoveryLoop, queuePgWrite, drainMirrorQueue,
  fullMirror, mirrorTable, hydrateFromPg, initPersistence,
  setSyncEnabled, isSyncEnabled,
  // Close
  close,
  // Raw db for advanced use
  db,
};
