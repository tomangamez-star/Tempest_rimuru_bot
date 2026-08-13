'use strict';
/**
 * Boot-cycle regression test — the periodic-rollback permanent fix.
 *
 * Proves that NO stale state can overwrite newer state across repeated
 * restart-style boot cycles, in BOTH directions:
 *
 *   (A) PG -> SQLite direction (boot hydration): the SQLite file survives a
 *       restart (disk-mounted / mid-hydration race). A newer local row must
 *       NOT be clobbered by an older PG snapshot. We pre-seed the "surviving"
 *       local cache with a NEWER updated_at, then boot (hydrateFromPg) from
 *       an OLDER PG snapshot — the local value must survive (no revert).
 *
 *   (B) SQLite -> PG direction (periodic mirror): a stale local snapshot must
 *       never clobber a newer PG value. We write a NEWER value to PG with a
 *       LATER updated_at, then mirrorTable('users') from an OLDER local
 *       cache — the PG value must survive (no revert).
 *
 * Only updated_at ordering decides the winner — values go UP and DOWN across
 * cycles (a lower balance is never treated as stale).
 *
 * Run: node tests/boot-cycle-test.js   (needs TEST_DATABASE_URL / local PG)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { Client } = require('pg'); // direct PG access for the "other writer" role

const PG_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const CYCLES = 20;
const USER = 424242;

/** Direct PG client — simulates a concurrent writer / other instance. */
async function pgClient() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}

function freshDb(dbPath) {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/config')];
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = os.tmpdir();
  process.env.DATABASE_URL = PG_URL;
  process.env.NODE_ENV = 'test';
  return require('../src/db');
}

/** Direct low-level SQLite write (bypasses the stamping helpers) — simulates a
 *  snapshot that a race would otherwise let overwrite newer data. */
function sqliteRaw(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

async function pgRow(pool, userId) {
  const { rows } = await pool.query('SELECT wallet, bank, updated_at FROM users WHERE user_id = $1', [userId]);
  return rows[0];
}

async function main() {
  console.log(`🔄 Boot-cycle regression test (${CYCLES} cycles — newest updated_at must always win, both directions)\n`);
  const db1 = freshDb(path.join(os.tmpdir(), `rimuru-boot-${Date.now()}-1.db`));
  await db1.initPersistence();
  await db1.acquireInstanceLock(0x52494d55);
  db1.setSyncEnabled(true);
  db1.getOrCreateUser(USER, { first_name: 'Boot', username: 'bootcycle' });
  db1.setWallet(USER, 100000);
  db1.setBank(USER, 50000);
  await new Promise((r) => setTimeout(r, 800)); // let the mirror + verification land

  const pool = await pgClient();
  // Deterministic baseline: the PG row must exist with a KNOWN OLD stamp
  // before the first cycle (the DB may contain leftovers from a previous run).
  await pool.query(
    'INSERT INTO users (user_id, username, first_name, wallet, bank, status, status_reason, status_until, hidden_until, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id) DO UPDATE SET wallet = EXCLUDED.wallet, bank = EXCLUDED.bank, updated_at = EXCLUDED.updated_at',
    [USER, 'bootcycle', 'Boot', 100000, 50000, 'active', '', 0, 0, Date.now(), Date.now() - 600000]
  );
  sqliteRaw(db1.db, 'UPDATE users SET wallet = 100000, bank = 50000, updated_at = ? WHERE user_id = ?', Date.now() - 600000, USER);
  let passA = 0;
  let passB = 0;

  for (let i = 1; i <= CYCLES; i++) {
    const t = Date.now() + i * 1000; // strictly increasing stamps

    // ---- Direction A: PG -> SQLite (boot hydration must not revert) ----
    // 1) A NEWER local write lands (balance goes UP and DOWN across cycles).
    const localVal = i % 2 === 0 ? 100000 + i * 1111 : 90000 - i * 333;
    const localBank = i % 2 === 0 ? 50000 + i * 77 : 40000 - i * 13;
    sqliteRaw(db1.db, 'UPDATE users SET wallet = ?, bank = ?, updated_at = ? WHERE user_id = ?', localVal, localBank, t, USER);

    // 2) PG must still hold the OLD value with an OLDER updated_at (stale snapshot).
    const pgOld = await pgRow(pool, USER);
    assert.ok(Number(pgOld.updated_at) < t, `PG snapshot (${pgOld.updated_at}) must be older than the local write (${t})`);

    // 3) Boot with a SURVIVING local cache: pre-seed db2's SQLite with the
    //    newer local row, then hydrate from PG (older snapshot).
    //    NOTE: db2's users table must exist BEFORE the row is seeded — the
    //    table is created on require(); initPersistence() then runs migrations
    //    which are no-ops on a fresh DB.
    const db2Path = path.join(os.tmpdir(), `rimuru-boot-${Date.now()}-2.db`);
    const db2 = freshDb(db2Path);
    sqliteRaw(db2.db, 'INSERT OR REPLACE INTO users (user_id, username, first_name, wallet, bank, status, status_reason, status_until, hidden_until, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      USER, 'bootcycle', 'Boot', localVal, localBank, 'active', '', 0, 0, Date.now(), t);
    await db2.initPersistence(); // hydrates from PG (OLDER) — must NOT revert the local row
    const after = db2.getUser(USER);
    if (after.wallet === localVal && after.bank === localBank) {
      passA++;
    } else {
      console.error(`  cycle ${i} A FAILED: expected local ${localVal}/${localBank}, got ${after.wallet}/${after.bank}`);
    }
    db2.close();

    // ---- Direction B: SQLite -> PG (periodic mirror must not revert) ----
    // 1) A newer PG write lands directly (another writer / newer op).
    const pgVal = i % 2 === 0 ? 300000 + i * 2222 : 250000 - i * 555;
    await pool.query('UPDATE users SET wallet = $1, updated_at = $2 WHERE user_id = $3', [pgVal, t + 500, USER]);
    // 2) The local cache still holds an OLDER value (stale snapshot).
    // 3) Mirror SQLite -> PG — the newer PG value must survive.
    db1.mirrorTable('users');
    await new Promise((r) => setTimeout(r, 400));
    const pgAfter = await pgRow(pool, USER);
    if (Number(pgAfter.wallet) === pgVal && Number(pgAfter.updated_at) === t + 500) {
      passB++;
    } else {
      console.error(`  cycle ${i} B FAILED: expected pg ${pgVal} (stamp ${t + 500}), got ${pgAfter.wallet} (stamp ${pgAfter.updated_at})`);
    }

    // Reset the local row to match PG (keep the next cycle clean).
    sqliteRaw(db1.db, 'UPDATE users SET wallet = ?, bank = ?, updated_at = ? WHERE user_id = ?', pgVal, 0, t + 500, USER);
  }

  db1.close();
  await pool.end();

  console.log(`\n  Direction A (PG->SQLite hydration, no stale revert): ${passA}/${CYCLES}`);
  console.log(`  Direction B (SQLite->PG mirror,     no stale revert): ${passB}/${CYCLES}`);
  assert.strictEqual(passA, CYCLES, 'A: stale PG snapshot must never revert a newer local balance');
  assert.strictEqual(passB, CYCLES, 'B: stale local snapshot must never revert a newer PG balance');
  console.log('\n✅ BOOT-CYCLE TEST PASSED — no stale state can overwrite newer state in either direction.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ BOOT-CYCLE TEST FAILED:', e.message);
  process.exit(1);
});
