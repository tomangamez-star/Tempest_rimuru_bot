'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const card = { source_url: 'https://shoob.gg/cards/info/abc123', name: 'Test Hero', series: 'Test Anime', tier: 3,
  telegram_file_id: 'AgAC-test', telegram_media_type: 'photo', telegram_message_id: 77 };
let claimed = false, charged = 0, refunded = 0;
const db = {
  normalizeShoobSearch: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  getSetting: () => null,
  randomShoobCards: async () => [card],
  isHuntCharacterClaimed: () => claimed,
  claimHuntCharacter: (_uid, row) => { if (claimed) return null; claimed = true; assert.equal(row.character_id, 'shoob:abc123'); return row; },
  addWallet: (_uid, amount) => { refunded += amount; },
  getSeenChatIds: () => [],
};
const economy = { chargeWallet: (_uid, amount) => { charged += amount; return { ok: true }; } };
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

const sent = [];
const bot = { sendPhoto: async (...args) => sent.push(args) };

(async () => {
  assert.equal(shop.PRICES[3], 250000000);
  assert(shop.priceFor({ ...card, name: 'Goku', tier: 6 }) > shop.priceFor({ ...card, name: 'Denji', tier: 6 }));
  assert.equal(shop.rollTier(() => 0.00), 1);
  assert.equal(shop.rollTier(() => 0.55), 2);
  assert.equal(shop.rollTier(() => 0.99), 6);
  const ok = await shop.buyTier(bot, -100, 42, 3);
  assert.equal(ok.ok, true);
  assert.equal(charged, shop.priceFor(card));
  assert.equal(refunded, 0);
  assert.equal(sent.length, 1);
  const unavailable = await shop.buyTier(bot, -100, 43, 3);
  assert.equal(unavailable.ok, false);
  assert.equal(charged, shop.priceFor(card), 'an unavailable card must not charge');
  console.log('archive card shop tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
