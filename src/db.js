'use strict';
/**
 * Rimuru Tempest Casino — Database layer.
 * SQLite (hot synchronous cache) + Postgres mirror (durable persistence).
 *
 * ARCHITECTURE
 * ============
 * Every write goes to SQLite FIRST (synchronous, always available), then
 * is QUEUED for Postgres mirroring. The mirror loop drains the queue in
 * FIFO order with a 10-second query timeout. On boot, if Postgres is
 * configured and reachable, the SQLite cache is REHYDRATED from Postgres
 * so balances/leaderboard/mods survive redeploys.
 *
 * PERSISTENCE DEGRADED MODE
 * =========================
 * When Postgres is configured but unreachable (timeout, connection refused,
 * etc.) the bot enters persistence-degraded/read-only mode. State-changing
 * Telegram commands are blocked at the router level before touching SQLite.
 * The bot stays alive and /health remains reachable. Background recovery
 * retries the connection every 15 seconds. Once Postgres is reachable again,
 * the cache is rehydrated and the write pipeline is re-enabled.
 *
 * ADVISORY LOCK (single-instance guard)
 * ======================================
 * A dedicated PoolClient is checked out for the lifetime of the primary
 * process. That client owns a PostgreSQL advisory lock (pg_try_advisory_lock).
 * A 10-second heartbeat verifies the session is alive. Losing the heartbeat
 * disables the write pipeline. This prevents two Render instances from
 * writing to Postgres simultaneously.
 *
 * TABLE REGISTRATION
 * ==================
 * Every table that should be mirrored to Postgres must be registered in
 * TABLE_COLS (column names) and TABLE_PKS (primary key column names).
 * The mirror loop uses these to build INSERT ... ON CONFLICT upserts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

/* ===================== SQLite setup ===================== */

const dbDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
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
      user_count INTEGER DEFAULT 0,
      total_coins INTEGER DEFAULT 0,
      suspect INTEGER DEFAULT 0,
      source TEXT DEFAULT 'sqlite'
    );
    CREATE TABLE IF NOT EXISTS backup_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_id INTEGER,
      table_name TEXT,
      row_count INTEGER DEFAULT 0,
      data TEXT
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
      description TEXT,
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
      last_attempt TEXT,
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
      image_url TEXT,
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      cached_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS waifu_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      character_id TEXT,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT,
      rarity TEXT DEFAULT 'common',
      claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS waifu_spawn (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT,
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      expires_at INTEGER,
      chat_id INTEGER DEFAULT 0,
      claimed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hunt_cache (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT,
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      cached_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hunt_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      character_id TEXT,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT,
      rarity TEXT DEFAULT 'common',
      claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hunt_spawn (
      character_id TEXT PRIMARY KEY,
      name TEXT,
      series TEXT DEFAULT '',
      image_url TEXT,
      bio TEXT DEFAULT '',
      favorites INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'common',
      expires_at INTEGER,
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
  `);
}

createTables();

/* ===================== HELPER: prepared statements ===================== */

const stmts = {};
function prep(sql) {
  if (!stmts[sql]) stmts[sql] = db.prepare(sql);
  return stmts[sql];
}

/* ===================== USER / ECONOMY ===================== */

function getOrCreateUser(userId, meta = {}) {
  let row = prep('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (!row) {
    prep('INSERT INTO users (user_id, username, first_name, wallet, bank, networth) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, meta.username || '', meta.first_name || '', config.startBalance, 0, config.startBalance
    );
    row = prep('SELECT * FROM users WHERE user_id = ?').get(userId);
  } else if (meta.username || meta.first_name) {
    prep('UPDATE users SET username = ?, first_name = ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(
      meta.username || row.username, meta.first_name || row.first_name, userId
    );
  }
  return row;
}

function getUser(userId) {
  return prep('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function addWallet(userId, amount) {
  prep('UPDATE users SET wallet = wallet + ?, networth = networth + ?, updated_at = datetime(\'now\') WHERE user_id = ?').run(amount, amount, userId);
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

function findUserByUsername(username) {
  return prep('SELECT * FROM users WHERE LOWER(username) = ?').get(String(username || '').toLowerCase());
}

function leaderboard(limit = 10) {
  return prep('SELECT * FROM users ORDER BY networth DESC LIMIT ?').all(limit);
}

function leaderboardCount(limit = 100) {
  return prep('SELECT * FROM users ORDER BY networth DESC LIMIT ?').all(limit);
}

function dashboardStats() {
  const totalUsers = prep('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = prep('SELECT COUNT(*) as c FROM users WHERE last_seen > ?').get(Date.now() - 7 * 24 * 3600 * 1000).c;
  const totalGroups = prep('SELECT COUNT(DISTINCT chat_id) as c FROM chat_logs WHERE chat_id < 0').get().c;
  const coinsInCirculation = prep('SELECT COALESCE(SUM(networth), 0) as c FROM users').get().c;
  return { totalUsers, activeUsers, totalGroups, coinsInCirculation };
}

function getCooldownCount() {
  return prep('SELECT COUNT(*) as c FROM cooldowns WHERE expires_at > ?').get(Date.now()).c;
}

/* ===================== ADMIN / PENALTIES ===================== */

function isAdminUser(userId) {
  const row = prep('SELECT * FROM admin_users WHERE user_id = ?').get(userId);
  return !!row;
}

function removeAdminUser(userId) {
  prep('DELETE FROM admin_users WHERE user_id = ?').run(userId);
}

function getUserStatus(userId) {
  const row = prep('SELECT status, status_until FROM users WHERE user_id = ?').get(userId);
  if (!row || !row.status) return null;
  if (row.status_until > 0 && row.status_until <= Date.now()) return null;
  return row;
}

function expirePenalties() {
  const expired = prep('SELECT user_id, status FROM users WHERE status != \'\' AND status_until > 0 AND status_until <= ?').all(Date.now());
  prep('UPDATE users SET status = \'\', status_until = 0, updated_at = datetime(\'now\') WHERE status != \'\' AND status_until > 0 AND status_until <= ?').run(Date.now());
  return expired;
}

/* ===================== COOLDOWNS ===================== */

function getCooldown(userId, action) {
  return prep('SELECT * FROM cooldowns WHERE user_id = ? AND action = ?').get(userId, action);
}

function setCooldown(userId, action, expiresAt) {
  prep('INSERT OR REPLACE INTO cooldowns (user_id, action, expires_at) VALUES (?, ?, ?)').run(userId, action, expiresAt);
}

function clearAllCooldowns() {
  prep('DELETE FROM cooldowns').run();
}

/* ===================== LOTTERY ===================== */

function getLottery() {
  return prep('SELECT * FROM lottery ORDER BY id DESC LIMIT 1').get();
}

function saveLottery(jackpot, buyers, entries) {
  const existing = getLottery();
  if (existing) {
    prep('UPDATE lottery SET jackpot = ?, buyers = ?, entries = ? WHERE id = ?').run(jackpot, buyers, JSON.stringify(entries), existing.id);
  } else {
    prep('INSERT INTO lottery (jackpot, buyers, entries) VALUES (?, ?, ?)').run(jackpot, buyers, JSON.stringify(entries));
  }
}

/* ===================== HEISTS ===================== */

function getOpenHeists() {
  const rows = prep('SELECT * FROM heists WHERE status = \'open\'').all();
  return rows.map((r) => ({ ...r, members: JSON.parse(r.members || '[]') }));
}

function getHeist(leaderId) {
  const row = prep('SELECT * FROM heists WHERE leader_id = ?').get(leaderId);
  if (!row) return null;
  return { ...row, members: JSON.parse(row.members || '[]') };
}

function saveHeist(leaderId, targetId, members, status, expiresAt) {
  prep('INSERT OR REPLACE INTO heists (leader_id, target_id, members, status, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    leaderId, targetId, JSON.stringify(members), status, expiresAt
  );
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
  prep('INSERT OR REPLACE INTO game_sessions (user_id, game, state, expires_at) VALUES (?, ?, ?, ?)').run(
    userId, game, typeof state === 'string' ? state : JSON.stringify(state), expiresAt
  );
}

function deleteGameSession(userId, game) {
  prep('DELETE FROM game_sessions WHERE user_id = ? AND game = ?').run(userId, game);
}

/* ===================== LOGGING ===================== */

function logGameHistory(data) {
  prep('INSERT INTO game_history (user_id, username, game, bet, result, amount) VALUES (?, ?, ?, ?, ?, ?)').run(
    data.user_id, data.username || '', data.game, data.bet || 0, data.result || '', data.amount || 0
  );
}

function logActivity(type, message, data = {}) {
  prep('INSERT INTO activity_feed (type, message, data) VALUES (?, ?, ?)').run(type, message, JSON.stringify(data));
}

function logAudit(userId, username, action, amount, details) {
  prep('INSERT INTO audit_log (user_id, username, action, amount, details) VALUES (?, ?, ?, ?, ?)').run(userId, username, action, amount || 0, details || '');
}

function logChat(msg) {
  const from = msg.from || {};
  prep('INSERT INTO chat_logs (user_id, username, chat_id, message) VALUES (?, ?, ?, ?)').run(
    from.id, from.username || '', msg.chat.id, String(msg.text || msg.caption || '').slice(0, 500)
  );
}

/* ===================== SEEN CHAT IDS ===================== */

function getSeenChatIds() {
  return prep('SELECT DISTINCT chat_id FROM chat_logs').all().map((r) => r.chat_id);
}

/* ===================== BROADCAST ===================== */

function createBroadcast(message, target, createdBy) {
  const info = prep('INSERT INTO broadcast_queue (message, target, created_by) VALUES (?, ?, ?)').run(message, target, createdBy);
  return { id: info.lastInsertRowid, message, target };
}

function getPendingBroadcasts() {
  return prep('SELECT * FROM broadcast_queue WHERE status = \'pending\' ORDER BY id ASC').all();
}

function markBroadcastDone(id) {
  prep('UPDATE broadcast_queue SET status = \'done\' WHERE id = ?').run(id);
}

/* ===================== EVENTS ===================== */

function createEvent(data) {
  const info = prep('INSERT INTO events (title, description, type, reward, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    data.title, data.description || '', data.type || 'mission', data.reward || 0, data.ends_at || 0, data.created_by || 0
  );
  return { id: info.lastInsertRowid, ...data };
}

function getActiveEvents() {
  return prep('SELECT * FROM events WHERE ends_at = 0 OR ends_at > ? ORDER BY id DESC').all(Date.now());
}

/* ===================== MISSION PROGRESS ===================== */

function getMissionProgress(userId, missionId) {
  return prep('SELECT * FROM mission_progress WHERE user_id = ? AND mission_id = ?').get(userId, missionId);
}

function upsertMissionProgress(userId, missionId, data) {
  prep('INSERT OR REPLACE INTO mission_progress (user_id, mission_id, attempts, completed, last_attempt) VALUES (?, ?, ?, ?, ?)').run(
    userId, missionId, data.attempts || 0, data.completed || 0, data.last_attempt || new Date().toISOString()
  );
}

/* ===================== REDEEM CODES ===================== */

function getRedeemCode(code) {
  return prep('SELECT * FROM redeem_codes WHERE code = ?').get(String(code || '').toUpperCase());
}

function createRedeemCode(code, amount, maxUses, createdBy) {
  prep('INSERT INTO redeem_codes (code, amount, max_uses, created_by) VALUES (?, ?, ?, ?)').run(code, amount, maxUses, createdBy);
}

function useRedeemCode(code) {
  prep('UPDATE redeem_codes SET uses = uses + 1 WHERE code = ?').run(code);
}

function deleteRedeemCode(code) {
  prep('DELETE FROM redeem_codes WHERE code = ?').run(code);
}

function listRedeemCodes() {
  return prep('SELECT * FROM redeem_codes ORDER BY created_at DESC').all();
}

function addRedeemClaim(code, userId) {
  prep('INSERT INTO redeem_claims (code, user_id) VALUES (?, ?)').run(code, userId);
}

function hasRedeemClaim(code, userId) {
  return !!prep('SELECT * FROM redeem_claims WHERE code = ? AND user_id = ?').get(code, userId);
}

/* ===================== WAIFU COLLECTION ===================== */

function getActiveWaifu() {
  return prep('SELECT * FROM waifu_spawn ORDER BY expires_at DESC LIMIT 1').get();
}

function setActiveWaifu(card, expiresAt, chatId) {
  prep('INSERT OR REPLACE INTO waifu_spawn (character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)').run(
    card.character_id, card.name, card.series || '', card.image_url, card.bio || '', card.favorites || 0, card.rarity || 'common', expiresAt, chatId
  );
}

function clearActiveWaifu() {
  prep('DELETE FROM waifu_spawn').run();
}

function claimWaifuCharacter(userId, char) {
  const existing = prep('SELECT * FROM waifu_claims WHERE user_id = ? AND character_id = ?').get(userId, char.character_id);
  if (existing) return false;
  prep('INSERT INTO waifu_claims (user_id, character_id, name, series, image_url, rarity) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId, char.character_id, char.name, char.series || '', char.image_url, char.rarity || 'common'
  );
  return true;
}

function getUserCollection(userId) {
  return prep('SELECT * FROM waifu_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
}

function getUserCharacterByIndex(userId, index) {
  const rows = prep('SELECT * FROM waifu_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
  if (index < 1 || index > rows.length) return null;
  return rows[index - 1];
}

function getCharacterByName(userId, name) {
  return prep('SELECT * FROM waifu_claims WHERE user_id = ? AND LOWER(name) = ?').get(userId, String(name).toLowerCase());
}

function getWaifuLeaderboard(limit = 10) {
  return prep('SELECT user_id, COUNT(*) as count FROM waifu_claims GROUP BY user_id ORDER BY count DESC LIMIT ?').all(limit);
}

function isWaifuCharacterClaimed(characterId) {
  return !!prep('SELECT * FROM waifu_claims WHERE character_id = ?').get(characterId);
}

/* ===================== HUNT COLLECTION ===================== */

function getActiveHunt() {
  return prep('SELECT * FROM hunt_spawn ORDER BY expires_at DESC LIMIT 1').get();
}

function setActiveHunt(card, expiresAt, chatId) {
  prep('INSERT OR REPLACE INTO hunt_spawn (character_id, name, series, image_url, bio, favorites, rarity, expires_at, chat_id, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)').run(
    card.character_id, card.name, card.series || '', card.image_url, card.bio || '', card.favorites || 0, card.rarity || 'common', expiresAt, chatId
  );
}

function clearActiveHunt() {
  prep('DELETE FROM hunt_spawn').run();
}

function claimHuntCharacter(userId, char) {
  const existing = prep('SELECT * FROM hunt_claims WHERE user_id = ? AND character_id = ?').get(userId, char.character_id);
  if (existing) return false;
  prep('INSERT INTO hunt_claims (user_id, character_id, name, series, image_url, rarity) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId, char.character_id, char.name, char.series || '', char.image_url, char.rarity || 'common'
  );
  return true;
}

function getHuntCollection(userId) {
  return prep('SELECT * FROM hunt_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
}

function getHuntCharacterByIndex(userId, index) {
  const rows = prep('SELECT * FROM hunt_claims WHERE user_id = ? ORDER BY claimed_at ASC').all(userId);
  if (index < 1 || index > rows.length) return null;
  return rows[index - 1];
}

function getHuntLeaderboard(limit = 10) {
  return prep('SELECT user_id, COUNT(*) as count FROM hunt_claims GROUP BY user_id ORDER BY count DESC LIMIT ?').all(limit);
}

function isHuntCharacterClaimed(characterId) {
  return !!prep('SELECT * FROM hunt_claims WHERE character_id = ?').get(characterId);
}

function cacheHuntCharacter(card) {
  prep('INSERT OR REPLACE INTO hunt_cache (character_id, name, series, image_url, bio, favorites, rarity) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    card.character_id, card.name, card.series || '', card.image_url, card.bio || '', card.favorites || 0, card.rarity || 'common'
  );
}

function getCachedHuntCharacter(characterId) {
  return prep('SELECT * FROM hunt_cache WHERE character_id = ?').get(characterId);
}

function getHuntPool(limit = 10) {
  return prep(`
    SELECT c.* FROM hunt_cache c
    WHERE NOT EXISTS (SELECT 1 FROM hunt_claims cl WHERE cl.character_id = c.character_id)
    ORDER BY RANDOM() LIMIT ?
  `).all(limit);
}

/* ===================== BOT MEMORY ===================== */

function setMemory(key, value, category = 'general') {
  prep('INSERT OR REPLACE INTO bot_memory (key, value, category, updated_at) VALUES (?, ?, ?, datetime(\'now\'))').run(key, value, category);
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
  prep('INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (\'paused\', ?, datetime(\'now\'))').run(paused ? 'true' : 'false');
}

function getBotPaused() {
  const row = prep("SELECT * FROM bot_state WHERE key = 'paused'").get();
  return row ? row.value === 'true' : false;
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
  };
}

async function acquireInstanceLock() {
  if (!PG_CONFIGURED || !pgPool) return false;
  try {
    pgClient = await pgPool.connect();
    const res = await pgClient.query('SELECT pg_try_advisory_lock(123456789) as locked');
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

async function releaseInstanceLock() {
  if (pgHeartbeatTimer) { clearInterval(pgHeartbeatTimer); pgHeartbeatTimer = null; }
  if (pgClient) {
    try {
      await pgClient.query('SELECT pg_advisory_unlock(123456789)');
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
  if (!pgReady || !pgWritable || !pgLockHeld || !pgPool) return;
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
  if (!pgReady || !pgWritable || !pgLockHeld) return;
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
  if (!pgReady || !pgWritable || !pgLockHeld || !pgPool) return;
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
      await ensurePgTables();
      await fullMirror();
    } catch (e) {
      pgLastError = e;
      pgConnected = false;
      pgReady = false;
      pgWritable = false;
      pgDegraded = true;
    }
  }, 15000);
  pgRecoveryTimer.unref && pgRecoveryTimer.unref();
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
  getOrCreateUser, getUser, addWallet, setNetworth, setWallet, setBank,
  findUserByUsername, leaderboard, leaderboardCount, dashboardStats,
  getCooldownCount,
  // Admin / penalties
  isAdminUser, removeAdminUser, getUserStatus, expirePenalties,
  // Cooldowns
  getCooldown, setCooldown, clearAllCooldowns,
  // Lottery
  getLottery, saveLottery,
  // Heists
  getOpenHeists, getHeist, saveHeist, deleteHeist,
  // Inventory
  getInventory, addInventory, removeInventory, hasItem,
  // Game sessions
  getGameSession, setGameSession, deleteGameSession,
  // Logging
  logGameHistory, logActivity, logAudit, logChat,
  // Seen chat IDs
  getSeenChatIds,
  // Broadcast
  createBroadcast, getPendingBroadcasts, markBroadcastDone,
  // Events
  createEvent, getActiveEvents,
  // Missions
  getMissionProgress, upsertMissionProgress,
  // Redeem codes
  getRedeemCode, createRedeemCode, useRedeemCode, deleteRedeemCode,
  listRedeemCodes, addRedeemClaim, hasRedeemClaim,
  // Waifu
  getActiveWaifu, setActiveWaifu, clearActiveWaifu, claimWaifuCharacter,
  getUserCollection, getUserCharacterByIndex, getCharacterByName,
  getWaifuLeaderboard, isWaifuCharacterClaimed,
  // Hunt
  getActiveHunt, setActiveHunt, clearActiveHunt, claimHuntCharacter,
  getHuntCollection, getHuntCharacterByIndex, getHuntLeaderboard,
  isHuntCharacterClaimed, cacheHuntCharacter, getCachedHuntCharacter, getHuntPool,
  // Memory
  setMemory, getMemory, getMemoriesByCategory, deleteMemory,
  // Bot state
  setBotPaused, getBotPaused,
  // Hide
  setHidden, isHidden,
  // Ping
  ping,
  // Postgres
  syncInfo, initPg, ensurePgTables, acquireInstanceLock, releaseInstanceLock,
  startMirrorLoop, startRecoveryLoop, queuePgWrite, drainMirrorQueue,
  fullMirror, mirrorTable,
  // Close
  close,
  // Raw db for advanced use
  db,
};