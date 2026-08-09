'use strict';
// Functional verification for the group gate + personality split + staff check.
// Runs against a throwaway temp DB. Not part of `npm test`.
process.env.DB_PATH = '/tmp/rimuru-gatecheck-' + Date.now() + '.db';
process.env.DATA_DIR = '/tmp';
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const db = require('../src/db');
const rimuru = require('../src/rimuru');

let ok = 0;
let fail = 0;
function t(name, cond) {
  if (cond) { ok++; console.log('  OK ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// 1. config group gate defaults
t('config.requiredGroup default @the_jtf', config.requiredGroup === '@the_jtf');
t('config.groupGateCacheMs 60000', config.groupGateCacheMs === 60000);
t('config.requiredGroupId 0', config.requiredGroupId === 0);

// 2. staff detection via admin_users
db.addAdminUser(777, 'mod1', 'mod', 'pw');
const isOwner = (id) => String(id) === String(config.ownerId);
const isStaff = (id) => isOwner(id) || !!db.getAdminUser(Number(id));
t('owner isStaff', isStaff(config.ownerId) === true);
t('mod 777 isStaff', isStaff(777) === true);
t('user 555 not staff', isStaff(555) === false);

// 3. personality split system prompts
const spStaff = rimuru.systemPrompt(true);
const spReg = rimuru.systemPrompt(false);
t('staff prompt has colleague tone', /trusted colleague|STAFF/.test(spStaff));
t('regular prompt has strict line', /confident, strict/.test(spReg));
t('staff prompt lacks strict line', !/confident, strict/.test(spStaff));
t('both prompts share base', spStaff.includes('Current top 5 richest') && spReg.includes('Current top 5 richest'));

// 4. canned replies staff vs regular
const cs = rimuru.cannedReply('hello', 'Mod1', true);
const cr = rimuru.cannedReply('hello', 'Bob', false);
t('canned staff warm', /Good to see you|How can I help/.test(cs));
t('canned regular strict', /Enjoying my casino/.test(cr));

console.log('\n' + ok + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
