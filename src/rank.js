'use strict';
/**
 * Rimuru Tempest Casino — Rank System 🏆
 *
 * Ranks: Bronze → Silver → Gold → Platinum → Diamond → Master → Legend →
 * Mythic (hidden). Promotion counts VALID matches only (bet >= 10% of the
 * player's balance), and 7 consecutive losses demote one rank.
 *
 * Dynamic house win %: during NON-peak hours the PLAYER win chance depends on
 * the rank tier (whales get worse odds). During peak hours (08:00–11:00 West
 * African Time / Nigeria, UTC+1) everything is a flat 50/50.
 *
 * Rewards are claimed on promotion: timed coins land in the TIME-WALLET (safe,
 * unrobbable, expires), non-timed coins land in the wallet, and every reward
 * also grants non-expiring inventory items.
 */
const config = require('./config');
const db = require('./db');

/** Ladder in promotion order (index 0 = lowest). */
const RANKS = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'legend',
  'mythic',
];

/** Total valid matches required to REACH each rank (index matches RANKS). */
const THRESHOLDS = [0, 10, 15, 25, 30, 50, 100, 1000];

/** Player win chance by rank during non-peak hours. */
const NON_PEAK_WIN_CHANCE = {
  bronze: 0.60,
  silver: 0.55,
  gold: 0.55,
  platinum: 0.55,
  diamond: 0.55,
  master: 0.45,
  legend: 0.40,
  mythic: 0.35,
};

/** Peak-hour window (UTC+1 = West African Time / Nigeria). */
const PEAK_START_HOUR = 8;
const PEAK_END_HOUR = 11; // exclusive: 08:00 ≤ h < 11:00

function rankIndex(rank) {
  const i = RANKS.indexOf(String(rank || '').toLowerCase());
  return i === -1 ? 0 : i;
}

/** Current rank string, defaulting to bronze for unknown values. */
function normalizeRank(rank) {
  return RANKS[rankIndex(rank)];
}

/** Threshold (total valid matches) to reach the given rank. */
function thresholdFor(rank) {
  return THRESHOLDS[rankIndex(rank)] || 0;
}

/** True during peak hours (08:00–11:00 WAT / UTC+1). */
function isPeakHour(now = new Date()) {
  const wat = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1, no DST
  const h = wat.getUTCHours();
  return h >= PEAK_START_HOUR && h < PEAK_END_HOUR;
}

/** Resolve a user-ish argument to a rank string. */
function resolveRank(user) {
  if (user == null) return 'bronze';
  if (typeof user === 'string') return normalizeRank(user);
  if (typeof user === 'number') {
    const u = db.getUser(user);
    return u ? normalizeRank(u.rank) : 'bronze';
  }
  return normalizeRank(user.rank);
}

/**
 * Chance that the PLAYER wins a given game.
 * Peak hours → flat 50/50 for every rank. Otherwise the rank tier applies.
 */
function getWinChance(user, game) {
  if (isPeakHour()) return 0.5;
  return NON_PEAK_WIN_CHANCE[resolveRank(user)] ?? 0.5;
}

/**
 * A match counts toward rank progression only when the bet is at least 10% of
 * the player's current balance (wallet — the spendable pool bets are drawn
 * from). `/mines 1` with a huge balance therefore does NOT advance rank.
 */
function isValidMatch(userId, betAmount) {
  const amt = Math.max(0, Number(betAmount) || 0);
  if (amt <= 0) return false;
  const u = db.getUser(userId);
  if (!u) return false;
  const balance = Math.max(1, Number(u.wallet) || 0);
  return amt >= balance * 0.10;
}

/** Reward table, in promotion order. */
function rewardFor(rank) {
  const r = normalizeRank(rank);
  const rewards = {
    bronze: { coins: 50000000, timed: true, ttlMs: 48 * 3600000, items: ['lucky'] },
    silver: { coins: 150000000, timed: true, ttlMs: 48 * 3600000, items: ['lucky', 'hook'] },
    gold: { coins: 400000000, timed: true, ttlMs: 72 * 3600000, items: ['lucky', 'hook', 'lockpick'] },
    platinum: { coins: 750000000, timed: true, ttlMs: 96 * 3600000, items: ['lockpick', 'mask', 'security'] },
    diamond: { coins: 2000000000, timed: false, items: ['security', 'mask', 'drill'] },
    master: { coins: 50000000000, timed: false, items: ['security', 'cyber', 'drill'] },
    legend: { coins: 500000000000, timed: false, items: ['cyber', 'security', 'drill', 'lucky'] },
    mythic: { coins: 1000000000000, timed: false, items: ['cyber', 'security', 'drill', 'lucky', 'mask'] },
  };
  return rewards[r] || rewards.bronze;
}

/** How many total valid matches remain before the next promotion. */
function matchesToNext(userId) {
  const u = db.getUser(userId) || { rank: 'bronze', rank_valid_matches: 0 };
  const idx = rankIndex(u.rank);
  if (idx >= RANKS.length - 1) return 0;
  const next = THRESHOLDS[idx + 1];
  const have = Number(u.rank_valid_matches) || 0;
  return Math.max(0, next - have);
}

/**
 * Apply a single game settlement to rank progression.
 * @param {number} userId
 * @param {number} betAmount
 * @param {boolean|string} won - true/'win' = win, false/'lose' = loss,
 *                               'push' = push/tie (counts, breaks the streak
 *                               without demoting)
 * @returns { counted, promoted, demoted, rank, matchesToNext }
 */
function recordMatchResult(userId, betAmount, won) {
  const u = db.getUser(userId);
  if (!u) return { counted: false };

  // Bets below 10% of balance are not "valid matches" — they still play, they
  // just don't advance (or demote) the player's rank.
  if (!isValidMatch(userId, betAmount)) {
    return { counted: false, rank: normalizeRank(u.rank) };
  }

  const outcome = won === true || won === 'win' ? 'win' : won === 'push' ? 'push' : 'lose';
  let validMatches = Number(u.rank_valid_matches) || 0;
  let losses = Number(u.rank_consecutive_losses) || 0;
  let rank = normalizeRank(u.rank);
  let demoted = false;

  if (outcome === 'win') {
    losses = 0;
    validMatches += 1;
  } else if (outcome === 'push') {
    losses = 0; // a push is not a failure — break the streak
    validMatches += 1;
  } else {
    losses += 1;
    validMatches += 1; // valid matches count regardless of outcome
    if (losses >= 7) {
      const idx = rankIndex(rank);
      if (idx > 0) {
        rank = RANKS[idx - 1];
        demoted = true;
      }
      losses = 0;
    }
  }

  let promoted = false;
  let granted = null;
  if (!demoted) {
    const idx = rankIndex(rank);
    if (idx < RANKS.length - 1 && validMatches >= THRESHOLDS[idx + 1]) {
      rank = RANKS[idx + 1];
      promoted = true;
      granted = grantRankReward(userId, rank);
    }
  }

  db.setRankStats(userId, rank, validMatches, losses);

  return {
    counted: true,
    promoted,
    demoted,
    rank,
    matchesToNext: matchesToNext(userId),
    reward: granted,
  };
}

/** Grant coins + items for reaching a rank (called on promotion). */
function grantRankReward(userId, rank) {
  const r = rewardFor(rank);
  const now = Date.now();

  if (r.timed) {
    db.addTimeWallet(userId, r.coins, now + r.ttlMs, `rank:${rank}`);
  } else {
    db.addWallet(userId, r.coins, `rank:${rank}`);
  }

  for (const itemId of r.items || []) {
    db.addItem(userId, itemId, 1);
  }

  db.logActivity('event', `🏆 Rank reward granted: ${rank} (+${r.coins})`, {
    target: userId,
    rank,
    coins: r.coins,
    timed: !!r.timed,
  });

  return { rank, coins: r.coins, timed: r.timed, items: r.items };
}

/** Ladder text for /ranks. */
function ranksList() {
  return RANKS.map((r, i) => {
    const emoji = ['🥉', '🥈', '🥇', '💠', '💎', '🔮', '👑', '🌌'][i];
    const reward = rewardFor(r);
    const need = THRESHOLDS[i];
    return `${emoji} <b>${r.toUpperCase()}</b> — reach at <b>${need}</b> valid matches` +
      `\n   reward: ${reward.coins.toLocaleString()} coins${reward.timed ? ' (⏳ timed)' : ' (saved)'}`;
  }).join('\n\n');
}

module.exports = {
  RANKS,
  THRESHOLDS,
  NON_PEAK_WIN_CHANCE,
  PEAK_START_HOUR,
  PEAK_END_HOUR,
  rankIndex,
  normalizeRank,
  thresholdFor,
  isPeakHour,
  resolveRank,
  getWinChance,
  isValidMatch,
  rewardFor,
  matchesToNext,
  recordMatchResult,
  grantRankReward,
  ranksList,
};
