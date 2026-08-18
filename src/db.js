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
  users: 'user_id, username, first_name, wallet, bank, networth, rank, rank_valid_matches, created_at, updated_at, status, status_until, hidden_until, last_seen',
  game_history: 'id, user_id, username, game, bet, result, amount, played_at',
  cooldowns: 'user_id, action, expires_at',
  admin_users: 'user_id, role, added_by, added_at',
  chat_logs: 'id, user_id, username, chat_id, message, timestamp',
  activity_feed: 'id, type, message, data, created_at',
  audit_log: 'id, user_id, username, action, amount, details, created_at',
  lottery: 'id, jackpot, buyers, entries, created_at',
  heists: 'leader_id, target_id, members, status, expires_at, created_at',
  inventory: 'user_id, item_id, quantity',
  game_sessions: 'user_id, game, state, expires_at',
  backup_meta: 'id, filename, ts, user_count, total_coins, suspect, source',
  backup_data: 'id, backup_id, table_name, row_count, data',
  backups: 'id, filename, data, user_count, created_by, created_at',
  broadcast_queue: 'id, message, target, status, created_by, created_at',
  events: 'id, title, description, type, reward, ends_at, created_by, created_at',
  mission_progress: 'user_id, mission_id, attempts, completed, last_attempt',
  redeem_codes: 'code, amount, uses, max_uses, created_by, created_at',
  redeem_claims: 'id, code, user_id, claimed_at',
  waifu_cache: 'character_id, name, series, image_url, bio, favorites, rarity, cached_at',
  waifu_claims: 'id, user_id, character_id, name, series, image_url, rarity, claimed_at',
  waifu_spawn: 'character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed',
  hunt_cache: 'character_id, name, series, image_url, bio, favorites, rarity, cached_at',
  hunt_claims: 'id, user_id, character_id, name, series, image_url, rarity, claimed_at',
  hunt_spawn: 'character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed',
  bot_memory: 'key, value, category, updated_at',
  bot_state: 'key, value, updated_at',
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
  waifu_cache: 'character_id',
  waifu_claims: 'id',
  waifu_spawn: 'character_id',
  hunt_cache: 'character_id',
  hunt_claims: 'id',
  hunt_spawn: 'character_id',
  bot_memory: 'key',
  bot_state: 'key',
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
      role TEXT DEFAULT 'mod',
      added_by INTEGER,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT DEFAULT '',
      chat_id INTEGER,
      message TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jackpot INTEGER DEFAULT 5000000,
      buyers INTEGER DEFAULT 0,
      entries TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS heists (
      leader_id INTEGER PRIMARY KEY,
      target_id INTEGER,
      members TEXT DEFAULT '[]',
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
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      description TEXT DEFAULT '',
      type TEXT DEFAULT 'mission',
      reward INTEGER DEFAULT 0,
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
      uses INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS redeem_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      user_id INTEGER,
      claimed_at TEXT DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS time_wallet (
      user_id INTEGER,
      expires_at INTEGER DEFAULT 0,
      amount INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, expires_at)
    );
  `);

  // Add status_reason column to existing installs (idempotent migration).
  try {
    db.exec(`ALTER TABLE users ADD COLUMN status_reason TEXT DEFAULT ''`);
  } catch (e) { /* already exists */ }
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
  const users = prep('SELECT COUNT(*) AS n FROM users').get().n;
  const totalCoins = prep('SELECT COALESCE(SUM(networth), 0) AS s FROM users').get().s;
  const totalBets = prep('SELECT COALESCE(SUM(bet), 0) AS s FROM game_history').get().s;
  const totalWins = prep('SELECT COALESCE(SUM(amount), 0) AS s FROM game_history WHERE result = \'win\'').get().s;
  return { users, totalCoins, totalBets, totalWins };
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

function setRankStats(userId, rank, validMatches) {
  prep('UPDATE users SET rank = ?, rank_valid_matches = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
    .run(rank, validMatches || 0, userId);
}

/* ===================== ADMIN / PENALTIES ===================== */

function isAdminUser(userId) {
  const row = prep('SELECT * FROM admin_users WHERE user_id = ?').get(userId);
  return !!row;
}

function addAdminUser(userId, role = 'mod', addedBy = 0) {
  prep('INSERT INTO admin_users (user_id, role, added_by) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role').run(userId, role, addedBy);
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

/* ===================== LOTTERY ===================== */

function getLottery() {
  const row = prep('SELECT * FROM lottery ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    prep('INSERT INTO lottery (jackpot, buyers, entries) VALUES (?, 0, \'[]\')').run(config.lottery.baseJackpot || 5000000);
    return prep('SELECT * FROM lottery ORDER BY id DESC LIMIT 1').get();
  }
  return row;
}

function saveLottery(jackpot, buyers, entries) {
  prep('UPDATE lottery SET jackpot = ?, buyers = ?, entries = ? WHERE id = (SELECT id FROM lottery ORDER BY id DESC LIMIT 1)').run(jackpot, buyers, JSON.stringify(entries || []));
}

/* ===================== HEISTS ===================== */

function getOpenHeists() {
  return prep('SELECT * FROM heists WHERE status = \'open\'').all();
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

function createHeist(leaderId, targetId, members, status, expiresAt) {
  saveHeist(leaderId, targetId, members, status, expiresAt);
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
  const from = msg.from || {};
  prep('INSERT INTO chat_logs (user_id, username, chat_id, message) VALUES (?, ?, ?, ?)')
    .run(from.id || 0, from.username || '', msg.chat ? msg.chat.id : 0, String(msg.text || msg.caption || '').slice(0, 500));
}

function getChatLogs(limit = 100) {
  return prep('SELECT * FROM chat_logs ORDER BY id DESC LIMIT ?').all(limit);
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

function updateBroadcastCount(id) {
  prep('UPDATE broadcast_queue SET status = status WHERE id = ?').run(id);
}

/* ===================== EVENTS ===================== */

function createEvent(data) {
  const info = prep('INSERT INTO events (title, description, type, reward, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(data.title || '', data.description || '', data.type || 'mission', data.reward || 0, data.ends_at || 0, data.created_by || 0);
  return prep('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid));
}

function getActiveEvents() {
  const now = Date.now();
  return prep('SELECT * FROM events WHERE ends_at = 0 OR ends_at > ? ORDER BY id DESC').all(now);
}

function listEvents(limit = 50) {
  return prep('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

function updateEvent(id, data) {
  const sets = [];
  const params = [];
  for (const k of ['title', 'description', 'type', 'reward', 'ends_at']) {
    if (data[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(data[k]);
    }
  }
  if (!sets.length) return null;
  params.push(id);
  prep(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return prep('SELECT * FROM events WHERE id = ?').get(id);
}

function deleteEvent(id) {
  prep('DELETE FROM events WHERE id = ?').run(id);
}

function activeEvents() {
  return getActiveEvents();
}

function incrementEventCompletions(userId, missionId) {
  const row = prep('SELECT * FROM mission_progress WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
  if (row) {
    prep('UPDATE mission_progress SET attempts = attempts + 1, last_attempt = ? WHERE user_id = ? AND mission_id = ?').run(Date.now(), userId, missionId);
  } else {
    prep('INSERT INTO mission_progress (user_id, mission_id, attempts, completed, last_attempt) VALUES (?, ?, 1, 0, ?)').run(userId, missionId, Date.now());
  }
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
  return prep('SELECT * FROM redeem_codes WHERE code = ?').get(code);
}

function createRedeemCode(code, amount, maxUses, createdBy) {
  try {
    prep('INSERT INTO redeem_codes (code, amount, uses, max_uses, created_by) VALUES (?, ?, 0, ?, ?)').run(code, amount, maxUses || 1, createdBy || 0);
    return prep('SELECT * FROM redeem_codes WHERE code = ?').get(code);
  } catch (e) {
    return null;
  }
}

function useRedeemCode(code) {
  const row = prep('SELECT * FROM redeem_codes WHERE code = ?').get(code);
  if (!row) return null;
  if (row.uses >= row.max_uses) return null;
  prep('UPDATE redeem_codes SET uses = uses + 1 WHERE code = ?').run(code);
  return prep('SELECT * FROM redeem_codes WHERE code = ?').get(code);
}

function deleteRedeemCode(code) {
  prep('DELETE FROM redeem_codes WHERE code = ?').run(code);
}

function listRedeemCodes() {
  return prep('SELECT * FROM redeem_codes ORDER BY created_at DESC').all();
}

function addRedeemClaim(code, userId) {
  try {
    prep('INSERT INTO redeem_claims (code, user_id) VALUES (?, ?)').run(code, userId);
    return true;
  } catch (e) {
    return false;
  }
}

function hasRedeemClaim(code, userId) {
  return !!prep('SELECT * FROM redeem_claims WHERE code = ? AND user_id = ?').get(code, userId);
}

/* ===================== REDEEM: legacy aliases ===================== */

function hasRedeemed(userId, code) {
  return hasRedeemClaim(code, userId);
}

function recordRedemption(userId, code) {
  return addRedeemClaim(code, userId);
}

/* ===================== TIME WALLET (timed rank rewards) ===================== */

function addTimeWallet(userId, amount, expiresAt) {
  prep('INSERT INTO time_wallet (user_id, amount, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id, expires_at) DO UPDATE SET amount = amount + ?')
    .run(userId, amount, expiresAt || 0, amount);
}

function getTimeWalletRow(userId) {
  const rows = prep('SELECT * FROM time_wallet WHERE user_id = ?').all(userId);
  let amount = 0;
  for (const r of rows) {
    if (r.expires_at > 0 && r.expires_at <= Date.now()) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
    } else {
      amount += r.amount;
    }
  }
  return { user_id: userId, amount };
}

function getTimeWalletBalance(userId) {
  const row = getTimeWalletRow(userId);
  return row ? row.amount : 0;
}

function spendTimeWallet(userId, amount) {
  const rows = prep('SELECT * FROM time_wallet WHERE user_id = ? ORDER BY expires_at ASC').all(userId);
  let remaining = amount;
  for (const r of rows) {
    if (remaining <= 0) break;
    if (r.expires_at > 0 && r.expires_at <= Date.now()) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
      continue;
    }
    const use = Math.min(r.amount, remaining);
    remaining -= use;
    if (r.amount - use <= 0) {
      prep('DELETE FROM time_wallet WHERE user_id = ? AND expires_at = ?').run(userId, r.expires_at);
    } else {
      prep('UPDATE time_wallet SET amount = amount - ? WHERE user_id = ? AND expires_at = ?').run(use, userId, r.expires_at);
    }
  }
  return remaining <= 0;
}

function sweepExpiredTimeWallet() {
  prep('DELETE FROM time_wallet WHERE expires_at > 0 AND expires_at <= ?').run(Date.now());
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
  prep('INSERT INTO bot_state (key, value, updated_at) VALUES (\'paused\', ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')').run(paused ? 'true' : 'false');
}

function getBotPaused() {
  const row = prep('SELECT value FROM bot_state WHERE key = \'paused\'').get();
  return row ? row.value === 'true' : false;
}

function getSetting(key) {
  const row = prep('SELECT value FROM bot_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  prep('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
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
      if (name === 'id') return 'id SERIAL PRIMARY KEY';
      if (name === 'user_id' && table === 'users') return 'user_id BIGINT PRIMARY KEY';
      if (name === 'code' && table === 'redeem_codes') return 'code TEXT PRIMARY KEY';
      if (name === 'character_id' && (table.includes('waifu') || table.includes('hunt'))) return 'character_id TEXT PRIMARY KEY';
      if (name === 'key' && table === 'bot_memory') return 'key TEXT PRIMARY KEY';
      if (name === 'key' && table === 'bot_state') return 'key TEXT PRIMARY KEY';
      if (c.includes('INTEGER') || c.includes('INT')) return `${name} BIGINT`;
      if (c.includes('TEXT')) return `${name} TEXT`;
      return `${name} TEXT`;
    });
    const pk = TABLE_PKS[table];
    try {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(', ')}, PRIMARY KEY (${pk}))`);
    } catch (e) {
      console.warn(`[db] ensurePgTables ${table}:`, e.message);
    }
  }
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
      const values = pkCols.map((c) => row[c]);
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
      const res = await pgPool.query(`SELECT ${colNames.join(', ')} FROM ${table}`);
      if (!res.rows.length) continue;
      prep(`DELETE FROM ${table}`).run();
      const placeholders = colNames.map(() => '?').join(', ');
      const insert = prep(`INSERT INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders})`);
      for (const row of res.rows) {
        try {
          insert.run(...colNames.map((c) => (row[c] === null || row[c] === undefined ? null : row[c])));
          hydrated++;
        } catch (e) {
          // Row-level conflict (e.g. legacy PK) — skip, non-fatal.
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
  getCooldown, setCooldown, clearAllCooldowns,
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
