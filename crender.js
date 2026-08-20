'use strict';

const gen2 = require('./hunt-card');
const oldgen = require('./special-hunt-card');

const sessions = new Map();
const TTL_MS = 10 * 60 * 1000;

function key(chatId, userId) { return `${chatId}:${userId}`; }
function clean(v, max = 500) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function isCancel(v) { return /^\/?cancel$/i.test(clean(v)); }
function tierOf(v) { const m = clean(v).match(/^t?([1-6])$/i); return m ? Number(m[1]) : 0; }
function rendererOf(v) {
  const s = clean(v).toLowerCase();
  if (['1','gen2','gen 2','g2'].includes(s)) return 'gen2';
  if (['2','oldgen','old gen','old','special'].includes(s)) return 'oldgen';
  return '';
}
function expire() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.updatedAt > TTL_MS) sessions.delete(k);
}
function has(chatId, userId) { expire(); return sessions.has(key(chatId, userId)); }
function cancel(chatId, userId) { return sessions.delete(key(chatId, userId)); }

async function start(ctx) {
  expire();
  const k = key(ctx.chatId, ctx.userId);
  sessions.set(k, { step: 'renderer', chatId: ctx.chatId, userId: ctx.userId, updatedAt: Date.now() });
  await ctx.reply('♦️ <b>CARD RENDERER 🛠️</b>\n\nChoose a renderer:\n\n<b>1️⃣ Gen 2</b>\n<b>2️⃣ Old Gen</b>\n\nReply with <code>1</code> or <code>2</code>.\nUse <code>/cancel</code> anytime.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
}

async function downloadTelegramImage(bot, msg) {
  let fileId = '';
  if (Array.isArray(msg.photo) && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\//i.test(String(msg.document.mime_type || ''))) fileId = msg.document.file_id;
  if (!fileId) return null;
  const url = await bot.getFileLink(fileId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram image download HTTP ${res.status}`);
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  if (buf.length > 20 * 1024 * 1024) throw new Error('Artwork is larger than 20 MB');
  return buf;
}

async function handleMessage(msg, deps) {
  expire();
  const chatId = msg.chat && msg.chat.id;
  const userId = msg.from && msg.from.id;
  const k = key(chatId, userId);
  const s = sessions.get(k);
  if (!s) return false;
  const text = clean(msg.text || msg.caption || '');
  if (isCancel(text)) {
    sessions.delete(k);
    await deps.reply(chatId, '❌ Card render cancelled.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E' });
    return true;
  }
  s.updatedAt = Date.now();

  if (s.step === 'renderer') {
    const r = rendererOf(text);
    if (!r) { await deps.reply(chatId, 'Choose <b>1</b> for Gen 2 or <b>2</b> for Old Gen.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true }); return true; }
    s.renderer = r; s.step = 'tier';
    await deps.reply(chatId, `🎴 <b>Choose card tier</b>\n\nSend <code>T1</code>, <code>T2</code>, <code>T3</code>, <code>T4</code>, <code>T5</code>, or <code>T6</code>.`, { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'tier') {
    const t = tierOf(text);
    if (!t) { await deps.reply(chatId, 'Tier must be <code>T1</code> through <code>T6</code>.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true }); return true; }
    s.tier = t; s.step = 'name';
    await deps.reply(chatId, '✍️ <b>Card name</b>\n\nSend the character/card name.\nExample: <code>Makima</code>', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'name') {
    if (!text) return true;
    s.name = clean(text, 80); s.step = 'series';
    await deps.reply(chatId, '🎬 <b>Series / Source</b>\n\nSend the anime, game, manga, or source name.\nExample: <code>Chainsaw Man</code>', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'series') {
    if (!text) return true;
    s.series = clean(text, 80); s.step = 'info';
    await deps.reply(chatId, '📖 <b>Card info</b>\n\nSend a short description for the card, or send <code>skip</code>.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'info') {
    s.info = /^skip$/i.test(text) ? '' : clean(text, 360); s.step = 'quote';
    await deps.reply(chatId, '💬 <b>Quote</b>\n\nSend an optional quote, or send <code>skip</code>.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'quote') {
    s.quote = /^skip$/i.test(text) ? '' : clean(text, 180); s.step = 'image';
    await deps.reply(chatId, `🖼️ <b>Send the artwork</b>\n\nSend the image you want Rimuru to render.\n\nRenderer: <b>${s.renderer === 'oldgen' ? 'Old Gen' : 'Gen 2'}</b>\nTier: <b>T${s.tier}</b>\nName: <b>${s.name}</b>`, { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    return true;
  }
  if (s.step === 'image') {
    let image;
    try { image = await downloadTelegramImage(deps.bot, msg); }
    catch (e) { await deps.reply(chatId, `⚠️ I couldn't read that artwork: ${e.message}`, { title: '♦️ CARD RENDERER 🛠️', color: '#FF5252' }); return true; }
    if (!image) { await deps.reply(chatId, 'Please send a photo or an image file. Use <code>/cancel</code> to stop.', { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true }); return true; }
    await deps.reply(chatId, `⚙️ <b>Rendering your JTF Card...</b>\n\nRenderer: <b>${s.renderer === 'oldgen' ? 'Old Gen' : 'Gen 2'}</b>\nTier: <b>T${s.tier}</b>\nName: <b>${s.name}</b>`, { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true });
    try {
      const renderer = s.renderer === 'oldgen' ? oldgen : gen2;
      const description = [s.info, s.quote ? `“${s.quote}”` : ''].filter(Boolean).join(' — ') || 'A custom JTF collectible.';
      const card = { name: s.name, series: s.series, bio: description, description, forced_tier: s.tier, preview_tier: s.tier, character_id: `custom-${Date.now()}` };
      const out = await renderer.render(card, image);
      if (!out || !out.buffer) throw new Error('renderer returned no card');
      const caption = `♦️ <b>JTF CARD RENDERER</b>\n${s.renderer === 'oldgen' ? '✦ Old Gen' : '🃏 Gen 2'} • <b>T${s.tier}</b> • <b>${s.name}</b>\n🎬 ${s.series}`;
      await deps.bot.sendPhoto(chatId, out.buffer, { caption, parse_mode: 'HTML' }, { filename: `JTF_${s.name.replace(/[^a-z0-9]+/gi, '_')}_T${s.tier}.png`, contentType: 'image/png' });
      sessions.delete(k);
    } catch (e) {
      console.error('[crender] render failed:', e.message, e.stack);
      await deps.reply(chatId, '⚠️ Rimuru could not render that card. Your session is still open — send another image or /cancel.', { title: '♦️ CARD RENDERER 🛠️', color: '#FF5252' });
    }
    return true;
  }
  return true;
}

module.exports = { start, handleMessage, has, cancel, _sessions: sessions };
