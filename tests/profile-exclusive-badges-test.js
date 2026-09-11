'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const history = [
  { id: 1, user_id: 10, bet: 1000000, game: 'cf', result: 'win', played_at: 100 },
  { id: 2, user_id: 20, bet: 9000000000, game: 'mines', result: 'lose', played_at: 200 },
  { id: 3, user_id: 30, bet: 5000000000, game: 'roulette', result: 'win', played_at: 300 },
];

const fakeStmt = (sql) => ({
  all: (userId) => sql.includes('WHERE user_id = ?')
    ? history.filter((r) => Number(r.user_id) === Number(userId))
    : [],
  get: () => sql.includes('ORDER BY bet DESC')
    ? history.slice().sort((a,b) => b.bet - a.bet || a.played_at - b.played_at || a.id - b.id)[0]
    : null,
});
const db = {
  db: { prepare: fakeStmt },
  getUser: (id) => ({ user_id: id, wallet: 0, bank: 0 }),
  leaderboard: () => [],
  getInventory: () => [],
};
const utils = { fmt: (n) => String(n), esc: (s) => String(s) };
const old = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /profile\.js$/.test(parent.filename)) {
    if (request === './db') return db;
    if (request === './utils') return utils;
  }
  return old.call(this, request, parent, isMain);
};
const profile = require(path.join('..', 'src', 'profile'));
Module._load = old;

const holder = profile.biggestGambler();
assert.equal(holder.user_id, 20);
assert(profile.badgesOf(20).some((b) => b.includes('Biggest Gambler')));
assert(!profile.badgesOf(10).some((b) => b.includes('Biggest Gambler')));
assert(!profile.badgesOf(30).some((b) => b.includes('Biggest Gambler')));
assert.equal(profile.exclusiveTitleOf(20).title, 'Biggest Gambler');
assert.equal(profile.exclusiveTitleOf(10), null);
console.log('exclusive Biggest Gambler test passed');
