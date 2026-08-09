'use strict';
/**
 * Rimuru Tempest Casino — unified message sending layer.
 *
 * Every message the bot emits goes through this module so that:
 *   1. The notebook-style <blockquote> left margin bar renders on EVERY
 *      message (casino, games, economy, leaderboard, balance, help, ...).
 *   2. parse_mode is ALWAYS 'HTML' (never Markdown — Telegram's HTML
 *      renderer draws the blockquote bar; Markdown cannot).
 *   3. User-generated content is HTML-escaped (esc) so <, >, & in
 *      usernames/input can never break formatting.
 *   4. A hardened sanitizer + plain-text rescue make "can't parse
 *      entities" 400 errors impossible.
 *   5. Inline keyboards are gated behind SHOW_INLINE_BUTTONS (default
 *      false): hidden by default, toggleable from config, never removed.
 *   6. Stickers are always sent AFTER the text message (never before).
 *
 * All callers receive a Promise<Message|null> (null = permanent failure).
 */
const config = require('./config');
const { note, esc, sanitizeHtml } = require('./utils');

/** HTML-escape a plain text body and wrap it as a notebook note. */
function noteFrom(text, opts = {}) {
  return note(opts.title || 'RIMURU', text, {
    color: opts.color,
    icon: opts.icon,
    html: opts.html === true, // trusted HTML → keep <b>/<code>/<a>
  });
}

/**
 * Send a text message wrapped in the blockquote note (EVERY bot message).
 * opts: { title, color, icon, html, reply_to_message_id, reply_markup, ... }
 *   - opts.html === true → body is TRUSTED HTML (kept as-is).
 *   - otherwise           → body is plain text, escaped automatically.
 * parse_mode is always 'HTML'. A parse error retries once as PLAIN text.
 */
async function sendText(bot, chatId, text, opts = {}) {
  const out = noteFrom(text, opts);
  const sendOpts = gatedOpts({ ...opts, parse_mode: 'HTML' });
  try {
    return await bot.sendMessage(chatId, out, sendOpts);
  } catch (e) {
    console.warn('[send] fallback (plain):', e.message);
    try {
      const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`[\]]/g, '');
      return await bot.sendMessage(chatId, plain, { ...sendOpts, parse_mode: undefined });
    } catch (e2) {
      console.error('[send] failed:', e2.message);
      return null;
    }
  }
}

/**
 * Edit an existing message, keeping the blockquote-note style.
 * Same trusted-HTML rules as sendText. Parse-error → plain-text retry.
 */
async function editText(bot, chatId, messageId, text, opts = {}) {
  const out = noteFrom(text, opts);
  const sendOpts = gatedOpts({ chat_id: chatId, message_id: messageId, ...opts, parse_mode: 'HTML' });
  try {
    return await bot.editMessageText(out, sendOpts);
  } catch (e) {
    console.warn('[edit] failed:', e.message);
    if (/can't parse entities|parse entities/i.test(e.message)) {
      try {
        const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`[\]]/g, '');
        return await bot.editMessageText(plain, { ...sendOpts, parse_mode: undefined });
      } catch (e2) {
        console.error('[edit] retry failed:', e2.message);
        return null;
      }
    }
    return null;
  }
}

/**
 * Send a message for GAME SESSIONS (mines/blackjack/higher-lower):
 * raw trusted HTML + optional inline keyboard, ALWAYS wrapped in the
 * blockquote note so the margin bar shows on game messages too.
 *
 * opts.html is implied true (callers build HTML themselves); the body is
 * sanitized as a safety net. reply_to_message_id etc. pass through.
 */
async function sendGame(bot, chatId, text, opts = {}) {
  const out = noteFrom(text, { ...opts, html: true });
  const sendOpts = gatedOpts({ ...opts, parse_mode: 'HTML' });
  try {
    return await bot.sendMessage(chatId, out, sendOpts);
  } catch (e) {
    console.warn('[send][game] fallback (plain):', e.message);
    try {
      const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`[\]]/g, '');
      return await bot.sendMessage(chatId, plain, { ...sendOpts, parse_mode: undefined });
    } catch (e2) {
      console.error('[send][game] failed:', e2.message);
      return null;
    }
  }
}

/**
 * Edit a game-session message (same rules as sendGame).
 * Note: the blockquote header/body are built fresh each edit — the bar
 * keeps rendering as the game board updates.
 */
async function editGame(bot, chatId, messageId, text, opts = {}) {
  const out = noteFrom(text, { ...opts, html: true });
  const sendOpts = gatedOpts({ chat_id: chatId, message_id: messageId, ...opts, parse_mode: 'HTML' });
  try {
    return await bot.editMessageText(out, sendOpts);
  } catch (e) {
    console.warn('[edit][game] failed:', e.message);
    if (/can't parse entities|parse entities/i.test(e.message)) {
      try {
        const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`[\]]/g, '');
        return await bot.editMessageText(plain, { ...sendOpts, parse_mode: undefined });
      } catch (e2) {
        console.error('[edit][game] retry failed:', e2.message);
        return null;
      }
    }
    return null;
  }
}

/**
 * Gate an INLINE keyboard behind SHOW_INLINE_BUTTONS.
 * Returns the inline reply_markup if buttons are enabled, else undefined.
 * (Inline menu code stays intact — just hidden by default. Toggle in
 * config, no rebuild needed.)
 *
 * NATIVE REPLY keyboards (ReplyKeyboardMarkup — the grid above the phone
 * keyboard) are NEVER gated: they carry a `keyboard` array and are the
 * primary navigation system, so they always pass through.
 */
function inlineMarkup(markup) {
  if (!markup) return undefined;
  // ReplyKeyboardMarkup / ReplyKeyboardRemove / ForceReply pass through.
  if (markup.keyboard || markup.remove_keyboard || markup.force_reply) return markup;
  // InlineKeyboardMarkup is gated.
  if (config.showInlineButtons !== true) return undefined;
  return markup;
}

/**
 * Strip reply_markup unless it is (a) a native reply keyboard, or
 * (b) an inline keyboard AND SHOW_INLINE_BUTTONS=true, or
 * (c) marked alwaysShowMarkup (gameplay grids like mines/race must ALWAYS
 *     show — they are unplayable without their buttons).
 */
function gatedOpts(opts) {
  const o = { ...opts };
  if (o.reply_markup) {
    if (o.alwaysShowMarkup === true) {
      // Gameplay-critical grid (mines 5×5, race colors, ...) — keep.
      delete o.alwaysShowMarkup;
    } else {
      o.reply_markup = inlineMarkup(o.reply_markup);
    }
  }
  return o;
}

/**
 * Send a sticker, but ONLY AFTER a text message has been sent.
 * Call AFTER sendText/sendGame resolves. Never throws.
 *   - stickerAfter(bot, chatId, sentTextPromise, stickerPromise)
 *   - stickerAfter(bot, chatId, null, stickerPromise) → sticker only
 */
async function stickerAfter(bot, chatId, textPromise, stickerPromise) {
  try {
    if (textPromise) await textPromise; // text first, sticker second
  } catch (e) {
    /* text failed — still try the sticker */
  }
  try {
    if (stickerPromise) await stickerPromise;
  } catch (e) {
    console.warn('[sticker] failed:', e.message);
  }
  return null;
}

/**
 * Raw low-level send (NO blockquote wrapper, NO parse_mode unless asked).
 * Used ONLY for Telegram-native objects (sendDice, sendSticker, etc.).
 */
function rawSend(bot, method, chatId, payload = {}) {
  return bot[method](chatId, payload);
}

module.exports = {
  sendText,
  editText,
  sendGame,
  editGame,
  inlineMarkup,
  gatedOpts,
  stickerAfter,
  rawSend,
  sanitizeHtml,
  esc,
};