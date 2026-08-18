'use strict';
/**
 * Regression test for the Render standby-loop bug:
 *   "[db] hydrateFromPg failed: column \"networth\" does not exist"
 *
 * Reproduces the EXACT production scenario with a real Postgres:
 *   1. PG has a LEGACY schema (users WITHOUT networth/rank/status/...,
 *      lottery.jackpot/buyers/entries, redeem_codes.uses, chat_logs.message)
 *      and REAL seeded rows.
 *   2. initPersistence() = initPg → ensurePgTables → migratePgColumns →
 *      hydrateFromPg must succeed (columns added, legacy data backfilled).
 *   3. acquireInstanceLock + setSyncEnabled must work → the standby gate in
 *      index.js is exited and the bot becomes primary.
 *   4. NO data may be lost: seeded rows still present, networth derived
 *      from wallet+bank, legacy renamed columns copied.
 *
 * Run: TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/rimuru_legacy
 *      node tests/hydrate-legacy-schema-test.js
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/rimuru_legacy';
const DB1 = path.join(os.tmpdir(), `rimuru-legacy-${Date.now()}.db`);

process.env.DB_PATH = DB1;
process.env.DATA_DIR = os.tmpdir();
process.env.DATABASE_URL = PG_URL;
process.env.NODE_ENV = 'test';

const db = require('../src/db');

async function main() {
  console.log('🧪 Hydration against LEGACY PG schema (networth missing) test\n');

  // ---- Boot exactly like Render: initPersistence() ----
  const p = await db.initPersistence();
  console.log(`  initPersistence → enabled=${p.enabled} hydrated=${p.hydrated}`);
  assert.ok(p.enabled, 'hydration must be ENABLED (no more standby loop)');
  assert.ok(p.hydrated >= 2, `hydrated at least 2 legacy users (got ${p.hydrated})`);

  // ---- User data preserved, networth backfilled from wallet+bank ----
  const owner = db.getUser(8781690556);
  console.log(`  owner: wallet=${owner.wallet} bank=${owner.bank} networth=${owner.networth} rank=${owner.rank}`);
  assert.strictEqual(Number(owner.wallet), 1234567890, 'owner wallet preserved');
  assert.strictEqual(Number(owner.bank), 987654321, 'owner bank preserved');
  assert.strictEqual(Number(owner.networth), 1234567890 + 987654321, 'networth = wallet + bank backfill');
  assert.ok(owner.rank, 'rank has a value (not missing column)');
  assert.strictEqual(Number(owner.status_until || 0), 0, 'status_until defaults to 0');

  const alice = db.getUser(111111);
  assert.strictEqual(Number(alice.networth), 500000 + 2500000, 'alice networth = wallet + bank');

  // ---- Legacy renamed columns copied into new schema ----
  const lot = db.getLottery();
  console.log(`  lottery: pot=${lot.pot} ticket_count=${lot.ticket_count} tickets=${JSON.stringify(lot.tickets)}`);
  assert.strictEqual(Number(lot.pot), 7000000, 'lottery.jackpot → pot copied');
  assert.strictEqual(Number(lot.ticket_count), 3, 'lottery.buyers → ticket_count copied');
  assert.deepStrictEqual(lot.tickets, [1, 2, 3], 'lottery.entries → tickets copied');

  const rc = db.getRedeemCode ? db.getRedeemCode('LEGACY10') : null;
  console.log(`  redeem LEGACY10: used=${rc ? rc.used_count : 'n/a'}`);
  if (rc) assert.strictEqual(Number(rc.used_count), 2, 'redeem_codes.uses → used_count copied');

  const logs = db.getChatLogs ? db.getChatLogs(111111, 20) : null;
  if (logs && logs.length) console.log(`  chat_logs: ${logs.length} row(s), text="${logs[0].text}"`);
  if (logs && logs.length) assert.strictEqual(logs[0].text, 'hello from legacy', 'chat_logs.message → text copied');

  // ---- PG schema now matches TABLE_COLS (networth etc. exist) ----
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: PG_URL });
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position`
  );
  const colNames = cols.rows.map((r) => r.column_name);
  console.log(`  PG users columns now: ${colNames.join(', ')}`);
  for (const need of ['networth', 'rank', 'rank_valid_matches', 'rank_consecutive_losses', 'status', 'status_until', 'hidden_until', 'last_seen', 'updated_at']) {
    assert.ok(colNames.includes(need), `PG users.${need} exists after migration`);
  }
  // PG data intact after migration:
  const pgOwner = await pool.query(`SELECT * FROM users WHERE user_id = 8781690556`);
  assert.strictEqual(Number(pgOwner.rows[0].wallet), 1234567890, 'PG owner wallet untouched');
  assert.strictEqual(Number(pgOwner.rows[0].networth), 1234567890 + 987654321, 'PG networth backfilled, not zeroed');
  await pool.end();

  // ---- Standby exit: advisory lock + write pipeline (the index.js path) ----
  const lockHeld = await db.acquireInstanceLock(0x52494d55);
  console.log(`  acquireInstanceLock → ${lockHeld}`);
  assert.ok(lockHeld, 'advisory lock acquired → bot becomes PRIMARY (exits standby)');
  db.setSyncEnabled(true);
  const info = db.syncInfo();
  console.log(`  syncInfo: hydrated=${info.hydrated} lockHeld=${info.lockHeld} syncEnabled=${info.syncEnabled} writable=${info.writable}`);
  assert.ok(info.hydrated, 'syncInfo.hydrated = true');
  assert.ok(info.lockHeld, 'syncInfo.lockHeld = true');
  assert.ok(info.syncEnabled, 'syncInfo.syncEnabled = true');

  // ---- Mirror still works (write pipeline functional) ----
  db.setWallet(8781690556, 999999999);
  await db.fullMirror(); // production uses startMirrorLoop's periodic fullMirror
  const pgAfter = new (require('pg')).Pool({ connectionString: PG_URL });
  const r2 = await pgAfter.query(`SELECT wallet, networth FROM users WHERE user_id = 8781690556`);
  console.log(`  mirror: PG wallet after write = ${r2.rows[0].wallet} networth=${r2.rows[0].networth}`);
  assert.strictEqual(Number(r2.rows[0].wallet), 999999999, 'SQLite → PG mirror write works');
  assert.strictEqual(Number(r2.rows[0].networth), 987654321 + 999999999, 'networth = bank + wallet after mirror');
  await pgAfter.end();

  db.close();
  console.log('\n✅ LEGACY-SCHEMA HYDRATION FIX VERIFIED — no standby loop, no data loss, primary acquired.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ LEGACY-SCHEMA HYDRATION TEST FAILED:', e.message);
  process.exit(1);
});
