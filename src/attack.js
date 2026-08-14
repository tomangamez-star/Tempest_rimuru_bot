'use strict';
/**
 * Rimuru Tempest Casino — Attack / Security Event System 🐉
 *
 * Rimuru randomly spawns attackers that hunt WEALTHY players (net worth >=
 * 250B). The richer the target, the higher their chance of being selected and
 * the more attackers are deployed. A player's purchased Security (inventory
 * item) fights first; if it is overwhelmed the player faces timed code
 * challenges (ONLINE only). Offline players rely on security alone.
 *
 * SPAWN RATE (hard requirement):
 *   - attackers spawn AT LEAST once every hour,
 *   - sometimes twice in an hour,
 *   - at most three times per hour.
 *   Each spawn MUST be a DIFFERENT user (no repeat target in the same hour).
 *
 * This module is intentionally split into two layers:
 *   1. PURE functions (deterministic, testable without Telegram).
 *   2. A controller (attach() → trigger / handleInput / sweep / scheduler)
 *      that wires the pure logic to the Telegram bot via injected callbacks.
 *
 * PERSISTENCE: the controller uses read-only db reads + the existing
 * db.addWallet / db.addItem write helpers, so every balance/security mutation
 * goes through the v4 versioned write pipeline unchanged. It does NOT touch
 * advisory locking, hydration, or fencing.
 */
const config = require('./config');
const db = require('./db');
const { fmt, clamp } = require('./utils');

/* ================= PURE LOGIC (testable, no Telegram) ================= */

/** Min net worth to be a legal attack target (from config). */
function minNetWorth() {
  return config.attack.minNetWorth;
}

/** True when a net worth qualifies as an attack target. */
function isEligibleTarget(networth) {
  return Number(networth) >= minNetWorth();
}

/**
 * Weighted target selection: bigger net worth → higher chance. Returns an
 * eligible user row (with networth) or null when the list is empty.
 * `excludeIds` is a Set of user ids to never return (cooldowns + this hour).
 */
function pickTargetWeighted(eligible, excludeIds = null, rng = Math.random) {
  if (!Array.isArray(eligible) || !eligible.length) return null;
  const pool = excludeIds ? eligible.filter((u) => !excludeIds.has(Number(u.user_id))) : eligible;
  if (!pool.length) return null;
  // Weight = networth (ascending order from db keeps ties stable).
  const total = pool.reduce((sum, u) => sum + Math.max(1, Number(u.networth)), 0);
  let roll = rng() * total;
  for (const u of pool) {
    roll -= Math.max(1, Number(u.networth));
    if (roll <= 0) return u;
  }
  return pool[pool.length - 1];
}

/**
 * Number of attackers deployed — scales with the target's net worth.
 * 250B → low (min), 500B → moderate, 1T → high, 10T → very high,
 * 100T+ → extreme (max).
 */
function attackerCountFor(networth, rng = Math.random) {
  const b = Number(networth) / 1e9; // billions
  const min = config.attack.minAttackers;
  const max = config.attack.maxAttackers;
  const lo = minNetWorth() / 1e9;           // 250
  const hi = 100000;                        // 100T in billions
  const ratio = clamp((b - lo) / (hi - lo), 0, 1);
  const count = Math.round(min + ratio * (max - min));
  // Light random wobble so not every rich target gets the identical count.
  const wobble = rng() < 0.5 ? -1 : 1;
  return clamp(count + wobble, min, max);
}

/**
 * SPAWN-RATE ROLL: how many attackers spawn on this hourly tick.
 * 60% → 1, 30% → 2, 10% → 3. Satisfies "at least once, sometimes twice,
 * at most three times per hour".
 */
function rollSpawnsThisHour(rng = Math.random) {
  const r = rng();
  if (r < 0.6) return 1;
  if (r < 0.9) return 2;
  return 3;
}

/**
 * Build the increasingly-harder challenge code for a round (1-indexed).
 * Round 1 = fixed easy "911", then longer/randomized phrases.
 */
function buildChallenge(round, rng = Math.random) {
  const digits = (n) => String(Math.floor(rng() * Math.pow(10, n))).padStart(n, '0');
  switch (round) {
    case 1: return '911';
    case 2: return `RIMURU-${digits(3)}`;
    case 3: return `${digits(5)}-RM`;
    default: return `${digits(3)}-RIMURU-${digits(2)}`;
  }
}

/** Controlled financial consequence: a % of wallet, clamped, never all of it. */
function stealAmount(wallet) {
  const w = Math.max(0, Number(wallet) || 0);
  if (!w) return 0;
  const raw = Math.floor(w * config.attack.breachPct);
  const capped = clamp(raw, config.attack.breachMin, config.attack.breachMax);
  return Math.max(0, Math.min(capped, w));
}

/* ================= CONTROLLER (Telegram wiring) ================= */

// In-memory state (intentionally ephemeral — a redeploy simply re-rolls).
const pendingChallenges = new Map(); // userId -> { code, round, roundsTotal, expiresAt, timer, attackers, chatId }
const recentTargets = new Map();     // userId -> last attacked timestamp
const lastSeen = new Map();          // userId -> last message timestamp
let spawnedThisHour = new Set();     // distinct user ids attacked this hour
let hourStart = 0;
let globalLastSpawnAt = 0;
let schedulerTimer = null;
let deps = null; // { bot, reply, announce } set by attach()

function attach(d) {
  deps = d || null;
  return module.exports;
}

/** Record that a user was seen online (called from the message router). */
function markSeen(userId) {
  lastSeen.set(Number(userId), Date.now());
}

/** Whether a user is "online" = sent a message within the online window. */
function isOnline(userId) {
  const ts = lastSeen.get(Number(userId));
  return ts ? (Date.now() - ts) <= config.attack.onlineWindowMs : false;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function targetHandle(u) {
  return u.username ? `@${esc(u.username)}` : esc(u.first_name || `user ${u.user_id}`);
}

/** Reset the per-hour distinct-target set when the hour rolls over. */
function rollHourIfNeeded(now = Date.now()) {
  if (!hourStart || now - hourStart >= 60 * 60 * 1000) {
    hourStart = now;
    spawnedThisHour = new Set();
  }
}

function isTargetOnCooldown(userId, now = Date.now()) {
  const ts = recentTargets.get(Number(userId));
  return ts ? (now - ts) < config.attack.targetCooldownMs : false;
}

function isGlobalOnCooldown(now = Date.now()) {
  return globalLastSpawnAt ? (now - globalLastSpawnAt) < config.attack.globalCooldownMs : false;
}

/** Send a message to a chat (DM or group) via the injected reply wrapper. */
async function send(chatId, text, opts = {}) {
  if (deps && typeof deps.reply === 'function') {
    try { return await deps.reply(chatId, text, opts); } catch (e) { console.warn('[attack] reply failed:', e.message); }
  }
  return null;
}

/** Announce a random-event message to all known chats via the broadcast queue. */
async function announce(text) {
  if (deps && typeof deps.announce === 'function') {
    try { await deps.announce(text); return; } catch (e) { console.warn('[attack] announce failed:', e.message); }
  }
  // Fallback: at least DM the target if we know it (handled by caller).
}

/* ---------------- challenge lifecycle ---------------- */

async function failBreach(targetId, chatId, attackers, reason) {
  clearChallenge(targetId);
  const u = db.getUser(targetId) || { wallet: 0 };
  const stolen = stealAmount(u.wallet);
  if (stolen > 0) db.addWallet(targetId, -stolen);
  const after = db.getUser(targetId) || { wallet: 0 };
  db.logActivity('event', `Attack breached ${targetId} (${reason}) — stolen ${stolen}`, { target: targetId, stolen });
  await send(chatId,
    `🔴 <b>BREACH COMPLETE</b>\n\n` +
    `The attackers escaped before authorities arrived.\n` +
    `💰 Stolen: <b>${fmt(stolen)}</b>\n` +
    `👛 Remaining wallet: <b>${fmt(after.wallet)}</b>`,
    { title: '🔴 ATTACK BREACHED', color: '#FF5252', html: true }
  );
}

function clearChallenge(userId) {
  const p = pendingChallenges.get(Number(userId));
  if (p && p.timer) clearTimeout(p.timer);
  pendingChallenges.delete(Number(userId));
}

/** Send the next challenge (or declare victory when all rounds complete). */
async function sendNextChallenge(targetId, chatId, round, roundsTotal, attackers) {
  const code = buildChallenge(round);
  const expiresAt = Date.now() + config.attack.challengeWindowMs;
  // Clear any prior timer (idempotent).
  const prev = pendingChallenges.get(targetId);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    failBreach(targetId, chatId, attackers, 'challenge timeout');
  }, config.attack.challengeWindowMs + 500);
  timer.unref && timer.unref();
  pendingChallenges.set(targetId, { code, round, roundsTotal, expiresAt, timer, attackers, chatId });
  await send(chatId,
    `🚨 <b>SYSTEM BREACH!</b>\n\n` +
    `Attackers are inside your network!\n` +
    `Type:\n\n<code>${code}</code>\n\n` +
    `⏱ <b>${Math.round(config.attack.challengeWindowMs / 1000)} SECONDS</b>`,
    { title: '🚨 SYSTEM BREACH', color: '#FF5252', html: true }
  );
}

async function succeedDefense(targetId, chatId, attackers) {
  clearChallenge(targetId);
  const remaining = db.getItemQty(targetId, 'security');
  await send(chatId,
    `🛡️ <b>BREACH CONTAINED</b>\n\n` +
    `🚨 Emergency response successful.\n` +
    `🕵️ All attackers have been arrested.\n` +
    `💰 Your funds are <b>SAFE</b>.\n` +
    `🔐 Security remaining: <b>${remaining}</b>`,
    { title: '🛡️ BREACH CONTAINED', color: '#4FC3F7', html: true }
  );
}

/** Handle a message that might be a challenge answer. Returns true if consumed. */
async function handleInput(userId, chatId, text) {
  const p = pendingChallenges.get(Number(userId));
  if (!p) return false;
  const answer = String(text || '').trim();
  if (answer !== p.code) {
    await failBreach(userId, chatId || p.chatId, p.attackers, 'wrong code');
    return true;
  }
  // Correct — advance to the next round, or win.
  const nextRound = p.round + 1;
  if (nextRound > p.roundsTotal) {
    await succeedDefense(userId, chatId || p.chatId, p.attackers);
    return true;
  }
  await sendNextChallenge(userId, chatId || p.chatId, nextRound, p.roundsTotal, p.attackers);
  return true;
}

/** Expire any pending challenge whose window elapsed (safety sweep). */
async function sweep() {
  const now = Date.now();
  const expired = [];
  for (const [uid, p] of pendingChallenges) {
    if (now >= p.expiresAt) expired.push(uid);
  }
  for (const uid of expired) {
    const p = pendingChallenges.get(uid);
    if (p) await failBreach(uid, p.chatId, p.attackers, 'challenge timeout');
  }
  return expired.length;
}

/* ---------------- attack trigger ---------------- */

/**
 * Run one attack spawn: find + select a target, deploy attackers, resolve the
 * security fight, then either stop (repelled) or start the breach challenge /
 * apply the financial consequence. Returns a result object for the caller.
 */
async function spawnOne({ manual = false, force = false, chatId = null, actorId = 0 } = {}) {
  const now = Date.now();
  rollHourIfNeeded(now);

  if (!force && isGlobalOnCooldown(now)) {
    return { ok: false, message: 'Rimuru just deployed attackers — the kingdom is on cooldown. Try again shortly.' };
  }

  // Search for eligible targets, excluding cooldown + this-hour repeats.
  const eligible = db.getAttackEligibleUsers(minNetWorth());
  const exclude = new Set();
  for (const uid of spawnedThisHour) exclude.add(uid);
  for (const [uid, ts] of recentTargets) if (now - ts < config.attack.targetCooldownMs) exclude.add(Number(uid));
  const target = pickTargetWeighted(eligible, exclude);

  if (!target) {
    globalLastSpawnAt = now;
    const msg = `🐉 Rimuru spawned attackers...\n🕵️ Attackers are searching for a valuable target...\n\n🕵️ <b>No eligible target found</b> (nobody is worth ${fmt(minNetWorth())} yet) — the attackers simply leave.`;
    if (chatId) await send(chatId, msg, { title: '🐉 ATTACK EVENT', color: '#FF5252', html: true });
    else await announce(msg);
    return { ok: true, message: msg, targetId: null, attackers: 0 };
  }

  const targetId = Number(target.user_id);
  const attackers = attackerCountFor(target.networth);
  const online = isOnline(targetId);
  const playerSecurity = db.getItemQty(targetId, 'security');
  const effectiveSecurity = playerSecurity + (online ? config.attack.onlineSecurityBonus : 0);

  // Mark cooldowns + this-hour distinct target.
  globalLastSpawnAt = now;
  recentTargets.set(targetId, now);
  spawnedThisHour.add(targetId);

  // Announcement (spawn → search → target acquired → deployed).
  const ann =
    `🐉 <b>Rimuru has spawned attackers...</b>\n` +
    `🕵️ Attackers are searching for a valuable target...\n\n` +
    `🚨 <b>TARGET ACQUIRED</b>\n` +
    `🎯 Target: ${targetHandle(target)}\n` +
    `💰 Net Worth: <b>${fmt(target.networth)}</b>\n\n` +
    `🕵️ <b>${attackers} attackers deployed.</b>`;
  if (chatId) await send(chatId, ann, { title: '🐉 ATTACK EVENT', color: '#FF5252', html: true });
  else await announce(ann);

  // Security fight.
  await send(targetId,
    `🛡️ <b>SECURITY DEPLOYED</b>\n` +
    `Player security: ${playerSecurity}\n` +
    `Incoming attackers: ${attackers}\n\n` +
    `⚔️ <b>SECURITY VS ATTACKERS...</b>`,
    { title: '🛡️ SECURITY DEPLOYED', color: '#4FC3F7', html: true }
  );

  if (effectiveSecurity >= attackers) {
    // Security wins — consume exactly `attackers` security (never below 0).
    if (attackers > 0) db.addItem(targetId, 'security', -attackers);
    db.logActivity('event', `Attack repelled for ${targetId} (${attackers} attackers)`, { target: targetId });
    await send(targetId,
      `🛡️ <b>ATTACK REPELLED!</b>\n\n` +
      `Your security successfully defended your funds.\n\n` +
      `🔐 Security consumed: <b>${Math.min(attackers, playerSecurity)}</b>\n` +
      `💰 Funds protected.`,
      { title: '🛡️ ATTACK REPELLED', color: '#4FC3F7', html: true }
    );
    return { ok: true, targetId, attackers, security: playerSecurity, outcome: 'repelled' };
  }

  // Breached — consume all security, then breach stage.
  if (playerSecurity > 0) db.addItem(targetId, 'security', -playerSecurity);
  await send(targetId,
    `🔴 <b>SECURITY BREACHED</b>\n\n` +
    `Your security system has been overwhelmed.\n` +
    `🚨 Attackers have entered the next stage...`,
    { title: '🔴 SECURITY BREACHED', color: '#FF5252', html: true }
  );

  if (online) {
    // Interactive breach: up to challengeRounds timed codes.
    await sendNextChallenge(targetId, targetId, 1, config.attack.challengeRounds, attackers);
    return { ok: true, targetId, attackers, security: playerSecurity, outcome: 'breach-interactive' };
  }

  // Offline → automatic financial consequence.
  await failBreach(targetId, targetId, attackers, 'offline target');
  return { ok: true, targetId, attackers, security: playerSecurity, outcome: 'breach-offline' };
}

/**
 * Public trigger used by /attack (manual) and the random scheduler.
 * manual=true announces in the given chat; manual=false broadcasts.
 */
async function trigger(opts = {}) {
  const r = await spawnOne(opts);
  return r;
}

/* ---------------- random hourly scheduler ---------------- */

/** Start the random attack scheduler (once per spawnIntervalMs). */
function startRandomScheduler() {
  if (!config.attack.enabled) return null;
  if (schedulerTimer) return schedulerTimer;
  // Fire a first spawn after a short warm-up so the feature is live soon.
  const firstDelay = 15 * 1000;
  let firstDone = false;
  schedulerTimer = setTimeout(function tick() {
    if (!config.attack.enabled) return;
    if (!firstDone) {
      firstDone = true;
      schedulerTimer = setInterval(runHourlySpawns, config.attack.spawnIntervalMs);
      schedulerTimer.unref && schedulerTimer.unref();
      // Do one immediate spawn on warm-up, then the hourly cadence takes over.
      runHourlySpawns();
      return;
    }
    runHourlySpawns();
  }, firstDelay);
  schedulerTimer.unref && schedulerTimer.unref();
  return schedulerTimer;
}

async function runHourlySpawns() {
  rollHourIfNeeded();
  const count = rollSpawnsThisHour();
  console.log(`[attack] hourly tick — spawning ${count} attacker(s)`);
  for (let i = 0; i < count; i++) {
    try {
      await spawnOne({ manual: false });
    } catch (e) {
      console.error('[attack] spawn error:', e.message);
    }
  }
}

function stopRandomScheduler() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Expose state for tests + debug. */
function state() {
  return {
    pendingChallenges: pendingChallenges.size,
    recentTargets: recentTargets.size,
    spawnedThisHour: [...spawnedThisHour],
    globalLastSpawnAt,
    schedulerRunning: !!schedulerTimer,
  };
}

module.exports = {
  // pure
  minNetWorth,
  isEligibleTarget,
  pickTargetWeighted,
  attackerCountFor,
  rollSpawnsThisHour,
  buildChallenge,
  stealAmount,
  // controller
  attach,
  markSeen,
  isOnline,
  trigger,
  handleInput,
  sweep,
  startRandomScheduler,
  stopRandomScheduler,
  state,
  // internal test hooks
  _clear: () => {
    pendingChallenges.clear();
    recentTargets.clear();
    lastSeen.clear();
    spawnedThisHour = new Set();
    hourStart = 0;
    globalLastSpawnAt = 0;
  },
};
