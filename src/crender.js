'use strict';

const gen2 = require('./hunt-card');
const oldgen = require('./special-hunt-card');
const signature = require('./jtf-gen-card');
const cards = require('./custom-cards');

const sessions = new Map();
const TTL_MS = 10 * 60 * 1000;
const FREE_DAILY = 3;
const PRICES = { 1: 50_000_000, 2: 500_000_000, 3: 10_000_000_000, 4: 500_000_000_000, 5: 10_000_000_000_000, 6: 100_000_000_000_000 };
const RENDERERS = {
  gen2: { key: 'gen2', label: 'Gen 2', badge: '🃏 Gen 2', aliases: ['1', 'gen2', 'gen 2', 'g2'] },
  oldgen: { key: 'oldgen', label: 'Old Gen', badge: '✦ Old Gen', aliases: ['2', 'oldgen', 'old gen', 'old', 'special'] },
  signature: { key: 'signature', label: 'JTF Signature', badge: '♦️ JTF Signature', aliases: ['3', 'signature', 'jtf', 'jtf gen', 'jtfgen', 'sig', 'gen3', 'gen 3'] },
};

function key(chatId, userId) { return `${chatId}:${userId}`; }
function clean(value, max = 500) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function tierOf(value) { const m = clean(value).match(/^t?([1-6])$/i); return m ? Number(m[1]) : 0; }
function expire() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.updatedAt > TTL_MS) sessions.delete(k);
}
function has(chatId, userId) { expire(); return sessions.has(key(chatId, userId)); }
function cancel(chatId, userId) { return sessions.delete(key(chatId, userId)); }
function money(n) { return Number(n).toLocaleString('en-US'); }
function rendererName(value) {
  const raw = clean(value).toLowerCase();
  return Object.values(RENDERERS).find((r) => r.aliases.includes(raw))?.key || '';
}
function rendererMeta(name) { return RENDERERS[name] || RENDERERS.gen2; }
function rendererImpl(name) {
  if (name === 'oldgen') return oldgen;
  if (name === 'signature') return signature;
  return gen2;
}

async function start(ctx) {
  expire();
  sessions.set(key(ctx.chatId, ctx.userId), {
    step: 'renderer', chatId: ctx.chatId, userId: ctx.userId, isStaff: !!ctx.isStaff, updatedAt: Date.now(),
  });
  await ctx.reply(
    '♦️ <b>CARD RENDERER 🛠️</b>\n\nChoose a renderer:\n\n' +
    '<b>1️⃣ Gen 2</b>\n' +
    '<b>2️⃣ Old Gen</b>\n' +
    '<b>3️⃣ JTF Signature</b>\n\n' +
    'Normal users receive <b>3 free successful renders daily</b>.\n' +
    'Reply <code>1</code>, <code>2</code>, or <code>3</code>. Use <code>/cancel</code> anytime.',
    { title: '♦️ CARD RENDERER 🛠️', color: '#FFD34E', html: true },
  );
}

async function dl(bot, msg) {
  let id = '';
  if (msg.photo?.length) id = msg.photo.at(-1).file_id;
  else if (msg.document && /^image\//i.test(msg.document.mime_type || '')) id = msg.document.file_id;
  if (!id) return null;
  const fileLink = await bot.getFileLink(id);
  const res = await fetch(fileLink);
  if (!res.ok) throw new Error(`Telegram image HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Artwork is larger than 20 MB');
  return buffer;
}

async function handleMessage(msg, deps) {
  expire();
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const k = key(chatId, userId);
  const s = sessions.get(k);
  if (!s) return false;

  const text = clean(msg.text || msg.caption || '');
  if (/^\/?cancel$/i.test(text)) {
    sessions.delete(k);
    await deps.reply(chatId, '❌ Card render cancelled.', { title: '♦️ CARD RENDERER 🛠️' });
    return true;
  }

  s.updatedAt = Date.now();

  if (s.step === 'renderer') {
    const renderer = rendererName(text);
    if (!renderer) {
      await deps.reply(chatId, 'Choose 1 for Gen 2, 2 for Old Gen, or 3 for JTF Signature.');
      return true;
    }
    s.renderer = renderer;
    s.step = 'tier';
    await deps.reply(chatId, '🎴 Choose tier: <code>T1</code> to <code>T6</code>.', { html: true });
    return true;
  }

  if (s.step === 'tier') {
    const tier = tierOf(text);
    if (!tier) {
      await deps.reply(chatId, 'Tier must be T1–T6.');
      return true;
    }
    s.tier = tier;
    s.step = 'name';
    await deps.reply(chatId, '✍️ <b>Card name</b>\nExample: <code>Makima</code>', { html: true });
    return true;
  }

  if (s.step === 'name') {
    if (!text) return true;
    s.name = clean(text, 80);
    s.step = 'series';
    await deps.reply(chatId, '🎬 <b>Series / Source</b>\nExample: <code>Chainsaw Man</code>', { html: true });
    return true;
  }

  if (s.step === 'series') {
    if (!text) return true;
    s.series = clean(text, 100);
    s.step = 'info';
    await deps.reply(chatId, '📖 <b>Card info</b> — send text or <code>skip</code>.', { html: true });
    return true;
  }

  if (s.step === 'info') {
    s.info = /^skip$/i.test(text) ? '' : clean(text, 360);
    s.step = 'quote';
    await deps.reply(chatId, '💬 <b>Quote</b> — send one or <code>skip</code>.', { html: true });
    return true;
  }

  if (s.step === 'quote') {
    s.quote = /^skip$/i.test(text) ? '' : clean(text, 180);
    s.step = 'image';
    await deps.reply(
      chatId,
      `🖼️ Send the artwork.\n\nRenderer: <b>${rendererMeta(s.renderer).label}</b>\nTier: <b>T${s.tier}</b>\nName: <b>${s.name}</b>`,
      { html: true },
    );
    return true;
  }

  if (s.step === 'image') {
    try { s.image = await dl(deps.bot, msg); }
    catch (e) {
      await deps.reply(chatId, `⚠️ ${e.message}`);
      return true;
    }
    if (!s.image) {
      await deps.reply(chatId, 'Send a photo/image file.');
      return true;
    }
    const used = s.isStaff ? 0 : cards.count(userId);
    const free = s.isStaff || used < FREE_DAILY;
    const cost = free ? 0 : PRICES[s.tier];
    s.cost = cost;
    s.step = 'confirm';
    await deps.reply(
      chatId,
      `♦️ <b>RENDER CONFIRMATION</b>\n\nRenderer: <b>${rendererMeta(s.renderer).label}</b>\nTier: <b>T${s.tier}</b>\nName: <b>${s.name}</b>\nCost: <b>${cost ? `🪙 ${money(cost)}` : 'FREE'}</b>\n${s.isStaff ? '👑 Staff unlimited render' : `Free renders used today: <b>${Math.min(used, 3)}/3</b>`}\n\nReply <code>confirm</code> or <code>/cancel</code>.`,
      { html: true },
    );
    return true;
  }

  if (s.step === 'confirm') {
    if (!/^confirm$/i.test(text)) {
      await deps.reply(chatId, 'Reply <code>confirm</code> to render or <code>/cancel</code>.', { html: true });
      return true;
    }
    if (s.cost) {
      const charged = deps.eco.chargeWallet(userId, s.cost, 'custom card render');
      if (!charged.ok) {
        await deps.reply(chatId, charged.message);
        return true;
      }
      s.charged = true;
    }
    await deps.reply(chatId, '⚙️ <b>Rendering your JTF Card...</b>', { html: true });
    try {
      const desc = [s.info, s.quote ? `“${s.quote}”` : ''].filter(Boolean).join(' — ') || 'A custom JTF collectible.';
      const renderer = rendererImpl(s.renderer);
      const card = {
        name: s.name,
        series: s.series,
        bio: desc,
        description: desc,
        forced_tier: s.tier,
        preview_tier: s.tier,
        character_id: `custom-${Date.now()}`,
      };
      const out = await renderer.render(card, s.image);
      if (!out?.buffer) throw new Error('renderer returned no card');
      s.output = out.buffer;
      if (!s.isStaff) cards.mark(userId);
      const cap = `♦️ <b>JTF CARD RENDERER</b>\n${rendererMeta(s.renderer).badge} • <b>T${s.tier}</b> • <b>${s.name}</b>\n🎬 ${s.series}`;
      const sentCard = await deps.bot.sendPhoto(
        chatId,
        s.output,
        { caption: cap, parse_mode: 'HTML' },
        { filename: `JTF_${s.name.replace(/[^a-z0-9]+/gi, '_')}_T${s.tier}.png`, contentType: 'image/png' },
      );
      s.renderMessageId = sentCard && sentCard.message_id;
      s.renderCaption = cap;
      s.step = 'save';
      await deps.reply(chatId, '💾 <b>Save this custom card to your collection?</b>\nReply <code>yes</code> or <code>no</code>.', { html: true });
    } catch (e) {
      if (s.charged) {
        deps.db.addWallet(userId, s.cost);
        s.charged = false;
      }
      console.error('[crender] render failed:', e.message);
      await deps.reply(chatId, '⚠️ Render failed. Any charged coins were refunded. Send <code>confirm</code> to retry or /cancel.', { html: true });
      s.step = 'confirm';
    }
    return true;
  }

  if (s.step === 'save') {
    if (/^no$/i.test(text)) {
      sessions.delete(k);
      await deps.reply(chatId, '♦️ Card finished without saving.');
      return true;
    }
    if (!/^yes$/i.test(text)) {
      await deps.reply(chatId, 'Reply yes or no.');
      return true;
    }
    try {
      const id = cards.newId();
      const path = await cards.upload(id, s.output);
      const row = cards.save({
        card_id: id,
        user_id: userId,
        renderer: s.renderer,
        tier: s.tier,
        name: s.name,
        series: s.series,
        info: s.info,
        quote: s.quote,
      }, path);
      if (s.renderMessageId) {
        try {
          await deps.bot.editMessageCaption(`${s.renderCaption}\n💾 Saved ID: <code>#${row.card_id}</code>`, {
            chat_id: chatId,
            message_id: s.renderMessageId,
            parse_mode: 'HTML',
          });
        } catch (_) {}
      }
      await deps.reply(chatId, `💾 <b>CARD SAVED</b>\n\nID: <code>#${row.card_id}</code>\n${row.name} • T${row.tier}\nUse <code>/customcards</code> to view your saved custom cards.`, { html: true });
      sessions.delete(k);
    } catch (e) {
      await deps.reply(chatId, `⚠️ Could not save the card: ${e.message}\nYour render is complete, but storage needs to be configured/fixed.`);
    }
    return true;
  }

  return true;
}

module.exports = { start, handleMessage, has, cancel, PRICES, FREE_DAILY, RENDERERS, _sessions: sessions };
