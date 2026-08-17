'use strict';
/**
 * Rimuru Tempest Casino — main bot router.
 * Wires node-telegram-bot-api to every module. Handles commands, inline
 * callbacks, penalties (ban/sus/mute), the "Rimuru" AI trigger, reply-to-bot
 * conversations, owner emoji reactions, sticker sending, the persistent
 * command menu (setMyCommands) and the multi-level inline menu system.
 *
 * UI: EVERY message is a "notebook note" — vibrant Rimuru blue/cyan + gold
 * with a vertical margin bar on the LEFT edge (HTML <blockquote>). All
 * sending goes through src/send.js so the bar renders on casino, games,
 * economy, leaderboard, balance, help — every single message.
 *
 * Navigation: the persistent ☰ command menu under the text input
 * (setMyCommands + setChatMenuButton) is the PRIMARY navigation. Inline
 * keyboards on messages are HIDDEN by default (SHOW_INLINE_BUTTONS=false)
 * but the inline menu code stays intact and toggleable.
 */
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const db = require('./db');
const eco = require('./economy');
const cd = require('./cooldowns');
const admin = require('./admin');
const leaderboard = require('./leaderboard');
const rimuru = require('./rimuru');
const memory = require('./memory');
const income = require('./income');
const { fmt, humanDuration, note, pick, THEME } = require('./utils');
const send = require('./send');

const slots = require('./games/slots');
const dice = require('./games/dice');
const coinflip = require('./games/coinflip');
const mines = require('./games/mines');
const blackjack = require('./games/blackjack');
const roulette = require('./games/roulette');
const higherlower = require('./games/higherlower');
const lottery = require('./games/lottery');
const race = require('./games/race');
const guess = require('./games/guess');
const crash = require('./games/crash');
const wheel = require('./games/wheel');
const rps = require('./games/rps');
const tictactoe = require('./games/tictactoe');
const dicevs = require('./games/dicevs');
const cfstreak = require('./games/cfstreak');
const numroulette = require('./games/numroulette');
const shop = require('./shop');
const crime = require('./crimes/crime');
const fishing = require('./fish');
const robbery = require('./crimes/robbery');
const heist = require('./crimes/heist');
const keyboards = require('./keyboards');
const missions = require('./missions');
const backup = require('./backup');
const redeem = require('./redeem');
const profile = require('./profile');
const broadcastMod = require('./broadcast');
const attack = require('./attack');
const fbi = require('./fbi');
const rank = require('./rank');
const timewallet = require('./timewallet');
const waifu = require('./waifu');
const hunt = require('./hunt');
const dashboard = require('./dashboard/server');

// In-memory heist timers (leaderId -> timeout)
const heistTimers = new Map();

// Health/debug state for /debug (staff-only)
let lastError = null;

// Tracks message_ids of Rimuru AI's own replies. Used to detect genuine
// "replying to Rimuru" so the AI doesn't get triggered by replies to
// ordinary bot output (game results, errors, etc. — those also default
// to a "RIMURU" header when no custom title is passed, so checking
// `from.is_bot` alone falsely matched almost any bot message). Bounded
// so it can't grow forever.
const rimuruMessageIds = new Set();
const RIMURU_ID_CAP = 500;
function markRimuruMessage(messageId) {
  if (messageId == null) return;
  rimuruMessageIds.add(messageId);
  if (rimuruMessageIds.size > RIMURU_ID_CAP) {
    const first = rimuruMessageIds.values().next().value;
    rimuruMessageIds.delete(first);
  }
}
let commitHash = null;
try {
  commitHash =
    process.env.RENDER_GIT_COMMIT ||
    require('child_process').execSync('git rev-parse --short HEAD', { timeout: 2000 }).toString().trim();
} catch (e) {
  commitHash = null;
}

// Owner emoji reaction keywords (config.reactions)
const REACT_KEYS = Object.keys(config.reactions).filter((k) => k !== 'fallback');

// Persistent command menu — the "☰" button next to the text input.
// This is the PRIMARY navigation (Telegram renders it as a dropdown under
// the input bar, the same area as the sticker/attachment menu).
const MENU_COMMANDS = [
  { command: 'leaderboard', description: '🏆 Leaderboard' },
  { command: 'balance', description: '💰 Balance' },
  { command: 'casino', description: '🎰 Casino' },
  { command: 'games', description: '🎮 Games' },
  { command: 'economy', description: '💼 Economy' },
  { command: 'shop', description: '🛒 Shop' },
  { command: 'crime', description: '🕵️ Crime' },
  { command: 'profile', description: '🪪 Profile / Badges' },
  { command: 'help', description: '❓ Help' },
  { command: 'health', description: '👌 Health' },
  { command: 'attack', description: '🐉 Deploy attackers (owner)' },
  { command: 'fbi', description: '🚔 FBI raid (owner)' },
  { command: 'swat', description: '🚔 SWAT raid (owner)' },
  { command: 'rank', description: '🏆 Your rank' },
  { command: 'ranks', description: '📊 Rank ladder' },
  { command: 'waifu', description: '💝 Spawn a waifu (owner)' },
  { command: 'collection', description: '💝 Your waifu collection' },
  { command: 'wlb', description: '💝 Waifu leaderboard' },
  { command: 'viewwaifu', description: '💝 View a waifu by number' },
  { command: 'hunt', description: '⚔️ Start an anime hunt (owner)' },
  { command: 'char', description: '⚔️ Search an anime character' },
  { command: 'characters', description: '⚔️ Your character collection' },
  { command: 'viewchar', description: '⚔️ View a character by number' },
  { command: 'clb', description: '⚔️ Character leaderboard' },
  { command: 'remember', description: '🧠 Store a memory (owner)' },
  { command: 'recall', description: '🧠 Recall a memory (owner)' },
];

function createBot() {
  const bot = new TelegramBot(config.telegramToken, {
    polling: true,
    onlyFirstMatch: false,
    filepath: false,
  });

  // sendPhoto helper used by /viewwaifu and /viewchar (photo-first, text fallback).
  const depsPhoto = (chatId, imageUrl, opts) => bot.sendPhoto(chatId, imageUrl, opts);

  /* ---------- helpers ---------- */

  function metaOf(msg) {
    const from = msg.from || {};
    return { username: from.username || '', first_name: from.first_name || '' };
  }

  function isOwner(userId) {
    return String(userId) === String(config.ownerId);
  }

  /** Authorized staff = the owner OR a moderator registered in the dashboard. */
  function isAuthorized(userId) {
    if (isOwner(userId)) return true;
    try {
      return !!db.getAdminUser(Number(userId));
    } catch (e) {
      return false;
    }
  }

  /** Staff check (owner + dashboard moderators). Used by the group gate,
   *  Rimuru personality split, /debug and /restart. */
  function isStaff(userId) {
    return isAuthorized(userId);
  }

  /**
   * Reply wrapper — EVERY message is a blockquote notebook note (HTML).
   * opts: { title, color, icon, raw, html, parse_mode, reply_markup,
   *         reply_to_message_id, ... }
   *  - opts.html === true OR opts.parse_mode === 'HTML' → body is TRUSTED
   *    HTML (never re-escaped — this kills the double-escape bug).
   *  - opts.raw === true → send the body verbatim (no note wrapper);
   *    still forced through parse_mode HTML + sanitizer as a safety net.
   *  - Inline keyboards are gated behind config.showInlineButtons.
   */
  async function reply(chatId, text, opts = {}) {
    const trustedHtml = opts.html === true || opts.parse_mode === 'HTML';
    // Reply-to-message: quote the triggering message ("replying to @user"
    // bubble) when the sender is replying to the bot, or for bot commands /
    // Rimuru triggers (the router tags ctx.msg._replyTarget).
    if (!opts.reply_to_message_id && opts._replyTarget) {
      opts = { ...opts, reply_to_message_id: opts._replyTarget };
      delete opts._replyTarget;
    }
    if (opts.raw) {
      // Raw HTML — sanitize, no note wrapper. parse_mode stays HTML.
      const safe = send.sanitizeHtml(text);
      return send.sendText(bot, chatId, safe, { ...opts, html: true, raw: true });
    }
    return send.sendText(bot, chatId, text, { ...opts, html: trustedHtml });
  }

  /** Edit wrapper — same note-style rules as reply(). */
  async function editMsg(chatId, messageId, text, opts = {}) {
    const trustedHtml = opts.html === true || opts.parse_mode === 'HTML';
    if (opts.raw) {
      const safe = send.sanitizeHtml(text);
      return send.editText(bot, chatId, messageId, safe, { ...opts, html: true, raw: true });
    }
    return send.editText(bot, chatId, messageId, text, { ...opts, html: trustedHtml });
  }

  /** Threaded reply (replies to a specific message — "replying to @user"). */
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
      keyboards,
      // Native reply-keyboard builder for the current page
      // ('main' | 'casino' | 'games' | 'economy') — attach to a response
      // via reply_markup so the grid persists above the phone keyboard.
      keyboardFor: (page) => keyboards.keyboardFor(page),
      reply: (t, o) => reply(msg.chat.id, t, { ...(msg._replyTarget ? { _replyTarget: msg._replyTarget } : {}), ...o }),
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

  /* ---------- stickers (Rimuru vibe) — ALWAYS AFTER the text ---------- */

  let stickerCache = null;
  let stickerDisabled = false;

  /** Get a random sticker file_id from the configured pack (graceful). */
  async function nextSticker() {
    if (!config.stickerPack || stickerDisabled) return null;
    try {
      if (!stickerCache) {
        const set = await bot.getStickerSet(config.stickerPack);
        stickerCache = (set.stickers || []).map((s) => s.file_id);
      }
      if (!stickerCache.length) {
        stickerDisabled = true;
        return null;
      }
      return stickerCache[Math.floor(Math.random() * stickerCache.length)];
    } catch (e) {
      console.warn(`[sticker] pack "${config.stickerPack}" unavailable — stickers disabled:`, e.message);
      stickerDisabled = true;
      return null;
    }
  }

  /** Send the sticker AFTER the text message resolves (never before). */
  async function stickerAfterText(chatId, textPromise) {
    const fileId = await nextSticker();
    if (!fileId) return null;
    try {
      await textPromise; // text FIRST
    } catch (e) {
      /* text failed — still try the sticker */
    }
    try {
      return await bot.sendSticker(chatId, fileId);
    } catch (e) {
      console.warn('[sticker] send failed:', e.message);
      return null;
    }
  }

  /* ---------- GROUP MEMBERSHIP GATE (@the_jtf) ---------- */
  // Before any non-staff user can use the bot (games/economy/commands),
  // they must be a member of config.requiredGroup. Staff bypass entirely.
  // Membership results are cached for config.groupGateCacheMs (60s) to avoid
  // hammering the Telegram API; the /verify button always re-checks fresh.

  const membershipCache = new Map(); // userId -> { ok: boolean, at: number }
  const MEMBERSHIP_CACHE_MAX = 5000; // OOM fix: bound the cache so it can't grow forever
  /** Cache a membership result, evicting the oldest entry when over cap. */
  function cacheMembership(userId, val) {
    membershipCache.set(userId, val);
    if (membershipCache.size > MEMBERSHIP_CACHE_MAX) {
      const oldest = membershipCache.keys().next().value;
      if (oldest !== undefined) membershipCache.delete(oldest);
    }
  }

  let resolvedGroupId = config.requiredGroupId || 0;
  let groupResolvePromise = null;

  /** Resolve the required group's numeric chat id via getChat('@the_jtf').
   *  Uses the REQUIRED_GROUP_ID override when set. Cached after first OK. */
  async function resolveRequiredGroup() {
    if (resolvedGroupId) return resolvedGroupId;
    if (groupResolvePromise) return groupResolvePromise;
    if (!config.requiredGroup) return 0; // gate disabled
    groupResolvePromise = (async () => {
      try {
        const chat = await bot.getChat(config.requiredGroup);
        if (chat && chat.id) {
          resolvedGroupId = chat.id;
          console.log(`[gate] required group ${config.requiredGroup} resolved to chat ${resolvedGroupId}`);
        } else {
          console.warn(`[gate] getChat(${config.requiredGroup}) returned no id — gate OFF`);
        }
      } catch (e) {
        console.warn(`[gate] could not resolve ${config.requiredGroup}: ${e.message} — gate OFF until resolved`);
      } finally {
        groupResolvePromise = null;
      }
      return resolvedGroupId;
    })();
    return groupResolvePromise;
  }

  /** Fresh membership check (never cached) — used by /verify. */
  async function checkMembershipFresh(userId) {
    if (isStaff(userId)) return { ok: true, staff: true };
    const gid = await resolveRequiredGroup();
    if (!gid) return { ok: true, gateOff: true }; // gate disabled/unresolved → allow
    try {
      const m = await bot.getChatMember(gid, userId);
      const status = m && m.status;
      const member = ['creator', 'administrator', 'member'].includes(status);
      membershipCache.set(userId, { ok: member, at: Date.now() });
      cacheMembership(userId, { ok: member, at: Date.now() });
      return { ok: member, status };
    } catch (e) {
      console.warn(`[gate] getChatMember(${gid}, ${userId}) error: ${e.message}`);
      return { ok: false, status: 'error' };
    }
  }

  /** Cached gate check (60s TTL). Fresh when expired. */
  async function gateAllowed(userId) {
    if (isStaff(userId)) return { ok: true, staff: true };
    const cached = membershipCache.get(userId);
    if (cached && Date.now() - cached.at < config.groupGateCacheMs) {
      return { ok: cached.ok, cached: true };
    }
    return checkMembershipFresh(userId);
  }

  /** Is the gate actually active right now? (group configured + resolved) */
  async function gateActive() {
    if (!config.requiredGroup) return false;
    if (config.requiredGroupId) return true;
    const gid = await resolveRequiredGroup();
    return !!gid;
  }

  /** The join-prompt message + inline "✅ Verify" button (always shown). */
  function gatePrompt(chatId) {
    const link = config.requiredGroup ? `https://t.me/${config.requiredGroup.replace(/^@/, '')}` : '';
    return {
      text:
        `🔒 <b>JOIN THE GROUP FIRST</b>\n\n` +
        `Mortal, you must be a member of <a href="${link}">${config.requiredGroup}</a> to use the casino.\n\n` +
        `1️⃣ Tap the group link above and press <b>Join</b>\n` +
        `2️⃣ Come back and tap <b>✅ Verify</b>\n\n` +
        `Only members of the house get to play. 🐉`,
      opts: {
        title: '🔒 MEMBERS ONLY',
        color: THEME.gold,
        html: true,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Verify', callback_data: 'gate:verify' }]],
        },
        // The Verify button is essential to the gate flow — it must render
        // even when SHOW_INLINE_BUTTONS=false.
        alwaysShowMarkup: true,
      },
    };
  }

  /** /verify — force a FRESH membership check and report the result. */
  async function verifyCommand(ctx) {
    const res = await checkMembershipFresh(ctx.userId);
    if (res.ok) {
      await ctx.reply(
        `✅ <b>VERIFIED!</b>\n\nWelcome to the house, ${ctx.msg.from.first_name || 'mortal'}. Everything is unlocked. 🎰`,
        { title: '✅ VERIFIED', color: THEME.gold, html: true }
      );
    } else {
      const p = gatePrompt(ctx.chatId);
      await ctx.reply(p.text, p.opts);
    }
    return res;
  }

  /* ---------- owner smart reactions (dynamic, owner-only) ---------- */

  // Dynamic fallback pool — picked at random so reactions feel alive.
  const REACT_POOL = ['👍', '❤️', '😄', '😂', '👏', '🔥', '💯', '😎'];

  /** Does this message target Rimuru (mention, reply-to-bot, or command)? */
  function targetsRimuru(msg) {
    const text = String(msg.text || msg.caption || '');
    if (text.startsWith('/')) return true;            // bot command
    if (rimuru.shouldTrigger(text)) return true;      // "rimuru" / mention
    const r = msg.reply_to_message;
    return !!(r && r.from && r.from.is_bot === true); // reply to the bot
  }

  /**
   * Pick a dynamic emoji for the owner's message: keyword reactions win
   * (e.g. "nice" → 👏), then sentiment hints, then a random pool pick so
   * it feels alive and varied.
   */
  function reactionFor(text) {
    const t = String(text || '').toLowerCase();
    for (const key of REACT_KEYS) {
      if (t.includes(key)) return config.reactions[key];
    }
    if (/\b(win|won|rich|profit|gain|lucky|jackpot|nice|great|love|good|yay)\b/.test(t)) {
      return pick(['🎉', '🔥', '💯', '😄', '💰']);
    }
    if (/\b(lose|lost|broke|bad|sad|cry|rip|ouch|damn|fail|unlucky)\b/.test(t)) {
      return pick(['💸', '😢', '😅', '🫠', '🙃']);
    }
    if (/\b(angry|mad|hate|rage|wtf|fuck|annoying)\b/.test(t)) {
      return pick(['😡', '🤬', '😤']);
    }
    if (t.includes('?')) {
      return pick(['🤔', '🧐']);
    }
    return pick(REACT_POOL);
  }

  /** Owner-only dynamic emoji reaction, fired before the text reply. */
  async function maybeReact(msg) {
    if (!msg.from || msg.from.is_bot) return;
    if (!isOwner(msg.from.id)) return;                 // owner only
    if (!targetsRimuru(msg)) return;                   // tag / reply / command only
    const text = String(msg.text || msg.caption || '');
    if (!text) return;
    try {
      await bot.setMessageReaction(msg.chat.id, msg.message_id, {
        reaction: [{ type: 'emoji', emoji: reactionFor(text) }],
      });
    } catch (e) {
      /* reactions are best-effort */
    }
  }

  /* ---------- inline menu system (kept intact, gated by SHOW_INLINE_BUTTONS) ---------- */

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
        `💎 <b>Mines</b> — /mines [amount] · 5×5, 4 mines (1 hidden) that MOVE after each pick\n` +
        `🎲 <b>Dice</b> — /dice [1-6] [amount] · 6× if you hit\n` +
        `📏 <b>Higher or Lower</b> — /hl [amount] · streak multiplier\n\n` +
        `👇 <i>Tap a game for details, or just type the command.</i>`,
      markup: {
        inline_keyboard: [
          [
            { text: '🪙 Coin Flip', callback_data: 'menu:g:cf' },
            { text: '💎 Mines', callback_data: 'menu:g:mines' },
          ],
          [
            { text: '🎲 Dice', callback_data: 'menu:g:dice' },
            { text: '📏 Higher/Lower', callback_data: 'menu:g:hl' },
          ],
          [
            { text: '🎯 Guess Number', callback_data: 'menu:g:guess' },
            { text: '🎰 Lottery', callback_data: 'menu:g:lottery' },
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
    mines: '💎 <b>Mines</b>\n<code>/mines [amount]</code>\n5×5 grid, 4 mines (1 hidden) — the mines MOVE after every pick. +25% of your bet per safe pick. Cash out anytime. 💣',
    dice: '🎲 <b>Dice</b>\n<code>/dice [1-6] [amount]</code>\nAnimated dice — hit your number = 6×. Rare, but sweet. 😎',
    hl: '📏 <b>Higher or Lower</b>\n<code>/hl [amount]</code>\nGuess the next card. Streak multiplier climbs, cash out anytime. 🔥',
    guess: '🎯 <b>Guess the Number</b>\n<code>/guess [amount]</code>\nPick 1-10. 3 chances with higher/lower hints. 1st try = 5x, 2nd = 3x, 3rd = 2x. 🎲',
    crash: '💥 <b>Crash</b>\n<code>/crash [amount]</code>\nA LIVE multiplier rocket — press 💰 CASHOUT before it explodes. Long rides pay big. 💥',
    wheel: '🎡 <b>Wheel of Fortune</b>\n<code>/wheel [amount]</code>\nSpin a 12-segment wheel — 0.5x to 10x. Lady luck decides. 🎰',
    rps: '✊ <b>Rock Paper Scissors</b>\n<code>/rps [rock|paper|scissors] [amount]</code>\nBeat the house. Tie = half back. ✋✌️',
    ttt: '⭕ <b>Tic-Tac-Toe</b>\n<code>/ttt [amount]</code>\nButton game vs the house — pick difficulty (Easy/Normal/Hard), then X or O. No bet = play for fun. ❌',
    duel: '🎲 <b>Dice Duel</b>\n<code>/duel [amount]</code>\nYou vs the house — higher roll wins. Ties go to the house. ⚔️',
    cfs: '🪙 <b>Coin Flip Streak</b>\n<code>/cfs [heads|tails] [amount]</code>\nEach correct flip doubles your payout. One miss = everything gone. 🔥',
    num: '🎯 <b>Number Roulette</b>\n<code>/num [1-10] [amount]</code>\nPick 1-10. Rarer picks pay more — up to 9x. 🎡',
  };

  /** Build a menu message (text + markup) and send it. */
  async function sendMenu(chatId, page = 'main', opts = {}) {
    const m = MENU[page]();
    // Route through reply() so the menu message is a blockquote note too
    // (bar renders) and reply_to_message_id is honoured.
    return reply(chatId, m.text, {
      title: '\ud83d\udcdc RIMURU MENU', color: THEME.gold, icon: '\ud83d\udcdc',
      html: true, reply_markup: send.inlineMarkup(m.markup), ...opts,
    });
  }

  /** Edit an existing menu message to a different page. */
  async function editMenu(chatId, messageId, page = 'main') {
    const m = MENU[page]();
    // Route through editMsg() — same blockquote-note style, parse-error safe.
    return editMsg(chatId, messageId, m.text, {
      title: '\ud83d\udcdc RIMURU MENU', color: THEME.gold, icon: '\ud83d\udcdc',
      html: true, reply_markup: send.inlineMarkup(m.markup),
    }).catch((e) => {
      console.warn('[menu] edit failed:', e.message);
      return null;
    });
  }

  /* ---------- command handlers ---------- */

  const handlers = {
    start: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      // Blockquote (notebook note) intro — Rimuru welcomes the user to the group.
      await ctx.reply(
        `Welcome to the Tempest house, <b>${u.first_name || 'mortal'}</b>. 🐉\n\n` +
        `I'm <b>Rimuru Tempest</b> — the lord of this casino. The house always wins… but I'll let you play. ✨\n\n` +
        `You start with <b>${fmt(config.startBalance)}</b> coins. 💰\n\n` +
        `Tap a button below to explore — or just type a command. 👇`,
        {
          title: '🐉 RIMURU TEMPEST CASINO',
          color: THEME.blue,
          html: true,
          // Centered inline buttons (main menu) — always shown on /start.
          reply_markup: MENU.main().markup,
          alwaysShowMarkup: true,
        }
      );
      // Native reply keyboard appears automatically after /start —
      // the grid above the phone keyboard (toggleable, not persistent).
      // ALWAYS re-send a FRESH main keyboard: Telegram caches the keyboard
      // per chat, so a group that saw an OLD deploy's labels (e.g. colored
      // emojis from a previous build) keeps tapping stale text. Re-sending
      // here replaces the stale cached keyboard with the current labels.
      if (config.showReplyKeyboard) {
        try {
          await bot.sendMessage(ctx.chatId, '⌨️ Your quick-menu keyboard is ready below.', {
            reply_markup: keyboards.keyboardFor('main'),
          });
        } catch (e) {
          console.warn('[start] keyboard:', e.message);
        }
      }
      // GROUP GATE: even /start checks membership for non-staff — if they
      // haven't joined the required group yet, show the join prompt.
      if (!isStaff(ctx.userId)) {
        const gate = await gateAllowed(ctx.userId);
        if (!gate.ok) {
          const p = gatePrompt(ctx.chatId);
          await ctx.reply(p.text, p.opts);
        }
      }
    },

    menu: async (ctx) => sendMenu(ctx.chatId),

    casino: async (ctx) => {
      await ctx.reply(MENU.casino().text, {
        title: '🎰 CASINO', color: THEME.cyan, html: true,
        reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor('casino') : send.inlineMarkup(MENU.casino().markup),
      });
    },
    games: async (ctx) => {
      await ctx.reply(MENU.games().text, {
        title: '🎮 GAMES', color: THEME.cyan, html: true,
        reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor('games') : send.inlineMarkup(MENU.games().markup),
      });
    },
    economy: async (ctx) => {
      await ctx.reply(MENU.economy().text, {
        title: '💼 ECONOMY', color: THEME.cyan, html: true,
        reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor('economy') : send.inlineMarkup(MENU.economy().markup),
      });
    },

    help: async (ctx) => {
      await ctx.reply(
        `<b>🎮 Games</b> (per-game cooldown)\n` +
        `• /slots [amt] — 3 reels, 2×/4×\n` +
        `• /dice [1-6] [amt] — animated dice, 6×\n` +
        `• /cf [heads|tails] [amt] — 2×\n` +
        `• /mines [amt] — 5×5, 4 mines (1 hidden) that MOVE after each pick, +25% per safe pick\n` +
        `• /bj [amt] — blackjack, 3:2 on blackjack\n` +
        `• /roulette [color|even|odd|low|high|dozen|column|straight|split] [amt]\n` +
        `• /hl [amt] — higher or lower, streak multiplier\n` +
        `• /guess [amt] — pick 1-10, 3 chances, up to 5x\n` +
        `• /lottery [buy|draw|status] [n] — tickets 10k, 5 buyers = draw\n\n` +
        `<b>🔥 New games</b>\n` +
        `• /crash [amt] — multiplier rocket, cash out before it crashes 💥\n` +
        `• /wheel [amt] — wheel of fortune, 0.5x–10x 🎡\n` +
        `• /rps [rock|paper|scissors] [amt] — vs the house ✊✋✌️\n` +
        `• /ttt [amt] — button tic-tac-toe vs the house (difficulty + X/O, no bet = fun) ⭕❌\n` +
        `• /duel [amt] — dice duel, higher roll wins 🎲\n` +
        `• /cfs [heads|tails] [amt] — coin flip streak, doubles each win 🪙\n` +
        `• /num [1-10] [amt] — number roulette, rare picks pay up to 9x 🎯\n\n` +
        `<b>💼 Economy</b>\n` +
        `• /balance — wallet + bank\n` +
        `• /dep [amt|all] — wallet → bank\n` +
        `• /wd [amt|all] — bank → wallet\n` +
        `• /donate [amt] (reply) — from wallet\n` +
        `• /transfer [amt] (reply) — from bank\n\n` +
        `<b>🕵️ Crime</b>\n` +
        `• /rob (reply) — 10 min cooldown, fail = fine\n` +
        `• /crime [amt] — bet on a crime, up to 7x (needs shop items)\n` +
        `• /heist (reply) — 20 min, open 60s for /join, max 5 crew\n` +
        `• /join — join an open heist\n\n` +
        `<b>🛒 Shop</b>\n` +
        `• /shop — item list · /buy [id] [qty] — buy items\n` +
        `• /inv — your inventory (crowbar/gun/mask → crime, hook → /fish)\n\n` +
        `<b>💵 Income</b>\n` +
        `• /beg · /work · /fish · /dig — quick coins\n` +
        `• /daily — 24h · /bonus — weekly\n\n` +
        `<b>🎣 Activities</b>\n` +
        `• /fish — needs a Fishing Hook from /shop\n` +
        `• /dig — treasure hunt\n\n` +
        `<b>🪪 Profile</b>\n` +
        `• /p — your profile card (rank, win rate, badges)\n` +
        `• /badges — your earned badges\n` +
        `• /id — your ID card\n` +
        `• /rank — your rank, logo, progress + time-wallet\n` +
        `• /ranks — full rank ladder (Bronze → Mythic)\n\n` +
        `<b>🕹️ Other</b>\n` +
        `• /race [amt] — race against the house\n` +
        `• /hide — 50M coins, vanish from robs &amp; heists for 60s\n` +
        `• /redeem [CODE] — claim a code (coins go to BANK)\n` +
        `• /verify — re-check your group membership\n` +
        `• /health — bot health &amp; persistence status (anyone)\n\n` +
        `<b>👑 Staff</b>\n` +
        `• /redeem create [CODE] [AMT] [USES] — mint a code (mods capped at 50M)\n` +
        `• /redeem list · /redeem delete [CODE] · /backup · /backups · /restore [id]\n` +
        `• /sb [amount] — set a user's whole networth (wallet = amount, bank = 0)\n` +
        `• /broadcast [message] (alias /bd) — announce to all users & groups\n` +
        `  · owner: any message · mods: must be relevant to the bot\n` +
        `• /set [type] [title] | [desc] | [reward] (alias /s) — create an event / mission / giveaway\n` +
        `• /attack — Rimuru deploys attackers against a wealthy player (owner/Rimuru only)\n` +
        `• /attack [number] (reply) — deploy exactly N attackers against the replied user (owner only)\n` +
        `• /FBI (alias /SWAT) — reply to raid a user's home (owner only, case-sensitive escape)\n` +
        `• /xleaderboard [n] (alias /xlb) — full networth list of ALL players, 1–100 (staff only)\n` +
        `• /stop — pause the bot for maintenance (owner) · /run — resume\n\n` +
        `<b>💝 Waifu collection</b>\n` +
        `• /waifu (alias /wspawn) — spawn a random character card with a Claim button (owner only)\n` +
        `• /collection (alias /waifus) — your claimed characters (numbered)\n` +
        `• /viewwaifu [number] (alias /vw) — view one claimed character by number\n` +
        `• /character [name] — details of one claimed character\n` +
        `• /wlb — top waifu collectors\n\n` +
        `<b>⚔️ Anime Hunt</b>\n` +
        `• /hunt (alias /shunt) — start an anime hunt, spawn a random character (owner only)\n` +
        `• /char [name] (alias /whois) — search a character and see their info (anyone)\n` +
        `• /characters — your claimed characters (numbered)\n` +
        `• /viewchar [number] (alias /vc) — view one claimed character by number\n` +
        `• /clb [n] — top character hunters (default 10, max 100)\n` +
        `• /remember [key] [value] — store a memory (owner only)\n` +
        `• /recall [key] — retrieve a memory (owner only)\n\n` +
        `<b>🏆 /lb</b> — top 10 richest\n` +
        `<b>📜 /menu</b> — interactive menu\n` +
        `☰ <i>The menu button next to the text box has all commands.</i>\n` +
        `💬 <i>Reply to me or say "Rimuru" to talk.</i>`,
        { title: '❓ RIMURU HELP', color: THEME.gold, html: true }
      );
    },

    balance: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `👛 Wallet (rob-able): <b>${fmt(u.wallet)}</b>\n` +
        `🏦 Bank (safe): <b>${fmt(u.bank)}</b>\n` +
        `💎 Net worth: <b>${fmt(u.wallet + u.bank)}</b>`,
        { title: `💰 ${u.first_name || 'YOUR'} BALANCE`, color: THEME.gold, html: true }
      );
    },

    // 💼 Economy sub-keyboard actions (reply-keyboard button taps)
    bank: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `🏦 <b>BANK</b>\n\n` +
        `💼 Saved: <b>${fmt(u.bank)}</b>\n` +
        `👛 Wallet: <b>${fmt(u.wallet)}</b>\n\n` +
        `Use <code>/dep [amount|all]</code> to deposit or <code>/wd [amount|all]</code> to withdraw.`,
        { title: '🏦 BANK', color: THEME.cyan, html: true }
      );
    },
    income: async (ctx) => {
      await ctx.reply(
        `<b>💵 INCOME</b>\n\n` +
        `• /beg — quick coins\n` +
        `• /work — steady pay\n` +
        `• /fish — lucky catch\n` +
        `• /dig — treasure hunt\n` +
        `• /daily — 24h reward\n` +
        `• /bonus — weekly reward`,
        { title: '💵 INCOME', color: THEME.gold, html: true }
      );
    },

    dep: async (ctx) => {
      // No amount → "all" (withdraw/deposit the full balance by default).
      const r = eco.deposit(ctx.userId, ctx.args[0] || 'all');
      await ctx.reply(r.message, { title: '🏦 DEPOSIT', color: THEME.cyan });
    },
    deposit: async (ctx) => {
      const r = eco.deposit(ctx.userId, ctx.args[0] || 'all');
      await ctx.reply(r.message, { title: '🏦 DEPOSIT', color: THEME.cyan });
    },
    wd: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0] || 'all');
      await ctx.reply(r.message, { title: '💵 WITHDRAW', color: THEME.cyan });
    },
    withdraw: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0] || 'all');
      await ctx.reply(r.message, { title: '💵 WITHDRAW', color: THEME.cyan });
    },

    donate: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/donate [amount]</code>. 🎯', { title: '💝 DONATE', color: THEME.cyan, html: true });
      const r = eco.donate(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { title: '💝 DONATE', color: THEME.cyan, html: true });
    },
    transfer: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/transfer [amount]</code>. 🎯', { title: '🏦 TRANSFER', color: THEME.cyan, html: true });
      const r = eco.transfer(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { title: '🏦 TRANSFER', color: THEME.cyan, html: true });
    },

    // ----- games -----
    slots: async (ctx) => {
      const r = await slots.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'slots', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    dice: async (ctx) => {
      const r = await dice.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'dice', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    cf: async (ctx) => {
      const r = await coinflip.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'coinflip', r.bet || ctx.args[1] || 0, r.won ? 'win' : 'lose', r.net);
      return r;
    },
    coinflip: async (ctx) => {
      const r = await coinflip.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'coinflip', r.bet || ctx.args[1] || 0, r.won ? 'win' : 'lose', r.net);
      return r;
    },
    mines: async (ctx) => {
      const r = await mines.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'mines', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    bj: async (ctx) => {
      const r = await blackjack.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'blackjack', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    roulette: async (ctx) => {
      const r = await roulette.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'roulette', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    hl: async (ctx) => {
      const r = await higherlower.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'higherlower', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    guess: async (ctx) => {
      const r = await guess.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'guess', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    crash: async (ctx) => {
      const r = await crash.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'crash', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    wheel: async (ctx) => {
      const r = await wheel.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'wheel', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    rps: async (ctx) => {
      const r = await rps.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'rps', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    ttt: async (ctx) => {
      const r = await tictactoe.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'tictactoe', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    duel: async (ctx) => {
      const r = await dicevs.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'dicevs', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    cfs: async (ctx) => {
      const r = await cfstreak.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'cfstreak', r.bet || ctx.args[1] || 0, r.won ? 'win' : 'lose', r.net);
      return r;
    },
    coinflipstreak: async (ctx) => {
      const r = await cfstreak.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'cfstreak', r.bet || ctx.args[1] || 0, r.won ? 'win' : 'lose', r.net);
      return r;
    },
    num: async (ctx) => {
      const r = await numroulette.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'numroulette', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    race: async (ctx) => {
      const r = await race.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'race', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    lottery: async (ctx) => {
      await lottery.play(ctx);
    },

    // ----- crime -----
    rob: async (ctx) => {
      await robbery.play(ctx);
    },
    heist: async (ctx) => {
      await heist.play(ctx);
    },
    crime: async (ctx) => {
      await crime.play(ctx);
    },
    join: async (ctx) => {
      await heist.join(ctx);
    },

    // ----- economy -----
    daily: async (ctx) => {
      await income.daily(ctx);
    },
    bonus: async (ctx) => {
      await income.bonus(ctx);
    },
    beg: async (ctx) => {
      await income.beg(ctx);
    },
    work: async (ctx) => {
      await income.work(ctx);
    },
    fish: async (ctx) => {
      await fishing.play(ctx);
    },
    dig: async (ctx) => {
      await fishing.dig(ctx);
    },

    // ----- shop -----
    shop: async (ctx) => {
      await shop.shop(ctx);
    },
    buy: async (ctx) => {
      await shop.buy(ctx);
    },
    inv: async (ctx) => {
      await shop.inventory(ctx);
    },

    // ----- profile -----
    p: async (ctx) => {
      await profile.profile(ctx);
    },
    profile: async (ctx) => {
      await profile.profile(ctx);
    },
    badges: async (ctx) => {
      await profile.badges(ctx);
    },
    id: async (ctx) => {
      await profile.id(ctx);
    },

    // ----- leaderboard -----
    lb: async (ctx) => {
      await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true });
    },
    leaderboard: async (ctx) => {
      await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true });
    },

    // ----- staff -----
    sb: async (ctx) => {
      await admin.setBalance(ctx);
    },
    addcoin: async (ctx) => {
      await admin.addCoins(ctx);
    },
    stop: async (ctx) => {
      await admin.stop(ctx);
    },
    run: async (ctx) => {
      await admin.run(ctx);
    },
    restart: async (ctx) => {
      await admin.restart(ctx);
    },
    ban: async (ctx) => {
      await admin.ban(ctx);
    },
    sus: async (ctx) => {
      await admin.suspend(ctx);
    },
    mute: async (ctx) => {
      await admin.mute(ctx);
    },
    unban: async (ctx) => {
      await admin.unban(ctx);
    },
    unsus: async (ctx) => {
      await admin.unsus(ctx);
    },
    unmute: async (ctx) => {
      await admin.unmute(ctx);
    },
    debug: async (ctx) => {
      await admin.debug(ctx, { lastError, commitHash });
    },
    backup: async (ctx) => {
      await backup.now(ctx);
    },
    backups: async (ctx) => {
      await backup.list(ctx);
    },
    restore: async (ctx) => {
      await backup.restore(ctx);
    },
    redeem: async (ctx) => {
      await redeem.handle(ctx);
    },
    xlb: async (ctx) => {
      await admin.xleaderboard(ctx);
    },
    xleaderboard: async (ctx) => {
      await admin.xleaderboard(ctx);
    },

    // ----- health -----
    health: async (ctx) => {
      await admin.health(ctx, { lastError, commitHash });
    },

    // ----- verify -----
    verify: async (ctx) => {
      await verifyCommand(ctx);
    },

    // ----- attack -----
    attack: async (ctx) => {
      await handleAttack(ctx);
    },

    // ----- FBI -----
    fbi: async (ctx) => {
      await handleFbi(ctx);
    },
    swat: async (ctx) => {
      await handleFbi(ctx);
    },

    // ----- hide -----
    hide: async (ctx) => {
      await admin.hide(ctx);
    },

    // ----- rank -----
    rank: async (ctx) => {
      await rank.show(ctx);
    },
    ranks: async (ctx) => {
      await rank.ladder(ctx);
    },

    // ----- broadcast -----
    broadcast: async (ctx) => {
      await handleBroadcast(ctx);
    },
    bd: async (ctx) => {
      await handleBroadcast(ctx);
    },

    // ----- set -----
    set: async (ctx) => {
      await handleSet(ctx);
    },
    s: async (ctx) => {
      await handleSet(ctx);
    },

    // ----- waifu -----
    waifu: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can spawn a waifu. 👑', { title: '💝 WAIFU', color: THEME.red });
      await waifu.spawn({ chatId: ctx.chatId });
    },
    wspawn: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can spawn a waifu. 👑', { title: '💝 WAIFU', color: THEME.red });
      await waifu.spawn({ chatId: ctx.chatId });
    },
    collection: async (ctx) => {
      const rows = db.getUserCharacters(ctx.userId);
      await ctx.reply(waifu.collectionCaption(rows), { title: '💝 WAIFU', color: '#FF80AB', html: true });
    },
    waifus: async (ctx) => {
      const rows = db.getUserCharacters(ctx.userId);
      await ctx.reply(waifu.collectionCaption(rows), { title: '💝 WAIFU', color: '#FF80AB', html: true });
    },
    viewwaifu: async (ctx) => {
      await viewWaifu(ctx);
    },
    vw: async (ctx) => {
      await viewWaifu(ctx);
    },
    wlb: async (ctx) => {
      const rows = db.getWaifuLeaderboard(100);
      await ctx.reply(waifu.leaderboardCaption(rows, 100), { title: '💝 WAIFU LEADERBOARD', color: '#FF80AB', html: true });
    },
    character: async (ctx) => {
      const rows = db.getUserCharacters(ctx.userId);
      await ctx.reply(waifu.characterCaption(rows), { title: '💝 WAIFU', color: '#FF80AB', html: true });
    },

    // ----- anime hunt -----
    hunt: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can start a hunt. 👑', { title: '⚔️ ANIME HUNT', color: THEME.red });
      const r = await hunt.spawn({ chatId: ctx.chatId });
      if (!r.ok) await ctx.reply(r.message, { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
    },
    shunt: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can start a hunt. 👑', { title: '⚔️ ANIME HUNT', color: THEME.red });
      const r = await hunt.spawn({ chatId: ctx.chatId });
      if (!r.ok) await ctx.reply(r.message, { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
    },
    char: async (ctx) => {
      const q = (ctx.args || []).join(' ').trim();
      if (!q) return ctx.reply('Usage: <code>/char <name></code> or <code>/whois <name></code>', { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
      const r = await hunt.searchAndShow(q, { chatId: ctx.chatId });
      if (!r.ok) await ctx.reply(r.message, { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
    },
    whois: async (ctx) => {
      const q = (ctx.args || []).join(' ').trim();
      if (!q) return ctx.reply('Usage: <code>/whois <name></code> or <code>/char <name></code>', { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
      const r = await hunt.searchAndShow(q, { chatId: ctx.chatId });
      if (!r.ok) await ctx.reply(r.message, { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
    },
    characters: async (ctx) => {
      const rows = db.getUserHuntCharacters(ctx.userId);
      await ctx.reply(hunt.collectionCaption(rows), { title: '⚔️ ANIME HUNT', color: THEME.gold, html: true });
    },
    viewchar: async (ctx) => {
      await viewChar(ctx);
    },
    vc: async (ctx) => {
      await viewChar(ctx);
    },
    clb: async (ctx) => {
      const n = Math.min(100, Math.max(1, parseInt((ctx.args || [])[0], 10) || 10));
      const rows = db.getHuntLeaderboard(n);
      await ctx.reply(hunt.leaderboardCaption(rows, n), { title: '⚔️ CHARACTER LEADERBOARD', color: THEME.gold, html: true });
    },

    // ----- memory -----
    remember: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can store memories. 👑', { title: '🧠 MEMORY', color: THEME.red });
      const args = ctx.args || [];
      if (args.length < 2) return ctx.reply('Usage: <code>/remember key value</code>', { title: '🧠 MEMORY', color: THEME.cyan, html: true });
      const key = args[0].toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const value = args.slice(1).join(' ').trim();
      memory.remember(key, value, 'bot_fact');
      await ctx.reply(`⟧ <b>Memory Stored</b>\\n\\n${key}: ${value}`, { title: '🧠 MEMORY', color: THEME.gold, html: true });
    },
    recall: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can recall memories. 👑', { title: '🧠 MEMORY', color: THEME.red });
      const key = (ctx.args || [])[0];
      if (!key) return ctx.reply('Usage: <code>/recall key</code>', { title: '🧠 MEMORY', color: THEME.cyan, html: true });
      const mem = memory.recall(key.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
      if (mem) {
        await ctx.reply(`🧠 <b>Memory</b>\\n\\n${mem.key}: ${mem.value}`, { title: '🧠 MEMORY', color: THEME.gold, html: true });
      } else {
        await ctx.reply(`🧠 No memory found for "${key}."`, { title: '🧠 MEMORY', color: THEME.cyan, html: true });
      }
    },
  };

  /* ---------- callback routing ---------- */

  async function onCallbackQuery(query) {
    const data = String(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const from = query.from || {};
    const userId = from.id;
    const ctx = buildCtx(query.message || { chat: { id: chatId }, from }, []);
    const pinfo = db.syncInfo();
    if (pinfo.configured && !pinfo.writable) {
      try { await bot.answerCallbackQuery(query.id, { text: 'Rimuru is in safe maintenance mode while the database recovers.', show_alert: true }); } catch (_) {}
      return;
    }

    const answerCb = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
    const editMsgCb = (text, opts = {}) => editMsg(chatId, messageId, text, opts);

    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply) await answerCb(check.reply);
      return;
    }

    try {
      if (data === 'gate:verify') {
        const res = await checkMembershipFresh(userId);
        if (res.ok) {
          await editMsg(chatId, messageId,
            `✅ <b>VERIFIED!</b>\n\nWelcome to the house, ${from.first_name || 'mortal'}. Everything is unlocked. 🎰`,
            { title: '✅ VERIFIED', color: THEME.gold, html: true });
          await answerCb('✅ Verified! Enjoy the casino.');
        } else {
          await answerCb('Still not a member — join the group first!');
        }
        return;
      }

      if (data.startsWith('menu:')) {
        const parts = data.split(':');
        const page = parts[1];

        if (page === 'main' || page === 'casino' || page === 'games' || page === 'economy') {
          await editMenu(chatId, messageId, page);
          await answerCb('');
          return;
        }

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
            `<b>🎮 Games</b>: /slots · /dice · /cf · /mines · /bj · /roulette · /hl · /guess · /race · /lottery\n` +
            `<b>💼 Economy</b>: /balance · /dep · /wd · /donate · /transfer\n` +
            `<b>🕵️ Crime</b>: /rob · /crime · /heist · /join\n` +
            `<b>🛒 Shop</b>: /shop · /buy · /inv\n` +
            `<b>🎣 Activities</b>: /fish · /dig\n` +
            `<b>💵 Income</b>: /beg · /work · /daily · /bonus\n` +
            `<b>👻 Sneaky</b>: /hide (vanish from robs &amp; heists for 60s)\n` +
            `<b>🏆</b> /lb · <b>📜</b> /menu · <b>✅</b> /verify · <b>👌</b> /health · <b>🏆</b> /rank\n` +
            `<b>💝</b> /waifu · /collection · /viewwaifu · /wlb\n` +
            `<b>⚔️</b> /hunt · /char · /characters · /viewchar · /clb\n` +
            `<b>👑 Staff</b>: /sb · /broadcast (/bd) · /set (/s) · /attack · /FBI (/SWAT) · /backup · /stop\n` +
            `💬 <i>Reply to me or say "Rimuru" to talk.</i>`,
            { title: '❓ HELP', color: THEME.gold, html: true });
          await answerCb('');
          return;
        }

        if (page === 'g' && parts[2] && GAME_USAGE[parts[2]]) {
          await replyThreaded(chatId, messageId, GAME_USAGE[parts[2]], { title: '🎮 GAME', color: THEME.cyan, html: true });
          await answerCb('');
          return;
        }

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

      if (data.startsWith('mines:')) {
        const parts = data.split(':');
        const action = parts[2];
        if (action === 'pick') await mines.onPick({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        if (action === 'cash') await mines.onCash({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('bj:')) {
        await blackjack.onAction({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('hl:')) {
        await higherlower.onAction({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('guess:')) {
        await guess.onPick({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('race:')) {
        await race.onPick({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('crash:')) {
        await crash.onCash({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('ttt:')) {
        await tictactoe.onAction({ data }, { bot, chatId, userId, reply: (t, o) => reply(chatId, t, o), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data === 'waifu:claim' || data.startsWith('waifu:claim')) {
        await waifu.claim(userId, { chatId, messageId, from, answerCb });
        return;
      }
      if (data === 'hunt:claim' || data.startsWith('hunt:claim')) {
        await hunt.claim(userId, { chatId, messageId, from, answerCb });
        return;
      }
      await answerCb('Unknown button.');
    } catch (e) {
      console.error('[callback] error:', e.message);
      lastError = e;
      await answerCb('Something went wrong.');
    }
  }

  /* ---------- dashboard: chat + game logging (best-effort) ---------- */

  function logGame(userId, meta, game, bet, result, amount) {
    try {
      db.logGameHistory({
        user_id: userId,
        username: meta.username || '',
        game,
        bet: bet || 0,
        result: result || '',
        amount: amount || 0,
      });
      rank.recordMatchResult(userId, bet || 0, result === 'win');
    } catch (e) { /* non-fatal */ }
  }

  /* ---------- message routing ---------- */

  const PAUSED_NOTICE = '🔒 Rimuru is paused for maintenance. Please try again later.';
  const PAUSE_EXEMPT_CMDS = ['run', 'backup', 'backups', 'restore', 'health', 'debug', 'stop', 'start', 'help'];
  const pausedNotified = new Set();

  function isPausedFor(msg) {
    if (!db.getBotPaused()) return false;
    const from = msg.from || {};
    if (String(from.id) === String(config.ownerId)) return false;
    const parsed = parseCommand(String(msg.text || msg.caption || ''));
    if (parsed && PAUSE_EXEMPT_CMDS.includes(parsed.cmd)) return false;
    const key = `${msg.chat.id}:${from.id}`;
    if (!pausedNotified.has(key)) {
      pausedNotified.add(key);
      try {
        bot.sendMessage(msg.chat.id, PAUSED_NOTICE).catch(() => {});
      } catch (e) { /* non-fatal */ }
    }
    return true;
  }

  const PERSISTENCE_EXEMPT_CMDS = new Set(['health', 'debug', 'help', 'start', 'verify', 'stop', 'run']);
  const PERSISTENCE_NOTICE = '🛠️ Rimuru is temporarily in safe maintenance mode while the database connection recovers. Your balance and progress are protected. Please try again shortly.';

  function isPersistenceBlockedFor(msg) {
    const info = db.syncInfo();
    if (!info.configured || info.writable) return false;
    const from = msg.from || {};
    const parsed = parseCommand(String(msg.text || msg.caption || ''));
    if (parsed && PERSISTENCE_EXEMPT_CMDS.has(parsed.cmd)) return false;
    try { bot.sendMessage(msg.chat.id, PERSISTENCE_NOTICE).catch(() => {}); } catch (_) {}
    return true;
  }

  async function onMessage(msg) {
    if (!msg.from || msg.from.is_bot) return;
    const text = String(msg.text || msg.caption || '');
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    try { attack.markSeen(userId); } catch (e) { /* non-fatal */ }
    if (isPersistenceBlockedFor(msg)) return;
    try {
      db.getOrCreateUser(userId, { username: msg.from.username || '', first_name: msg.from.first_name || '' });
    } catch (e) { /* non-fatal */ }
    if (isPausedFor(msg)) return;
    try { db.logChat(msg); } catch (e) { /* non-fatal */ }
    msg._replyTarget = msg.message_id;
    const ctx = buildCtx(msg, []);
    db.expirePenalties();
    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply && text.startsWith('/')) await reply(chatId, check.reply, { title: '⛔ BLOCKED', color: THEME.red });
      return;
    }
    await maybeReact(msg);
    const parsed = parseCommand(text);
    if (parsed) {
      const { cmd, args } = parsed;
      const handler = handlers[cmd];
      if (handler) {
        ctx.args = args;
        try {
          const staffCmds = ['ban', 'sus', 'mute', 'unban', 'unsus', 'unmute', 'restart', 'addcoin', 'sb', 'broadcast', 'bd', 'set', 's', 'xleaderboard', 'xlb', 'debug', 'backup', 'backups', 'restore', 'redeem', 'stop', 'run', 'attack', 'fbi', 'swat'];
          if (!isStaff(ctx.userId) && !['start', 'help', 'verify'].includes(cmd) && !staffCmds.includes(cmd)) {
            const gate = await gateAllowed(ctx.userId);
            if (!gate.ok) {
              const p = gatePrompt(chatId);
              await reply(chatId, p.text, p.opts);
              return;
            }
          }
          await handler(ctx);
        } catch (e) {
          console.error(`[cmd /${cmd}] error:`, e.message, e.stack);
          lastError = e;
          await reply(chatId, `⚠️ Something went wrong with /${cmd}. Try again.`, { title: '💥 ERROR', color: THEME.red });
        }
        return;
      }
    }

    const kbRoute = keyboards.routeButton(text);
    if (kbRoute) {
      if (kbRoute.back) {
        await reply(chatId, `✨️ <b>Main menu</b> — pick a category.`, {
          title: '🐉 RIMURU CASINO', color: THEME.cyan, html: true,
          reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor('main') : undefined,
        });
        return;
      }
      if (kbRoute.page) {
        const pageTexts = {
          casino: MENU.casino().text,
          games: MENU.games().text,
          economy: MENU.economy().text,
        };
        await reply(chatId, pageTexts[kbRoute.page] || '', {
          title: kbRoute.page === 'casino' ? '🎰 CASINO' : kbRoute.page === 'games' ? '🎮 GAMES' : '💼 ECONOMY',
          color: THEME.cyan, html: true,
          reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor(kbRoute.page) : undefined,
        });
        return;
      }
      const handler = handlers[kbRoute.cmd];
      if (handler) {
        ctx.args = [];
        try {
          await handler(ctx);
        } catch (e) {
          console.error(`[kb /${kbRoute.cmd}] error:`, e.message, e.stack);
          await reply(chatId, `⚠️ Something went wrong with that button. Try again.`, { title: '💥 ERROR', color: THEME.red });
        }
        return;
      }
    }

    try {
      if (await attack.handleInput(userId, chatId, text)) return;
    } catch (e) { console.error('[attack] handleInput error:', e.message); }

    try {
      if (await fbi.handleInput(userId, chatId, text)) return;
    } catch (e) { console.error('[fbi] handleInput error:', e.message); }

    const isReplyToBot = msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot === true &&
      rimuruMessageIds.has(msg.reply_to_message.message_id);
    if (rimuru.shouldTrigger(text) || isReplyToBot) {
      if (!isStaff(userId)) {
        const gate = await gateAllowed(userId);
        if (!gate.ok) {
          const p = gatePrompt(chatId);
          await reply(chatId, p.text, p.opts);
          return;
        }
      }
      const from = msg.from;
      const owner = isOwner(userId);
      const name = from.first_name || from.username || 'mortal';
      try {
        const ans = await rimuru.reply(text, {
          id: userId, first_name: name, username: from.username,
          isOwner: owner, isStaff: isStaff(userId),
        });
        const textPromise = reply(chatId, ans, { title: '🐉 RIMURU', color: THEME.gold, reply_to_message_id: msg.message_id });
        const sent = await textPromise;
        if (sent && sent.message_id != null) markRimuruMessage(sent.message_id);
        await stickerAfterText(chatId, Promise.resolve(sent));
      } catch (e) {
        console.error('[rimuru] reply error:', e.message);
        lastError = e;
        await reply(chatId, 'Hmph. The void ate my words. Try again, mortal.', { title: '🐉 RIMURU', color: THEME.gold, reply_to_message_id: msg.message_id });
      }
      return;
    }
  }

  let botMeId = null;
  bot.getMe().then((me) => {
    botMeId = me.id;
    return bot.setMyCommands(MENU_COMMANDS)
      .then(() => bot.setChatMenuButton({ menu_button: { type: 'commands' } }))
      .then(() => bot.getMyCommands());
  }).then((cmds) => {
    console.log(`✰ Persistent command menu registered (setMyCommands): ${cmds.map((c) => `/${c.command}`).join(' ')}`);
  }).catch((e) => {
    console.warn('[boot] getMe/setMyCommands failed:', e.message);
  });

  try {
    dashboard.setActiveBot(bot);
  } catch (e) { /* non-fatal */ }
  setInterval(() => {
    try {
      let drained = 0;
      const sender = makeBroadcastSender();
      for (let item = dashboard.drainBroadcastQueue(sender); item; item = dashboard.drainBroadcastQueue(sender)) {
        drained++;
        if (drained >= 50) break;
      }
      if (drained) console.log(`[dashboard] drained ${drained} broadcast(s)`);
    } catch (e) {
      console.error('[dashboard] drain error:', e.message);
    }
  }, 10000);

  function makeBroadcastSender() {
    return (item, done) => {
      let count = 0;
      const target = item.target || 'all';
      const chats = new Set();
      try {
        for (const cid of db.getSeenChatIds()) chats.add(Number(cid));
      } catch (e) { /* non-fatal */ }
      let list = [...chats];
      if (target === 'groups') list = list.filter((c) => c < 0);
      else if (target === 'users') list = list.filter((c) => c > 0);
      list = [...new Set(list)].slice(0, target === 'all' ? 1000 : 500);
      (async () => {
        for (const cid of list) {
          try {
            await bot.sendMessage(cid, item.message, { parse_mode: 'HTML' });
            count++;
          } catch (e) { /* skip unreachable chats */ }
        }
        done(count);
        console.log(`[dashboard] broadcast #${item.id} (${target}) delivered to ${count}/${list.length} chats`);
      })().catch(() => done(count));
    };
  }

  try {
    attack.attach({
      reply: (chatId, text, opts) => reply(chatId, text, opts),
      announce: (text) => {
        const rec = db.createBroadcast(text, 'all', Number(config.ownerId));
        dashboard.queueBroadcast(rec.id, rec.message, 'all');
        return Promise.resolve();
      },
      group: async (text, opts) => {
        const groups = db.getSeenChatIds().filter((cid) => Number(cid) < 0);
        for (const gid of groups) {
          try { await reply(gid, text, opts); } catch (e) { /* non-fatal */ }
        }
      },
    });
    attack.startRandomScheduler();
  } catch (e) {
    console.error('[attack] wiring failed:', e.message);
  }

  try {
    fbi.attach({
      reply: (chatId, text, opts) => reply(chatId, text, opts),
      announce: (text) => {
        const rec = db.createBroadcast(text, 'all', Number(config.ownerId));
        dashboard.queueBroadcast(rec.id, rec.message, 'all');
        return Promise.resolve();
      },
    });
  } catch (e) {
    console.error('[fbi] wiring failed:', e.message);
  }

  try {
    waifu.attach({
      reply: (chatId, text, opts) => reply(chatId, text, opts),
      sendPhoto: (chatId, imageUrl, opts) => bot.sendPhoto(chatId, imageUrl, opts),
      answerCb: (text) => bot.answerCallbackQuery(text && text.query_id ? text.query_id : undefined, text && text.text ? { text: text.text } : {}).catch(() => {}),
    });
  } catch (e) {
    console.error('[waifu] wiring failed:', e.message);
  }

  try {
    hunt.attach({
      reply: (chatId, text, opts) => reply(chatId, text, opts),
      sendPhoto: (chatId, imageUrl, opts) => bot.sendPhoto(chatId, imageUrl, opts),
      answerCb: (text) => bot.answerCallbackQuery(text && text.query_id ? text.query_id : undefined, text && text.text ? { text: text.text } : {}).catch(() => {}),
    });
  } catch (e) {
    console.error('[hunt] wiring failed:', e.message);
  }

  bot.on('message', onMessage);
  bot.on('callback_query', onCallbackQuery);

  try {
    waifu.startAutoSpawn(bot, { getChatIds: db.getSeenChatIds });
  } catch (e) { console.error('[waifu] auto-spawn wiring failed:', e.message); }

  try {
    hunt.startAutoSpawn(bot, { getChatIds: db.getSeenChatIds });
  } catch (e) { console.error('[hunt] auto-spawn wiring failed:', e.message); }

  setInterval(() => {
    const expired = db.expirePenalties();
    for (const u of expired) {
      console.log(`[admin] ${u.status} expired for user ${u.user_id}`);
    }
  }, 30000);

  setInterval(() => {
    try { attack.sweep(); } catch (e) { console.error('[attack] sweep error:', e.message); }
  }, 5000);

  setInterval(() => {
    try { fbi.sweep(); } catch (e) { console.error('[fbi] sweep error:', e.message); }
  }, 5000);

  setInterval(() => {
    try { waifu.expireIfNeeded(); } catch (e) { console.error('[waifu] sweep error:', e.message); }
  }, 30000);

  setInterval(() => {
    try { hunt.expireIfNeeded(); } catch (e) { console.error('[hunt] sweep error:', e.message); }
  }, 30000);

  setInterval(() => {
    try { timewallet.sweep(); } catch (e) { console.error('[rank] time-wallet sweep error:', e.message); }
  }, 60000);

  let lastPeak = rank.isPeakHour();
  setInterval(() => {
    try {
      const nowPeak = rank.isPeakHour();
      if (nowPeak && !lastPeak) {
        const rec = db.createBroadcast('🌞 <b>PEAK HOURS STARTED</b>\n\nEvery game is now a flat 50/50 until 11:00 WAT. Good luck, mortals!', 'all', Number(config.ownerId));
        dashboard.queueBroadcast(rec.id, rec.message, 'all');
        console.log('[rank] peak hours STARTED (08:00 WAT) — flat 50/50 engaged');
      } else if (!nowPeak && lastPeak) {
        const rec = db.createBroadcast('🌙 <b>PEAK HOURS ENDED</b>\n\nRank-based win chances are back. Top ranks face worse odds — the house protects its whales.', 'all', Number(config.ownerId));
        dashboard.queueBroadcast(rec.id, rec.message, 'all');
        console.log('[rank] peak hours ENDED (11:00 WAT) — rank-tier odds restored');
      }
      lastPeak = nowPeak;
    } catch (e) { console.error('[rank] peak-hour scheduler error:', e.message); }
  }, 60000);

  bot.on('polling_error', (err) => {
    console.error('[polling] error:', err.message);
  });

  return bot;
}

module.exports = { createBot, MENU_COMMANDS };
