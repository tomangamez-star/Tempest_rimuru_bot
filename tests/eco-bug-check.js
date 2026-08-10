'use strict';
// Ad-hoc verification: the mines onPick eco bug fix.
// Seeds a session directly (like play does) and calls onPick — the exact
// path that crashed with "eco is not defined" before the fix.
const mines = require('../src/games/mines');
const db = require('../src/db');
const eco = require('../src/economy');

const uid = 8809;
db.getOrCreateUser(uid, { first_name: 'Miner', username: 'miner' });
eco.creditWallet(uid, 5000000);

let edited = 0;
let answered = '';
const cb = {
  userId: uid,
  reply: async () => {},
  editMsg: async () => { edited++; },
  answerCb: async (t) => { answered = String(t || ''); },
  eco,
};

(async () => {
  // Seed a session the same way mines.play does (bypass cooldown from other tests)
  const s = mines.createSession(uid, 1000);
  mines.sessions.set(uid, s);
  const safeCell = [...Array(25).keys()].find((i) => !s.mines.has(i));
  await mines.onPick({ data: 'mines:' + uid + ':pick:' + safeCell }, cb);
  console.log('PICK SURVIVED (no eco crash) | boards edited:', edited, '| answer:', answered);
  if (edited === 0 || !answered) {
    console.error('UNEXPECTED: no board update / no answer — onPick may not have run');
    process.exit(1);
  }
  mines.sessions.clear();
  process.exit(0);
})().catch((e) => { console.error('CRASH:', e.message); process.exit(1); });
