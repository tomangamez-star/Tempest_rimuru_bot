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

const config = require('./config');
const db = require('./db');
const eco = require('./economy');
const cd = require('./cooldowns');
const admin = require('./admin');
const leaderboard = require('./leaderboard');
const rimuru = require('./rimuru');
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
const dashboard = require('./dashboard/server');

// In-memory heist timers (leaderId -> timeout)
const heistTimers = new Map();

// Health/debug state for /debug (staff-only)
let lastError = null;
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
];

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
    crash: '💥 <b>Crash</b>\n<code>/crash [amount]</code>\nThe multiplier rockets up — cash out before it crashes. Long rides pay big. 💥',
    wheel: '🎡 <b>Wheel of Fortune</b>\n<code>/wheel [amount]</code>\nSpin a 12-segment wheel — 0.5x to 10x. Lady luck decides. 🎰',
    rps: '✊ <b>Rock Paper Scissors</b>\n<code>/rps [rock|paper|scissors] [amount]</code>\nBeat the house. Tie = half back. ✋✌️',
    ttt: '⭕ <b>Tic-Tac-Toe</b>\n<code>/ttt [amount]</code>\nBeat the house at tic-tac-toe. Win = 1.8x, draw = half back. ❌',
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
        `• /ttt [amt] — tic-tac-toe vs the house ⭕❌\n` +
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
        `• /id — your ID card\n\n` +
        `<b>🕹️ Other</b>\n` +
        `• /race [amt] — race against the house\n` +
        `• /hide — 50M coins, vanish from robs &amp; heists for 60s\n` +
        `• /redeem [CODE] — claim a code (coins go to BANK)\n` +
        `• /verify — re-check your group membership\n` +
        `• /health — bot health &amp; persistence status (anyone)\n\n` +
        `<b>👑 Staff</b>\n` +
        `• /redeem create [CODE] [AMT] [USES] — mint a code (mods capped at 50M)\n` +
        `• /redeem list · /redeem delete [CODE] · /backup · /backups · /restore [id]\n` +
        `• /stop — pause the bot for maintenance (owner) · /run — resume\n\n` +
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
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'coinflip', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    coinflip: async (ctx) => {
      const r = await coinflip.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'coinflip', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    mines: async (ctx) => mines.play(ctx),
    bj: async (ctx) => blackjack.play(ctx),
    blackjack: async (ctx) => blackjack.play(ctx),
    roulette: async (ctx) => {
      const r = await roulette.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'roulette', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    hl: async (ctx) => higherlower.play(ctx),
    higherlower: async (ctx) => higherlower.play(ctx),
    guess: async (ctx) => guess.play(ctx),
    guessthenumber: async (ctx) => guess.play(ctx),
    race: async (ctx) => {
      const r = await race.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'race', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },

    // ----- new games -----
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
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'ttt', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    tictactoe: async (ctx) => {
      const r = await tictactoe.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'ttt', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    duel: async (ctx) => {
      const r = await dicevs.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'duel', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    cfs: async (ctx) => {
      const r = await cfstreak.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'cfs', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    coinflipstreak: async (ctx) => {
      const r = await cfstreak.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'cfs', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    num: async (ctx) => {
      const r = await numroulette.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'num', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },
    numroulette: async (ctx) => {
      const r = await numroulette.play(ctx);
      if (r && typeof r.won === 'boolean') logGame(ctx.userId, metaOf(ctx.msg), 'num', ctx.args[0], r.won ? 'win' : 'lose', r.net);
    },

    // ----- events & missions (created from the admin dashboard) -----
    missions: async (ctx) => {
      await ctx.reply(missions.listMissions(), { title: '📜 MISSIONS', color: THEME.gold, html: true });
    },
    mission: async (ctx) => {
      const id = ctx.args[0] ? Number(ctx.args[0]) : null;
      const r = missions.attemptMission(ctx.userId, metaOf(ctx.msg), id);
      await ctx.reply(r.message, { title: r.win ? '✅ MISSION' : '📜 MISSION', color: r.win ? THEME.gold : THEME.red, html: true });
    },
    heistrimuru: async (ctx) => {
      const g = cd.guard(ctx.userId, 'mission', 'Heist Rimuru');
      if (g.blocked) return ctx.reply(g.message, { title: '🎭 EVENT', color: THEME.red });
      const r = missions.heistRimuru(ctx.userId, metaOf(ctx.msg));
      cd.start(ctx.userId, 'mission', missions.MISSION_COOLDOWN_MS);
      await ctx.reply(r.message, { title: '🎭 EVENT', color: r.win ? THEME.gold : THEME.red, html: true });
    },
    fightrimuru: async (ctx) => {
      const g = cd.guard(ctx.userId, 'mission', 'Fight Rimuru');
      if (g.blocked) return ctx.reply(g.message, { title: '⚔️ EVENT', color: THEME.red });
      const r = missions.fightRimuru(ctx.userId, metaOf(ctx.msg));
      cd.start(ctx.userId, 'mission', missions.MISSION_COOLDOWN_MS);
      await ctx.reply(r.message, { title: '⚔️ EVENT', color: r.win ? THEME.gold : THEME.red, html: true });
    },

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
      if (!target) return ctx.reply('Reply to someone with <code>/rob</code>. 🎯', { title: '🦹 ROBBERY', color: THEME.red, html: true });
      const g = cd.guard(ctx.userId, 'rob', 'Robbery');
      if (g.blocked) return ctx.reply(g.message, { title: '🦹 ROBBERY', color: THEME.red });
      const r = robbery.attempt(ctx.userId, target.id, metaOf(ctx.msg));
      if (r.ok) cd.start(ctx.userId, 'rob', config.cooldowns.rob);
      await ctx.reply(r.message, { title: '🦹 ROBBERY', color: THEME.red });
    },

    heist: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/heist</code>. 🎯', { title: '🏦 HEIST', color: THEME.red, html: true });
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
        const open = db.getOpenHeists();
        const fullCrew = open.some((o) => o.members.length >= config.heist.maxMembers);
        await ctx.reply(r.message, { title: '🤝 JOIN HEIST', color: THEME.red });
        if (fullCrew) {
          const full = open.find((o) => o.members.length >= config.heist.maxMembers);
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
    fish: async (ctx) => { const r = fishing.fish(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { title: '🎣 FISH', color: THEME.cyan }); },
    dig: async (ctx) => { const r = income.earn(ctx.userId, 'dig', metaOf(ctx.msg)); await ctx.reply(r.message, { title: '⛏️ DIG', color: THEME.cyan }); },
    daily: async (ctx) => { const r = income.daily(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { title: '📅 DAILY', color: THEME.gold }); },
    bonus: async (ctx) => { const r = income.bonus(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { title: '🎁 BONUS', color: THEME.gold }); },

    // ----- shop / crime -----
    shop: async (ctx) => { await ctx.reply(shop.shopList(), { title: '🛒 RIMURU\'S SHOP', color: THEME.gold, html: true }); },
    store: async (ctx) => { await ctx.reply(shop.shopList(), { title: '🛒 RIMURU\'S SHOP', color: THEME.gold, html: true }); },
    buy: async (ctx) => {
      const id = ctx.args[0];
      if (!id) return ctx.reply('🎯 Usage: <code>/buy [id] [qty]</code> — e.g. <code>/buy 4</code> or <code>/buy hook 2</code>. Check <code>/shop</code> first.', { title: '🛒 BUY', color: THEME.red, html: true });
      const r = shop.buyItem(ctx.userId, id, ctx.args[1], metaOf(ctx.msg));
      await ctx.reply(r.message, { title: r.ok ? '✅ PURCHASED' : '🛒 BUY', color: r.ok ? THEME.gold : THEME.red, html: true });
    },
    inv: async (ctx) => { await ctx.reply(shop.inventoryText(ctx.userId), { title: '📦 INVENTORY', color: THEME.cyan, html: true }); },
    inventory: async (ctx) => { await ctx.reply(shop.inventoryText(ctx.userId), { title: '📦 INVENTORY', color: THEME.cyan, html: true }); },
    crime: async (ctx) => {
      const g = cd.guard(ctx.userId, 'crime', 'Crime');
      if (g.blocked) return ctx.reply(g.message, { title: '🕵️ CRIME', color: THEME.red });
      const r = crime.commit(ctx.userId, ctx.args[0], metaOf(ctx.msg));
      if (r.ok) cd.start(ctx.userId, 'crime', config.cooldowns.rob);
      await ctx.reply(r.message, { title: r.ok ? (r.success ? '✅ CRIME' : '🚔 CRIME') : '🕵️ CRIME', color: r.ok ? (r.success ? THEME.gold : THEME.red) : THEME.red, html: true });
    },

    // ----- hide: vanish from robs & heists for 60s -----
    hide: async (ctx) => {
      const g = cd.guard(ctx.userId, 'hide', 'Hiding');
      if (g.blocked) return ctx.reply(g.message, { title: '\ud83d\udc80 HIDE', color: THEME.red });
      const price = config.hide.price;
      const charge = eco.chargeWallet(ctx.userId, price, 'hide');
      if (!charge.ok) return ctx.reply(charge.message, { title: '\ud83d\udc80 HIDE', color: THEME.red });
      db.setHidden(ctx.userId, Date.now() + config.hide.durationMs);
      cd.start(ctx.userId, 'hide', config.cooldowns.hide);
      db.logActivity('user', `\ud83d\udc80 /hide by ${metaOf(ctx.msg).username || ctx.userId}`, { target: ctx.userId, cost: price });
      await ctx.reply(
        `\ud83d\udc80 <b>YOU VANISHED</b>\n\n` +
        `You paid <b>${fmt(price)}</b> to slip into the shadows.\n` +
        `For <b>60 seconds</b> nobody can <code>/rob</code> or <code>/heist</code> you.\n` +
        `\ud83d\udc5b Wallet: <b>${fmt(eco.balance(ctx.userId).wallet)}</b>`,
        { title: '\ud83d\udc80 HIDE', color: THEME.cyan, html: true }
      );
    },

    // ----- leaderboard -----
    lb: async (ctx) => { await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true }); },
    leaderboard: async (ctx) => { await ctx.reply(leaderboard.render(), { title: '🏆 LEADERBOARD', color: THEME.gold, html: true }); },

    // ----- profile / badges / id -----
    p: async (ctx) => { await ctx.reply(profile.profileText(ctx, ctx.userId), { title: '🪪 PROFILE', color: THEME.gold, html: true }); },
    profile: async (ctx) => { await ctx.reply(profile.profileText(ctx, ctx.userId), { title: '🪪 PROFILE', color: THEME.gold, html: true }); },
    badges: async (ctx) => { await ctx.reply(profile.badgesText(ctx, ctx.userId), { title: '🏅 BADGES', color: THEME.gold, html: true }); },
    id: async (ctx) => { await ctx.reply(profile.idCardText(ctx, ctx.userId), { title: '🪪 ID CARD', color: THEME.cyan, html: true }); },

    // ----- admin (owner only) -----
    ban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/ban [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.BANNED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — BAN', color: THEME.red });
    },
    sus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/sus [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.SUSPECTED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — SUSPEND', color: THEME.red });
    },
    mute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/mute [reason]</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.MUTED, reason, dur);
      await ctx.reply(r.message, { title: '👑 ADMIN — MUTE', color: THEME.red });
    },
    unban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unban</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNBAN', color: THEME.cyan });
    },
    unsus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unsus</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNSUSPEND', color: THEME.cyan });
    },
    unmute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('Reply to someone with <code>/unmute</code>. 🎯', { title: '👑 ADMIN', color: THEME.red, html: true });
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { title: '👑 ADMIN — UNMUTE', color: THEME.cyan });
    },

    // ----- /stop & /run — maintenance pause (owner only, persisted) -----
    // While paused Rimuru ignores ALL non-owner users in groups AND DMs
    // (commands, games, button taps, chat). The owner stays exempt so they
    // can always /run, /backup, /restore, /health. The flag lives in the DB
    // (SQLite + Postgres) so the pause survives redeploys.
    stop: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '🔒 PAUSE', color: THEME.red });
      db.setBotPaused(true);
      db.logActivity('mod', `/stop by ${metaOf(ctx.msg).username || ctx.userId} — bot PAUSED`, { target: ctx.userId });
      await ctx.reply(
        `🔒 <b>RIMURU PAUSED</b>\n\n` +
        `All non-owner users are now ignored — no commands, no games, no button taps.\n` +
        `The pause is <b>persisted</b> and survives redeploys.\n\n` +
        `Resume with <code>/run</code>. The house is closed. 🚪`,
        { title: '🔒 PAUSE', color: THEME.red, html: true }
      );
    },
    run: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '▶️ RESUME', color: THEME.red });
      db.setBotPaused(false);
      pausedNotified.clear(); // fresh notices after resume
      db.logActivity('mod', `/run by ${metaOf(ctx.msg).username || ctx.userId} — bot RESUMED`, { target: ctx.userId });
      await ctx.reply(
        `▶️ <b>RIMURU RESUMED</b>\n\n` +
        `The house is open again. Welcome back, mortals. 🎰`,
        { title: '▶️ RESUME', color: THEME.gold, html: true }
      );
    },

    // ----- staff reset: clear ALL active state (owner + moderators) -----
    restart: async (ctx) => {
      if (!isStaff(ctx.userId)) return ctx.reply('Only the King and his moderators can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const actor = metaOf(ctx.msg);
      db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'restart', 0, 'full state reset');
      db.logActivity('mod', `/restart by ${actor.username || ctx.userId}`, { target: ctx.userId });
      const cleared = [];

      // 1) In-memory game sessions
      for (const [userId, s] of mines.sessions) { s.alive = false; cleared.push(`mines:${userId}`); }
      mines.sessions.clear();
      for (const [userId, s] of blackjack.sessions) { s.done = true; cleared.push(`blackjack:${userId}`); }
      blackjack.sessions.clear();
      for (const [userId, s] of higherlower.sessions) { s.alive = false; cleared.push(`higherlower:${userId}`); }
      higherlower.sessions.clear();
      for (const userId of race.sessions.keys()) { cleared.push(`race:${userId}`); }
      race.sessions.clear();

      // 2) Open heists (DB) + their timers
      const openHeists = db.getOpenHeists();
      for (const row of openHeists) {
        const timer = heistTimers.get(row.leader_id);
        if (timer) clearTimeout(timer);
        heistTimers.delete(row.leader_id);
        db.deleteHeist(row.leader_id);
        cleared.push(`heist:${row.leader_id}`);
      }

      // 3) All cooldowns
      const cdRows = db.db.prepare('SELECT user_id, action FROM cooldowns').all();
      for (const row of cdRows) cleared.push(`cd:${row.user_id}:${row.action}`);
      db.clearAllCooldowns();

      // 4) Reset lottery state
      db.saveLottery(config.lottery.baseJackpot, 0, []);
      cleared.push('lottery');

      await ctx.reply(
        `🔄 <b>RESTART COMPLETE</b>\n\n` +
        `Cleared <b>${cleared.length}</b> active state entries:\n` +
        `• Active games: mines, blackjack, higher/lower, race\n` +
        `• Open heists & timers\n` +
        `• All cooldowns\n` +
        `• Lottery pot reset to ${fmt(config.lottery.baseJackpot)}\n\n` +
        `The house is clean. Everything starts fresh. ✨`,
        { title: '👑 ADMIN — RESTART', color: THEME.gold, html: true }
      );
    },

    // ----- staff coin commands (owner + dashboard moderators) -----
    addcoin: async (ctx) => {
      const r = staffCoin(ctx, 'add');
      await ctx.reply(r.message, { title: r.title, color: r.color, html: true });
    },
    sb: async (ctx) => {
      const r = staffCoin(ctx, 'set');
      await ctx.reply(r.message, { title: r.title, color: r.color, html: true });
    },

    // ----- group gate -----
    verify: async (ctx) => verifyCommand(ctx),

    // ----- staff health dump (owner + moderators) -----
    debug: async (ctx) => {
      if (!isStaff(ctx.userId)) {
        return ctx.reply('Only staff can do that. 👑', { title: '🔒 STAFF ONLY', color: THEME.red });
      }
      try {
        const pkg = require('../package.json');
        const stats = db.dashboardStats();
        const cdCount = db.getCooldownCount();
        const mem = process.memoryUsage();
        const gid = await resolveRequiredGroup();
        const pInfo = db.syncInfo();
        const pgStatus = pInfo.configured
          ? (pInfo.ready && pInfo.connected ? `✅ connected (${pInfo.host}:${pInfo.port})` : `❌ ${pInfo.host}:${pInfo.port} — ${pInfo.lastPgError || 'connecting…'}`)
          : 'off (SQLite-only, ephemeral)';
        // Verified write-through status — shows whether writes actually LAND in Postgres.
        const verified = pInfo.configured
          ? `✅ writes: ${pInfo.writesOk} · failures: ${pInfo.writesFailed} · last write ${pInfo.lastWriteAt ? `${Math.floor((Date.now() - pInfo.lastWriteAt) / 1000)}s ago` : 'never'} · verified ${pInfo.lastVerifyAt ? `${Math.floor((Date.now() - pInfo.lastVerifyAt) / 1000)}s ago` : 'never'}`
          : 'n/a';
        const lines = [
          `🤖 <b>Version</b>: ${pkg.version || 'n/a'} (${commitHash || 'n/a'})`,
          `⏱ <b>Uptime</b>: ${humanDuration(Math.floor(process.uptime() * 1000))}`,
          `🏓 <b>Ping</b>: ${db.ping()}ms`,
          `👥 <b>Users</b>: ${fmt(stats.totalUsers)} (${fmt(stats.activeUsers)} active)`,
          `👪 <b>Groups</b>: ${fmt(stats.totalGroups)}`,
          `💰 <b>Coins in circulation</b>: ${fmt(stats.coinsInCirculation)}`,
          `⏳ <b>Active cooldowns</b>: ${fmt(cdCount)}`,
          `🔒 <b>Required group</b>: ${config.requiredGroup || 'off'} (chat ${gid || 'unresolved'})`,
          `🗄 <b>Persistence</b>: ${pgStatus}${pInfo.configured ? ` (mirrors: ${pInfo.lastMirrorAt ? 'running' : 'pending'})` : ''}`,
          `✔️ <b>Verified writes</b>: ${verified}`,
          `Auto-backup: ${(() => { try { const bs = backup.getBackupState(); return `on · ${bs.schedule} · keep ${bs.keep} · ran ${bs.runCount} · suspect ${bs.suspectCount}`; } catch (e) { return 'n/a'; } })()}`,
          `💾 <b>Memory</b>: rss ${fmt(Math.round(mem.rss / 1048576))} MB · heap ${fmt(Math.round(mem.heapUsed / 1048576))} MB`,
          `⚠️ <b>Last error</b>: ${lastError ? String(lastError.message || lastError).slice(0, 200) : 'none'}`,
        ];
        const actor = metaOf(ctx.msg);
        db.logAudit(ctx.userId, actor.username || String(ctx.userId), 'debug', 0, 'staff debug dump');
        db.logActivity('mod', `/debug by ${actor.username || ctx.userId}`, { target: ctx.userId });
        await ctx.reply(lines.join('\n'), { title: '🛠 DEBUG', color: THEME.cyan, html: true });
      } catch (e) {
        await ctx.reply(`⚠️ Debug failed: ${e.message}`, { title: '🛠 DEBUG', color: THEME.red });
      }
    },

    // ----- health: everyone can check the bot is alive (no staff gate) -----
    health: async (ctx) => {
      try {
        const pkg = require('../package.json');
        const stats = db.dashboardStats();
        const mem = process.memoryUsage();
        const pInfo = db.syncInfo();
        const pgStatus = pInfo.configured
          ? (pInfo.ready && pInfo.connected ? `✅ connected (${pInfo.host}:${pInfo.port})` : `❌ ${pInfo.host}:${pInfo.port} — ${pInfo.lastPgError || 'connecting…'}`)
          : 'off (SQLite-only, ephemeral)';
        // Verified write-through status — shows whether writes actually LAND in Postgres.
        const verified = pInfo.configured
          ? `✅ writes: ${pInfo.writesOk} · failures: ${pInfo.writesFailed} · last write ${pInfo.lastWriteAt ? `${Math.floor((Date.now() - pInfo.lastWriteAt) / 1000)}s ago` : 'never'} · verified ${pInfo.lastVerifyAt ? `${Math.floor((Date.now() - pInfo.lastVerifyAt) / 1000)}s ago` : 'never'}`
          : 'n/a';
        const lines = [
          `🤖 <b>Version</b>: ${pkg.version || 'n/a'} (${commitHash || 'n/a'})`,
          `⏱ <b>Uptime</b>: ${humanDuration(Math.floor(process.uptime() * 1000))}`,
          `🏓 <b>Ping</b>: ${db.ping()}ms`,
          `👥 <b>Users</b>: ${fmt(stats.totalUsers)}`,
          `👪 <b>Groups</b>: ${fmt(stats.totalGroups)}`,
          `💰 <b>Coins in circulation</b>: ${fmt(stats.coinsInCirculation)}`,
          `🗄 <b>Persistence</b>: ${pgStatus}${pInfo.configured ? ` (mirrors: ${pInfo.lastMirrorAt ? 'running' : 'pending'})` : ''}`,
          `✔️ <b>Verified writes</b>: ${verified}`,
          `💾 <b>Memory</b>: rss ${fmt(Math.round(mem.rss / 1048576))} MB · heap ${fmt(Math.round(mem.heapUsed / 1048576))} MB`,
          `⚠️ <b>Last error</b>: ${lastError ? String(lastError.message || lastError).slice(0, 200) : 'none'}`,
        ];
        await ctx.reply(lines.join('\n'), { title: '👌 HEALTH', color: THEME.cyan, html: true });
      } catch (e) {
        await ctx.reply(`⚠️ Health check failed: ${e.message}`, { title: '👌 HEALTH', color: THEME.red });
      }
    },

    // ----- owner-only backup / restore (safety net) -----
    backup: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const r = backup.backup();
      db.logAudit(ctx.userId, metaOf(ctx.msg).username || String(ctx.userId), 'backup', 0, 'owner backup dump');
      await ctx.reply(r.message, { title: r.ok ? '📦 BACKUP' : '❌ BACKUP', color: r.ok ? THEME.gold : THEME.red, html: true });
    },
    // ----- staff backup listing + targeted restore (owner confirmation) -----
    backups: async (ctx) => {
      if (!isStaff(ctx.userId)) return ctx.reply('Only staff can do that. 👑', { title: '🔒 STAFF ONLY', color: THEME.red });
      const list = backup.listBackups(15);
      if (!list.length) {
        return ctx.reply('No backups yet. Run <code>/backup</code> to create one.', { title: '📦 BACKUPS', color: THEME.cyan, html: true });
      }
      const lines = list.map((b) => {
        const when = new Date(b.ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const flag = b.suspect ? ' ⚠️ SUSPECT' : '';
        const uc = Number.isFinite(Number(b.userCount)) ? Number(b.userCount) : 0;
        return `• <b>${b.source === 'postgres' ? '🗄️' : '📄'} ${b.id}</b> — ${when}${flag}\n` +
               `  <code>${b.filename}</code> · ${fmt(uc)} users`;
      });
      await ctx.reply(
        `<b>AVAILABLE BACKUPS</b> (${list.length})\n\n${lines.join('\n')}\n\n` +
        `Restore one with <code>/restore &lt;id&gt;</code> (owner). ⚠️ SUSPECT snapshots may be a regressed state — prefer a non-suspect one.`,
        { title: '📦 BACKUPS', color: THEME.cyan, html: true }
      );
    },
    restore: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('Only the King can do that. 👑', { title: '👑 ADMIN', color: THEME.red });
      const idArg = (ctx.args && ctx.args[0]) ? Number(ctx.args[0]) : NaN;
      let r;
      if (Number.isFinite(idArg) && idArg > 0) {
        // Targeted restore by id — always logged; caller confirmed the id.
        r = backup.restoreById(idArg);
      } else {
        r = backup.restore(); // newest GOOD backup only (never a suspect)
      }
      db.logAudit(ctx.userId, metaOf(ctx.msg).username || String(ctx.userId), 'restore', 0, Number.isFinite(idArg) && idArg > 0 ? `restore by id ${idArg}` : 'restore newest good');
      await ctx.reply(r.message, { title: r.ok ? '♻️ RESTORE' : '❌ RESTORE', color: r.ok ? THEME.gold : THEME.red, html: true });
    },

    // ----- redeem codes: /redeem [CODE] (user) · create/list/delete (staff) -----
    redeem: async (ctx) => {
      const args = ctx.args || [];
      const sub = String(args[0] || '').toLowerCase();
      const rest = args.slice(1);
      let r;
      if (sub === 'create') {
        r = redeem.createCode(ctx.userId, rest, metaOf(ctx.msg));
      } else if (sub === 'list') {
        r = redeem.listCodes(ctx.userId);
      } else if (sub === 'delete') {
        r = redeem.deleteCode(ctx.userId, rest[0], metaOf(ctx.msg));
      } else {
        r = redeem.redeemCode(ctx.userId, args[0], metaOf(ctx.msg));
      }
      await ctx.reply(r.message, {
        title: '🎟️ REDEEM', color: r.ok ? THEME.gold : THEME.red, html: true,
      });
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

  /**
   * /addcoin <amount> [@username | reply] — add coins to a user's wallet.
   * /sb <amount> [@username | reply]     — set a user's wallet exactly.
   * Owner + dashboard moderators only (moderators table in the dashboard DB).
   * No target → the command sender. Amount must be a positive number.
   */
  function staffCoin(ctx, mode) {
    if (!isAuthorized(ctx.userId)) {
      return {
        title: '🔒 STAFF ONLY',
        color: THEME.red,
        message: 'Only the King and his moderators can do that. 👑',
      };
    }
    const raw = String((ctx.args || [])[0] || '').trim();
    const amt = Math.floor(Number(raw.replace(/,/g, '')));
    if (!Number.isFinite(amt) || amt <= 0) {
      return {
        title: mode === 'add' ? '➕ ADDCOIN' : '🎯 SET BALANCE',
        color: THEME.red,
        message: `Usage: <code>/${mode} [amount] [@username or reply]</code> — amount must be a positive number.`,
      };
    }
    // Target resolution: replied-to user > @username > the sender
    let targetId = ctx.userId;
    const replied = repliedUser(ctx.msg);
    const mention = (ctx.args || []).find((a) => String(a).startsWith('@'));
    if (replied) {
      targetId = replied.id;
    } else if (mention) {
      const uname = String(mention).slice(1).toLowerCase();
      const row = db.findUserByUsername(uname);
      if (!row) {
        return {
          title: '❓ UNKNOWN USER',
          color: THEME.red,
          message: `No user found for <code>@${uname}</code> — they must /start the bot first.`,
        };
      }
      targetId = row.user_id;
    }
    const actor = metaOf(ctx.msg);
    const target = db.getOrCreateUser(targetId);
    if (mode === 'add') db.addWallet(targetId, amt);
    else db.setWallet(targetId, amt);
    const after = db.getUser(targetId);
    db.logActivity('admin', `/${mode} ${fmt(amt)} -> ${target.first_name || targetId} by ${actor.username || ctx.userId}`, {
      target: targetId,
      actor: ctx.userId,
    });
    return {
      title: mode === 'add' ? '➕ COINS ADDED' : '🎯 BALANCE SET',
      color: THEME.gold,
      message:
        (mode === 'add'
          ? `➕ <b>Added</b> ${fmt(amt)} coins to `
          : `🎯 <b>Set</b> balance to <b>${fmt(amt)}</b> for `) +
        `<a href="tg://user?id=${targetId}">${target.first_name || targetId}</a>.\n` +
        `💰 Wallet: <b>${fmt(after.wallet)}</b> · 🏦 Bank: <b>${fmt(after.bank)}</b> · 💎 Net: <b>${fmt(after.wallet + after.bank)}</b>`,
    };
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
      /* ----- group gate: Verify button (FRESH membership re-check) ----- */
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
            `<b>🎮 Games</b>: /slots · /dice · /cf · /mines · /bj · /roulette · /hl · /guess · /race · /lottery\n` +
            `<b>💼 Economy</b>: /balance · /dep · /wd · /donate · /transfer\n` +
            `<b>🕵️ Crime</b>: /rob · /crime · /heist · /join\n` +
            `<b>🛒 Shop</b>: /shop · /buy · /inv\n` +
            `<b>🎣 Activities</b>: /fish · /dig\n` +
            `<b>💵 Income</b>: /beg · /work · /daily · /bonus\n` +
            `<b>👻 Sneaky</b>: /hide (vanish from robs &amp; heists for 60s)\n` +
            `<b>🏆</b> /lb · <b>📜</b> /menu · <b>✅</b> /verify · <b>👌</b> /health\n` +
            `💬 <i>Reply to me or say "Rimuru" to talk.</i>`,
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
    } catch (e) { /* non-fatal */ }
  }

  /* ---------- message routing ---------- */

  // Maintenance pause (/stop, owner only) — persisted, survives redeploys.
  // While paused, EVERY non-owner interaction is ignored (commands, games,
  // button taps, Rimuru chat). The owner stays exempt and can always use
  // /run, /backup, /restore, /health and other admin commands so they are
  // never locked out. Each user/chat gets ONE short notice, then silence.
  const PAUSED_NOTICE =
    '🔒 Rimuru is paused for maintenance. Please try again later.';
  const PAUSE_EXEMPT_CMDS = ['run', 'backup', 'backups', 'restore', 'health', 'debug', 'stop', 'start', 'help'];
  const pausedNotified = new Set(); // `chatId:userId` seen while paused

  /** Should this message be ignored because the bot is paused? */
  function isPausedFor(msg) {
    if (!db.getBotPaused()) return false;
    const from = msg.from || {};
    if (String(from.id) === String(config.ownerId)) return false; // owner exempt
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

  async function onMessage(msg) {
    // Ignore non-user messages (channel posts, etc.)
    if (!msg.from || msg.from.is_bot) return;
    const text = String(msg.text || msg.caption || '');
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    // AUTO-CREATE PROFILE: ANY message or command from a user creates their
    // profile — /start is no longer required. getOrCreateUser is idempotent
    // and only writes when a profile field actually changes, so this is cheap
    // on every message. Runs BEFORE the pause gate so profiles are still
    // created while the bot is paused for maintenance.
    try {
      db.getOrCreateUser(userId, { username: msg.from.username || '', first_name: msg.from.first_name || '' });
    } catch (e) { /* non-fatal */ }
    // Maintenance pause gate — BEFORE any handling (except owner + exempt).
    if (isPausedFor(msg)) return;
    // Dashboard: log every user message (chat log for moderation).
    try { db.logChat(msg); } catch (e) { /* non-fatal */ }
    // Quote the triggering message on EVERY response from this handler —
    // commands, reply-keyboard taps, Rimuru replies, even penalty/error
    // messages show the "replying to @user" bubble above the reply.
    msg._replyTarget = msg.message_id;
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
        // (reply_to_message_id already set via msg._replyTarget at the top)
        try {
          // GROUP MEMBERSHIP GATE: non-staff must be a member of the required
          // group to use games/economy/commands. Exempt: /start, /help,
          // /verify, and staff commands (owner + moderators always bypass).
          const staffCmds = ['ban', 'sus', 'mute', 'unban', 'unsus', 'unmute', 'restart', 'addcoin', 'sb', 'debug', 'backup', 'backups', 'restore', 'redeem', 'stop', 'run'];
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

    // NATIVE REPLY-KEYBOARD BUTTON TAPS — Telegram sends the button label
    // as a normal message; map it to the matching command/sub-keyboard.
    // (Must run BEFORE the Rimuru AI trigger so "🎰 Casino" opens the
    // casino sub-keyboard instead of triggering an AI reply.)
    const kbRoute = keyboards.routeButton(text);
    if (kbRoute) {
      if (kbRoute.back) {
        // 🔙 Back → main keyboard (and a hint message)
        await reply(chatId, `⌨️ <b>Main menu</b> — pick a category.`, {
          title: '🐉 RIMURU CASINO', color: THEME.cyan, html: true,
          reply_markup: config.showReplyKeyboard ? keyboards.keyboardFor('main') : undefined,
        });
        return;
      }
      if (kbRoute.page) {
        // Category button → show the sub-keyboard (same space, replaces main)
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
      // Game/economy command button → run the matching handler
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

    // Rimuru AI triggers:
    //  1) message contains "rimuru" (no command needed)
    //  2) message REPLIES to one of the bot's own messages (direct chat)
    const isReplyToBot = msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot === true;
    if (rimuru.shouldTrigger(text) || isReplyToBot) {
      // GROUP GATE: non-staff must be a member to chat with Rimuru.
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
        // Text FIRST, sticker AFTER — never the other way around.
        // Personality split: staff (owner + moderators) get the warm
        // colleague tone; everyone else gets strict Rimuru.
        const ans = await rimuru.reply(text, {
          id: userId, first_name: name, username: from.username,
          isOwner: owner, isStaff: isStaff(userId),
        });
        const textPromise = reply(chatId, ans, { title: '🐉 RIMURU', color: THEME.gold, reply_to_message_id: msg.message_id });
        await stickerAfterText(chatId, textPromise);
      } catch (e) {
        console.error('[rimuru] reply error:', e.message);
        lastError = e;
        await reply(chatId, 'Hmph. The void ate my words. Try again, mortal.', { title: '🐉 RIMURU', color: THEME.gold, reply_to_message_id: msg.message_id });
      }
      return;
    }
  }

  /* ---------- boot: persistent command menu + bot identity ---------- */

  let botMeId = null;
  bot.getMe().then((me) => {
    botMeId = me.id;
    // Persistent command menu — the "☰ Menu" button next to the text input
    // (Telegram shows these commands in the input-bar dropdown, the same
    // area as the sticker/attachment menu).
    return bot.setMyCommands(MENU_COMMANDS)
      .then(() => bot.setChatMenuButton({ menu_button: { type: 'commands' } }))
      .then(() => bot.getMyCommands());
  }).then((cmds) => {
    console.log(`☰ Persistent command menu registered (setMyCommands): ${cmds.map((c) => `/${c.command}`).join(' ')}`);
  }).catch((e) => {
    console.warn('[boot] getMe/setMyCommands failed:', e.message);
  });

  // Dashboard: give the broadcast queue the live bot (fan-out) and drain it.
  try {
    dashboard.setActiveBot(bot);
  } catch (e) { /* non-fatal */ }
  setInterval(() => {
    try {
      // Drain the WHOLE queue each tick. Delivery is async (per item) so the
      // next item starts immediately instead of waiting 10s for the first.
      let drained = 0;
      for (let item = dashboard.drainBroadcastQueue(makeBroadcastSender); item; item = dashboard.drainBroadcastQueue(makeBroadcastSender)) {
        drained++;
        if (drained >= 50) break; // safety cap per tick
      }
      if (drained) console.log(`[dashboard] drained ${drained} broadcast(s)`);
    } catch (e) {
      console.error('[dashboard] drain error:', e.message);
    }
  }, 10000);

  /** Build the fan-out callback for one broadcast queue item.
   *  Sends to BOTH private users AND group chats (never just one), sourced
   *  from chat_logs (persistent, survives redeploys) plus live-known chats.
   *  Delivery is async — the queue moves on immediately. */
  function makeBroadcastSender() {
    return (item, done) => {
      let count = 0;
      const target = item.target || 'all';
      const chats = new Set();
      try {
        // FIX: getSeenChatIds() returns a FLAT array of chat ids (numbers),
        // NOT rows — iterating `row.chat_id` made every entry `undefined` and
        // the fan-out list became [undefined], so broadcasts silently
        // delivered to 0 chats. Use the ids directly.
        for (const cid of db.getSeenChatIds()) chats.add(Number(cid));
      } catch (e) { /* non-fatal */ }
      let list = [...chats];
      if (target === 'groups') list = list.filter((c) => c < 0);
      else if (target === 'users') list = list.filter((c) => c > 0);
      // dedupe + cap (500 users + 500 groups max)
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

module.exports = { createBot, MENU_COMMANDS };