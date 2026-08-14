'use strict';
/**
 * Rimuru Tempest Casino — Attack / Security Event System tests.
 *
 * Pure logic (targeting, attacker scaling, spawn-rate roll, challenge codes,
 * steal amount) + DB-integration (eligibility, full spawn flows) WITHOUT
 * touching Telegram. The Telegram wiring (bot.js) is exercised indirectly via
 * attack.attach() with injected fakes.
 *
 * Run: node tests/attack-test.js
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

// Isolated temp DB (same pattern as the other test suites).
process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-attack-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const db = require('../src/db');
const attack = require('../src/attack');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

/* ---------- pure logic ---------- */

test('attack: min net worth threshold', () => {
  assert.strictEqual(attack.minNetWorth(), 250000000000);
  assert.strictEqual(attack.isEligibleTarget(250000000000), true);
  assert.strictEqual(attack.isEligibleTarget(250000000000 - 1), false);
  assert.strictEqual(attack.isEligibleTarget(1000000000000), true);
});

test('attack: weighted target selection excludes cooldown/repeat ids', () => {
  const eligible = [
    { user_id: 1, networth: 250000000000 },
    { user_id: 2, networth: 500000000000 },
    { user_id: 3, networth: 1000000000000 },
  ];
  const picked = attack.pickTargetWeighted(eligible, null, () => 0);
  assert.ok(picked, 'picks a target');
  const excl = new Set([1, 2, 3]);
  assert.strictEqual(attack.pickTargetWeighted(eligible, excl, () => 0), null, 'all excluded → null');
  const picked3 = attack.pickTargetWeighted(eligible, new Set([1, 2]), () => 0.999999);
  assert.strictEqual(picked3.user_id, 3, 'returns the only non-excluded target');
});

test('attack: attacker count scales with wealth and stays in bounds', () => {
  const lo = config.attack.minAttackers;
  const hi = config.attack.maxAttackers;
  for (const b of [250, 500, 1000, 10000, 100000]) {
    const c = attack.attackerCountFor(b * 1e9, () => 0.5);
    assert.ok(c >= lo && c <= hi, `count ${c} in [${lo},${hi}] for ${b}B`);
  }
  const low = attack.attackerCountFor(1e9, () => 0.5);
  const high = attack.attackerCountFor(1e18, () => 0.5);
  assert.ok(low <= lo + 1, `low end ${low} is at/near min ${lo}`);
  assert.ok(high >= hi - 1, `high end ${high} is at/near max ${hi}`);
});

test('attack: spawn rate roll is 1–3 per hour (and all three occur)', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = attack.rollSpawnsThisHour();
    assert.ok(n >= 1 && n <= 3, `roll ${n} within 1..3`);
    seen.add(n);
  }
  assert.deepStrictEqual([...seen].sort(), [1, 2, 3], 'all of 1, 2, 3 occur');
});

test('attack: challenges get harder per round', () => {
  assert.strictEqual(attack.buildChallenge(1, () => 0), '911');
  const c2 = attack.buildChallenge(2, () => 0);
  const c3 = attack.buildChallenge(3, () => 0);
  const c4 = attack.buildChallenge(4, () => 0);
  assert.ok(c2.startsWith('RIMURU-'), `round 2 is ${c2}`);
  assert.ok(c3.endsWith('-RM'), `round 3 is ${c3}`);
  assert.ok(c4.includes('RIMURU'), `round 4 is ${c4}`);
});

test('attack: steal amount is a clamped percentage, never the whole wallet', () => {
  const w = 1000000000; // 1B
  const stolen = attack.stealAmount(w);
  assert.strictEqual(stolen, Math.floor(w * config.attack.breachPct));
  assert.ok(stolen < w, 'never steals everything');
  assert.strictEqual(attack.stealAmount(0), 0);
  const huge = attack.stealAmount(1e16);
  assert.ok(huge <= config.attack.breachMax, 'respects the ceiling');
});

/* ---------- DB integration ---------- */

/** Retire every currently-eligible user so the next spawn test has exactly
 *  ONE candidate (its own uid). Tests share one SQLite file, so prior tests'
 *  rich users would otherwise win the weighted pick. */
function retireEligible() {
  for (const u of db.getAttackEligibleUsers(attack.minNetWorth())) {
    db.setNetworth(u.user_id, 0);
  }
}

test('attack: getAttackEligibleUsers returns only 250B+', () => {
  db.getOrCreateUser(70001);
  db.getOrCreateUser(70002);
  db.getOrCreateUser(70003);
  db.getOrCreateUser(70004);
  db.setNetworth(70001, 250000000000);   // eligible
  db.setNetworth(70002, 500000000000);   // eligible
  db.setNetworth(70003, 249999999999);   // just below → excluded
  db.setNetworth(70004, 100000);         // way below → excluded
  const rows = db.getAttackEligibleUsers(250000000000);
  const ids = rows.map((r) => r.user_id).sort();
  assert.deepStrictEqual(ids, [70001, 70002], 'only 250B+ returned');
});

test('attack: full spawn repelled by security consumes security', async () => {
  attack._clear();
  retireEligible();
  const uid = 80001;
  db.getOrCreateUser(uid);
  db.setNetworth(uid, 300000000000);
  db.addItem(uid, 'security', 50);
  attack.attach({
    reply: () => Promise.resolve(null),
    announce: () => Promise.resolve(),
  });
  const r = await attack.trigger({ manual: false, force: true });
  assert.ok(r.ok);
  assert.strictEqual(r.targetId, uid, 'the only eligible player is targeted');
  assert.strictEqual(r.outcome, 'repelled');
  assert.ok(r.attackers >= 1);
  assert.ok(db.getItemQty(uid, 'security') < 50, 'security consumed');
  assert.strictEqual(db.getUser(uid).wallet, 300000000000, 'funds protected');
});

test('attack: full spawn offline breach steals a percentage of wallet', async () => {
  attack._clear();
  retireEligible();
  const uid = 80002;
  db.getOrCreateUser(uid);
  db.setNetworth(uid, 400000000000);
  const before = db.getUser(uid).wallet;
  attack.attach({
    reply: () => Promise.resolve(null),
    announce: () => Promise.resolve(),
  });
  // No markSeen → offline → no security → breach + steal.
  const r = await attack.trigger({ manual: false, force: true });
  assert.ok(r.ok);
  assert.strictEqual(r.targetId, uid);
  assert.strictEqual(r.outcome, 'breach-offline');
  const after = db.getUser(uid).wallet;
  assert.ok(after < before, 'wallet reduced');
  assert.ok(after >= before - config.attack.breachMax, 'not over the cap');
});

test('attack: online interactive breach — correct code contains, wrong code breaches', async () => {
  attack._clear();
  retireEligible();
  const origRounds = config.attack.challengeRounds;

  // Correct code (single round) → contained, wallet untouched.
  config.attack.challengeRounds = 1;
  const uid = 80003;
  db.getOrCreateUser(uid);
  db.setNetworth(uid, 500000000000);
  attack.attach({ reply: () => Promise.resolve(null), announce: () => Promise.resolve() });
  attack.markSeen(uid);
  const r = await attack.trigger({ manual: false, force: true });
  assert.strictEqual(r.outcome, 'breach-interactive');
  const beforeWallet = db.getUser(uid).wallet;
  const consumed = await attack.handleInput(uid, uid, '911');
  assert.strictEqual(consumed, true, 'challenge input consumed');
  assert.strictEqual(db.getUser(uid).wallet, beforeWallet, 'funds safe after containment');

  // Wrong code → breach.
  attack._clear();
  retireEligible();
  const uid2 = 80004;
  db.getOrCreateUser(uid2);
  db.setNetworth(uid2, 600000000000);
  attack.markSeen(uid2);
  const r2 = await attack.trigger({ manual: false, force: true });
  assert.strictEqual(r2.outcome, 'breach-interactive');
  const before2 = db.getUser(uid2).wallet;
  const consumed2 = await attack.handleInput(uid2, uid2, 'WRONG');
  assert.strictEqual(consumed2, true);
  assert.ok(db.getUser(uid2).wallet < before2, 'wallet reduced on wrong code');

  config.attack.challengeRounds = origRounds;
});

test('attack: no repeat target within the same hour', async () => {
  attack._clear();
  retireEligible();
  const uid = 80005;
  db.getOrCreateUser(uid);
  db.setNetworth(uid, 700000000000);
  attack.attach({ reply: () => Promise.resolve(null), announce: () => Promise.resolve() });
  const r1 = await attack.trigger({ manual: false, force: true });
  assert.strictEqual(r1.targetId, uid);
  const r2 = await attack.trigger({ manual: false, force: true });
  assert.strictEqual(r2.targetId, null, 'no repeat target — attackers leave');
  assert.ok(r2.message.includes('No eligible target'), 'says no eligible target');
});

/* ---------- run ---------- */

(async () => {
  console.log('🐉 Rimuru Attack/Security System tests\n');
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${name} — ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
