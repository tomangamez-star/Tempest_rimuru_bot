'use strict';
/**
 * Rimuru Tempest Casino — Dashboard smoke tests.
 * Tests the dashboard DB layer + missions module WITHOUT Telegram.
 * Run: node tests/dashboard-test.js
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

// Isolated temp DB
process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-dash-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';
process.env.DASHBOARD_PASSWORD = 'testpass123';

const config = require('../src/config');
const db = require('../src/db');
const missions = require('../src/missions');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name} — ${e.message}`);
  }
}

console.log('🧪 Rimuru Casino Dashboard tests\n');

/* ---------- dashboard DB layer ---------- */
test('dashboard: chat log + retrieve', () => {
  db.logChat({ from: { id: 1, username: 'a', first_name: 'A' }, chat: { id: -100, title: 'G' }, text: '/start' });
  const logs = db.getChatLogs(10);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].text, '/start');
  assert.strictEqual(logs[0].is_command, 1);
  const byUser = db.getChatLogs(10, 1);
  assert.strictEqual(byUser.length, 1);
});

test('dashboard: game history + retrieve', () => {
  db.logGameHistory({ user_id: 1, username: 'a', game: 'slots', bet: 100, result: 'win', amount: 200 });
  const g = db.getGameHistory(10);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].game, 'slots');
  assert.strictEqual(g[0].amount, 200);
});

test('dashboard: admin user add/list/remove', () => {
  db.addAdminUser(8781690556, 'thedevilslord', 'owner', 'pw1');
  db.addAdminUser(999, 'mod1', 'mod', 'pw2');
  const mods = db.listAdminUsers();
  assert.strictEqual(mods.length, 2);
  const owner = db.getAdminUser(8781690556);
  assert.strictEqual(owner.role, 'owner');
  db.removeAdminUser(999);
  assert.strictEqual(db.listAdminUsers().length, 1);
});

test('dashboard: events create/update/active', () => {
  const ev = db.createEvent({ title: 'Heist Rimuru', description: 'Survive', type: 'mission', reward: 100000, created_by: 1 });
  assert.ok(ev.id > 0);
  const active = db.activeEvents();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].title, 'Heist Rimuru');
  const upd = db.updateEvent(ev.id, { active: false });
  assert.strictEqual(upd.active, 0);
  assert.strictEqual(db.activeEvents().length, 0);
  db.updateEvent(ev.id, { active: true });
  db.incrementEventCompletions(ev.id);
  assert.strictEqual(db.listEvents()[0].completions, 1);
  db.deleteEvent(ev.id);
  assert.strictEqual(db.listEvents().length, 0);
});

test('dashboard: broadcast + activity + audit', () => {
  const b = db.createBroadcast('hello all', 'all', 1);
  assert.ok(b.id > 0);
  db.updateBroadcastCount(b.id, 3);
  assert.strictEqual(db.listBroadcasts()[0].sent_count, 3);
  db.logActivity('event', 'Rimuru awake', {});
  assert.ok(db.getActivity(10).length >= 1);
  db.logAudit(1, 'owner', 'give', 5, '+1000');
  assert.ok(db.getAuditLog(10).length >= 1);
});

test('dashboard: stats aggregate', () => {
  const s = db.dashboardStats();
  assert.ok(typeof s.totalUsers === 'number');
  assert.ok(typeof s.coinsInCirculation === 'number');
  assert.ok(Array.isArray(s.topUsers));
});

/* ---------- missions module ---------- */
test('missions: list empty when no events', () => {
  const msg = missions.listMissions();
  assert.ok(msg.includes('NO ACTIVE EVENTS'));
});

test('missions: heistRimuru + fightRimuru return messages', () => {
  db.getOrCreateUser(42, { username: 'tester' });
  const h = missions.heistRimuru(42, { username: 'tester' });
  assert.ok(h.message.includes('HEIST'));
  const f = missions.fightRimuru(42, { username: 'tester' });
  assert.ok(f.message.includes('FIGHT'));
});

test('missions: attemptMission with an active event', () => {
  db.createEvent({ title: 'Win big', description: 'Just win', type: 'mission', reward: 50000, created_by: 1 });
  const r = missions.attemptMission(42, { username: 'tester' });
  assert.ok(r.ok === true || r.ok === false);
  assert.ok(r.message.length > 0);
});

/* ---------- config ---------- */
test('config: dashboard block present', () => {
  assert.ok(config.dashboard);
  assert.strictEqual(config.dashboard.password, 'testpass123');
  assert.ok(config.dashboard.enabled === true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
