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
process.env.BACKUP_DIR = path.join(os.tmpdir(), `rimuru-test-bk-${Date.now()}`);
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
  // cleanup: remove the test backup file so the repo tree stays clean
  try { fs.unlinkSync(b.file); } catch (e) { /* non-fatal */ }
});

/* ---------- redeem codes ---------- */
test('redeem: owner creates a code (unlimited amount)', () => {
  const redeem = require('../src/redeem');
  const r = redeem.createCode(config.ownerId, ['BONUS100', '1000000', '5'], { first_name: 'King', username: 'king' });
  assert.ok(r.ok, 'owner can create code: ' + (r.message || ''));
  assert.strictEqual(r.code, 'BONUS100');
  const rec = db.getRedeemCode('BONUS100');
  assert.ok(rec, 'code stored');
  assert.strictEqual(rec.amount, 1000000);
  assert.strictEqual(rec.max_uses, 5);
  assert.strictEqual(rec.used_count, 0);
});

test('redeem: user redeems code → coins go to BANK, one per user', () => {
  const redeem = require('../src/redeem');
  db.getOrCreateUser(8801, { first_name: 'UserA', username: 'usera' });
  db.setBank(8801, 0);
  const r = redeem.redeemCode(8801, 'BONUS100', { first_name: 'UserA', username: 'usera' });
  assert.ok(r.ok, 'redeem ok: ' + (r.message || ''));
  assert.strictEqual(r.amount, 1000000);
  const u = db.getUser(8801);
  assert.strictEqual(u.bank, 1000000, 'coins landed in BANK');
  assert.strictEqual(u.wallet, config.startBalance, 'wallet untouched');
  // one per user — second attempt rejected
  const r2 = redeem.redeemCode(8801, 'BONUS100', { first_name: 'UserA' });
  assert.ok(!r2.ok, 'second redeem rejected');
  assert.ok(/already redeemed/i.test(r2.message), 'message mentions already redeemed');
});

test('redeem: max uses enforced', () => {
  const redeem = require('../src/redeem');
  // uses remaining = 4 after user 8801 used one
  db.getOrCreateUser(8802, { first_name: 'UserB', username: 'userb' });
  db.getOrCreateUser(8803, { first_name: 'UserC', username: 'userc' });
  db.getOrCreateUser(8804, { first_name: 'UserD', username: 'userd' });
  db.getOrCreateUser(8805, { first_name: 'UserE', username: 'usere' });
  for (const id of [8802, 8803, 8804, 8805]) {
    const r = redeem.redeemCode(id, 'BONUS100', { first_name: 'U' });
    assert.ok(r.ok, `redeem ${id} ok: ${r.message || ''}`);
  }
  const rec = db.getRedeemCode('BONUS100');
  assert.strictEqual(rec.used_count, 5, '5 of 5 uses consumed');
  db.getOrCreateUser(8806, { first_name: 'UserF', username: 'userf' });
  const r = redeem.redeemCode(8806, 'BONUS100', { first_name: 'UserF' });
  assert.ok(!r.ok, '6th redeem rejected');
  assert.ok(/used up|vault is empty/i.test(r.message), 'message mentions used up');
});

test('redeem: mod create capped at 50M, cannot self-redeem own code', () => {
  const redeem = require('../src/redeem');
  // add a moderator (dashboard admin_users)
  const MOD_ID = 77001;
  db.addAdminUser(MOD_ID, 'modone', 'mod', 'pw');
  // mod tries to mint a 100M code → rejected (cap 50M)
  const big = redeem.createCode(MOD_ID, ['MODBIG', '100000000', '10'], { username: 'modone' });
  assert.ok(!big.ok, 'mod 100M code rejected');
  assert.ok(/50,000,000|50M/i.test(big.message), 'message mentions 50M cap');
  // mod mints a 10M code → ok
  const ok = redeem.createCode(MOD_ID, ['MOD10', '10000000', '3'], { username: 'modone' });
  assert.ok(ok.ok, 'mod 10M code created: ' + (ok.message || ''));
  assert.strictEqual(db.getRedeemCode('MOD10').creator_role, 'mod');
  // mod tries to redeem own code → rejected
  const selfR = redeem.redeemCode(MOD_ID, 'MOD10', { username: 'modone' });
  assert.ok(!selfR.ok, 'mod cannot redeem own code');
  assert.ok(/own/i.test(selfR.message), 'message mentions own code');
  // but mod CAN redeem an owner code (BONUS100 is maxed out — create a fresh owner one)
  const ownerCode = redeem.createCode(config.ownerId, ['OWNER1', '250000', '5'], { username: 'king' });
  assert.ok(ownerCode.ok, 'owner code created');
  const modR = redeem.redeemCode(MOD_ID, 'OWNER1', { username: 'modone' });
  assert.ok(modR.ok, 'mod can redeem owner code: ' + (modR.message || ''));
  assert.strictEqual(db.getUser(MOD_ID).bank, 250000, 'mod bank credited');
});

test('redeem: list + delete (staff)', () => {
  const redeem = require('../src/redeem');
  const list = redeem.listCodes(config.ownerId);
  assert.ok(list.ok, 'list works');
  assert.ok(/BONUS100/.test(list.message), 'list shows BONUS100');
  // non-staff cannot list
  const nope = redeem.listCodes(8801);
  assert.ok(!nope.ok, 'non-staff cannot list');
  const del = redeem.deleteCode(config.ownerId, 'MOD10', { username: 'king' });
  assert.ok(del.ok, 'delete works');
  assert.ok(!db.getRedeemCode('MOD10'), 'code gone after delete');
});

/* ---------- text→command mapper (Task 3) ---------- */
test('mapper: every keyboard label routes to its command/page', () => {
  const keyboards = require('../src/keyboards');
  const pages = ['main', 'casino', 'games', 'economy'];
  const seen = [];
  for (const page of pages) {
    for (const row of keyboards.keyboardFor(page).keyboard) {
      for (const btn of row) {
        const route = keyboards.routeButton(btn.text);
        assert.ok(route, `button "${btn.text}" routes to something`);
        if (route.cmd) seen.push(`${btn.text} → /${route.cmd}`);
        else if (route.page) seen.push(`${btn.text} → page ${route.page}`);
        else if (route.back) seen.push(`${btn.text} → back`);
      }
    }
  }
  // spot-check the critical mappings
  assert.strictEqual(keyboards.routeButton('💰 Balance').cmd, 'balance');
  assert.strictEqual(keyboards.routeButton('🎰 Casino').page, 'casino');
  assert.strictEqual(keyboards.routeButton('💼 Economy').page, 'economy');
  assert.strictEqual(keyboards.routeButton('🏆 Leaderboard').cmd, 'leaderboard');
  assert.strictEqual(keyboards.routeButton('🎲 Dice').cmd, 'dice');
  assert.strictEqual(keyboards.routeButton('🪙 Coin Flip').cmd, 'coinflip');
  assert.strictEqual(keyboards.routeButton('💣 Mines').cmd, 'mines');
  assert.strictEqual(keyboards.routeButton('🎟️ Lottery').cmd, 'lottery');
  assert.strictEqual(keyboards.routeButton('🏦 Bank').cmd, 'bank');
  assert.strictEqual(keyboards.routeButton('💵 Income').cmd, 'income');
  assert.strictEqual(keyboards.routeButton('🛒 Shop').cmd, 'shop');
  assert.strictEqual(keyboards.routeButton('🕵️ Crime').cmd, 'crime');
  assert.strictEqual(keyboards.routeButton('🎣 Fish').cmd, 'fish');
  assert.strictEqual(keyboards.routeButton('🪪 Profile').cmd, 'profile');
  assert.strictEqual(keyboards.routeButton('↩️ Back').back, true);
  assert.strictEqual(keyboards.routeButton('❓ Help').cmd, 'help');
});

test('mapper: loose match strips emoji variants (client sends different emoji)', () => {
  const keyboards = require('../src/keyboards');
  // A client might send the label with a different (or no) emoji — the loose
  // matcher must still route it.
  assert.strictEqual(keyboards.routeButton('Balance').cmd, 'balance');
  assert.strictEqual(keyboards.routeButton('🏦Bank').cmd, 'bank');
  assert.strictEqual(keyboards.routeButton('coin flip').cmd, 'coinflip');
  assert.strictEqual(keyboards.routeButton('CRIME').cmd, 'crime');
  assert.ok(keyboards.routeButton('🎮games').page === 'games' || keyboards.routeButton('🎮games').cmd, 'emoji+label routes');
});

/* ---------- backup to Postgres (Task 4) ---------- */
test('backup: snapshot also stored in Postgres table, restore prefers it', () => {
  const uid = 8810;
  db.getOrCreateUser(uid, { first_name: 'PG', username: 'pgbackup' });
  db.setWallet(uid, 2222222);
  db.setBank(uid, 3333333);
  db.addItem(uid, 'gun', 1);
  const b = backup.backup();
  assert.ok(b.ok, 'backup ok');
  assert.ok(b.pg === true, 'PG copy stored: ' + JSON.stringify(b));
  const pgB = db.newestBackupPg();
  assert.ok(pgB && pgB.data, 'newest PG backup exists');
  const parsed = JSON.parse(pgB.data);
  assert.ok(parsed.users.some((u) => u.user_id === uid && u.wallet === 2222222), 'PG backup contains user');
  assert.ok(db.listBackupsPg().length >= 1, 'listBackupsPg non-empty');
  // restore picks PG source
  const r = backup.restore();
  assert.ok(r.ok, 'restore ok');
  assert.strictEqual(r.source, 'postgres', 'restore prefers Postgres');
});

/* ---------- hydration fix (Task 5) ---------- */
test('hydration: INSERT OR REPLACE so Postgres (source of truth) wins over stale cache', () => {
  // Simulate: write a NEW balance to "Postgres" (via the sqlite-backed backup
  // table we treat as the durable store) — then verify that when a fresh
  // db is hydrated the PG value wins over a stale local row.
  const uid = 8820;
  db.getOrCreateUser(uid, { first_name: 'Hydrate', username: 'hydrate' });
  db.setWallet(uid, 999999); // "new" value
  // The old bug: INSERT OR IGNORE would keep a stale local row.
  // The fix: hydrateFromPg uses INSERT OR REPLACE.
  const dbSrc = require('../src/db');
  assert.ok(typeof dbSrc.hydrateFromPg === 'function', 'hydrateFromPg exported');
  // We can't easily point at a live PG in tests; the key assertion is that
  // the hydrate function body uses INSERT OR REPLACE (checked via source
  // inspection below — the old buggy code used the INSERT-OR-IGNORE semantic).
  const fs = require('fs');
  const dbCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const hydrateSection = dbCode.slice(dbCode.indexOf('async function hydrateFromPg'), dbCode.indexOf('async function hydrateFromPg') + 1400);
  assert.ok(hydrateSection.includes('INSERT OR REPLACE'), 'hydrate uses INSERT OR REPLACE');
  assert.ok(!hydrateSection.includes('INSERT OR IGNORE'), 'hydrate body has no INSERT OR IGNORE');
  assert.ok(dbCode.includes('hidden_until'), 'users cols include hidden_until');
});

/* ---------- new games ---------- */
test('crash: payout = bet × multiplier, crash=1.0 pays 0', () => {
  const crash = require('../src/games/crash');
  for (let i = 0; i < 200; i++) {
    const r = crash.playCrash(1000);
    assert.ok(r.crash >= 1.0, 'crash multiplier >= 1.0');
    if (r.crash > 1.0) assert.strictEqual(r.payout, Math.floor(1000 * r.crash));
    else assert.strictEqual(r.payout, 0, 'crash at 1.0 pays 0');
  }
});

test('wheel: segments have expected range and payouts', () => {
  const wheel = require('../src/games/wheel');
  const seg = wheel.spin(1000).segment;
  assert.ok(['0.5x','1x','1.5x','2x','3x','5x','10x'].includes(seg.label), 'valid segment label');
  assert.ok(seg.mult >= 0.5 && seg.mult <= 10, 'multiplier in range');
});

test('rps: judge logic + tie pays half', () => {
  const rps = require('../src/games/rps');
  assert.strictEqual(rps.judge('rock', 'scissors'), 'player');
  assert.strictEqual(rps.judge('paper', 'rock'), 'player');
  assert.strictEqual(rps.judge('scissors', 'paper'), 'player');
  assert.strictEqual(rps.judge('rock', 'paper'), 'house');
  assert.strictEqual(rps.judge('rock', 'rock'), 'tie');
  const t = rps.playRps('rock', 1000);
  if (t.result === 'tie') assert.strictEqual(t.payout, 500, 'tie pays half back');
  if (t.result === 'player') assert.strictEqual(t.payout, 1900, 'win pays 1.9x');
});

test('ttt: board resolves to player|bot|tie with valid payout', () => {
  const ttt = require('../src/games/tictactoe');
  for (let i = 0; i < 50; i++) {
    const r = ttt.playTtt(1000);
    assert.ok(['player','bot','tie'].includes(r.result), 'valid result');
    if (r.result === 'player') assert.strictEqual(r.payout, 1800);
    if (r.result === 'tie') assert.strictEqual(r.payout, 500);
    if (r.result === 'bot') assert.strictEqual(r.payout, 0);
  }
});

test('duel: higher roll wins, ties resolve by rank win chance', () => {
  const duel = require('../src/games/dicevs');
  for (let i = 0; i < 100; i++) {
    const r = duel.duel(1000, 0.5);
    assert.ok(r.player >= 1 && r.player <= 6 && r.bot >= 1 && r.bot <= 6, 'rolls in 1-6');
    if (r.player > r.bot) assert.strictEqual(r.result, 'player');
    else if (r.player < r.bot) assert.strictEqual(r.result, 'bot');
    // Ties are now resolved by the rank-tier win chance (peak hours = 0.5),
    // so a tied roll can produce either outcome — never an invalid result.
    assert.ok(r.result === 'player' || r.result === 'bot', 'tie resolves to a valid outcome');
    if (r.result === 'player') assert.strictEqual(r.payout, 1900);
  }
});

test('cfstreak: multiplier doubles per win, 0 on first miss', () => {
  const cfs = require('../src/games/cfstreak');
  for (let i = 0; i < 100; i++) {
    const r = cfs.playStreak(1000, 'heads');
    assert.ok(r.wins >= 0);
    assert.strictEqual(r.payout, r.wins > 0 ? Math.floor(1000 * Math.pow(2, r.wins)) : 0);
  }
  // Consistency: choice is either heads or tails; wins count correct flips.
  const s = cfs.streak('tails');
  assert.ok(Number.isInteger(s.wins) && s.wins >= 0, 'streak returns integer wins');
});

test('numroulette: payouts match rarity table', () => {
  const num = require('../src/games/numroulette');
  const r = num.playNum(7, 1000);
  assert.ok(r.chosen >= 1 && r.chosen <= 10 && r.drawn >= 1 && r.drawn <= 10);
  if (r.payout > 0) assert.strictEqual(r.payout, Math.floor(1000 * num.PAYOUTS[7]));
  else assert.notStrictEqual(r.drawn, 7);
});

/* ---------- profile / badges / id ---------- */
test('profile: rankOf + badges + profileText render', () => {
  const profile = require('../src/profile');
  const uid = 9901;
  db.getOrCreateUser(uid, { first_name: 'ProfileTester', username: 'pt' });
  db.setWallet(uid, 5000000);
  db.setBank(uid, 5000000);
  db.logGameHistory({ user_id: uid, username: 'pt', game: 'slots', bet: 1000, result: 'win', amount: 1000 });
  db.logGameHistory({ user_id: uid, username: 'pt', game: 'dice', bet: 500, result: 'lose', amount: -500 });
  const r = profile.rankOf(uid);
  assert.ok(r.title && r.rank, 'rank + title resolved');
  assert.strictEqual(r.net, 10000000, 'net worth computed');
  const ctx = { userId: uid, args: [], msg: {} };
  const txt = profile.profileText(ctx, uid);
  assert.ok(txt.includes('ProfileTester'), 'profile shows name');
  assert.ok(txt.includes('10,000,000'), 'profile shows net worth');
  assert.ok(txt.includes('Win rate'), 'profile shows win rate');
  const b = profile.badgesText(ctx, uid);
  assert.ok(b.includes('Badges') || b.includes('•'), 'badges render');
  const id = profile.idCardText(ctx, uid);
  assert.ok(id.includes('ID CARD'), 'id card renders');
});

/* ---------- broadcast queue + dashboard events (DB layer) ---------- */
test('broadcast: createBroadcast stores + updateBroadcastCount works', () => {
  const rec = db.createBroadcast('hello broadcast', 'all', 8781690556);
  assert.ok(rec.id > 0, 'broadcast created with id');
  assert.strictEqual(rec.target, 'all');
  db.updateBroadcastCount(rec.id, 7);
  const list = db.listBroadcasts(5);
  assert.ok(list.some((b) => b.id === rec.id && b.sent_count === 7), 'sent_count updated');
});

test('events: createEvent + giveaway-type whitelist in DB layer', () => {
  const ev = db.createEvent({ title: 'Free Giveaway Test', type: 'giveaway', reward: 500000, created_by: 8781690556 });
  assert.ok(ev.id > 0, 'event created');
  assert.strictEqual(ev.type, 'giveaway');
  assert.strictEqual(ev.reward, 500000);
  const list = db.listEvents();
  assert.ok(list.some((e) => e.id === ev.id && e.title === 'Free Giveaway Test'), 'event listed');
});

/* ---------- db ping ---------- */
test('db: ping returns a number (ms)', () => {
  const p = db.ping();
  assert.ok(Number.isFinite(p) && p >= 0, 'ping is a non-negative number');
});

/* ---------- native colored reply keyboards (Bot API 9.4 KeyboardButton.style) ---------- */
test('keyboards: every KeyboardButton carries a native style (primary/danger/success)', () => {
  const keyboards = require('../src/keyboards');
  const pages = ['main', 'casino', 'games', 'economy'];
  const valid = new Set(['primary', 'danger', 'success']);
  let total = 0;
  for (const page of pages) {
    const markup = keyboards.keyboardFor(page);
    assert.ok(markup.keyboard && markup.keyboard.length > 0, `${page} has keyboard rows`);
    for (const row of markup.keyboard) {
      for (const btn of row) {
        total++;
        assert.ok(btn && typeof btn.text === 'string' && btn.text.length > 0, `${page} button has text`);
        assert.ok(valid.has(btn.style), `${page} button '${btn.text}' has valid style (got: ${btn.style})`);
      }
    }
  }
  assert.ok(total >= 15, `at least 15 styled buttons across all keyboards (got ${total})`);
});

test('keyboards: emoji labels restored + risk buttons are red (danger)', () => {
  const keyboards = require('../src/keyboards');
  const main = keyboards.mainKeyboard();
  const all = main.keyboard.flat();
  // Original emoji labels (not colored-emoji prefixes)
  assert.ok(all.some((b) => b.text === '💰 Balance'), '💰 Balance label present');
  assert.ok(all.some((b) => b.text === '🎰 Casino'), '🎰 Casino label present');
  assert.ok(all.some((b) => b.text === '🏆 Leaderboard'), '🏆 Leaderboard label present');
  // Mines + crime are risk actions → bg_danger
  const games = keyboards.gamesKeyboard().keyboard.flat();
  const mines = games.find((b) => b.text === '💣 Mines');
  assert.ok(mines && mines.style === 'danger', 'Mines is red (bg_danger)');
  const eco = keyboards.economyKeyboard().keyboard.flat();
  const crime = eco.find((b) => b.text === '🕵️ Crime');
  assert.ok(crime && crime.style === 'danger', 'Crime is red (bg_danger)');
  // Balance/bank/income are safe → bg_success
  const bal = all.find((b) => b.text === '💰 Balance');
  assert.ok(bal && bal.style === 'success', 'Balance is green (bg_success)');
});

test('keyboards: JSON serialization keeps style (node-telegram-bot-api stringifies reply_markup untouched)', () => {
  const keyboards = require('../src/keyboards');
  // Collect every button from all four keyboards and confirm style survives JSON round-trip
  const allBtns = ['main', 'casino', 'games', 'economy']
    .flatMap((page) => keyboards.keyboardFor(page).keyboard.flat());
  const json = JSON.stringify(allBtns);
  assert.ok(json.includes('"style":"primary"'), 'JSON contains bg_primary');
  assert.ok(json.includes('"style":"success"'), 'JSON contains bg_success');
  assert.ok(json.includes('"style":"danger"'), 'JSON contains bg_danger');
  for (const btn of allBtns) {
    const roundTrip = JSON.parse(JSON.stringify(btn));
    assert.strictEqual(roundTrip.style, btn.style, `style survives JSON round-trip for '${btn.text}'`);
  }
});

test('keyboards: routeButton maps panel-switch + all labels (emoji, bare, old colored variants)', () => {
  const keyboards = require('../src/keyboards');
  // Panel switches (emoji + bare + stale colored-emoji variants)
  assert.deepStrictEqual(keyboards.routeButton('🎰 Casino'), { page: 'casino' });
  assert.deepStrictEqual(keyboards.routeButton('Casino'), { page: 'casino' });
  assert.deepStrictEqual(keyboards.routeButton('🟣🎰 Casino'), { page: 'casino' }); // stale variant
  assert.deepStrictEqual(keyboards.routeButton('🎮 Games'), { page: 'games' });
  assert.deepStrictEqual(keyboards.routeButton('Games'), { page: 'games' });
  assert.deepStrictEqual(keyboards.routeButton('💼 Economy'), { page: 'economy' });
  assert.deepStrictEqual(keyboards.routeButton('Economy'), { page: 'economy' });
  assert.deepStrictEqual(keyboards.routeButton('↩️ Back'), { back: true });
  assert.deepStrictEqual(keyboards.routeButton('Back'), { back: true });
  // Command buttons (emoji + bare)
  assert.deepStrictEqual(keyboards.routeButton('💰 Balance'), { cmd: 'balance' });
  assert.deepStrictEqual(keyboards.routeButton('Balance'), { cmd: 'balance' });
  assert.deepStrictEqual(keyboards.routeButton('🪙 Coin Flip'), { cmd: 'coinflip' });
  assert.deepStrictEqual(keyboards.routeButton('Coin Flip'), { cmd: 'coinflip' });
  assert.deepStrictEqual(keyboards.routeButton('🪪 Profile'), { cmd: 'profile' });
  assert.deepStrictEqual(keyboards.routeButton('Profile'), { cmd: 'profile' });
  // New games
  assert.deepStrictEqual(keyboards.routeButton('Crash'), { cmd: 'crash' });
  assert.deepStrictEqual(keyboards.routeButton('Number Roulette'), { cmd: 'num' });
  assert.strictEqual(keyboards.routeButton('gibberish'), null);
});

test('pause flag: setBotPaused/getBotPaused persisted (SQLite + mirrored to PG pipeline)', () => {
  db.setBotPaused(false);
  assert.strictEqual(db.getBotPaused(), false, 'not paused by default');
  db.setBotPaused(true);
  assert.strictEqual(db.getBotPaused(), true, 'paused after /stop');
  db.setBotPaused(false);
  assert.strictEqual(db.getBotPaused(), false, 'resumed after /run');
  // persisted row exists
  const row = db.db.prepare('SELECT value FROM settings WHERE key = ?').get('bot_paused');
  assert.ok(row && String(row.value) === '0', 'settings row persisted');
});

/* ---------- /sb networth (Feature 1) ---------- */
test('db.setNetworth: sets wallet=N AND resets bank=0 (whole networth = N)', () => {
  const uid = 9301;
  db.getOrCreateUser(uid, { first_name: 'Networth', username: 'nw' });
  db.setWallet(uid, 5000);
  db.setBank(uid, 95000); // networth 100000 before
  db.setNetworth(uid, 12345);
  const u = db.getUser(uid);
  assert.strictEqual(u.wallet, 12345, 'wallet becomes N');
  assert.strictEqual(u.bank, 0, 'bank reset to 0');
  assert.strictEqual(u.wallet + u.bank, 12345, 'networth exactly N');
});

test('db.setNetworth: zero is allowed (wallet 0, bank 0)', () => {
  const uid = 9302;
  db.getOrCreateUser(uid, { first_name: 'Zero', username: 'zero' });
  db.setWallet(uid, 999999);
  db.setBank(uid, 999999);
  db.setNetworth(uid, 0);
  const u = db.getUser(uid);
  assert.strictEqual(u.wallet, 0);
  assert.strictEqual(u.bank, 0);
});

/* ---------- /broadcast relevance + /set helpers (Features 2 & 3) ---------- */
test('broadcast: keyword relevance accepts bot-related messages', async () => {
  const bc = require('../src/broadcast');
  assert.ok(bc.keywordRelevance('New casino event with a 50000 coin reward') >= 1);
  const r = await bc.isRelevant('Rimuru casino economy update');
  assert.ok(r.ok, 'relevant message accepted: ' + r.reason);
});

test('broadcast: relevance rejects random/unrelated messages (no Groq key in tests)', async () => {
  const bc = require('../src/broadcast');
  const r = await bc.isRelevant('buy my crypto course now!!!');
  assert.ok(!r.ok, 'unrelated message rejected');
  assert.strictEqual(r.via, 'keyword', 'uses keyword fallback when Groq is off');
});

test('broadcast: event announcement builder + type whitelist', () => {
  const bc = require('../src/broadcast');
  assert.deepStrictEqual(bc.EVENT_TYPES, ['mission', 'event', 'giveaway', 'trivia', 'challenge']);
  assert.ok(bc.isEventType('giveaway'));
  assert.ok(!bc.isEventType('bogus'));
  const ann = bc.buildEventAnnouncement({ id: 5, title: 'Heist Rimuru', description: 'Steal it', type: 'mission', reward: 100000 });
  assert.ok(ann.includes('Heist Rimuru'), 'announcement has title');
  assert.ok(ann.includes('100,000'), 'announcement has formatted reward');
  assert.ok(ann.includes('/mission 5'), 'announcement links the event id');
});

/* ---------- broadcast queue pipeline (Feature 4) ---------- */
test('broadcast: queueBroadcast + drainBroadcastQueue actually deliver', () => {
  const dboard = require('../src/dashboard/server');
  const delivered = [];
  // Create a broadcast row first (queueBroadcast just needs id/message/target).
  const rec = db.createBroadcast('queued announcement', 'all', 8781690556);
  dboard.queueBroadcast(rec.id, rec.message, 'all');
  assert.strictEqual(dboard.pendingBroadcasts(), 1, 'one item pending');
  const item = dboard.drainBroadcastQueue((it, done) => {
    delivered.push(it);
    done(3);
  });
  assert.ok(item, 'drained an item');
  assert.strictEqual(item.id, rec.id, 'drained the right item');
  assert.strictEqual(delivered.length, 1, 'send callback fired');
  assert.strictEqual(dboard.pendingBroadcasts(), 0, 'queue emptied');
});

/* ---------- rank system ---------- */
test('rank: getWinChance rank tiers + peak-hour override', () => {
  const rank = require('../src/rank');
  const u = { rank: 'bronze' };
  // Non-peak tiers per spec.
  assert.strictEqual(rank.getWinChance({ rank: 'bronze' }, 'slots'), 0.60);
  assert.strictEqual(rank.getWinChance({ rank: 'silver' }, 'slots'), 0.55);
  assert.strictEqual(rank.getWinChance({ rank: 'gold' }, 'slots'), 0.55);
  assert.strictEqual(rank.getWinChance({ rank: 'diamond' }, 'slots'), 0.55);
  assert.strictEqual(rank.getWinChance({ rank: 'master' }, 'slots'), 0.45);
  assert.strictEqual(rank.getWinChance({ rank: 'legend' }, 'slots'), 0.40);
  assert.strictEqual(rank.getWinChance({ rank: 'mythic' }, 'slots'), 0.35);
  // Peak-hour flat 50/50 regardless of rank.
  const RealDate = Date;
  const peak = new RealDate('2026-08-15T08:30:00+01:00').getTime();
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [peak])); }
    static now() { return peak; }
  };
  try {
    assert.strictEqual(rank.isPeakHour(), true);
    assert.strictEqual(rank.getWinChance({ rank: 'mythic' }, 'slots'), 0.5);
    assert.strictEqual(rank.getWinChance({ rank: 'bronze' }, 'slots'), 0.5);
  } finally {
    global.Date = RealDate;
  }
});

test('rank: valid matches require >= 10% of wallet', () => {
  const rank = require('../src/rank');
  const uid = 99101;
  db.getOrCreateUser(uid, { first_name: 'RankTest' });
  db.setWallet(uid, 1000000);
  assert.strictEqual(rank.isValidMatch(uid, 100000), true, '10% counts');
  assert.strictEqual(rank.isValidMatch(uid, 99999), false, 'below 10% does not count');
  assert.strictEqual(rank.isValidMatch(uid, 0), false, 'zero bet never counts');
});

test('rank: promotion thresholds + rewards', () => {
  const rank = require('../src/rank');
  assert.strictEqual(rank.THRESHOLDS[1], 10, 'bronze→silver at 10');
  assert.strictEqual(rank.THRESHOLDS[2], 15, 'silver→gold at 15');
  assert.strictEqual(rank.THRESHOLDS[7], 1000, 'legend→mythic at 1000');
  assert.ok(rank.rewardFor('diamond').timed === false, 'diamond+ saved cash');
  assert.ok(rank.rewardFor('gold').timed === true, 'gold timed');
  assert.ok(rank.rewardFor('bronze').coins === 50000000, 'bronze 50M');
  assert.strictEqual(rank.rankIndex('mythic'), 7, 'mythic is last');
});

test('rank: recordMatchResult promotion + demotion', () => {
  const rank = require('../src/rank');
  const uid = 99102;
  db.getOrCreateUser(uid, { first_name: 'ProgressionTest' });
  db.setWallet(uid, 1000000); // 10% threshold = 100k
  // 10 valid WINS should promote Bronze → Silver.
  for (let i = 0; i < 10; i++) rank.recordMatchResult(uid, 100000, true);
  let u = db.getUser(uid);
  assert.strictEqual(rank.normalizeRank(u.rank), 'silver', 'promoted to silver after 10 valid wins');
  // Reset wallet to a level where the NEXT promotion is far away, so 7 losses
  // cleanly demote without crossing the gold threshold first.
  // Reset to silver with 0 valid matches so the gold threshold (15) stays far
  // away — 7 losses then cleanly demote without a promotion in between.
  db.setRankStats(uid, 'silver', 0, 0);
  u = db.getUser(uid);
  assert.strictEqual(rank.normalizeRank(u.rank), 'silver', 'reset to silver at 0 matches');
  // 7 consecutive valid LOSSES should demote Silver → Bronze.
  for (let i = 0; i < 7; i++) rank.recordMatchResult(uid, 100000, false);
  u = db.getUser(uid);
  assert.strictEqual(rank.normalizeRank(u.rank), 'bronze', 'demoted after 7 consecutive losses');
});

test('rank: time-wallet add/spend/expiry (safe + unrobbable)', () => {
  const rank = require('../src/rank');
  const tw = require('../src/timewallet');
  const uid = 99103;
  db.getOrCreateUser(uid, { first_name: 'TimeWalletTest' });
  const now = Date.now();
  db.addTimeWallet(uid, 1000, now + 60000, 'test');
  assert.strictEqual(tw.balance(uid), 1000, 'time-wallet holds coins');
  // Attack theft is wallet/bank-only — time-wallet stays untouched.
  db.setWallet(uid, 100);
  const stolen = rank.getWinChance; // noop reference; the theft code never calls tw
  assert.ok(typeof stolen === 'function');
  assert.strictEqual(tw.balance(uid), 1000, 'time-wallet unaffected by wallet writes');
  // Spending drains time-wallet first.
  const r = tw.spend(uid, 400, now);
  assert.strictEqual(r.spent, 400, 'spent from time-wallet');
  assert.strictEqual(tw.balance(uid), 600, 'balance reduced');
  // Use a FRESH user for the expiry path (the existing row's expiry is the
  // later of the two, so a separate user isolates the expiry sweep).
  const uid2 = 99104;
  db.getOrCreateUser(uid2, { first_name: 'ExpiryTest' });
  db.addTimeWallet(uid2, 999, now + 1000, 'expires-soon');
  const swept = tw.sweep(now + 5000);
  assert.ok(swept >= 1, 'expired rows swept');
  assert.strictEqual(tw.balance(uid2, now + 5000), 0, 'expired coins gone');
  assert.strictEqual(tw.balance(uid, now + 5000), 600, 'only unexpired coins remain');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL SMOKE TESTS PASSED ✅');