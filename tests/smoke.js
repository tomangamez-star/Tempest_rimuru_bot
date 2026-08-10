'use strict';
/**
 * Rimuru Tempest Casino — smoke tests.
 * Tests pure logic + DB layer without touching Telegram.
 * Run: npm test  (or: node tests/smoke.js)
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

// Use a temp DB so we never touch the real one
process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const db = require('../src/db');
const eco = require('../src/economy');
const admin = require('../src/admin');
const cd = require('../src/cooldowns');
const utils = require('../src/utils');
const slots = require('../src/games/slots');
const dice = require('../src/games/dice');
const coinflip = require('../src/games/coinflip');
const roulette = require('../src/games/roulette');
const mines = require('../src/games/mines');
const blackjack = require('../src/games/blackjack');
const higherlower = require('../src/games/higherlower');
const lottery = require('../src/games/lottery');
const robbery = require('../src/crimes/robbery');
const heist = require('../src/crimes/heist');
const income = require('../src/income');
const leaderboard = require('../src/leaderboard');
const rimuru = require('../src/rimuru');

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

console.log('🧪 Rimuru Casino smoke tests\n');

/* ---------- utils ---------- */
test('utils: fmt formats thousands', () => {
  assert.strictEqual(utils.fmt(500000), '500,000');
});
test('utils: parseAmount all/half/empty', () => {
  assert.strictEqual(utils.parseAmount('all', 1000), 1000);
  assert.strictEqual(utils.parseAmount('half', 1000), 500);
  assert.strictEqual(utils.parseAmount('', 1000), 1000);
  assert.strictEqual(utils.parseAmount('abc', 1000), null);
  assert.strictEqual(utils.parseAmount('500', 1000), 500);
  assert.strictEqual(utils.parseAmount('5,000', 10000), 5000);
});
test('utils: humanDuration', () => {
  assert.ok(utils.humanDuration(120000).includes('2m'));
  assert.ok(utils.humanDuration(3600000).includes('1h'));
});
test('utils: chance bounds', () => {
  for (let i = 0; i < 100; i++) {
    const c = utils.chance(0.5);
    assert.ok(typeof c === 'boolean');
  }
});

/* ---------- economy ---------- */
test('economy: new user starts with 500k', () => {
  const u = eco.ensure(1001, { first_name: 'Tester' });
  assert.strictEqual(u.wallet, config.startBalance);
  assert.strictEqual(u.bank, 0);
});
test('economy: deposit & withdraw', () => {
  const d = eco.deposit(1001, '100000');
  assert.ok(d.ok);
  const u1 = db.getUser(1001);
  assert.strictEqual(u1.wallet, 400000);
  assert.strictEqual(u1.bank, 100000);
  const w = eco.withdraw(1001, 'all');
  assert.ok(w.ok);
  const u2 = db.getUser(1001);
  assert.strictEqual(u2.wallet, 500000);
  assert.strictEqual(u2.bank, 0);
});
test('economy: deposit more than wallet fails', () => {
  const r = eco.deposit(1001, '999999999');
  assert.ok(!r.ok);
});
test('economy: donate from wallet (reply flow)', () => {
  eco.ensure(1002, { first_name: 'Broke' });
  const r = eco.donate(1001, 1002, '5000');
  assert.ok(r.ok);
  assert.strictEqual(db.getUser(1002).wallet, config.startBalance + 5000);
});
test('economy: transfer from bank (reply flow)', () => {
  eco.deposit(1001, '50000');
  const r = eco.transfer(1001, 1002, '20000');
  assert.ok(r.ok);
  const u1 = db.getUser(1001);
  const u2 = db.getUser(1002);
  assert.strictEqual(u1.bank, 30000);
  assert.strictEqual(u2.bank, 20000);
});

/* ---------- admin ---------- */
test('admin: ban/sus/mute + lift', () => {
  const r1 = admin.applyPenalty(1002, admin.STATUS.BANNED, 'spam');
  assert.ok(r1.ok);
  assert.ok(!admin.checkInteract(1002).allowed);
  admin.liftPenalty(1002);
  assert.ok(admin.checkInteract(1002).allowed);
  admin.applyPenalty(1002, admin.STATUS.SUSPECTED, 'suspicious', '2h');
  const check = admin.checkInteract(1002, { gambling: true });
  assert.ok(!check.allowed); // can't gamble
  assert.ok(admin.checkInteract(1002, { gambling: false }).allowed); // can chat
});
test('admin: parseDuration', () => {
  assert.strictEqual(admin.parseDuration('30m'), 30 * 60000);
  assert.strictEqual(admin.parseDuration('2h'), 2 * 3600000);
  assert.strictEqual(admin.parseDuration('1d'), 86400000);
  assert.strictEqual(admin.parseDuration('bogus'), 0);
});

/* ---------- games ---------- */
test('slots: payout math (2x / 4x / 0)', () => {
  const bet = 1000;
  const r2 = slots.spin(bet);
  // deterministic checks via monkeypatch-free logic: just verify shape
  assert.ok(typeof r2.win === 'boolean');
  assert.strictEqual(r2.reels.length, 3);
  if (r2.win) assert.ok(r2.payout === bet * 2 || r2.payout === bet * 4);
  else assert.strictEqual(r2.payout, 0);
});
test('dice: roll math', () => {
  const r = dice.roll(1000, 3);
  assert.ok(r.rolled >= 1 && r.rolled <= 6);
  if (r.win) assert.strictEqual(r.payout, 6000);
});
test('coinflip: payout math', () => {
  const r = coinflip.flipCoin(5000, 'tails');
  assert.ok(['heads', 'tails'].includes(r.flip));
  if (r.win) assert.strictEqual(r.payout, 10000);
});
test('roulette: color spin (red win gives 2x)', () => {
  // force a red win: spin with seeded check is random, verify structure instead
  const r = roulette.spin(1000, 'color', 'red');
  assert.ok(r.number >= 0 && r.number <= 36);
  if (r.win) assert.strictEqual(r.payout, 2000);
});
test('roulette: straight payout 36x', () => {
  const r = roulette.spin(1000, 'straight', '7');
  if (r.win) assert.strictEqual(r.payout, 36000);
});
test('mines: multipliers climb', () => {
  const s = mines.createSession(2001, 1000);
  assert.strictEqual(mines.nextMult(s), 1.25);
  s.revealed.add(0);
  assert.strictEqual(mines.nextMult(s), 1.5);
  s.revealed.add(1);
  assert.ok(mines.currentWorth(s) > 1000 * 1.5);
  // 3 mines, 22 safe cells max
  assert.strictEqual(s.mines.size, 3);
});
test('blackjack: hand values & blackjack', () => {
  assert.strictEqual(blackjack.handValue(['A♠', 'K♠']), 21);
  assert.strictEqual(blackjack.handValue(['A♠', 'A♦', '9♣']), 21);
  assert.strictEqual(blackjack.handValue(['10♠', 'K♠']), 20);
  assert.ok(blackjack.isBlackjack(['A♠', 'K♠']));
});
test('higherlower: rank values', () => {
  assert.strictEqual(higherlower.rankValue({ rank: 'A', suit: '♠' }), 14);
  assert.strictEqual(higherlower.rankValue({ rank: 'K', suit: '♠' }), 13);
  assert.strictEqual(higherlower.rankValue({ rank: '7', suit: '♠' }), 7);
});

/* ---------- lottery ---------- */
test('lottery: buy tickets, pot grows, draw needs 5 buyers', () => {
  const l1 = lottery.status();
  assert.ok(l1.includes(config.lottery.baseJackpot.toLocaleString()));
  const b = lottery.buy(1001, 2, { first_name: 'A' });
  assert.ok(b.ok);
  lottery.buy(1002, 1, { first_name: 'B' });
  lottery.buy(1003, 1, { first_name: 'C' });
  lottery.buy(1004, 1, { first_name: 'D' });
  const early = lottery.draw();
  assert.ok(!early.ok); // only 4 buyers
  lottery.buy(1005, 1, { first_name: 'E' });
  const d = lottery.draw();
  assert.ok(d.ok);
  assert.ok(d.pot >= config.lottery.baseJackpot);
  // Winner got the pot
  const winner = db.getUser(d.winner.user_id);
  assert.ok(winner.wallet > config.startBalance);
});

/* ---------- crimes ---------- */
test('robbery: cannot rob owner', () => {
  const r = robbery.attempt(1001, Number(config.ownerId), { first_name: 'X' });
  assert.ok(!r.ok);
});
test('robbery: cannot rob broke user', () => {
  // 1003 has startBalance, so drain it first
  const target = 1003;
  db.setWallet(target, 0);
  const r = robbery.attempt(1001, target, { first_name: 'Y' });
  assert.ok(!r.ok);
});
test('robbery: success/fail shapes', () => {
  db.setWallet(1001, 100000);
  db.setWallet(1004, 50000);
  const r = robbery.attempt(1001, 1004, { first_name: 'Robber' });
  assert.ok(r.ok);
  if (r.success) {
    assert.ok(r.take > 0);
  } else {
    assert.ok(r.fine > 0);
  }
});
test('heist: cannot heist owner', () => {
  const r = heist.start(1001, Number(config.ownerId), { first_name: 'X' });
  assert.ok(!r.ok);
});
test('heist: risk scales down with members', () => {
  assert.ok(heist.riskFor(1) > heist.riskFor(3));
  assert.ok(heist.victoryChance(3) > heist.victoryChance(1));
  assert.ok(heist.riskFor(5) <= 0.4);
});
test('heist: needs 30% networth of target', () => {
  // Target 1005 has huge balance
  db.setWallet(1005, 5000000);
  const r = heist.start(1001, 1005, { first_name: 'X' });
  assert.ok(!r.ok); // 1001 too small
});
test('heist: full flow start → join → execute', () => {
  // Ensure users exist first (real flow: users are created on first interaction)
  eco.ensure(2002, { first_name: 'RichTarget' });
  eco.ensure(2003, { first_name: 'Leader' });
  eco.ensure(2004, { first_name: 'Joiner' });
  // Rich target
  db.setWallet(2002, 100000);
  db.setBank(2002, 2000000); // bank 2M
  // Rich leader
  db.setWallet(2003, 1000000);
  db.setBank(2003, 1000000);
  const s = heist.start(2003, 2002, { first_name: 'Leader' });
  assert.ok(s.ok);
  const j = heist.join(2004, { first_name: 'Joiner' });
  assert.ok(j.ok);
  const e = heist.execute(2003);
  assert.ok(e.ok);
  assert.ok(e.success === true || e.success === false);
});

/* ---------- income ---------- */
test('income: daily/bonus cooldowns', () => {
  const d1 = income.daily(1001, { first_name: 'Tester' });
  assert.ok(d1.ok);
  const d2 = income.daily(1001, { first_name: 'Tester' });
  assert.ok(!d2.ok); // blocked by 24h cooldown
});
test('income: work/beg earn', () => {
  const w = income.earn(1001, 'work', { first_name: 'Tester' });
  assert.ok(w.ok && w.amount > 0);
});

/* ---------- cooldowns ---------- */
test('cooldowns: guard blocks within window', () => {
  cd.start(1001, 'rob', 60000);
  const g = cd.guard(1001, 'rob');
  assert.ok(g.blocked);
  db.clearCooldown(1001, 'rob');
  assert.ok(!cd.guard(1001, 'rob').blocked);
});

/* ---------- leaderboard ---------- */
test('leaderboard: renders top 10 in the reference style', () => {
  const lb = leaderboard.render();
  assert.ok(lb.includes(leaderboard.HEADER), 'header box present');
  assert.ok(lb.includes(leaderboard.TAGLINE), 'decorative tagline present');
  assert.ok(lb.includes('🥇'), 'rank 1 medal present');
  assert.ok(lb.includes('🥈'), 'rank 2 medal present');
  assert.ok(lb.includes('🥉'), 'rank 3 medal present');
  assert.ok(lb.includes('4\ufe0f\u20e3'), 'rank 4 keycap present');
  assert.ok(!lb.includes('1\ufe0f\u20e3') || lb.includes('1\ufe0f\u20e3 0\ufe0f\u20e3'), 'no bare rank-1 keycap (medal instead)');
  assert.ok(lb.includes('\u2517\u2501\u2501 Net Worth:'), 'net worth line present');
  assert.ok(lb.includes(leaderboard.FOOTER), 'footer present');
  assert.ok(lb.includes('\n\n'), 'blank gap between entries');
  assert.ok(lb.length > 20);
});

/* ---------- rimuru ---------- */
test('rimuru: trigger detection', () => {
  assert.ok(rimuru.shouldTrigger('hey Rimuru what games do you have'));
  assert.ok(rimuru.shouldTrigger('RIMURU!'));
  assert.ok(!rimuru.shouldTrigger('hello there'));
});
test('rimuru: canned fallback works without API key', () => {
  // Simulate no-client path by testing the exported fn indirectly:
  // if client is null, reply() returns canned lines
  const ans = rimuru.cannedReply('hello', 'Bob');
  assert.ok(typeof ans === 'string' && ans.length > 0);
});

/* ---------- config ---------- */
test('config: house edge and key numbers', () => {
  assert.strictEqual(config.houseEdge, 0.55);
  assert.strictEqual(config.startBalance, 500000);
  assert.strictEqual(config.lottery.ticketPrice, 10000);
  assert.strictEqual(config.lottery.minBuyers, 5);
  assert.strictEqual(config.mines.mineCount, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL SMOKE TESTS PASSED ✅');