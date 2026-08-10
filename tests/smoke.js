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
const guess = require('../src/games/guess');
const shop = require('../src/shop');
const crime = require('../src/crimes/crime');
const fishing = require('../src/fish');
const robbery = require('../src/crimes/robbery');
const heist = require('../src/crimes/heist');
const income = require('../src/income');
const leaderboard = require('../src/leaderboard');
const rimuru = require('../src/rimuru');
const backup = require('../src/backup');

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
test('mines: reward = wager + wager*0.25 per safe pick (none before 1st move)', () => {
  const s = mines.createSession(2001, 1000);
  // 4 mines: 3 visible + 1 hidden
  assert.strictEqual(s.mines.size, 4);
  assert.strictEqual(mines.VISIBLE_MINES, 3);
  assert.strictEqual(mines.MAX_PICKS, 22);
  // NO reward before the 1st move: cash-out is exactly the wager, mult 1.00x
  assert.strictEqual(mines.nextMult(s), 1.0);
  assert.strictEqual(mines.currentWorth(s), 1000);
  // 1st safe pick -> +25% of the wager (1000 -> 1250, mult 1.25x)
  s.picks += 1;
  assert.strictEqual(mines.nextMult(s), 1.25);
  assert.strictEqual(mines.currentWorth(s), 1250);
  // 2nd safe pick -> +250 more (total 1500, mult 1.50x)
  s.picks += 1;
  assert.strictEqual(mines.nextMult(s), 1.5);
  assert.strictEqual(mines.currentWorth(s), 1500);
});
test('mines: reshuffle never lands on revealed cells', () => {
  const s = mines.createSession(2002, 5000);
  s.revealed.add(0);
  s.revealed.add(1);
  for (let i = 0; i < 100; i++) {
    mines.reshuffleMines(s);
    assert.strictEqual(s.mines.size, 4);
    for (const idx of s.revealed) {
      assert.ok(!s.mines.has(idx), `mine landed on revealed cell ${idx}`);
    }
  }
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
test('guess: multipliers by chance (1st=5x, 2nd=3x, 3rd=2x)', () => {
  const s = guess.createSession(2101, 1000);
  s.answer = 7;
  assert.strictEqual(guess.multFor(s), 5);
  s.chancesLeft = 2;
  assert.strictEqual(guess.multFor(s), 3);
  s.chancesLeft = 1;
  assert.strictEqual(guess.multFor(s), 2);
  assert.strictEqual(guess.MAX_CHANCES, 3);
});
test('guess: answer always in 1..10', () => {
  for (let i = 0; i < 50; i++) {
    const s = guess.createSession(2101 + i, 500);
    assert.ok(s.answer >= 1 && s.answer <= 10);
  }
});

/* ---------- shop / inventory / crime / fishing ---------- */
test('shop: catalog has required items', () => {
  const ids = shop.ITEMS.map((i) => i.id);
  for (const need of ['crowbar', 'gun', 'mask', 'hook', 'security', 'cyber']) {
    assert.ok(ids.includes(need), `missing item: ${need}`);
  }
});
test('shop: buy adds inventory and deducts wallet', () => {
  eco.ensure(2201, { first_name: 'Shopper' });
  db.setWallet(2201, 200000);
  const r = shop.buyItem(2201, 'hook', 2, { first_name: 'Shopper' });
  assert.ok(r.ok);
  assert.strictEqual(r.qty, 2);
  assert.strictEqual(db.getItemQty(2201, 'hook'), 2);
  assert.strictEqual(db.getUser(2201).wallet, 200000 - 15000 * 2);
});
test('shop: cannot afford buy fails', () => {
  db.setWallet(2201, 100);
  const r = shop.buyItem(2201, 'gun', 1, { first_name: 'Shopper' });
  assert.ok(!r.ok);
});
test('shop: inventory list renders', () => {
  const t = shop.inventoryText(2201);
  assert.ok(t.includes('HOOK') || t.includes('hook') || t.includes('Fishing'));
});
test('crime: requires bet, higher bet payout scales', () => {
  eco.ensure(2202, { first_name: 'Criminal' });
  db.setWallet(2202, 1000000);
  const noBet = crime.commit(2202, '', { first_name: 'Criminal' });
  assert.ok(!noBet.ok);
  const r = crime.commit(2202, '50000', { first_name: 'Criminal' });
  assert.ok(r.ok);
  if (r.success) assert.ok(r.payout >= 50000 * 2);
});
test('crime: items unlock better crimes + bonus odds', () => {
  // Armed robbery needs crowbar + gun + mask
  db.addItem(2202, 'crowbar', 1);
  db.addItem(2202, 'gun', 1);
  db.addItem(2202, 'mask', 1);
  const best = crime.bestCrime(2202);
  assert.ok(best && ['armed', 'vault'].includes(best.id));
  const bonus = crime.itemBonus(2202);
  assert.ok(bonus >= 0.10);
});
test('crime: security escape / cyber defense bonuses', () => {
  db.addItem(2202, 'security', 1);
  assert.ok(crime.escapeBonus(2202) >= 0.10);
  db.addItem(2202, 'cyber', 1);
  assert.ok(crime.defenseBonus(2202) >= 0.15);
});
test('fishing: requires hook', () => {
  const r = fishing.fish(2203, { first_name: 'Angler' });
  assert.ok(!r.ok); // no hook yet
  assert.ok(r.message.includes('Hook'));
});
test('fishing: works with hook', () => {
  db.addItem(2203, 'hook', 1);
  const r = fishing.fish(2203, { first_name: 'Angler' });
  assert.ok(r.ok);
  assert.ok(typeof r.caught === 'boolean');
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
  assert.strictEqual(config.mines.mineCount, 4);
  assert.strictEqual(config.mines.visibleMines, 3);
  assert.strictEqual(config.mines.multPerPick, 0.25);
});

/* ---------- hide ---------- */
test('hide: setHidden/isHidden lifecycle', () => {
  const uid = 8801;
  db.getOrCreateUser(uid, { first_name: 'Shady', username: 'shady' });
  db.setHidden(uid, Date.now() + 60000);
  assert.ok(db.isHidden(uid), 'hidden while active');
  db.setHidden(uid, Date.now() - 1000);
  assert.ok(!db.isHidden(uid), 'not hidden after expiry');
  db.setHidden(uid, 0);
  assert.ok(!db.isHidden(uid), 'not hidden when cleared');
});

test('hide: robbery and heist refuse hidden targets', () => {
  const victim = 8802;
  const robber = 8803;
  db.getOrCreateUser(victim, { first_name: 'Victim', username: 'victim' });
  db.getOrCreateUser(robber, { first_name: 'Robber', username: 'robber' });
  db.setWallet(victim, 1000000);
  db.setBank(victim, 1000000);
  db.setHidden(victim, Date.now() + 60000);
  const r = robbery.attempt(robber, victim, { first_name: 'Robber' });
  assert.ok(!r.ok && /hidden/.test(r.message), 'rob blocked on hidden target');
  const h = heist.start(robber, victim, { first_name: 'Robber' });
  assert.ok(!h.ok && /hidden/.test(h.message), 'heist blocked on hidden target');
  db.setHidden(victim, 0);
});

/* ---------- health ---------- */
test('config: hide price + duration present', () => {
  assert.strictEqual(config.hide.price, 50000000);
  assert.strictEqual(config.hide.durationMs, 60000);
  assert.ok(config.cooldowns.hide > 0);
});

/* ---------- backup / restore ---------- */
test('backup: dumps users + inventory, restore round-trips', () => {
  const uid = 8804;
  db.getOrCreateUser(uid, { first_name: 'Backup', username: 'backup' });
  db.setWallet(uid, 1234567);
  db.setBank(uid, 7654321);
  db.addItem(uid, 'hook', 2);
  const b = backup.backup();
  assert.ok(b.ok, 'backup succeeded');
  assert.ok(b.file && /backup-\d+\.json$/.test(b.file), 'backup file named backup-<ts>.json');
  const fs = require('fs');
  assert.ok(fs.existsSync(b.file), 'backup file exists on disk');
  const data = JSON.parse(fs.readFileSync(b.file, 'utf8'));
  assert.ok(Array.isArray(data.users), 'backup has users array');
  assert.ok(data.users.some((u) => u.user_id === uid && u.wallet === 1234567 && u.bank === 7654321), 'backup contains balances');
  const r = backup.restore();
  assert.ok(r.ok, 'restore succeeded');
  const u = db.getUser(uid);
  assert.strictEqual(u.wallet, 1234567, 'wallet restored');
  assert.strictEqual(u.bank, 7654321, 'bank restored');
  assert.ok(db.getItemQty(uid, 'hook') >= 2, 'inventory restored');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL SMOKE TESTS PASSED ✅');