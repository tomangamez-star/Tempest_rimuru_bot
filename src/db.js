'use strict';
/**
 * Rimuru Tempest Casino — SQLite data layer (better-sqlite3).
 * Stores: users (balance/wallet/bank/status), cooldowns, lottery state, heists.
 * All operations are synchronous & atomic (better-sqlite3).
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureDir } = require('./utils');

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
`);

/* ---------------- Users ---------------- */

function getOrCreateUser(userId, meta = {}) {
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (row) {
    if (meta.username || meta.first_name) {
      db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?')
        .run(meta.username || row.username, meta.first_name || row.first_name, userId);
    }
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  }
  db.prepare('INSERT INTO users (user_id, username, first_name, wallet, bank, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, meta.username || '', meta.first_name || '', config.startBalance, 0, 'active', Date.now());
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function getNetWorth(userId) {
  const u = getUser(userId);
  if (!u) return 0;
  return u.wallet + u.bank;
}

function setWallet(userId, amount) {
  db.prepare('UPDATE users SET wallet = ? WHERE user_id = ?').run(amount, userId);
}

function setBank(userId, amount) {
  db.prepare('UPDATE users SET bank = ? WHERE user_id = ?').run(amount, userId);
}

/** Atomically add to wallet (positive or negative). Returns new wallet. */
function addWallet(userId, delta) {
  db.prepare('UPDATE users SET wallet = wallet + ? WHERE user_id = ?').run(delta, userId);
  return getUser(userId).wallet;
}

/** Atomically add to bank. Returns new bank. */
function addBank(userId, delta) {
  db.prepare('UPDATE users SET bank = bank + ? WHERE user_id = ?').run(delta, userId);
  return getUser(userId).bank;
}

function setStatus(userId, status, reason, until = 0) {
  db.prepare('UPDATE users SET status = ?, status_reason = ?, status_until = ? WHERE user_id = ?')
    .run(status, reason || '', until, userId);
}

function clearStatus(userId) {
  db.prepare("UPDATE users SET status = 'active', status_reason = '', status_until = 0 WHERE user_id = ?").run(userId);
}

/** Top 10 by net worth (wallet + bank). */
function leaderboard(limit = 10) {
  return db.prepare(`
    SELECT user_id, username, first_name, wallet, bank, (wallet + bank) AS networth
    FROM users
    ORDER BY networth DESC
    LIMIT ?
  `).all(limit);
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
}

function clearCooldown(userId, action) {
  db.prepare('DELETE FROM cooldowns WHERE user_id = ? AND action = ?').run(userId, action);
}

/* ---------------- Lottery ---------------- */

function getLottery() {
  let row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO lottery (id, pot, ticket_count, tickets) VALUES (1, ?, 0, ?)')
      .run(config.lottery.baseJackpot, '[]');
    row = db.prepare('SELECT * FROM lottery WHERE id = 1').get();
  }
  row.tickets = JSON.parse(row.tickets);
  return row;
}

function saveLottery(pot, ticketCount, tickets) {
  db.prepare('UPDATE lottery SET pot = ?, ticket_count = ?, tickets = ? WHERE id = 1')
    .run(pot, ticketCount, JSON.stringify(tickets));
}

/* ---------------- Heists ---------------- */

function getHeist(leaderId) {
  const row = db.prepare('SELECT * FROM heists WHERE leader_id = ?').get(leaderId);
  if (!row) return null;
  row.members = JSON.parse(row.members);
  return row;
}

function createHeist(heist) {
  db.prepare('INSERT INTO heists (leader_id, leader_name, target_id, target_name, members, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(heist.leader_id, heist.leader_name, heist.target_id, heist.target_name, JSON.stringify(heist.members), heist.started_at, heist.status);
}

function updateHeistMembers(leaderId, members) {
  db.prepare('UPDATE heists SET members = ? WHERE leader_id = ?').run(JSON.stringify(members), leaderId);
}

function updateHeistStatus(leaderId, status) {
  db.prepare('UPDATE heists SET status = ? WHERE leader_id = ?').run(status, leaderId);
}

function deleteHeist(leaderId) {
  db.prepare('DELETE FROM heists WHERE leader_id = ?').run(leaderId);
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
  return expired;
}

function close() {
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
  leaderboard,
  getCooldown,
  setCooldown,
  clearCooldown,
  getLottery,
  saveLottery,
  getHeist,
  createHeist,
  updateHeistMembers,
  updateHeistStatus,
  deleteHeist,
  expirePenalties,
  close,
};
