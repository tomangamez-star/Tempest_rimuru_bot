'use strict';
/**
 * Rimuru Tempest Casino — Telegram bot core.
 * Creates the bot instance, registers all command handlers, callback
 * routing, message routing, Rimuru AI integration, and periodic tasks.
 */
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const db = require('./db');
const keyboards = require('./keyboards');
const send = require('./send');
const eco = require('./economy');
const cd = require('./cooldowns');
const admin = require('./admin');
const leaderboard = require('./leaderboard');
const profile = require('./profile');
const rank = require('./rank');
const timewallet = require('./timewallet');
const income = require('./income');
const fishing = require('./fish');
const shop = require('./shop');
const crime = require('./crimes/crime');
const robbery = require('./crimes/robbery');
const heist = require('./crimes/heist');
const lottery = require('./lottery');
const missions = require('./missions');
const attack = require('./attack');
const fbi = require('./fbi');
const waifu = require('./waifu');
const hunt = require('./hunt');
const rimuru = require('./rimuru');
const memory = require('./memory');
const broadcastMod = require('./broadcast');
const dashboard = require('./dashboard/server');

// Games
const slots = require('./games/slots');
const dice = require('./games/dice');
const coinflip = require('./games/coinflip');
const mines = require('./games/mines');
const blackjack = require('./games/blackjack');
const roulette = require('./games/roulette');
const higherlower = require('./games/higherlower');
const guess = require('./games/guess');
const race = require('./games/race');
const crash = require('./games/crash');
const wheel = require('./games/wheel');
const rps = require('./games/rps');
const tictactoe = require('./games/tictactoe');
const dicevs = require('./games/dicevs');
const cfstreak = require('./games/cfstreak');
const numroulette = require('./games/numroulette');

const THEME = { blue: '#2196F3', cyan: '#00BCD4', gold: '#FFB300', red: '#F44336', green: '#4CAF50', purple: '#9C27B0' };

let commitHash = 'unknown';
try { commitHash = require('child_process').execSync('git rev-parse --short HEAD 2>/dev/null || echo unknown').toString().trim(); } catch (e) {}

let lastError = null;
let stickerCache = null;
let stickerDisabled = false;
let membershipCache = new Map();
let heistTimers = new Map();
let depsPhoto = null;

const GAME_USAGE = {
  slots: '<b>/slots [amount]</b> — 3 reels, 2 match = 2x, 3 match = 4x',
  dice: '<b>/dice [1-6] [amount]</b> — animated dice, pick a number, hit = 6x',
  cf: '<b>/cf [heads|tails] [amount]</b> — coin flip, 2x',
  mines: '<b>/mines [amount]</b> — 5x5 grid, 4 mines (1 hidden), mines MOVE after each safe pick, +25% per pick',
  bj: '<b>/bj [amount]</b> — blackjack, 3:2 on blackjack',
  roulette: '<b>/roulette [color|even|odd|low|high|dozen|column|straight|split] [amount]</b>',
  hl: '<b>/hl [amount]</b> — higher or lower, streak multiplier',
  guess: '<b>/guess [amount]</b> — pick 1-10, 3 chances, up to 5x',
  race: '<b>/race [amount]</b> — bet on a car color, 1st=3x, 2nd=1.5x',
  crash: '<b>/crash [amount]</b> — multiplier rocket, cash out before it crashes',
  wheel: '<b>/wheel [amount]</b> — wheel of fortune, 0.5x-10x',
  rps: '<b>/rps [rock|paper|scissors] [amount]</b> — vs the house',
  ttt: '<b>/ttt [amount]</b> — button tic-tac-toe vs the house',
  duel: '<b>/duel [amount]</b> — dice duel, higher roll wins',
  cfs: '<b>/cfs [heads|tails] [amount]</b> — coin flip streak, doubles each win',
  num: '<b>/num [1-10] [amount]</b> — number roulette, up to 9x',
};

const MENU_COMMANDS = [
  { command: 'start', description: 'Welcome to the Tempest house 🐉' },
  { command: 'menu', description: 'Interactive menu 🎮' },
  { command: 'help', description: 'All commands 📖' },
  { command: 'balance', description: 'Your wallet + bank 💰' },
  { command: 'dep', description: 'Wallet → bank 🏦' },
  { command: 'wd', description: 'Bank → wallet 💵' },
  { command: 'lb', description: 'Top 10 richest 🏆' },
  { command: 'p', description: 'Your profile card 🪪' },
  { command: 'rank', description: 'Your rank & progress 🏅' },
  { command: 'hunt', description: 'Start an anime hunt ⚔️' },
  { command: 'char', description: 'Search anime character 🔍' },
  { command: 'clb', description: 'Character leaderboard 🏆' },
  { command: 'health', description: 'Bot health 👌' },
];

function createBot() {
  const bot = new TelegramBot(config.telegramToken, { polling: true });

  // Expose sendPhoto for waifu/hunt view commands
  depsPhoto = (chatId, imageUrl, opts) => bot.sendPhoto(chatId, imageUrl, opts).catch(() => {});

  /* ---------- helpers ---------- */

  function isOwner(userId) { return String(userId) === String(config.ownerId); }

  function isStaff(userId) {
    if (isOwner(userId)) return true;
    try { return db.isAdminUser(userId); } catch (e) { return false; }
  }

  function isAuthorized(userId) {
    if (isOwner(userId)) return true;
    try { return db.isAdminUser(userId); } catch (e) { return false; }
  }

  function metaOf(msg) {
    const from = msg.from || {};
    return { user_id: from.id, username: from.username || '', first_name: from.first_name || '' };
  }

  function repliedUser(msg) {
    if (msg.reply_to_message && msg.reply_to_message.from) {
      return { id: msg.reply_to_message.from.id, username: msg.reply_to_message.from.username };
    }
    return null;
  }

  function parseCommand(text) {
    const t = String(text || '').trim();
    const m = t.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/);
    if (!m) return null;
    return { cmd: m[1].toLowerCase(), args: m[2] ? m[2].trim().split(/\s+/) : [] };
  }

  function buildCtx(msg, args) {
    const from = msg.from || {};
    return {
      msg, userId: from.id, chatId: msg.chat.id, args,
      isOwner: isOwner(from.id),
      reply: (text, opts) => reply(msg.chat.id, text, opts),
    };
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function humanDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m ${s % 60}s`;
  }

  /**
   * Unified reply helper: sends a message with a consistent blockquote
   * style (notebook note) and optional inline keyboard. Every handler
   * goes through this so the bot's voice stays uniform.
   */
  async function reply(chatId, text, opts = {}) {
    const title = opts.title || '';
    const color = opts.color || THEME.blue;
    const html = opts.html !== false;
    const markup = opts.reply_markup || undefined;
    const replyTo = opts.reply_to_message_id || undefined;
    const alwaysShow = opts.alwaysShowMarkup || false;

    // Build the blockquote-style message
    const header = title ? `<b>${title}</b>\n` : '';
    const body = html ? text : text.replace(/<[^>]+>/g, '');
    const full = header + body;

    try {
      await bot.sendMessage(chatId, full, {
        parse_mode: html ? 'HTML' : undefined,
        reply_markup: markup,
        reply_to_message_id: replyTo,
        disable_web_page_preview: true,
      });
    } catch (e) {
      // Fallback: strip HTML and retry
      try {
        await bot.sendMessage(chatId, body, {
          reply_markup: markup,
          reply_to_message_id: replyTo,
        });
      } catch (e2) {
        console.error('[reply] failed:', e2.message);
      }
    }
  }

  /** Edit an existing message (used by game callbacks). */
  async function editMsg(chatId, messageId, text, opts = {}) {
    const title = opts.title || '';
    const color = opts.color || THEME.blue;
    const html = opts.html !== false;
    const markup = opts.reply_markup || undefined;
    const header = title ? `<b>${title}</b>\n` : '';
    const body = html ? text : text.replace(/<[^>]+>/g, '');
    const full = header + body;
    try {
      await bot.editMessageText(full, {
        chat_id: chatId, message_id: messageId,
        parse_mode: html ? 'HTML' : undefined,
        reply_markup: markup,
      });
    } catch (e) {
      if (!e.message.includes('message is not modified')) {
        console.warn('[editMsg] failed:', e.message);
      }
    }
  }

  /** Reply to a menu message as a threaded response (new message, not edit). */
  async function replyThreaded(chatId, messageId, text, opts = {}) {
    await reply(chatId, text, { ...opts, reply_to_message_id: messageId });
  }

  /** Edit the menu message to a new page. */
  async function editMenu(chatId, messageId, page) {
    const menu = MENU[page] ? MENU[page]() : MENU.main();
    await editMsg(chatId, messageId, menu.text, {
      title: menu.title, color: THEME.blue, html: true,
      reply_markup: menu.markup,
    });
  }

  /** Send a fresh menu message. */
  async function sendMenu(chatId) {
    const menu = MENU.main();
    await reply(chatId, menu.text, {
      title: menu.title, color: THEME.blue, html: true,
      reply_markup: menu.markup,
    });
  }

  /**
   * Send a random sticker from the configured pack after the text reply.
   * Waits for the text promise to settle first, then sends the sticker.
   * If the sticker pack is invalid or the API fails, we disable stickers
   * for the rest of this session (no repeated failures).
   */
  async function stickerAfterText(chatId, textPromise) {
    if (stickerDisabled) return;
    if (!config.stickerPack) return;
    try {
      await textPromise;
      if (!stickerCache) {
        const pack = await bot.getStickerSet(config.stickerPack);
        stickerCache = pack.stickers || [];
      }
      if (stickerCache.length > 0) {
        const pick = stickerCache[Math.floor(Math.random() * stickerCache.length)];
        await bot.sendSticker(chatId, pick.file_id);
      }
    } catch (e) {
      stickerDisabled = true;
      console.warn('[sticker] disabled:', e.message);
    }
  }

  /**
   * GROUP MEMBERSHIP GATE: check if a user is a member of the required group.
   * Non-staff users must be members before using games/economy/commands.
   * Results are cached for groupGateCacheMs (default 60s).
   * The /verify button always does a FRESH check (bypasses cache).
   */
  async function checkMembership(userId) {
    if (!config.requiredGroup) return { ok: true };
    const cached = membershipCache.get(userId);
    if (cached && cached.at > Date.now() - config.groupGateCacheMs) {
      return { ok: cached.ok };
    }
    return await checkMembershipFresh(userId);
  }

  async function checkMembershipFresh(userId) {
    if (!config.requiredGroup) return { ok: true };
    try {
      const chatId = await resolveRequiredGroup();
      if (!chatId) return { ok: false, reason: 'group-unresolved' };
      const member = await bot.getChatMember(chatId, userId);
      const ok = member && ['member', 'administrator', 'creator'].includes(member.status);
      membershipCache.set(userId, { ok, at: Date.now() });
      return { ok };
    } catch (e) {
      console.warn('[gate] checkMembership error:', e.message);
      return { ok: false, reason: 'api-error' };
    }
  }

  let resolvedGroupId = null;
  async function resolveRequiredGroup() {
    if (config.requiredGroupId) return config.requiredGroupId;
    if (resolvedGroupId) return resolvedGroupId;
    if (!config.requiredGroup) return null;
    try {
      const chat = await bot.getChat(config.requiredGroup);
      resolvedGroupId = chat.id;
      return chat.id;
    } catch (e) {
      console.warn('[gate] resolveRequiredGroup error:', e.message);
      return null;
    }
  }

  async function gateAllowed(userId) {
    if (!config.requiredGroup) return { ok: true };
    return await checkMembership(userId);
  }

  function gatePrompt(chatId) {
    return {
      text: `🔒 <b>JOIN THE GROUP FIRST</b>\n\nYou must join <b>${config.requiredGroup}</b> and tap <b>Verify</b> before using the bot.\n\n👇 Tap the button below to join, then come back and tap <b>Verify</b>.`,
      opts: {
        title: '🔒 GATE', color: THEME.red, html: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: `📢 Join ${config.requiredGroup}`, url: `https://t.me/${config.requiredGroup.replace('@', '')}` }],
            [{ text: '✅ Verify', callback_data: 'gate:verify' }],
          ],
        },
      },
    };
  }

  async function verifyCommand(ctx) {
    const res = await checkMembershipFresh(ctx.userId);
    if (res.ok) {
      await ctx.reply('✅ <b>VERIFIED!</b>\n\nYou are a member. Everything is unlocked. 🎰', { title: '✅ VERIFIED', color: THEME.gold, html: true });
    } else {
      const p = gatePrompt(ctx.chatId);
      await ctx.reply(p.text, p.opts);
    }
  }

  /**
   * Penalty gate: check if a user is banned/suspected/muted.
   * Banned = blocked entirely. Suspected = blocked entirely.
   * Muted = commands blocked, but can still chat with Rimuru.
   * Returns { allowed, reply } where reply is the message to show.
   */
  function canInteract(userId, isCommand = false) {
    try {
      const status = db.getUserStatus(userId);
      if (!status) return { allowed: true };
      if (status.status === 'banned') {
        return { allowed: false, reply: '⛔ You are banned from the casino. The King has spoken.' };
      }
      if (status.status === 'suspected') {
        return { allowed: false, reply: '⛔ You are under investigation. All commands are blocked.' };
      }
      if (status.status === 'muted' && isCommand) {
        return { allowed: false, reply: '🔇 You are muted. You can still chat with Rimuru, but commands are blocked.' };
      }
    } catch (e) { /* non-fatal */ }
    return { allowed: true };
  }

  /** Owner smart reactions: emoji react on certain keywords. */
  async function maybeReact(msg) {
    if (!isOwner(msg.from?.id)) return;
    const text = String(msg.text || '').toLowerCase();
    const reacts = config.reactions;
    let emoji = null;
    for (const [key, val] of Object.entries(reacts)) {
      if (key === 'fallback') continue;
      if (text.includes(key)) { emoji = val; break; }
    }
    if (!emoji && reacts.fallback) {
      emoji = reacts.fallback[Math.floor(Math.random() * reacts.fallback.length)];
    }
    if (emoji) {
      try { await bot.setMessageReaction(msg.chat.id, msg.message_id, { reaction: [{ type: 'emoji', emoji }] }); } catch (e) {}
    }
  }

  /* ---------- MENU system ---------- */

  const MENU = {
    main: () => ({
      title: '🐉 RIMURU TEMPEST CASINO',
      text: 'Welcome to the Tempest house, mortal. 🐉\n\nPick a category below:',
      markup: {
        inline_keyboard: [
          [{ text: '🎰 Casino', callback_data: 'menu:casino' }, { text: '🎮 Games', callback_data: 'menu:games' }],
          [{ text: '💼 Economy', callback_data: 'menu:economy' }],
          [{ text: '🏆 Leaderboard', callback_data: 'menu:lb' }, { text: '💰 Balance', callback_data: 'menu:bal' }],
          [{ text: '❓ Help', callback_data: 'menu:help' }],
        ],
      },
    }),
    casino: () => ({
      title: '🎰 CASINO',
      text: '🎰 <b>Casino Games</b>\n\nPick a game:',
      markup: {
        inline_keyboard: [
          [{ text: '🎰 Slots', callback_data: 'menu:g:slots' }, { text: '🎲 Dice', callback_data: 'menu:g:dice' }],
          [{ text: '🪙 Coin Flip', callback_data: 'menu:g:cf' }, { text: '💣 Mines', callback_data: 'menu:g:mines' }],
          [{ text: '🃏 Blackjack', callback_data: 'menu:g:bj' }, { text: '🎡 Roulette', callback_data: 'menu:g:roulette' }],
          [{ text: '📈 Higher/Lower', callback_data: 'menu:g:hl' }, { text: '🔢 Guess', callback_data: 'menu:g:guess' }],
          [{ text: '🏎️ Race', callback_data: 'menu:g:race' }, { text: '💥 Crash', callback_data: 'menu:g:crash' }],
          [{ text: '🎡 Wheel', callback_data: 'menu:g:wheel' }, { text: '✊ RPS', callback_data: 'menu:g:rps' }],
          [{ text: '⭕ Tic-Tac-Toe', callback_data: 'menu:g:ttt' }, { text: '⚔️ Duel', callback_data: 'menu:g:duel' }],
          [{ text: '🪙 CFS', callback_data: 'menu:g:cfs' }, { text: '🎯 Num Roulette', callback_data: 'menu:g:num' }],
          [{ text: '🎟️ Lottery', callback_data: 'menu:g:lottery' }],
          [{ text: '🔙 Back', callback_data: 'menu:main' }],
        ],
      },
    }),
    games: () => ({
      title: '🎮 GAMES',
      text: '🎮 <b>All Games</b>\n\nTap any for details:',
      markup: {
        inline_keyboard: [
          [{ text: '🎰 Slots', callback_data: 'menu:g:slots' }, { text: '🎲 Dice', callback_data: 'menu:g:dice' }],
          [{ text: '🪙 Coin Flip', callback_data: 'menu:g:cf' }, { text: '💣 Mines', callback_data: 'menu:g:mines' }],
          [{ text: '🃏 Blackjack', callback_data: 'menu:g:bj' }, { text: '🎡 Roulette', callback_data: 'menu:g:roulette' }],
          [{ text: '📈 Higher/Lower', callback_data: 'menu:g:hl' }, { text: '🔢 Guess', callback_data: 'menu:g:guess' }],
          [{ text: '🏎️ Race', callback_data: 'menu:g:race' }, { text: '💥 Crash', callback_data: 'menu:g:crash' }],
          [{ text: '🎡 Wheel', callback_data: 'menu:g:wheel' }, { text: '✊ RPS', callback_data: 'menu:g:rps' }],
          [{ text: '⭕ Tic-Tac-Toe', callback_data: 'menu:g:ttt' }, { text: '⚔️ Duel', callback_data: 'menu:g:duel' }],
          [{ text: '🪙 CFS', callback_data: 'menu:g:cfs' }, { text: '🎯 Num Roulette', callback_data: 'menu:g:num' }],
          [{ text: '🎟️ Lottery', callback_data: 'menu:g:lottery' }],
          [{ text: '🔙 Back', callback_data: 'menu:main' }],
        ],
      },
    }),
    economy: () => ({
      title: '💼 ECONOMY',
      text: '💼 <b>Economy Actions</b>\n\nQuick actions:',
      markup: {
        inline_keyboard: [
          [{ text: '💰 Balance', callback_data: 'menu:bal' }],
          [{ text: '🏦 Dep All', callback_data: 'menu:eco:depAll' }, { text: '🏦 Dep 100k', callback_data: 'menu:eco:dep100k' }],
          [{ text: '💵 WD All', callback_data: 'menu:eco:wdAll' }, { text: '💵 WD 100k', callback_data: 'menu:eco:wd100k' }],
          [{ text: '🔙 Back', callback_data: 'menu:main' }],
        ],
      },
    }),
  };