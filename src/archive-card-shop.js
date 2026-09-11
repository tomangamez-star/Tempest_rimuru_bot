'use strict';

const crypto = require('crypto');
const db = require('./db');
const eco = require('./economy');
const { fmt } = require('./utils');

const PRICES = Object.freeze({
  1: Number(process.env.CARD_SHOP_T1_PRICE) || 10_000_000,
  2: Number(process.env.CARD_SHOP_T2_PRICE) || 50_000_000,
  3: Number(process.env.CARD_SHOP_T3_PRICE) || 250_000_000,
  4: Number(process.env.CARD_SHOP_T4_PRICE) || 1_000_000_000,
  5: Number(process.env.CARD_SHOP_T5_PRICE) || 10_000_000_000,
  6: Number(process.env.CARD_SHOP_T6_PRICE) || 100_000_000_000,
});
const LABELS = Object.freeze({ 1: 'COMMON', 2: 'RARE', 3: 'MYTHICAL', 4: 'LEGACY', 5: 'ULTIMATE', 6: 'GODLIKE' });
const RARITIES = Object.freeze({ 1: 'common', 2: 'rare', 3: 'mythical', 4: 'legacy', 5: 'ultimate', 6: 'godlike' });
const CHARACTER_MULTIPLIERS = Object.freeze({
  'goku': 5, 'vegeta': 4, 'gojo satoru': 4, 'satoru gojo': 4, 'naruto uzumaki': 4,
  'monkey d luffy': 4, 'luffy': 4, 'rimuru tempest': 4, 'ichigo kurosaki': 3.5,
  'madara uchiha': 3.5, 'ryomen sukuna': 3.5, 'sukuna': 3.5, 'denji': 1.5,
});

const offers = new Map();
let timer = null;
let kickoff = null;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cardId(card) {
  const match = String(card && card.source_url || '').match(/\/cards\/info\/([^/?#]+)/i);
  return match ? match[1] : String(card && card.telegram_message_id || crypto.randomBytes(6).toString('hex'));
}
function normalizedName(card) { return db.normalizeShoobSearch(card && card.name || ''); }
function roundPrice(value) {
  const step = value >= 100_000_000_000 ? 1_000_000_000 : value >= 1_000_000_000 ? 100_000_000 : value >= 100_000_000 ? 10_000_000 : 1_000_000;
  return Math.max(step, Math.round(value / step) * step);
}
function tier(card) { return Math.max(1, Math.min(6, Number(card && card.tier) || 1)); }
function priceKey(card) { return `card_price:${normalizedName(card)}:t${tier(card)}`; }
function priceFor(card) {
  const override = Number(db.getSetting(priceKey(card)) || 0);
  if (override > 0) return Math.floor(override);
  const nameMultiplier = CHARACTER_MULTIPLIERS[normalizedName(card)] || 1;
  const id = cardId(card);
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash * 31) + id.charCodeAt(i)) >>> 0;
  const variantMultiplier = 0.9 + (hash % 21) / 100;
  return roundPrice(PRICES[tier(card)] * nameMultiplier * variantMultiplier);
}
function mediaMethod(card) {
  const type = String(card && card.telegram_media_type || 'photo').toLowerCase();
  return type === 'video' ? 'sendVideo' : type === 'animation' ? 'sendAnimation' : type === 'document' ? 'sendDocument' : 'sendPhoto';
}
function menuMarkup() {
  return { inline_keyboard: [
    [1,2,3].map((t) => ({ text: `T${t} · ${fmt(PRICES[t])}`, callback_data: `cshop:tier:${t}` })),
    [4,5,6].map((t) => ({ text: `T${t} · ${fmt(PRICES[t])}`, callback_data: `cshop:tier:${t}` })),
  ] };
}
function menuText() {
  return ['🎴 <b>JTF ARCHIVE CARD SHOP</b>', '', 'Cards come directly from the Telegram archive—no external artwork downloads.',
    '', ...[1,2,3,4,5,6].map((t) => `⭐ T${t} ${LABELS[t]} — <b>${fmt(PRICES[t])}</b>`), '', 'Payment is taken from your wallet.'].join('\n');
}
async function showMenu(bot, chatId) {
  return bot.sendMessage(chatId, menuText(), { parse_mode: 'HTML', reply_markup: menuMarkup() });
}
async function sendCard(bot, chatId, card, caption, markup) {
  if (!card || !card.telegram_file_id) throw new Error('Archive card has no Telegram file_id');
  return bot[mediaMethod(card)](chatId, card.telegram_file_id, { caption, parse_mode: 'HTML', reply_markup: markup });
}
function ownedShape(card) {
  const t = tier(card);
  return {
    character_id: `shoob:${cardId(card)}`, name: card.name || 'Unknown', series: card.series || '',
    image_url: card.telegram_file_id, rarity: RARITIES[t], favorites: 0,
  };
}
async function choose(t) {
  const candidates = await db.randomShoobCards(t, 20);
  return candidates.find((card) => !db.isHuntCharacterClaimed(`shoob:${cardId(card)}`)) || null;
}
function offerCaption(offer) {
  const t = tier(offer.card);
  return [
    `🎴 <b>${offer.heading || 'CARD SHOP OFFER'}</b>`,
    `👤 ${esc(offer.card.name || 'Unknown')}`,
    offer.card.series ? `🎬 ${esc(offer.card.series)}` : '',
    `⭐ T${t} ${LABELS[t]}`,
    `💰 Price: <b>${fmt(offer.price)}</b>`,
  ].filter(Boolean).join('\n');
}
function soldCaption(offer, buyer) {
  const t = tier(offer.card);
  return [
    `🎴 <b>${offer.heading || 'CARD SHOP OFFER'}</b>`,
    `👤 ${esc(offer.card.name || 'Unknown')}`,
    offer.card.series ? `🎬 ${esc(offer.card.series)}` : '',
    `⭐ T${t} ${LABELS[t]}`,
    `💰 Sold for: <b>${fmt(offer.price)}</b>`,
    '',
    `✅ <b>SOLD TO ${esc(buyer.label)}</b>`,
    `👑 Added to ${esc(buyer.possessive)} collection`,
  ].filter(Boolean).join('\n');
}
function buyerFrom(query) {
  const from = query && query.from || {};
  const label = from.username ? `@${from.username}` : (from.first_name || `user ${from.id}`);
  const possessive = from.username ? `@${from.username}'s` : `${from.first_name || 'the buyer'}'s`;
  return { id: Number(from.id), label, possessive };
}
async function markOfferSold(bot, offer, buyer) {
  if (!offer.messageId) return;
  try {
    await bot.editMessageCaption(soldCaption(offer, buyer), {
      chat_id: offer.chatId,
      message_id: offer.messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  } catch (e) {
    console.warn('[card-shop] could not update sold offer:', e.message);
  }
}

async function buy(bot, chatId, userId, card, lockedPrice = 0) {
  const t = tier(card), price = Number(lockedPrice) || priceFor(card);
  const payment = eco.chargeWallet(userId, price, `T${t} archive card`);
  if (!payment.ok) return { ok: false, message: payment.message };
  const claimed = db.claimHuntCharacter(userId, ownedShape(card));
  if (!claimed) {
    db.addWallet(userId, price);
    return { ok: false, message: 'That archive card was already purchased. Your coins were refunded.' };
  }
  return { ok: true, card, price };
}

async function buyTier(bot, chatId, userId, t) {
  const card = await choose(t);
  if (!card) return { ok: false, message: `No unowned T${t} archive card is available right now.` };
  return buy(bot, chatId, userId, card);
}

async function createOffer(bot, chatId, card, heading = 'CARD SHOP OFFER') {
  const id = crypto.randomBytes(5).toString('hex'), t = tier(card), price = priceFor(card);
  const offer = {
    id, chatId: Number(chatId), card, price, heading,
    sold: false, busy: false, expiresAt: Date.now() + 60 * 60 * 1000,
    messageId: null,
  };
  offers.set(id, offer);
  const sent = await sendCard(
    bot, chatId, card, offerCaption(offer),
    { inline_keyboard: [[{ text: `🛒 BUY · ${fmt(price)}`, callback_data: `cshop:offer:${id}` }]] },
  );
  offer.messageId = sent && sent.message_id ? Number(sent.message_id) : null;
  return offer;
}

function rollTier(random = Math.random) {
  const n = Number(random()) * 100;
  if (n < 26) return 1;
  if (n < 56) return 2;
  if (n < 78) return 3;
  if (n < 90) return 4;
  if (n < 97) return 5;
  return 6;
}
async function hourlyTick(bot, getChatIds) {
  const groups = (typeof getChatIds === 'function' ? getChatIds() : []).filter((id) => Number(id) < 0);
  for (const chatId of groups) {
    const card = await choose(rollTier());
    if (!card) continue;
    await createOffer(bot, chatId, card, 'HOURLY ARCHIVE OFFER');
  }
  const now = Date.now();
  for (const [id, offer] of offers) if (offer.expiresAt <= now || offer.sold) offers.delete(id);
}
function msUntilMinute(minute) {
  const now = new Date(), next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next - now;
}
function start(bot, getChatIds) {
  if (timer || kickoff) return timer || kickoff;
  kickoff = setTimeout(() => {
    kickoff = null;
    hourlyTick(bot, getChatIds).catch((e) => console.warn('[card-shop] hourly:', e.message));
    timer = setInterval(() => hourlyTick(bot, getChatIds).catch((e) => console.warn('[card-shop] hourly:', e.message)), 3600000);
    timer.unref && timer.unref();
  }, msUntilMinute(25));
  kickoff.unref && kickoff.unref();
  console.log('[card-shop] archive-only paid offer scheduled hourly at :25');
  return kickoff;
}
async function handleCallback(bot, query) {
  const parts = String(query.data || '').split(':');
  if (parts[0] !== 'cshop') return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = query.from && query.from.id;

  if (parts[1] === 'tier') {
    await bot.answerCallbackQuery(query.id, { text: 'Finding an archive card…' }).catch(() => {});
    const card = await choose(Number(parts[2]));
    if (!card) await bot.sendMessage(chatId, `No unowned T${Number(parts[2])} archive card is available right now.`);
    else await createOffer(bot, chatId, card);
    return true;
  }

  if (parts[1] === 'offer') {
    const offer = offers.get(parts[2]);
    if (!offer || offer.expiresAt <= Date.now()) {
      await bot.answerCallbackQuery(query.id, { text: 'This offer expired.', show_alert: true }).catch(() => {});
      return true;
    }
    if (offer.sold || offer.busy) {
      await bot.answerCallbackQuery(query.id, { text: 'Someone already bought this card.', show_alert: true }).catch(() => {});
      return true;
    }

    offer.busy = true;
    let result;
    try {
      result = await buy(bot, chatId, userId, offer.card, offer.price);
      if (result.ok) {
        offer.sold = true;
        offer.buyerId = Number(userId);
        offer.buyer = buyerFrom(query);
        await markOfferSold(bot, offer, offer.buyer);
      }
    } finally {
      offer.busy = false;
    }

    await bot.answerCallbackQuery(query.id, {
      text: result && result.ok ? 'Card purchased!' : (result && result.message) || 'Purchase failed.',
      show_alert: !(result && result.ok),
    }).catch(() => {});
    return true;
  }
  return true;
}

module.exports = {
  PRICES, LABELS, CHARACTER_MULTIPLIERS, priceFor, priceKey, rollTier,
  showMenu, buyTier, createOffer, hourlyTick, start, handleCallback,
  offerCaption, soldCaption, buyerFrom, _offers: offers,
};
