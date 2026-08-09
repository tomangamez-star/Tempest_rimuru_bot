'use strict';
/**
 * Rimuru Tempest Casino — central configuration.
 * Reads from process.env (dotenv) with sensible defaults for local dev.
 */
require('dotenv').config();

const config = {
  // Telegram
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  ownerId: String(process.env.OWNER_ID || '8781690556'),
  allowedUpdates: (process.env.ALLOWED_UPDATES || 'messages,callback_query').split(','),

  // Groq (Rimuru AI)
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS || 150),
  groqTemperature: Number(process.env.GROQ_TEMPERATURE || 0.9),

  // Runtime
  port: Number(process.env.PORT || 10000),
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',

  // Storage
  // Relative path → works anywhere (local dev AND Render free tier without a disk).
  // Override with DB_PATH=/data/rimuru.db + DATA_DIR=/data when using a
  // persistent disk on Starter+ (see README "Storage notes").
  dbPath: process.env.DB_PATH || './data/rimuru.db',
  dataDir: process.env.DATA_DIR || './data',

  // Rimuru sticker pack — sends a random sticker with Rimuru's replies.
  // Set STICKER_PACK to any public pack name (e.g. Tensei_Shitara_Slime_Datta_Ken2).
  // If unset or invalid, the bot skips stickers gracefully (never crashes).
  stickerPack: process.env.STICKER_PACK || 'Tensei_Shitara_Slime_Datta_Ken2',

  // Inline buttons on messages — HIDDEN by default (persistent ☰ command
  // menu in the input bar is the primary navigation). Set
  // SHOW_INLINE_BUTTONS=true to bring the old inline keyboards back —
  // the code stays intact, just gated behind this flag (no rebuild needed).
  showInlineButtons: String(process.env.SHOW_INLINE_BUTTONS || 'false').toLowerCase() === 'true',

  // Native reply keyboard (ReplyKeyboardMarkup) — shows after /start by
  // default. Set SHOW_REPLY_KEYBOARD=false to disable it entirely.
  showReplyKeyboard: String(process.env.SHOW_REPLY_KEYBOARD || 'true').toLowerCase() === 'true',

  // ===================== GROUP MEMBERSHIP GATE =====================
  // Before any non-staff user can use the bot (games, economy, commands),
  // they must be a member of REQUIRED_GROUP (default @the_jtf).
  //  - REQUIRED_GROUP:    the group's @username; resolved to its numeric
  //                       chat ID at runtime via getChat('@the_jtf').
  //  - REQUIRED_GROUP_ID: optional numeric override (skips getChat).
  //  - Set REQUIRED_GROUP to '' to disable the gate entirely.
  // Staff (owner + dashboard moderators) always bypass the gate.
  requiredGroup: process.env.REQUIRED_GROUP || '@the_jtf',
  requiredGroupId: process.env.REQUIRED_GROUP_ID ? Number(process.env.REQUIRED_GROUP_ID) : 0,
  // Membership checks are cached briefly (60s) to avoid hammering the
  // Telegram API; the /verify button always does a FRESH check.
  groupGateCacheMs: Number(process.env.GROUP_GATE_CACHE_MS || 60 * 1000),

  // Owner smart reactions (emoji reacts on the owner's messages)
  reactions: {
    die: '☠️',
    lol: '😂',
    haha: '😂',
    win: '💰',
    rich: '💰',
    lose: '💸',
    broke: '💸',
    love: '❤️',
    mad: '😡',
    angry: '😡',
    gg: '👏',
    nice: '👏',
    '?': '🤔',
    fallback: ['🐉', '🔥', '😎'],
  },

  // ===================== DASHBOARD =====================
  // Admin web dashboard (served by the same HTTP server on :PORT).
  //  - DASHBOARD_PASSWORD: login password for the owner + moderators.
  //    If unset, the dashboard generates a random password on boot and
  //    prints it to the logs ONCE (owner can then set it permanently).
  //  - DASHBOARD_ENABLED: set to 'false' to disable the dashboard entirely.
  dashboard: {
    enabled: String(process.env.DASHBOARD_ENABLED || 'true').toLowerCase() !== 'false',
    // Fixed default password so the owner never has to dig through Render
    // logs. Override anytime by setting DASHBOARD_PASSWORD on Render.
    password: process.env.DASHBOARD_PASSWORD || 'RimuruTempest2024!',
    sessionTtlMs: 7 * 24 * 3600 * 1000, // 7-day session cookie
    // Max chat-log lines kept per message for the feed
    feedLimit: 100,
  },

  // Economy
  startBalance: 500000,
  houseEdge: 0.55, // house wins 55% of the time on skill-less games

  // Cooldowns (ms) — NOTE: no global game cooldown.
  // Gambling itself has NO cooldown. Each game keeps its own per-game
  // cooldown via PER_GAME_COOLDOWN_MS below (per game per user).
  cooldowns: {
    rob: 10 * 60 * 1000,      // robbery
    heist: 20 * 60 * 1000,    // heist
    daily: 24 * 60 * 60 * 1000,
    bonus: 7 * 24 * 60 * 60 * 1000,
    work: 60 * 1000,
    beg: 60 * 1000,
    fish: 2 * 60 * 1000,
    dig: 3 * 60 * 1000,
  },

  // Per-game cooldown (ms) — applies to EACH game individually per user,
  // so switching between games is always instant.
  perGameCooldownMs: Number(process.env.PER_GAME_COOLDOWN_MS || 2 * 60 * 1000),

  // Lottery
  lottery: {
    ticketPrice: 10000,
    minBuyers: 5,
    baseJackpot: 5000000,
  },

  // Heist
  heist: {
    openWindowMs: 60 * 1000,     // 1 minute to /join
    maxMembers: 5,               // leader counts as 1
    leaderBaseRisk: 0.65,        // leader starts at 65% risk
    minNetworthShare: 0.30,      // need 30% of target's networth to attempt
    winShare: 0.50,              // up to half of target's bank split equally
    failPenalty: 0.10,           // lose 10% of own networth on failure
  },

  // Robbery
  rob: {
    minTargetWallet: 10000,      // can't rob broke users
    successRate: 0.60,
    maxTakePct: 0.15,            // take up to 15% of target's wallet
    finePct: 0.05,               // fine = 5% of robber's wallet on fail
  },

  // Mines
  mines: {
    grid: 5,
    mineCount: 3,
    multipliers: [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 14.0, 16.0, 20.0, 25.0],
    // index = number of safe picks BEFORE this pick → multiplier for next pick
  },

  // Slots
  slots: {
    items: ['🍒', '🍋', '🍇', '💎', '⭐', '7️⃣', '🎰', '💰'],
    twoMatchMult: 2,
    threeMatchMult: 4,
  },

  // Dice — /dice uses Telegram's animated dice (1-6). Pick a number, hit = x6.
  dice: {
    mult: 6,
  },

  // Coin flip — win = double (bet + winnings)
  coinflip: {
    mult: 2,
  },

  // Roulette payouts (multiplier on bet)
  roulette: {
    colorMult: 2,
    parityMult: 2,
    halfMult: 2,
    dozenMult: 3,
    columnMult: 3,
    straightMult: 36,
    splitMult: 18,
  },

  // Blackjack
  blackjack: {
    blackjackPayout: 2.5, // 3:2 → 2.5x of bet returned
    doubleAllowed: true,
  },

  // Race — bet on a car color; 1st = 3x, 2nd = 1.5x, 3rd/4th = 0
  race: {
    positionMult: [3.0, 1.5, 0, 0], // index 0 = 1st place
    cars: ['red', 'blue', 'green', 'yellow'],
  },

  // Passive income ranges [min, max]
  income: {
    beg: [500, 5000],
    work: [2000, 15000],
    fish: [1000, 8000],
    dig: [3000, 20000],
    daily: [25000, 50000],
    bonus: [100000, 250000],
  },
};

// Guard: critical config missing
if (!config.telegramToken && config.env === 'production') {
  console.error('[config] FATAL: TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

module.exports = config;