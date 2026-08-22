'use strict';

const gen2 = require('./hunt-card');
const oldgen = require('./special-hunt-card');
const signature = require('./jtf-gen-card');
const aiTemplate = require('./ai-template-card');
const cards = require('./custom-cards');
const animatedCard = require('./animated-card');
const crypto = require('crypto');

const sessions = new Map();
const TTL_MS = 20 * 60 * 1000;
const FREE_DAILY = 3;
const ANIMATED_STAR_PRICE = 10;
const PRICES = { 1: 50_000_000, 2: 500_000_000, 3: 10_000_000_000, 4: 500_000_000_000, 5: 10_000_000_000_000, 6: 100_000_000_000_000 };
const RENDERERS = {
  gen2: { key: 'gen2', label: 'Gen 2', badge: '🃏 Gen 2', aliases: ['1', 'gen2', 'gen 2', 'g2'] },
  oldgen: { key: 'oldgen', label: 'Old Gen', badge: '✦ Old Gen', aliases: ['2', 'oldgen', 'old gen', 'old', 'special'] },
  signature: { key: 'signature', label: 'JTF Signature', badge: '♦️ JTF Signature', aliases: ['3', 'signature', 'jtf', 'jtf gen', 'jtfgen', 'sig', 'gen3', 'gen 3'] },
  ai: { key: 'ai', label: 'JTF AI Custom', badge: '✦ JTF AI Custom', aliases: ['4', 'ai', 'ai custom', 'custom ai', 'gen4', 'gen 4', 'fourth'] },
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
  if (name === 'ai') return aiTemplate;
  return gen2;
}

async function start(ctx) {
  expire();
  sessions.set(key(ctx.chatId, ctx.userId), {
    step: 'renderer', chatId: ctx.chatId, userId: ctx.userId,
    isStaff: !!ctx.isStaff, isOwner: !!ctx.isOwner, updatedAt: Date.now(),
  });
  await ctx.reply(
    '♦️ <b>CARD RENDERER 🛠️</b>\n\nChoose a renderer:\n\n' +
    '<b>1️⃣ Gen 2</b>\n' +
    '<b>2️⃣ Old Gen</b>\n' +
    '<b>3️⃣ JTF Signature</b>\n\n' +
    '<b>4️⃣ JTF AI Custom</b> — artwork-directed template\n\n' +
    'Normal users receive <b>3 free successful static renders daily</b>.\n' +
    '✨ Every renderer supports <b>T6 Premium Motion</b> for <b>⭐10</b>.\n' +
    'Reply <code>1</code>, <code>2</code>, <code>3</code>, or <code>4</code>. Use <code>/cancel</code> anytime.',
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

async function dlAnimation(bot, msg) {
  const media = msg.animation || msg.video || (msg.document && /^(?:image\/gif|video\/)/i.test(msg.document.mime_type || '') ? msg.document : null);
  if (!media?.file_id) return null;
  const declaredSize = Number(media.file_size) || 0;
  if (declaredSize > animatedCard.MAX_INPUT_BYTES) throw new Error('Animation must be 15 MB or smaller');
  const fileLink = await bot.getFileLink(media.file_id);
  const res = await fetch(fileLink);
  if (!res.ok) throw new Error(`Telegram animation HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const meta = {
    mimeType: media.mime_type || (msg.animation ? 'video/mp4' : 'video/mp4'),
    duration: Number(media.duration) || 0,
    fileName: media.file_name || 'animation.mp4',
  };
  animatedCard.validateInput(buffer, meta);
  return { buffer, ...meta };
}

function cardData(s) {
  const desc = [s.info, s.quote ? `“${s.quote}”` : ''].filter(Boolean).join(' — ') || 'A custom JTF collectible.';
  return {
    name: s.name, series: s.series, bio: desc, description: desc,
    forced_tier: s.tier, preview_tier: s.tier,
    character_id: `custom-${Date.now()}`,
  };
}

async function refundStars(s, deps, reason) {
  if (!s.paymentChargeId) return false;
  try {
    if (typeof deps.bot.refundStarPayment === 'function') {
      await deps.bot.refundStarPayment(s.userId, s.paymentChargeId);
    } else if (typeof deps.bot._request === 'function') {
      // node-telegram-bot-api 0.66 predates the convenience wrapper, but its
      // supported generic Bot API request path can call the official method.
      await deps.bot._request('refundStarPayment', { form: {
        user_id: s.userId,
        telegram_payment_charge_id: s.paymentChargeId,
      } });
    } else throw new Error('Telegram refund method is unavailable');
    deps.db.updateStarRenderPayment(s.paymentChargeId, 'refunded');
    s.paymentRefunded = true;
    console.warn(`[crender-stars] refunded ${s.paymentChargeId}: ${reason}`);
    return true;
  } catch (error) {
    deps.db.updateStarRenderPayment(s.paymentChargeId, 'refund_pending');
    console.error(`[crender-stars] REFUND PENDING ${s.paymentChargeId}:`, error.message);
    return false;
  }
}

async function renderAndDeliver(s, deps) {
  const chatId = s.chatId;
  await deps.reply(chatId, s.animated ? '✨ <b>Forging your animated T6 JTF Card...</b>' : '⚙️ <b>Rendering your JTF Card...</b>', { html: true });
  try {
    const renderer = rendererImpl(s.renderer);
    const artwork = s.animated
      ? await animatedCard.extractPoster(s.animation.buffer, s.animation)
      : s.image;
    const staticOut = await renderer.render(cardData(s), artwork);
    if (!staticOut?.buffer) throw new Error('renderer returned no card');
    let output = staticOut.buffer;
    if (s.animated) {
      if (s.paymentChargeId) deps.db.updateStarRenderPayment(s.paymentChargeId, 'rendering');
      const motion = await animatedCard.render({
        mediaBuffer: s.animation.buffer,
        staticBuffer: staticOut.buffer,
        mimeType: s.animation.mimeType,
        duration: s.animation.duration,
        renderer: s.renderer,
      });
      output = motion.buffer;
    }
    s.output = output;
    s.outputAnimated = !!s.animated;
    if (!s.isStaff && !s.animated) cards.mark(s.userId);
    const cap = `♦️ <b>JTF CARD RENDERER</b>\n${rendererMeta(s.renderer).badge} • <b>T${s.tier}</b> • <b>${s.name}</b>\n🎬 ${s.series}${s.animated ? `\n✨ <b>PREMIUM MOTION${s.isOwner ? ' • OWNER PASS' : ' • ⭐10'}</b>` : ''}`;
    const sentCard = s.animated
      ? await deps.bot.sendAnimation(chatId, output, { caption: cap, parse_mode: 'HTML', duration: animatedCard.DURATION, width: animatedCard.WIDTH, height: animatedCard.HEIGHT }, { filename: `JTF_${s.name.replace(/[^a-z0-9]+/gi, '_')}_T6_MOTION.mp4`, contentType: 'video/mp4' })
      : await deps.bot.sendPhoto(chatId, output, { caption: cap, parse_mode: 'HTML' }, { filename: `JTF_${s.name.replace(/[^a-z0-9]+/gi, '_')}_T${s.tier}.png`, contentType: 'image/png' });
    if (s.animated && s.paymentChargeId) deps.db.updateStarRenderPayment(s.paymentChargeId, 'delivered');
    s.renderMessageId = sentCard && sentCard.message_id;
    s.renderCaption = cap;
    s.step = 'save';
    await deps.reply(chatId, `💾 <b>Save this ${s.animated ? 'animated ' : ''}custom card to your collection?</b>\nReply <code>yes</code> or <code>no</code>.`, { html: true });
    return true;
  } catch (error) {
    console.error('[crender] render failed:', error.message);
    if (s.animated) {
      const refunded = s.paymentChargeId ? await refundStars(s, deps, error.message) : false;
      await deps.reply(chatId, s.isOwner
        ? '⚠️ Animated render failed. No Stars were charged; start /crender to try again.'
        : (refunded
          ? '⚠️ Animated render failed, so your ⭐10 was automatically refunded. Start /crender to try again.'
          : '⚠️ Animated render failed. The automatic refund is pending; the payment ID was recorded for recovery.'), { html: true });
      sessions.delete(key(s.chatId, s.userId));
    } else {
      if (s.charged) { deps.db.addWallet(s.userId, s.cost); s.charged = false; }
      await deps.reply(chatId, '⚠️ Render failed. Any charged coins were refunded. Send <code>confirm</code> to retry or /cancel.', { html: true });
      s.step = 'confirm';
    }
    return false;
  }
}

async function handlePreCheckout(query, deps) {
  const s = Array.from(sessions.values()).find((item) => item.userId === query.from?.id && item.invoicePayload === query.invoice_payload);
  const valid = !!s && s.step === 'awaiting_payment' && query.currency === 'XTR' && Number(query.total_amount) === ANIMATED_STAR_PRICE;
  await deps.bot.answerPreCheckoutQuery(query.id, valid, valid ? undefined : { error_message: 'This animated-render session expired. Start /crender again; you were not charged.' });
  return valid;
}

async function handlePayment(msg, deps) {
  const payment = msg.successful_payment;
  if (!payment) return false;
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  const s = Array.from(sessions.values()).find((item) => item.userId === userId && item.invoicePayload === payment.invoice_payload);
  const chargeId = String(payment.telegram_payment_charge_id || '');
  if (!s || payment.currency !== 'XTR' || Number(payment.total_amount) !== ANIMATED_STAR_PRICE) {
    try {
      if (chargeId && typeof deps.bot.refundStarPayment === 'function') await deps.bot.refundStarPayment(userId, chargeId);
      else if (chargeId && typeof deps.bot._request === 'function') await deps.bot._request('refundStarPayment', { form: { user_id: userId, telegram_payment_charge_id: chargeId } });
    } catch (_) {}
    await deps.reply(chatId, '⚠️ This premium-render session expired, so the Stars payment was refunded. Start /crender again.');
    return true;
  }
  const recorded = deps.db.recordStarRenderPayment({
    charge_id: chargeId, payload: payment.invoice_payload, user_id: userId, chat_id: chatId,
    amount: payment.total_amount, currency: payment.currency, status: 'paid',
    renderer: s.renderer, card_name: s.name,
  });
  if (!recorded.inserted) {
    if (recorded.payment?.status === 'delivered') await deps.reply(chatId, '✅ This animated render payment was already delivered.');
    return true;
  }
  s.paymentChargeId = chargeId;
  s.step = 'rendering';
  await renderAndDeliver(s, deps);
  return true;
}

async function handleMessage(msg, deps) {
  expire();
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const k = key(chatId, userId);
  const s = sessions.get(k);
  if (!s) return false;

  if (msg.successful_payment) return handlePayment(msg, deps);

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
      await deps.reply(chatId, 'Choose 1 for Gen 2, 2 for Old Gen, 3 for JTF Signature, or 4 for JTF AI Custom.');
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
    if (tier === 6) {
      s.step = 'mode';
      await deps.reply(chatId, '💎 <b>T6 OUTPUT</b>\n\n<b>1️⃣ Static T6</b> — normal renderer pricing\n<b>2️⃣ Premium Animated T6</b> — ⭐10\n\nPremium accepts a GIF or short looping video and adds moving stars, glow, shimmer and renderer-specific aura.', { html: true });
    } else {
      s.animated = false;
      s.step = 'name';
      await deps.reply(chatId, '✍️ <b>Card name</b>\nExample: <code>Makima</code>', { html: true });
    }
    return true;
  }

  if (s.step === 'mode') {
    if (!/^[12]$/.test(text)) {
      await deps.reply(chatId, 'Reply <code>1</code> for Static T6 or <code>2</code> for Premium Animated T6.', { html: true });
      return true;
    }
    s.animated = text === '2';
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
      s.animated
        ? `🎞️ Send a <b>GIF or short looping video</b>.\n\nMaximum: <b>8 seconds / 15 MB</b>\nRenderer: <b>${rendererMeta(s.renderer).label}</b>\nTier: <b>T6 Premium Motion</b>\nName: <b>${s.name}</b>`
        : `🖼️ Send the artwork.\n\nRenderer: <b>${rendererMeta(s.renderer).label}</b>\nTier: <b>T${s.tier}</b>\nName: <b>${s.name}</b>`,
      { html: true },
    );
    return true;
  }

  if (s.step === 'image') {
    try {
      if (s.animated) s.animation = await dlAnimation(deps.bot, msg);
      else s.image = await dl(deps.bot, msg);
    }
    catch (e) {
      await deps.reply(chatId, `⚠️ ${e.message}`);
      return true;
    }
    if (s.animated ? !s.animation : !s.image) {
      await deps.reply(chatId, s.animated ? 'Send a GIF, MP4, MOV, or WEBM animation.' : 'Send a photo/image file.');
      return true;
    }
    const used = s.animated ? 0 : (s.isStaff ? 0 : cards.count(userId));
    const free = s.animated ? false : (s.isStaff || used < FREE_DAILY);
    const cost = s.animated ? 0 : (free ? 0 : PRICES[s.tier]);
    s.cost = cost;
    s.step = 'confirm';
    await deps.reply(
      chatId,
      `♦️ <b>RENDER CONFIRMATION</b>\n\nRenderer: <b>${rendererMeta(s.renderer).label}</b>\nTier: <b>T${s.tier}${s.animated ? ' PREMIUM MOTION' : ''}</b>\nName: <b>${s.name}</b>\nCost: <b>${s.animated ? (s.isOwner ? 'FREE' : `⭐${ANIMATED_STAR_PRICE}`) : (cost ? `🪙 ${money(cost)}` : 'FREE')}</b>\n${s.animated ? (s.isOwner ? '👑 Owner Premium Motion pass' : 'Payment is requested only after you confirm.') : (s.isStaff ? '👑 Staff unlimited render' : `Free renders used today: <b>${Math.min(used, 3)}/3</b>`)}\n\nReply <code>confirm</code> or <code>/cancel</code>.`,
      { html: true },
    );
    return true;
  }

  if (s.step === 'confirm') {
    if (!/^confirm$/i.test(text)) {
      await deps.reply(chatId, 'Reply <code>confirm</code> to render or <code>/cancel</code>.', { html: true });
      return true;
    }
    if (s.animated) {
      if (s.isOwner) {
        s.step = 'rendering';
        await renderAndDeliver(s, deps);
        return true;
      }
      s.invoicePayload = `jtfanim:${userId}:${crypto.randomBytes(8).toString('hex')}`;
      await deps.bot.sendInvoice(
        chatId,
        'Animated T6 JTF Card',
        `${rendererMeta(s.renderer).label} • ${s.name} • 6-second premium motion render`,
        s.invoicePayload,
        '',
        'XTR',
        [{ label: 'T6 Premium Motion Render', amount: ANIMATED_STAR_PRICE }],
        { start_parameter: `jtf-motion-${crypto.randomBytes(4).toString('hex')}` },
      );
      s.step = 'awaiting_payment';
      await deps.reply(chatId, '⭐ Complete the Telegram Stars invoice above. Rimuru renders immediately after payment.');
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
    await renderAndDeliver(s, deps);
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
      const path = await cards.upload(id, s.output, { animated: s.outputAnimated, contentType: s.outputAnimated ? 'video/mp4' : 'image/png' });
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

module.exports = { start, handleMessage, handlePayment, handlePreCheckout, has, cancel, PRICES, FREE_DAILY, ANIMATED_STAR_PRICE, RENDERERS, _sessions: sessions };
