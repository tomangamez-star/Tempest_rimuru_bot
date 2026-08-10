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
const { createBot } = require('./bot');
const { createDashboard, ensureOwnerPassword } = require('./dashboard/server');

const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || '';
const PRIMARY_ID = process.env.RENDER_PRIMARY_INSTANCE_ID || '';

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
  console.log(`🐉 Rimuru Tempest Casino — starting (env=${config.env})${INSTANCE_ID ? ` instance=${INSTANCE_ID}` : ''}`);

  // ── Durability: hydrate SQLite from Postgres (if DATABASE_URL set), then
  // start the periodic mirror so every write survives redeploys.
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
      res.end(JSON.stringify({ ok: true, service: 'rimuru-casino', persistence: db.syncInfo(), time: Date.now() }));
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

  // ── Bot ───────────────────────────────────────────────────────────────
  let bot;
  try {
    bot = createBot();
    console.log('🤖 Rimuru Tempest is awake. The house is open.');
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
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}