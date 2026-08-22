'use strict';
const assert = require('assert');
const Module = require('module');

async function run() {
  const docs = [
    { source_url: 'https://shoob.gg/cards/info/t2', name: 'Rimuru Tempest', normalized_name: 'rimuru tempest', tier: 2, telegram_file_id: 'photo-2', telegram_media_type: 'photo' },
    { source_url: 'https://shoob.gg/cards/info/t5', name: 'Rimuru Tempest', normalized_name: 'rimuru tempest', tier: 5, telegram_file_id: 'video-5', telegram_media_type: 'video' },
  ];
  const db = {
    normalizeShoobSearch(value) { return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); },
    async searchShoobCards() { return { rows: docs, total: docs.length }; },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './db' && parent && /shoob-cards\.js$/.test(parent.filename)) return db;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../src/shoob-cards')];
  const shoob = require('../src/shoob-cards');
  assert.strictEqual(shoob.normalizeName('  Rimurú—Tempest! '), 'rimuru tempest');
  assert.deepStrictEqual(shoob.parseQuery('Rimuru Tempest T5'), { query: 'Rimuru Tempest', tier: 5 });
  assert.strictEqual(shoob.exactCandidates(docs, 'RIMURU TEMPEST')[0].tier, 5);
  assert.strictEqual((await shoob.findExact('Rimuru Tempest', 2)).tier, 2);
  const sent = [];
  const bot = {
    sendPhoto: async (...a) => sent.push(['photo', ...a]),
    sendVideo: async (...a) => sent.push(['video', ...a]),
    sendAnimation: async (...a) => sent.push(['animation', ...a]),
    sendDocument: async (...a) => sent.push(['document', ...a]),
  };
  await shoob.sendArchived(bot, -100, docs[1]);
  assert.strictEqual(sent[0][0], 'video');
  assert.strictEqual(sent[0][2], 'video-5');
  const result = await shoob.startSearch(bot, -100, 77, 'Rimuru Tempest');
  assert.strictEqual(result.ok, true);
  assert.ok(shoob._sessions.size === 1);
  console.log('SHOOB ARCHIVE TEST OK');
  Module._load = originalLoad;
}
run().catch((e) => { console.error(e); process.exit(1); });
