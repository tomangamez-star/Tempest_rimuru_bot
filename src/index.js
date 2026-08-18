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
  // Environment IDs are only a hint. Postgres advisory locking below is the
  // authoritative single-writer fence. Missing PRIMARY_ID must NEVER grant
  // extra write authority during a deploy overlap.
  if (!INSTANCE_ID) return true;
  if (!PRIMARY_ID) return true;
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

  // IMPORTANT: Render health is a liveness check, not the persistence readiness check.
  // Start the HTTP listener BEFORE Postgres initialization/locking so Render never
  // waits on a slow database connection or receives 503 just because this process
  // is temporarily a standby during a deploy overlap. The JSON reports readiness.
  let dashboard = null;
  let bot;
  let server;
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const persistence = db.syncInfo();
      const ready = !persistence.configured ||
        (persistence.ready && persistence.connected && persistence.instanceLockHeld && !standby);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ready,
        service: 'rimuru-casino',
        commit: COMMIT_HASH,
        standby,
        syncEnabled: db.isSyncEnabled ? db.isSyncEnabled() : true,
        instance: INSTANCE_ID || null,
        persistence,
        backups: backup.getBackupState ? backup.getBackupState() : undefined,
        time: Date.now(),
      }));
      return;
    }
    if (dashboard && typeof dashboard.app === 'function') {
      dashboard.app(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  console.log(`🩺 Health server listening on :${config.port} (GET /health)`);


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
  let persisted = { enabled: false, hydrated: 0 };
  if (db.initPersistence) {
    try {
      persisted = await db.initPersistence();
      if (db.startRecoveryLoop) db.startRecoveryLoop();
    } catch (e) {
      console.warn('[db] initPersistence() failed:', e.message);
      persisted = { enabled: false, hydrated: 0 };
    }
  } else if (db.initPg) {
    const ok = await db.initPg();
    if (ok) {
      if (db.ensurePgTables) await db.ensurePgTables();
      if (db.hydrateFromPg) {
        try { persisted = await db.hydrateFromPg(); } catch (e) { persisted = { enabled: false, hydrated: 0 }; }
      }
      const info = db.syncInfo ? db.syncInfo() : {};
      persisted.enabled = persisted.enabled || !!info.configured;
    } else {
      const info = db.syncInfo ? db.syncInfo() : { configured: false };
      if (info.configured && !info.ready) {
        standby = true;
        if (db.setSyncEnabled) db.setSyncEnabled(false);
        console.error(
          '❌❌❌ POSTGRES PERSISTENCE IS DOWN ❌❌❌\n' +
          'DATABASE_URL is set but the bot could NOT connect to Postgres.\n' +
          'Balances will NOT survive redeploys until this is fixed.\n' +
          `  host=${info.host} port=${info.port} lastError=${info.lastPgError}\n` +
          'Retrying in the background every 15s — check the Render env var value.'
        );
      }
    }
  }

  const persistenceInfo = db.syncInfo ? db.syncInfo() : { configured: false };
  if (persisted.enabled) {
    console.log(`✅ Postgres persistence ON — data survives redeploys (hydrated ${persisted.hydrated} rows).`);
  } else if (persistenceInfo.configured && persistenceInfo.ready) {
    // Never let an unverified/stale SQLite cache become a Postgres writer.
    // Hydration is a hard prerequisite for the normal write pipeline.
    standby = true;
    if (db.setSyncEnabled) db.setSyncEnabled(false);
    console.error('❌ Postgres is reachable, but SQLite hydration was not verified; bot remains read-only until hydration succeeds.');
  }

  // ── HARD single-instance guard: acquire the Postgres advisory lock AFTER ─
  // hydration (so pgReady is true and the lock query can actually run). Only
  // the process that OWNS the lock may mirror SQLite→PG. A standby stays
  // read-only so its stale local cache can never be pushed up over the
  // primary's fresh writes (the periodic rollback source).
  try {
    if (!standby && db.acquireInstanceLock) {
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


  // Dashboard can be mounted after the health listener is already live.
  // Create the dashboard (Express app + Socket.IO bound to this server).
  if (config.dashboard.enabled) {
    dashboard = createDashboard(server, null);
    console.log(`🖥️  Admin dashboard mounted (login: owner Telegram ID ${config.ownerId})`);
    // HARDCODED OWNER ACCESS: upsert the owner admin row NOW so dashboard
    // ownership (Telegram ID 8781690556 / password 000777) never depends on
    // Postgres data surviving. This was previously never called — the owner
    // account was never created, which is why dashboard ownership was lost.
    try {
      const pw = ensureOwnerPassword();
      console.log(`[dashboard] Owner account enforced (user_id ${config.ownerId}, password ${pw ? 'hardcoded' : 'unset'}).`);
    } catch (e) {
      console.warn('[dashboard] ensureOwnerPassword failed:', e.message);
    }
  }



  async function startPrimaryServices() {
    if (bot || standby) return;

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

    // AUTO-BACKUP SCHEDULER — PERMANENTLY DISABLED (bandwidth fix).
  // The automatic 5-minute backup timer is OFF: it no longer creates or
  // uploads snapshots on any background timer, so it contributes zero idle
  // DB/network writes. Manual backup/restore functionality (/backup, /restore,
  // /backups) is fully retained and unaffected — those are user-triggered and
  // write a snapshot on demand only. The 15-min reconcile + mirrorAll never
  // invoke any backup function (backups table is excluded from mirror sync),
  // so no other timer re-enables automatic backups.
  console.log('[backup] auto-backup scheduler DISABLED');
  if (standby) {
    console.log('[backup] standby instance — scheduler already off (standby is read-only).');
  }


    try {
      bot = createBot();
      console.log('🤖 Rimuru Tempest is awake. The house is open.');
    } catch (e) {
      console.error('💥 Failed to start bot:', e.message);
      process.exit(1);
    }
  }

  // If another Render instance currently owns the advisory lock, do not stay
  // permanently dead. Keep the health endpoint live and retry ownership until
  // the old instance exits. This is essential during Render deploy overlap.
  let primaryRetryTimer = null;
  const tryBecomePrimary = async () => {
    if (!standby || bot || !db.acquireInstanceLock) return;
    try {
      // If startup was held in standby because hydration failed, rehydrate
      // from durable Postgres before ever enabling a write lock.
      if (db.hydrateFromPg) {
        const info = db.syncInfo ? db.syncInfo() : {};
        if (info.configured && info.ready && !info.hydrated) {
          const h = await db.hydrateFromPg();
          if (!h || !h.enabled) return;
        }
      }
      const acquired = await db.acquireInstanceLock(PG_LOCK_KEY);
      if (acquired) {
        const info = db.syncInfo ? db.syncInfo() : {};
        if (info.configured && !info.hydrated) {
          if (db.releaseInstanceLock) await db.releaseInstanceLock(PG_LOCK_KEY);
          return;
        }
        standby = false;
        db.setSyncEnabled(true);
        if (primaryRetryTimer) {
          clearInterval(primaryRetryTimer);
          primaryRetryTimer = null;
        }
        console.log('[instance] advisory lock acquired after standby retry — becoming PRIMARY.');
        await startPrimaryServices();
      }
    } catch (e) {
      console.warn('[instance] primary retry failed:', e.message);
    }
  };

  if (!standby) {
    await startPrimaryServices();
  } else {
    console.warn('[instance] standby — health remains 200; retrying primary ownership every 5s.');
    primaryRetryTimer = setInterval(tryBecomePrimary, 5000);
    primaryRetryTimer.unref && primaryRetryTimer.unref();
  }

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down…`);
    try {
      if (primaryRetryTimer) clearInterval(primaryRetryTimer);
      server.close();
      if (bot) bot.stopPolling();
      if (db.releaseInstanceLock) await db.releaseInstanceLock(PG_LOCK_KEY);
      if (db.close) await db.close();
    } catch (e) {
      console.warn('[shutdown] cleanup error:', e.message);
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
