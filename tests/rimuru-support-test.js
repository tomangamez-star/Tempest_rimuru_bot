'use strict';
const assert = require('assert');
const Module = require('module');
const saved = [];
const db = {
  getUser(id) { return { user_id: id, first_name: id === 1 ? 'King' : 'Tester', wallet: 1000, bank: 2000, networth: 3000, rank: 'silver', rank_valid_matches: 12 }; },
  leaderboard() { return [{ user_id: 2, first_name: 'Tester', networth: 3000 }]; },
  getActiveGameSessions() { return [{ game: 'mines' }]; },
  getUserCollection() { return [{ id: 1 }]; },
  getUserHuntCharacters() { return [{ id: 1 }, { id: 2 }]; },
};
const memory = {
  userContext() { return 'birthday: August 22'; }, conversationContext() { return ''; },
  remember(key, value, category) { saved.push({ key, value, category }); return true; },
  recall() { return null; },
};
const original = Module._load;
Module._load = function(request, parent, main) {
  if (parent && /src\/rimuru\.js$/.test(parent.filename)) {
    if (request === './db') return db;
    if (request === './memory') return memory;
    if (request === './config') return { groqApiKey: '', groqModel: 'test', groqMaxTokens: 350, groqTemperature: .65, ownerId: '1' };
    if (request === './utils') return { fmt: (n) => String(n) };
    if (request === './rank') return { matchesToNext: () => 3 };
  }
  return original.call(this, request, parent, main);
};
const rimuru = require('../src/rimuru');
(async () => {
  const prompt = rimuru.systemPrompt(false, { id: 2, first_name: 'Tester' });
  assert.ok(prompt.includes('/shoob <name>'));
  assert.ok(prompt.includes('Active games: mines'));
  assert.ok(prompt.includes('private remembered facts'));
  const reply = await rimuru.reply('Rimuru my birthday is December 5', { id: 2, first_name: 'Tester' });
  assert.ok(reply.includes('December 5'));
  assert.deepStrictEqual(saved[0], { key: 'user:2:birthday', value: 'December 5', category: 'user_info' });
  console.log('RIMURU SUPPORT BRAIN TEST OK');
  Module._load = original;
})().catch((e) => { console.error(e); process.exit(1); });
