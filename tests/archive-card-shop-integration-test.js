'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const card = {
  source_url: 'https://shoob.gg/cards/info/abc123',
  name: 'Goku',
  series: 'Dragon Ball',
  tier: 6,
  telegram_file_id: 'AgAC-test',
  telegram_media_type: 'photo',
  telegram_message_id: 77,
};
let claimed = false;
const db = {
  normalizeShoobSearch: (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  getSetting: () => null,
  randomShoobCards: async () => [card],
  isHuntCharacterClaimed: () => claimed,
  claimHuntCharacter: (_uid, row) => { if (claimed) return null; claimed = true; return row; },
  addWallet: () => {},
};
const economy = { chargeWallet: () => ({ ok: true }) };
const utils = { fmt: (n) => String(n) };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /archive-card-shop\.js$/.test(parent.filename)) {
    if (request === './db') return db;
    if (request === './economy') return economy;
    if (request === './utils') return utils;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const shop = require(path.join('..', 'src', 'archive-card-shop'));
Module._load = originalLoad;

(async () => {
  let edited = null;
  const bot = {
    sendPhoto: async () => ({ message_id: 99 }),
    answerCallbackQuery: async () => {},
    editMessageCaption: async (caption, opts) => { edited = { caption, opts }; },
  };

  const offer = await shop.createOffer(bot, -100, card, 'HOURLY ARCHIVE OFFER');
  assert.equal(offer.messageId, 99);

  await shop.handleCallback(bot, {
    id: 'cb1',
    data: `cshop:offer:${offer.id}`,
    from: { id: 42, username: 'caleb' },
    message: { chat: { id: -100 }, message_id: 99 },
  });

  assert.equal(offer.sold, true);
  assert(edited.caption.includes('SOLD TO @caleb'));
  assert.deepEqual(edited.opts.reply_markup, { inline_keyboard: [] });
  console.log('archive sold-display integration test passed');
})().catch((e) => { console.error(e); process.exit(1); });
