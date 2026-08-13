'use strict';
/**
 * Rimuru Tempest Casino — entrypoint.
 * Boots the HTTP health server (for Render) + the Telegram bot.
 *
 * Single-instance guard: Render can briefly run TWO processes during a
 * deploy (old instance shutting down + new instance starting). Two bot
 * instances polling the same token = "409 Conflict: terminated by other
 * getUpdates request". We fix that here:
 *   1. Only the "primary" instance (lowest RENDER_INSTANCE_ID, or the sole
 *      instance when the env var is unset) runs the bot. Any duplicate exits
 *      immediately (health server still answers, so Render is happy).
 *   2. On boot we call deleteWebhook() so no stale webhook competes with
 *      getUpdates polling.
 *   3. A 5s startup delay lets the old instance fully shut down before the
 *      new one starts polling.
 */
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const backup = require('./backup');
const { createBot } = require('./bot');
const { createDashboard, ensureOwnerPassword } = require('./dashboard/server');

const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || '';
const PRIMARY_ID = process.env.RENDER_PRIMARY_INSTANCE_ID || '';

// Boot commit hash — lets us PROVE which code is running (Render sets
// RENDER_GIT_COMMIT automatically; local dev falls back to git HEAD).
const COMMIT_HASH =
  process.env.RENDER_GIT_COMMIT ||
  (() => {
    try {
      return require('child_process').execSync('git rev-parse --short HEAD', { timeout: 2000 }).toString().trim();
    } catch (e) {
      return 'unknown';
    }
  })();

// Postgres advisory lock — the HARD single-instance guard. The first process
// to acquire the lock runs the bot + sync loop; any second process (Render
// briefly runs two during a deploy, or a stale instance that never died)
// serves health-only and never writes data. This kills the two-writers race
// that periodic rollbacks were blamed on. Lock key must match db.js.
const PG_LOCK_KEY = 0x52494d55; // "RIMU"
let standby = false;

// ── Single-instance guard ──────────────────────────────────────────────
// If RENDER_INSTANCE_ID is set AND a primary is defined, only the primary
// runs the bot. When the vars are unset (local dev), we run normally.
function isPrimaryInstance() {
  if (!INSTANCE_ID) return true;            // not on Render / no instance id → run
  if (!PRIMARY_ID) return true;             // instance id set but no primary → run (Render 0.9+ sets both; be lenient)
  return INSTANCE_ID === PRIMARY_ID;
}

if (!isPrimaryInstance()) {
  console.log(`[instance] ${INSTANCE_ID} is a duplicate — skipping bot (primary=${PRIMARY_ID}). Health server stays up.`);
  // Health-only mode: keep the port answering so Render doesn't restart us.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'rimuru-casino', instance: INSTANCE_ID, standby: true, time: Date.now() }));
  });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[standby] Health server listening on :${config.port} (GET /health)`);
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
} else {
  main();
}

async function main() {
  console.log(`🐉 Rimuru Tempest Casino — starting (env=${config.env})${INSTANCE_ID ? ` instance=${INSTANCE_ID}` : ''} commit=${COMMIT_HASH}`);

  // ── HARD single-instance guard FIRST: acquire the Postgres advisory lock
  // BEFORE initPersistence() starts any SQLite→PG write pipeline. Only the
  // process that OWNS the lock may mirror; a standby (Render deploy overlap /
  // stale instance) is set read-only so its stale local cache can never be
  // pushed up over the primary's fresh writes (the periodic rollback source).
  // ── Durability: hydrate SQLite from Postgres FIRST ────────────────────
  // initPersistence() connects to Postgres, creates/migrates tables, sets
  // pgReady=true, and hydrates the local SQLite cache from the durable store.
  // It does NOT start the SQLite→PG write pipeline (syncEnabled defaults to
  // false / fail-closed) — the advisory lock below decides who may write.
  const persisted = await db.initPersistence();
  if (persisted.enabled) {
    console.log(`✅ Postgres persistence ON — data survives redeploys (hydrated ${persisted.hydrated} rows).`);
  } else {
    const info = db.syncInfo();
    if (info.configured && !info.ready) {
      // DATABASE_URL is set but Postgres is not connected yet — say it LOUDLY.
      console.error(
        '❌❌❌ POSTGRES PERSISTENCE IS DOWN ❌❌❌\n' +
        'DATABASE_URL is set but the bot could NOT connect to Postgres.\n' +
        'Balances will NOT survive redeploys until this is fixed.\n' +
        `  host=${info.host} port=${info.port} failures=${info.failures} lastError=${info.lastPgError}\n` +
        'Retrying in the background every 15s — check the Render env var value.'
      );
    }
  }

  // ── HARD single-instance guard: acquire the Postgres advisory lock AFTER ─
  // hydration (so pgReady is true and the lock query can actually run). Only
  // the process that OWNS the lock may mirror SQLite→PG. A standby stays
  // read-only so its stale local cache can never be pushed up over the
  // primary's fresh writes (the periodic rollback source).
  try {
    if (db.acquireInstanceLock) {
      standby = !(await db.acquireInstanceLock(PG_LOCK_KEY));
      db.setSyncEnabled(!standby);
      if (standby) {
        console.warn(
          `[instance] ${INSTANCE_ID || process.pid} is STANDBY — another instance holds the bot lock. ` +
          'Health server stays up; SQLite→PG write pipeline DISABLED (prevents dual writers / stale overwrites).'
        );
      } else {
        console.log(`[instance] acquired PG advisory lock ${PG_LOCK_KEY} — I am the bot owner (write pipeline enabled).`);
      }
    } else {
      // No lock support (SQLite-only dev): enable writes for the sole instance.
      db.setSyncEnabled(true);
    }
  } catch (e) {
    console.error('[instance] advisory lock check failed — treating as STANDBY (writes disabled) to prevent stale overwrites:', e.message);
    standby = true;
    db.setSyncEnabled(false);
  }

  // ── Dashboard password (owner login) ─────────────────────────────────
  ensureOwnerPassword();

  // ── Health server for Render ─────────────────────────────────────────
  // We attach the Express dashboard app + Socket.IO to the SAME server, so
  // there is exactly ONE HTTP listener on :PORT (health + dashboard + API).
  let dashboard = null;
  const server = http.createServer((req, res) => {
    // Health route always answers first; everything else goes to Express.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'rimuru-casino',
        commit: COMMIT_HASH,
        standby,
        syncEnabled: db.isSyncEnabled ? db.isSyncEnabled() : true,
        instance: INSTANCE_ID || null,
        persistence: db.syncInfo(),
        backups: backup.getBackupState ? backup.getBackupState() : undefined,
        time: Date.now(),
      }));
      return;
    }
    // Dashboard mounted? Route to Express. Otherwise 404.
    if (dashboard && typeof dashboard.app === 'function') {
      dashboard.app(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  // Create the dashboard (Express app + Socket.IO bound to this server).
  if (config.dashboard.enabled) {
    dashboard = createDashboard(server, null);
    console.log(`🖥️  Admin dashboard mounted (login: owner Telegram ID ${config.ownerId})`);
  }

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`🩺 Health server listening on :${config.port} (GET /health)`);
  });

  // ── Stale-instance cleanup ────────────────────────────────────────────
  // Clear any leftover webhook so getUpdates polling owns the update stream.
  // (node-telegram-bot-api with polling:true calls deleteWebhook internally,
  // but we do it explicitly with a guard so an overlapping old instance can
  // never steal updates mid-deploy.)
  try {
    const probe = new TelegramBot(config.telegramToken);
    const info = await probe.getWebhookInfo();
    if (info && info.url) {
      console.log('[boot] clearing stale webhook:', info.url);
      await probe.deleteWebhook();
    }
    probe.stopPolling && probe.stopPolling();
  } catch (e) {
    console.warn('[boot] webhook probe skipped:', e.message);
  }

  // Let any old overlapping instance finish shutting down before polling.
  await new Promise((r) => setTimeout(r, 5000));

  // Auto-backup scheduler (hidden safety net) — flat 5-min interval with
  // rolling retention + regression detection (see src/backup.js). Only the
  // bot owner (non-standby) instance schedules backups; runScheduledBackup
  // also self-guards on the write-pipeline flag (db.isSyncEnabled).
  if (!standby) {
    try { backup.getBackupState(); } catch (e) { /* non-fatal */ }
    // Boot anchor repair: eagerly clamp/bootstrap backup_last_ts so a stale
    // or future value can never suppress the 5-min schedule (root cause of
    // "auto-backup stopped completely").
    try { backup.clampBackupAnchor(); } catch (e) { /* non-fatal */ }
    // Boot diagnostic: print the scheduler anchor so we can SEE it is alive
    // and not suppressed by a stale/future backup_last_ts. The first tick
    // after boot also clamps/bootstraps a bad anchor (see runScheduledBackup).
    try {
      const bs = backup.getBackupState();
      const lastAt = Number(bs && bs.lastBackupAt) || 0;
      const nextDue = lastAt > 0 ? Math.max(0, lastAt + bs.intervalMs - Date.now()) : bs.intervalMs;
      console.log(
        `[backup] state: enabled=${bs.enabled} every=${Math.round(bs.intervalMs / 60000)}min keep=${bs.keep} ` +
        `ran=${bs.runCount} suspect=${bs.suspectCount} lastAnchor=${lastAt || 'none'} nextDueIn=${Math.round(nextDue / 1000)}s`
      );
    } catch (e) { /* non-fatal */ }
    setInterval(() => {
      try {
        const r = backup.runScheduledBackup();
        if (r && r.ran && r.suspect) {
          db.logActivity('backup', `Auto-backup flagged SUSPECT (${r.reason || 'regression'}) - good chain kept`, {});
        }
      } catch (e) {
        console.error('[backup] scheduler tick error:', e.message);
      }
    }, config.autoBackup.checkMs);
    console.log(`[backup] scheduler ON - every ${config.autoBackup.intervalMs / 60000} min, keep ${config.autoBackup.keep}, regression threshold ${Math.round(config.autoBackup.regressionPct * 100)}%`);
  } else {
    console.log('[backup] scheduler SKIPPED (standby instance).');
  }

  // ── Bot ───────────────────────────────────────────────────────────────
  let bot;
  try {
    if (standby) {
      console.warn('[instance] standby — bot NOT started (another instance owns the lock).');
    } else {
      bot = createBot();
      console.log('🤖 Rimuru Tempest is awake. The house is open.');
    }
  } catch (e) {
    console.error('💥 Failed to start bot:', e.message);
    process.exit(1);
  }

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down…`);
    try {
      server.close();
      if (bot) bot.stopPolling();
      if (db.releaseInstanceLock) db.releaseInstanceLock(PG_LOCK_KEY).catch(() => {});
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}