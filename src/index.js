'use strict';
/**
 * Rimuru Tempest Casino — entrypoint.
 * Boots the HTTP health server (for Render) + the Telegram bot.
 */
const http = require('http');
const config = require('./config');
const { createBot } = require('./bot');

console.log(`🐉 Rimuru Tempest Casino — starting (env=${config.env})`);

// Health server for Render (keeps the service "live" and checkable)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'rimuru-casino', time: Date.now() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🩺 Health server listening on :${config.port} (GET /health)`);
});

// Start the bot
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
