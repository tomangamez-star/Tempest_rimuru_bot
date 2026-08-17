'use strict';
/**
 * Rimuru Tempest Casino — Rimuru Memory System 🧠
 *
 * A persistent memory layer for Rimuru AI. Uses the bot_memory table in
 * SQLite/Postgres (via db.js) to store and recall information about users,
 * groups, events, coin circulation, and bot facts.
 *
 * Categories:
 *   user_info    — facts about specific users (preferences, notes)
 *   group_event  — events that happened in a group chat
 *   coin_stats   — coin circulation, economy snapshots
 *   bot_fact     — general bot knowledge (rules, lore)
 *   conversation — recent conversation context
 */
const db = require('./db');

const VALID_CATEGORIES = ['user_info', 'group_event', 'coin_stats', 'bot_fact', 'conversation', 'general'];

function validCategory(cat) {
  return VALID_CATEGORIES.includes(String(cat || '').toLowerCase()) ? String(cat).toLowerCase() : 'general';
}

/**
 * Store a memory. Upserts by key.
 * @param {string} key - Unique memory key (e.g. "user:12345:preferred_game")
 * @param {*} value - Value to store (will be JSON-stringified if object)
 * @param {string} [category='general'] - One of: user_info, group_event, coin_stats, bot_fact, conversation
 */
function remember(key, value, category = 'general') {
  const k = String(key || '').trim();
  if (!k) return false;
  const v = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  db.setMemory(k, v, validCategory(category));
  return true;
}

/**
 * Recall a memory by key.
 * @param {string} key - The memory key
 * @returns {object|null} { key, value, category, updated_at } or null
 */
function recall(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const row = db.getMemory(k);
  if (!row) return null;
  // Try to parse JSON value
  try {
    row.value = JSON.parse(row.value);
  } catch (_) { /* keep as string */ }
  return row;
}

/**
 * Recall all memories in a category.
 * @param {string} category
 * @returns {Array} Array of { key, value, category, updated_at }
 */
function recallByCategory(category) {
  const cat = validCategory(category);
  return db.getMemoriesByCategory(cat).map((row) => {
    try {
      row.value = JSON.parse(row.value);
    } catch (_) { /* keep as string */ }
    return row;
  });
}

/**
 * Forget a memory by key.
 * @param {string} key
 */
function forget(key) {
  db.deleteMemory(String(key || '').trim());
}

/**
 * Build a context string from recent memories for the Rimuru system prompt.
 * @param {number} [limit=5] - Max memories to include
 * @returns {string} A formatted string of recent memories
 */
function contextString(limit = 5) {
  const rows = db.getMemoriesByCategory('conversation').slice(0, limit);
  if (!rows.length) return '';
  return 'Recent memories:\n' + rows.map((r) => `  - ${r.key}: ${r.value}`).join('\n');
}

module.exports = {
  remember,
  recall,
  recallByCategory,
  forget,
  contextString,
  VALID_CATEGORIES,
};
