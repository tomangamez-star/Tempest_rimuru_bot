'use strict';
/**
 * Rimuru Tempest Casino — main bot router.
 * Wires node-telegram-bot-api to every module. Handles commands, inline
 * callbacks, penalties (ban/sus/mute), the "Rimuru" AI trigger, reply-to-bot
 * conversations, owner emoji reactions, sticker sending, the persistent
 * command menu (setMyCommands) and the multi-level inline menu system.
 *
 * UI: every message is a "notebook note" — vibrant Rimuru blue/cyan + gold
 * with a vertical red margin line on the LEFT edge (HTML blockquote).
 */
const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const db = require('./db');
const eco = require('./economy');
const cd = require('./cooldowns');
const admin = require('./admin');
const leaderboard = require('./leaderboard');
const rimuru = require('./rimuru');
const income = require('./income');
const { fmt, humanDuration, note, THEME, sanitizeHtml } = require('./utils');

const slots = require('./games/slots');
const dice = require('./games/dice');
const coinflip = require('./games/coinflip');
const mines = require('./games/mines');
const blackjack = require('./games/blackjack');
const roulette = require('./games/roulette');
const higherlower = require('./games/higherlower');
const lottery = require('./games/lottery');
const robbery = require('./crimes/robbery');
const heist = require('./crimes/heist');

// In-memory heist timers (leaderId -> timeout)
const heistTimers = new Map();

// Owner emoji reaction keywords (config.reactions)
const REACT_KEYS = Object.keys(config.reactions).filter((k) => k !== 'fallback');

function createBot() {
  const bot = new TelegramBot(config.telegramToken, {
    polling: true,
    onlyFirstMatch: false,
    filepath: false,
  });

  /* ---------- helpers ---------- */

  function metaOf(msg) {
    const from = msg.from || {};
    return { username: from.username || '', first_name: from.first_name || '' };
  }

  function isOwner(userId) {
    return String(userId) === String(config.ownerId);
  }

  /**
   * Reply wrapper — auto-wraps in notebook-note style (HTML) unless `raw`.
   * opts: { title, color, icon, raw, html, parse_mode, reply_markup, ... }
   */
  async function reply(chatId, text, opts = {}) {
    let out = text;
    let parseMode = opts.parse_mode;
    if (!opts.raw) {
      out = note(opts.title || 'RIMURU', text, {
        color: opts.color,
        icon: opts.icon,
        html: opts.html === true,
      });
      parseMode = 'HTML';
    } else if (parseMode === 'HTML') {
      // Raw HTML still gets the safety net — strip unsupported tags.
      out = sanitizeHtml(out);
    }
    try {
      return await bot.sendMessage(chatId, out, { ...opts, parse_mode: parseMode });
    } catch (e) {
      console.warn('[reply] fallback (plain):', e.message);
      try {
        // Strip ALL tags + markdown so plain text can never fail to parse.
        const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`\[\]]/g, '');
        return await bot.sendMessage(chatId, plain, { ...opts, parse_mode: undefined });
      } catch (e2) {
        console.error('[reply] failed:', e2.message);
        return null;
      }
    }
  }

  /** Edit wrapper — same note-style rules as reply(). */
  async function editMsg(chatId, messageId, text, opts = {}) {
    let out = text;
    let parseMode = opts.parse_mode;
    if (!opts.raw) {
      out = note(opts.title || 'RIMURU', text, {
        color: opts.color,
        icon: opts.icon,
        html: opts.html === true,
      });
      parseMode = 'HTML';
    } else if (parseMode === 'HTML') {
      out = sanitizeHtml(out);
    }
    try {
      return await bot.editMessageText(out, { chat_id: chatId, message_id: messageId, ...opts, parse_mode: parseMode });
    } catch (e) {
      console.warn('[edit] failed:', e.message);
      // Parse-error rescue: retry once with plain text (no parse_mode).
      if (/can't parse entities|parse entities/i.test(e.message)) {
        try {
          const plain = String(text).replace(/<[^>]*>/g, '').replace(/[*_`\[\]]/g, '');
          return await bot.editMessageText(plain, { chat_id: chatId, message_id: messageId, ...opts, parse_mode: undefined });
        } catch (e2) {
          console.error('[edit] retry failed:', e2.message);
          return null;
        }
      }
      return null;
    }
  }

  /** Threaded reply (replies to a specific message — used by the menu). */
  async function replyThreaded(chatId, messageId, text, opts = {}) {
    return reply(chatId, text, { ...opts, reply_to_message_id: messageId });
  }

  function buildCtx(msg, args = []) {
    const from = msg.from || {};
    return {
      bot,
      msg,
      args,
      chatId: msg.chat.id,
      userId: from.id,
      isOwner: isOwner(from.id),
      eco,
      cd,
      config,
      db,
      reply: (t, o) => reply(msg.chat.id, t, o),
      editMsg: (chatId, messageId, t, o) => editMsg(chatId, messageId, t, o),
      answerCb: (text) => bot.answerCallbackQuery(text && text.query_id ? text.query_id : undefined, text && text.text ? { text: text.text } : {}).catch(() => {}),
    };
  }

  /** Parse "/cmd arg1 arg2" from message text. */
  function parseCommand(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return null;
    const parts = t.slice(1).split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return { cmd, args: parts.slice(1) };
  }

  /** Resolve a replied-to user (for /rob, /heist, /donate, /transfer). */
  function repliedUser(msg) {
    const r = msg.reply_to_message;
    if (!r || !r.from) return null;
    return r.from;
  }

  /* ---------- penalty gating ---------- */

  function canInteract(userId, gambling = true) {
    return admin.checkInteract(userId, { gambling });
  }

  /* ---------- stickers (Rimuru vibe) ---------- */

  let stickerCache = null;
  let stickerDisabled = false;

  /** Send a random sticker from the configured pack. Graceful if unset/fails. */
  async function maybeSendSticker(chatId) {
    if (!config.stickerPack || stickerDisabled) return;
    try {
      if (!stickerCache) {
        const set = await bot.getStickerSet(config.stickerPack);
        stickerCache = (set.stickers || []).map((s) => s.file_id);
      }
      if (!stickerCache.length) {
        stickerDisabled = true;
        return;
      }
      const fileId = stickerCache[Math.floor(Math.random() * stickerCache.length)];
      await bot.sendSticker(chatId, fileId);
    } catch (e) {
      console.warn(`[sticker] pack "${config.stickerPack}" unavailable — stickers disabled:`, e.message);
      stickerDisabled = true;
    }
  }

  /* ---------- owner smart reactions ---------- */

  function reactionFor(text) {
    const t = String(text || '').toLowerCase();
    for (const key of REACT_KEYS) {
      if (t.includes(key)) return config.reactions[key];
    }
    return THEME.acc.slime; // 🐉 default vibe
  }

  async function maybeReact(msg) {
    if (!msg.from || msg.from.is_bot) return;
    if (!isOwner(msg.from.id)) return; // owner only
    const text = String(msg.text || msg.caption || '');
    if (!text || text.startsWith('/')) return; // skip commands
    try {
      await bot.setMessageReaction(msg.chat.id, msg.message_id, {
        reaction: [{ type: 'emoji', emoji: reactionFor(text) }],
      });
    } catch (e) {
      /* reactions are best-effort */
    }
  }

  /* ---------- inline menu system ---------- */

  const MENU = {
    main: () => ({
      text:
        `🐉 <b>RIMURU'S CASINO</b>\n\n` +
        `✨ Welcome to the Tempest house, mortal.\n` +
        `👑 The house always wins — but I'll let you play.\n\n` +
        `👇 <i>Pick your poison:</i>`,
      markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboard', callback_data: 'menu:lb' },
            { text: '💰 Balance', callback_data: 'menu:bal' },
          ],
          [
            { text: '🎰 Casino', callback_data: 'menu:casino' },
            { text: '🎮 Games', callback_data: 'menu:games' },
          ],
          [
            { text: '💼 Economy', callback_data: 'menu:economy' },
            { text: '❓ Help', callback_data: 'menu:help' },
          ],
        ],
      },
    }),

    casino: () => ({
      text:
        `🎰 <b>CASINO — the big tables</b>\n\n` +
        `♠️ <b>Blackjack</b> — /bj [amount] · 3:2 on blackjack\n` +
        `🎡 <b>Roulette</b> — /roulette [type] [amount] · up to 36×\n` +
        `🍒 <b>Slots</b> — /slots [amount] · 2× / 4×\n` +
        `🎟️ <b>Lottery</b> — /lottery buy · pot of 5,000,000+ 🤑\n\n` +
        `👇 <i>Tap a game for details, or just type the command.</i>`,
      markup: {
        inline_keyboard: [
          [
            { text: '♠️ Blackjack', callback_data: 'menu:g:bj' },
            { text: '🎡 Roulette', callback_data: 'menu:g:roulette' },
          ],
          [
            { text: '🍒 Slots', callback_data: 'menu:g:slots' },
            { text: '🎟️ Lottery', callback_data: 'menu:g:lottery' },
          ],
          [{ text: '⬅️ Back', callback_data: 'menu:main' }],
        ],
      },
    }),

    games: () => ({
      text:
        `🎮 <b>GAMES — quick & light</b>\n\n` +
        `🪙 <b>Coin Flip</b> — /cf [heads|tails] [amount] · 2×\n` +
        `💎 <b>Mines</b> — /mines [amount] · 5×5, multiplier climbs\n` +
        `🎲 <b>Dice</b> — /dice [1-6] [amount] · 6× if you hit\n` +
        `🃏 <b>Higher or Lower</b> — /hl [amount] · streak multiplier\n\n` +
        `👇 <i>Tap a game for details, or just type the command.</i>`,
      markup: {
        inline_keyboard: [
          [
            { text: '🪙 Coin Flip', callback_data: 'menu:g:cf' },
            { text: '💎 Mines', callback_data: 'menu:g:mines' },
          ],
          [
            { text: '🎲 Dice', callback_data: 'menu:g:dice' },
            { text: '🃏 Higher/Lower', callback_data: 'menu:g:hl' },
          ],
          [{ text: '⬅️ Back', callback_data: 'menu:main' }],
        ],
      },
    }),

    economy: () => ({
      text:
        `💼 <b>ECONOMY</b>\n\n` +
        `👛 Wallet (rob-able) vs 🏦 Bank (safe).\n` +
        `💰 Keep your loot in the bank, mortal.\n\n` +
        `✨ <i>More tools coming soon…</i>`,
      markup: {
        inline_keyboard: [
          [
            { text: '🏦 Deposit All', callback_data: 'menu:eco:depAll' },
            { text: '🏦 Deposit 100k', callback_data: 'menu:eco:dep100k' },
          ],
          [
            { text: '👛 Withdraw All', callback_data: 'menu:eco:wdAll' },
            { text: '👛 Withdraw 100k', callback_data: 'menu:eco:wd100k' },
          ],
          [{ text: '⬅️ Back', callback_data: 'menu:main' }],
        ],
      },
    }),
  };

  const GAME_USAGE = {
    bj: '♠️ <b>Blackjack</b>\n<code>/bj [amount]</code>\nHit / Stand / Double. Dealer stands on 17+. Blackjack pays 3:2. 💪',
    roulette: '🎡 <b>Roulette</b>\n<code>/roulette color red 5000</code>\nred|black 2× · even|odd 2× · low|high 2× · dozen 3× · column 3× · straight 36× · split 18×',
    slots: '🍒 <b>Slots</b>\n<code>/slots [amount]</code>\n3 reels — 2 match = 2×, 3 match = 4×. 🎰',
    lottery: '🎟️ <b>Lottery</b>\n<code>/lottery buy [tickets]</code>\nTicket = 10,000 coins. 5 buyers = draw. Pot grows with every ticket! 🤑',
    cf: '🪙 <b>Coin Flip</b>\n<code>/cf [heads|tails] [amount]</code>\nWin = double. 🍀',
    mines: '💎 <b>Mines</b>\n<code>/mines [amount]</code>\n5×5 grid, 3 mines. Safe pick = multiplier climbs. Cash out anytime. 💣',
    dice: '🎲 <b>Dice</b>\n<code>/dice [1-6] [amount]</code>\nAnimated dice — hit your number = 6×. Rare, but sweet. 😎',
    hl: '🃏 <b>Higher or Lower</b>\n<code>/hl [amount]</code>\nGuess the next card. Streak multiplier climbs, cash out anytime. 🔥',
  };

  /** Build a menu message (text + markup) and send it. */
  async function sendMenu(chatId, page = 'main', opts = {}) {
    const m = MENU[page]();
    const text = note('📜 RIMURU MENU', m.text, { color: THEME.gold, icon: '📜', html: true });
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: m.markup, ...opts });
  }

  /** Edit an existing menu message to a different page. */
  async function editMenu(chatId, messageId, page = 'main') {
    const m = MENU[page]();
    const text = note('📜 RIMURU MENU', m.text, { color: THEME.gold, icon: '📜', html: true });
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: m.markup }).catch((e) => {
      console.warn('[menu] edit failed:', e.message);
      return null;
    });
  }

  /* ---------- command handlers ---------- */

  const handlers = {
    start: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `Welcome, ${u.first_name || 'mortal'}. The house always wins — but I'll let you play.\n` +
        `You start with <b>${fmt(config.startBalance)}</b> coins. 💰\n\n` +
        `🎮 Games: /slots · /dice · /cf · /mines · /bj · /roulette · /hl · /lottery\n` +
        `💼 Economy: /balance · /dep · /wd · /donate · /transfer\n` +
        `🦹 Crime: /rob · /heist\n` +
        `💵 Income: /beg · /work · /fish · /dig · /daily · /bonus\n` +
        `🏆 /lb — rich list · 📜 /menu — command menu\n\n` +
        `🗨️ <i>Reply to me or say "Rimuru" to talk directly.</i>`,
        { title: '🐉 RIMURU TEMPEST CASINO', color: THEME.blue }
      );
    },

    menu: async (ctx) => sendMenu(ctx.chatId),

    casino: async (ctx) => {
      await ctx.reply(MENU.casino().text, { title: '🎰 CASINO', color: THEME.cyan, html: true, reply_markup: MENU.casino().markup });
    },
    games: async (ctx) => {
      await ctx.reply(MENU.games().text, { title: '🎮 GAMES', color: THEME.cyan, html: true, reply_markup: MENU.games().markup });
    },
    economy: async (ctx) => {
      await ctx.reply(MENU.economy().text, { title: '💼 ECONOMY', color: THEME.cyan, html: true, reply_markup: MENU.economy().markup });
    },

    help: async (ctx) => {
      await ctx.reply(
        `<b>🎮 Games</b> (per-game cooldown)\n` +
        `• /slots [amt] — 3 reels, 2×/4×\n` +
        `• /dice [1-6] [amt] — animated dice, 6×\n` +
        `• /cf [heads|tails] [amt] — 2×\n` +
        `• /mines [amt] — 5×5 minefield, cash out anytime\n` +
        `• /bj [amt] — blackjack, 3:2 on blackjack\n` +
        `• /roulette [color|even|odd|low|high|dozen|column|straight|split] [amt]\n` +
        `• /hl [amt] — higher or lower, streak multiplier\n` +
        `• /lottery [buy|draw|status] [n] — tickets 10k, 5 buyers = draw\n\n` +
        `<b>💼 Economy</b>\n` +
        `• /balance — wallet + bank\n` +
        `• /dep [amt|all] — wallet → bank\n` +
        `• /wd [amt|all] — bank → wallet\n` +
        `• /donate [amt] (reply) — from wallet\n` +
        `• /transfer [amt] (reply) — from bank\n\n` +
        `<b>🦹 Crime</b>\n` +
        `• /rob (reply) — 10 min cooldown, fail = fine\n` +
        `• /heist (reply) — 20 min, open 60s for /join, max 5 crew\n` +
        `• /join — join an open heist\n\n` +
        `<b>💵 Income</b>\n` +
        `• /beg · /work · /fish · /dig — quick coins\n` +
        `• /daily — 24h · /bonus — weekly\n\n` +
        `<b>🏆 /lb</b> — top 10 richest\n` +
        `<b>📜 /menu</b> — interactive menu\n` +
        `🗨️ <i>Reply to me or say "Rimuru" to talk.</i>`,
        { title: '❓ RIMURU HELP', color: THEME.gold }
      );
    },

    balance: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `👛 Wallet (rob-able): <b>${fmt(u.wallet)}</b>\n` +
        `🏦 Bank (safe): <b>${fmt(u.bank)}</b>\n` +
        `💎 Net worth: <b>${fmt(u.wallet + u.bank)}</b>`,
        { title: `💰 ${u.first_name || 'YOUR'} BALANCE`, color: THEME.gold }
      );
    },

    dep: async (ctx) => {
      const r = eco.deposit(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { title: '🏦 DEPOSIT', color: THEME.cyan });
    },
    deposit: async (ctx) => {
      const r = eco.deposit(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { title: '🏦 DEPOSIT', color: THEME.cyan });
    },
    wd: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { title: '👛 WITHDRAW', color: THEME.cyan });
    },
    withdraw: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { title: '👛 WITHDRAW', color: THEME.cyan });
    },

    donate: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/donate [amount]</code>. 🎯', { title: '💝 DONATE', color: THEME.cyan });
      const r = eco.donate(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { title: '💝 DONATE', color: THEME.cyan, html: true });
    },
    transfer: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/transfer [amount]</code>. 🎯', { title: '🏦 TRANSFER', color: THEME.cyan });
      const r = eco.transfer(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { title: '🏦 TRANSFER', color: THEME.cyan, html: true });
    },

    // ----- games -----
    slots: async (ctx) => slots.play(ctx),
    dice: async (ctx) => dice.play(ctx),
    cf: async (ctx) => coinflip.play(ctx),
    coinflip: async (ctx) => coinflip.play(ctx),
    mines: async (ctx) => mines.play(ctx),
    bj: async (ctx) => blackjack.play(ctx),
    blackjack: async (ctx) => blackjack.play(ctx),
    roulette: async (ctx) => roulette.play(ctx),
    hl: async (ctx) => higherlower.play(ctx),
    higherlower: async (ctx) => higherlower.play(ctx),

    lottery: async (ctx) => {
      const sub = (ctx.args[0] || 'status').toLowerCase();
      if (sub === 'buy') {
        const r = lottery.buy(ctx.userId, ctx.args[1] || 1, metaOf(ctx.msg));
        if (r.ok && r.buyers >= config.lottery.minBuyers) {
          // Enough buyers — run the draw right away
          const d = lottery.draw();
          await ctx.reply(`${r.message}\n\n${d.message}`, { title: '🎟️ LOTTERY', color: THEME.gold, html: true });
        } else {
          await ctx.reply(r.message, { title: '🎟️ LOTTERY', color: THEME.gold });
        }
        return;
      }
      if (sub === 'draw') {
        const d = lottery.draw();
        await ctx.reply(d.message, { title: '🎟️ LOTTERY DRAW', color: THEME.gold, html: true });
        return;
      }
      await ctx.reply(lottery.status(), { title: '🎟️ LOTTERY', color: THEME.gold });
    },

    // ----- crimes -----
    rob: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/rob</code>. 🎯', { title: '🦹 ROBBERY', color: THEME.red });
      const g = cd.guard(ctx.userId, 'rob', 'Robbery');
      if (g.blocked) return ctx.reply(g.message, { title: '🦹 ROBBERY', color: THEME.red });
      const r = robbery.attempt(ctx.userId, target.id, metaOf(ctx.msg));
      if (r.ok) cd.start(ctx.userId, 'rob', config.cooldowns.rob);
      await ctx.reply(r.message, { title: '🦹 ROBBERY', color: THEME.red });
    },

    heist: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/heist</code>. 🎯', { title: '🏦 HEIST', color: THEME.red });
      const g = cd.guard(ctx.userId, 'heist', 'Heist');
      if (g.blocked) return ctx.reply(g.message, { title: '🏦 HEIST', color: THEME.red });
      const r = heist.start(ctx.userId, target.id, metaOf(ctx.msg));
      if (r.ok) {
        cd.start(ctx.userId, 'heist', config.cooldowns.heist);
        scheduleHeist(ctx, r.heist);
      }
      await ctx.reply(r.message, { title: '🏦 HEIST', color: THEME.red });
    },

    join: async (ctx) => {
      const r = heist.join(ctx.userId, metaOf(ctx.msg));
      if (r.ok && r.message) {
        const open = db.db.prepare("SELECT * FROM heists WHERE status = 'open'").all();
        const fullCrew = open.some((o) => JSON.parse(o.members).length >= config.heist.maxMembers);
        await ctx.reply(r.message, { title: '🤝 JOIN HEIST', color: THEME.red });
        if (fullCrew) {
          const full = open.find((o) => JSON.parse(o.members).length >= config.heist.maxMembers);
          if (full) {
            const res = heist.execute(full.leader_id);
            const timer = heistTimers.get(full.leader_id);
            if (timer) clearTimeout(timer);
            heistTimers.delete(full.leader_id);
            await ctx.reply(res.message, { title: '🏦 HEIST RESULT', color: THEME.red, html: true });
          }
        }
      } else {
        await ctx.reply(r.message, { title: '🤝 JOIN HEIST', color: THEME.red });
      }
    },

    // ----- income -----
    beg: async (ctx) => { const r = income.earn(ctx.userId, 'beg', metaOf(ctx.msg)); await ctx.reply(r.message, { title: '🙏 BEG', color: THEME.cyan }); },
    work: async (ctx) => { const r = income.earn(ctx.userId, 'work', metaOf(ctx.msg)); await ctx.reply(r.message, { title: '💼 WORK', color: THEME.cyan }); },
    fish: async (ctx) => { const r = income.earn(ctx.userId, 'fish', metaOf(ctx.msg)); await ctx.reply(r.message, { title: '🎣 FISH', color: THEME.cyan }); },
    dig: async (ctx) => { const r = income.earn(ctx.userId, 'dig', metaOf(ctx.msg)); await ctx.reply(r.message, { title: '⛏️ DIG', color: THEME.cyan }); },
    daily: async (ctx) => { const r = income.daily(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { title: '📅 DAILY', color: THEME.gold }); },
    bonus: async (ctx) => { const r = income.bonus(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { title: '🎁 BONUS', color: THEME.gold }); },

    // ----- leaderboard -----
    lb: async (ctx) => { await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true }); },
    leaderboard: async (ctx) => { await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true }); },

    // ----- admin (owner only) -----
    ban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/ban [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.BANNED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — BAN', color: THEME.red });
    },
    sus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/sus [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.SUSPECTED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — SUSPEND', color: THEME.red });
    },
    mute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/mute [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.MUTED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — MUTE', color: THEME.red });
    },
    unban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unban</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNBAN', color: THEME.cyan });
    },
    unsus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unsus</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNSUSPEND', color: THEME.cyan });
    },
    unmute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unmute</code>. 🎯', { title: '👑 ADMIN', color: THEME.red });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNMUTE', color: THEME.cyan });
    },
  };

  /** Split "/ban 2h spamming" → { dur: '2h', reason: 'spamming' } */
  function splitDurReason(args) {
    if (!args.length) return { dur: null, reason: '' };
    if (admin.parseDuration(args[0])) {
      return { dur: args[0], reason: args.slice(1).join(' ') };
    }
    return { dur: null, reason: args.join(' ') };
  }

  /** Schedule heist execution after the 60s open window. */
  function scheduleHeist(ctx, heistRow) {
    const timer = heistTimers.get(heistRow.leader_id);
    if (timer) clearTimeout(timer);
    const t = setTimeout(async () => {
      const h = db.getHeist(heistRow.leader_id);
      if (h && h.status === 'open') {
        const res = heist.execute(heistRow.leader_id);
        await reply(
          ctx.msg.chat.id,
          `⏰ <b>The heist window closed.</b>\n\n${res.message}`,
          { title: '🏦 HEIST RESULT', color: THEME.red, html: true }
        );
      }
      heistTimers.delete(heistRow.leader_id);
    }, config.heist.openWindowMs);
    heistTimers.set(heistRow.leader_id, t);
  }

  /* ---------- callback routing ---------- */

  async function onCallbackQuery(query) {
    const data = String(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const from = query.from || {};
    const userId = from.id;
    const ctx = buildCtx(query.message || { chat: { id: chatId }, from }, []);

    const answerCb = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
    // Bound partial for game modules: editMsg(text, opts) → edits THIS message
    const editMsgCb = (text, opts = {}) => editMsg(chatId, messageId, text, opts);

    // Penalty gate on all callbacks
    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply) await answerCb(check.reply);
      return;
    }

    try {
      /* ----- menu system ----- */
      if (data.startsWith('menu:')) {
        const parts = data.split(':');
        const page = parts[1];

        // Navigate pages (edit the menu message in place)
        if (page === 'main' || page === 'casino' || page === 'games' || page === 'economy') {
          await editMenu(chatId, messageId, page);
          await answerCb('');
          return;
        }

        // Threaded replies under the menu message
        if (page === 'lb') {
          await replyThreaded(chatId, messageId, leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true });
          await answerCb('');
          return;
        }
        if (page === 'bal') {
          const u = eco.ensure(userId, { first_name: from.first_name || '', username: from.username || '' });
          await replyThreaded(chatId, messageId,
            `👛 Wallet: <b>${fmt(u.wallet)}</b> · 🏦 Bank: <b>${fmt(u.bank)}</b> · 💎 Net: <b>${fmt(u.wallet + u.bank)}</b>`,
            { title: '💰 BALANCE', color: THEME.gold, html: true });
          await answerCb('');
          return;
        }
        if (page === 'help') {
          await replyThreaded(chatId, messageId,
            `<b>🎮 Games</b>: /slots · /dice · /cf · /mines · /bj · /roulette · /hl · /lottery\n` +
            `<b>💼 Economy</b>: /balance · /dep · /wd · /donate · /transfer\n` +
            `<b>🦹 Crime</b>: /rob · /heist · /join\n` +
            `<b>💵 Income</b>: /beg · /work · /fish · /dig · /daily · /bonus\n` +
            `<b>🏆</b> /lb · <b>📜</b> /menu\n` +
            `🗨️ <i>Reply to me or say "Rimuru" to talk.</i>`,
            { title: '❓ HELP', color: THEME.gold, html: true });
          await answerCb('');
          return;
        }

        // Game detail from a menu sub-page
        if (page === 'g' && parts[2] && GAME_USAGE[parts[2]]) {
          await replyThreaded(chatId, messageId, GAME_USAGE[parts[2]], { title: '🎮 GAME', color: THEME.cyan, html: true });
          await answerCb('');
          return;
        }

        // Economy quick actions
        if (page === 'eco') {
          const action = parts[2];
          let r;
          if (action === 'depAll') r = eco.deposit(userId, 'all');
          else if (action === 'dep100k') r = eco.deposit(userId, '100000');
          else if (action === 'wdAll') r = eco.withdraw(userId, 'all');
          else if (action === 'wd100k') r = eco.withdraw(userId, '100000');
          if (r) {
            await replyThreaded(chatId, messageId, r.message, { title: '💼 ECONOMY', color: THEME.cyan });
          }
          await answerCb('');
          return;
        }

        await answerCb('Unknown button.');
        return;
      }

      /* ----- game callbacks ----- */
      if (data.startsWith('mines:')) {
        const parts = data.split(':');
        const action = parts[2];
        if (action === 'pick') await mines.onPick({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        if (action === 'cash') await mines.onCash({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('bj:')) {
        await blackjack.onAction({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('hl:')) {
        await higherlower.onAction({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      await answerCb('Unknown button.');
    } catch (e) {
      console.error('[callback] error:', e.message);
      await answerCb('Something went wrong.');
    }
  }

  /* ---------- message routing ---------- */

  async function onMessage(msg) {
    // Ignore non-user messages (channel posts, etc.)
    if (!msg.from || msg.from.is_bot) return;
    const text = String(msg.text || msg.caption || '');
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const ctx = buildCtx(msg, []);

    // Expire temporary penalties periodically (cheap)
    db.expirePenalties();

    // Penalty gate for ANY interaction
    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply && text.startsWith('/')) await reply(chatId, check.reply, { title: '⛔ BLOCKED', color: THEME.red });
      return;
    }

    // Owner smart reactions (emoji react, no command needed)
    await maybeReact(msg);

    // Command routing (commands win over chat triggers)
    const parsed = parseCommand(text);
    if (parsed) {
      const { cmd, args } = parsed;
      const handler = handlers[cmd];
      if (handler) {
        ctx.args = args;
        try {
          await handler(ctx);
        } catch (e) {
          console.error(`[cmd /${cmd}] error:`, e.message, e.stack);
          await reply(chatId, `⚠️ Something went wrong with /${cmd}. Try again.`, { title: '💥 ERROR', color: THEME.red });
        }
        return;
      }
    }

    // Rimuru AI triggers:
    //  1) message contains "rimuru" (no command needed)
    //  2) message REPLIES to one of the bot's own messages (direct chat)
    const isReplyToBot = msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot === true;
    if (rimuru.shouldTrigger(text) || isReplyToBot) {
      const from = msg.from;
      const owner = isOwner(userId);
      const name = from.first_name || from.username || 'mortal';
      try {
        await maybeSendSticker(chatId);
        const ans = await rimuru.reply(text, { id: userId, first_name: name, username: from.username, isOwner: owner });
        await reply(chatId, ans, { title: '🐉 RIMURU', color: THEME.gold });
      } catch (e) {
        console.error('[rimuru] reply error:', e.message);
        await reply(chatId, 'Hmph. The void ate my words. Try again, mortal.', { title: '🐉 RIMURU', color: THEME.gold });
      }
      return;
    }
  }

  /* ---------- boot: persistent command menu + bot identity ---------- */

  let botMeId = null;
  bot.getMe().then((me) => {
    botMeId = me.id;
    return bot.setMyCommands([
      { command: 'leaderboard', description: '🏆 Leaderboard' },
      { command: 'balance', description: '💰 Balance' },
      { command: 'casino', description: '🎰 Casino' },
      { command: 'games', description: '🎮 Games' },
      { command: 'economy', description: '💼 Economy' },
      { command: 'help', description: '❓ Help' },
    ]);
  }).then(() => {
    console.log('📜 Persistent command menu registered (setMyCommands).');
  }).catch((e) => {
    console.warn('[boot] getMe/setMyCommands failed:', e.message);
  });

  bot.on('message', onMessage);
  bot.on('callback_query', onCallbackQuery);

  // Periodic: expire penalties (every 30s)
  setInterval(() => {
    const expired = db.expirePenalties();
    for (const u of expired) {
      console.log(`[admin] ${u.status} expired for user ${u.user_id}`);
    }
  }, 30000);

  bot.on('polling_error', (err) => {
    console.error('[polling] error:', err.message);
  });

  return bot;
}

module.exports = { createBot };