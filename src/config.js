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
  dbPath: process.env.DB_PATH || './data/rimuru.db',
  dataDir: process.env.DATA_DIR || './data',

  // External Postgres (Supabase)
  databaseUrl: process.env.DATABASE_URL || process.env.SUPABASE_URL || '',
  dbSyncIntervalMs: Number(process.env.DB_SYNC_INTERVAL_MS || 30000),

  // Auto-Backup
  autoBackup: {
    enabled: String(process.env.AUTO_BACKUP_ENABLED || 'true').toLowerCase() !== 'false',
    checkMs: Math.max(5000, Number(process.env.AUTO_BACKUP_CHECK_MS || 30000)),
    keep: Math.max(2, Number(process.env.AUTO_BACKUP_KEEP || 5)),
    regressionPct: Math.min(0.9, Math.max(0.05, Number(process.env.AUTO_BACKUP_REGRESSION_PCT || 0.20))),
    intervalMs: 5 * 60 * 1000,
  },

  // Sticker pack
  stickerPack: process.env.STICKER_PACK || 'Tensei_Shitara_Slime_Datta_Ken2',

  // Inline buttons
  showInlineButtons: String(process.env.SHOW_INLINE_BUTTONS || 'false').toLowerCase() === 'true',
  showReplyKeyboard: String(process.env.SHOW_REPLY_KEYBOARD || 'true').toLowerCase() === 'true',

  // Group membership gate
  requiredGroup: process.env.REQUIRED_GROUP || '@the_jtf',
  requiredGroupId: process.env.REQUIRED_GROUP_ID ? Number(process.env.REQUIRED_GROUP_ID) : 0,
  groupGateCacheMs: Number(process.env.GROUP_GATE_CACHE_MS || 60 * 1000),

  // Owner reactions
  reactions: { die: '☠️', lol: '😂', haha: '😂', win: '💰', rich: '💰', lose: '💸', broke: '💸', love: '❤️', mad: '😡', angry: '😡', gg: '👏', nice: '👏', '?': '🤔', fallback: ['🐉', '🔥', '😎'] },

  // Dashboard
  dashboard: { enabled: String(process.env.DASHBOARD_ENABLED || 'true').toLowerCase() !== 'false', password: process.env.DASHBOARD_PASSWORD || 'RimuruTempest2024!', sessionTtlMs: 7 * 24 * 3600 * 1000, feedLimit: 100 },

  // Economy
  startBalance: 500000,
  houseEdge: 0.55,

  // Cooldowns
  cooldowns: { rob: 10 * 60 * 1000, heist: 20 * 60 * 1000, daily: 24 * 60 * 60 * 1000, bonus: 7 * 24 * 60 * 60 * 1000, work: 60 * 1000, beg: 60 * 1000, fish: 2 * 60 * 1000, dig: 3 * 60 * 1000, hide: 30 * 60 * 1000 },

  // Hide
  hide: { price: 50000000, durationMs: 60 * 1000 },

  // Per-game cooldown
  perGameCooldownMs: Number(process.env.PER_GAME_COOLDOWN_MS || 2 * 60 * 1000),

  // Lottery
  lottery: { ticketPrice: 10000, minBuyers: 5, baseJackpot: 5000000 },

  // Heist
  heist: { openWindowMs: 60 * 1000, maxMembers: 5, leaderBaseRisk: 0.65, minNetworthShare: 0.30, winShare: 0.50, failPenalty: 0.10 },

  // Rob
  rob: { minTargetWallet: 10000, successRate: 0.60, maxTakePct: 0.15, finePct: 0.05 },

  // Attack
  attack: { enabled: String(process.env.ATTACK_ENABLED || 'true').toLowerCase() !== 'false', minNetWorth: 250000000000, spawnIntervalMs: 60 * 60 * 1000, jitterMaxMs: 40 * 60 * 1000, minAttackers: 3, maxAttackers: 30, challengeWindowMs: 5 * 1000, challengeRounds: 4, challengeGraceMs: 3 * 1000, breachPct: 0.10, breachMin: 1000, breachMax: 1000000000000, targetCooldownMs: 2 * 60 * 60 * 1000, globalCooldownMs: 10 * 60 * 1000, onlineWindowMs: 5 * 60 * 1000, onlineSecurityBonus: 1, offlineSecurityAdvantage: 0, manualMaxAttackers: 10000 },

  // Mines
  mines: { grid: 5, mineCount: 4, visibleMines: 3, reshuffleAfterPick: true, multPerPick: 0.25, maxPicks: 22 },

  // Slots
  slots: { items: ['🍒', '🍋', '🍇', '💎', '⭐', '7️⃣', '🎰', '🔰'], twoMatchMult: 2, threeMatchMult: 4 },

  // Dice
  dice: { mult: 6 },

  // Coin flip
  coinflip: { mult: 2 },

  // Roulette
  roulette: { colorMult: 2, parityMult: 2, halfMult: 2, dozenMult: 3, columnMult: 3, straightMult: 36, splitMult: 18 },

  // Blackjack
  blackjack: { blackjackPayout: 2.5, doubleAllowed: true },

  // Race
  race: { positionMult: [3.0, 1.5, 0, 0], cars: ['red', 'blue', 'green', 'yellow'] },

  // Passive income
  income: { beg: [500, 5000], work: [2000, 15000], fish: [1000, 8000], dig: [3000, 20000], daily: [25000, 50000], bonus: [100000, 250000] },

  // Shop
  shop: { items: [{ id: 'crowbar', name: 'Crowbar', emoji: '🪓', price: 25000, desc: 'Required for robbery-type crimes.' }, { id: 'gun', name: 'Gun', emoji: '🔫', price: 75000, desc: 'Required for armed robbery crimes.' }, { id: 'mask', name: 'Robbery Mask', emoji: '🎭', price: 20000, desc: 'Required for robbery crimes.' }, { id: 'hook', name: 'Fishing Hook', emoji: '🎣', price: 15000, desc: 'Required to /fish.' }, { id: 'security', name: 'Security', emoji: '🛡�️', price: 100000, desc: 'Boosts escape odds (+10%).' }, { id: 'cyber', name: 'Cyber Security', emoji: '🐻', price: 200000, desc: 'Defense against heists (+15%).' }, { id: 'lockpick', name: 'Lockpick', emoji: '🗝���' , price: 30000, desc: '+8% crime success.' }, { id: 'lucky', name: "Lucky Charm', emoji: '🍀', price: 50000, desc: '+5% crime success.' }, { id: 'drill', name: 'Drill', emoji: '🛠️', price: 125000, desc: '+12% crime success.' }], crime: { minBet: 5000, maxBet: 2000000, baseSuccess: 0.45, itemBonus: { crowbar: 0.10, gun: 0.12, mask: 0.06, lockpick: 0.08, lucky: 0.05, drill: 0.12 }, securityEscapeBonus: 0.10, cyberDefenseBonus: 0.15 } },

  // Fish
  fish: { catchLines: [(c) => `🐟 You reel in a fat carp — sold for **${c}**.`, (c) => `🐠 A shimmering tuna! **${c}**.`, (c) => `🦑 A rare squid — the market pays **${c}**.`, (c) => `🦞 A Lobster! Dinner AND profit: **${c}**.`], junkLines: [`👢 You hooked an old boot. Nothing but shame.`, `🪣 A rusty bucket. The fish laughed at you.`, `🌿 Iust seaweed. The ocean is mocking you.`] },

  // FBI
  fbi: { enabled: String(process.env.FBI_ENABLED || 'true').toLowerCase() !== 'false', threshold: 1000000000, maxRemaining: 1000000, raidWindowMs: 3 * 1000, finePct: 0.40, fineMin: 1000, fineMax: 1000000000000 },

  // Waifu
  waifu: { enabled: String(process.env.WAIFU_ENABLED || 'true').toLowerCase() !== 'false', claimWindowMs: 15 * 60 * 1000, autoSpawnIntervalMs: 60 * 60 * 1000, fetchTimeoutMs: 10000, userAgent: 'RimuruTempestCasino/1.0', nekosBestUrl: 'https://nekos.best/api/v2/waifu', waifuPicsUrl: 'https://api.waifu.pics/sfw/waifu' },

  // Anime Hunt
  hunt: { enabled: String(process.env.HUNT_ENABLED || 'true').toLowerCase() !== 'false', claimWindowMs: 15 * 60 * 1000, autoSpawnIntervalMs: 60 * 60 * 1000, fetchTimeoutMs: 10000, rateLimitMs: 1000, userAgent: 'RimuruTempestCasino/1.0', baseUrl: 'https://api.jikan.moe/v4', randomUrl: 'https://api.jikan.moe/v4/random/characters', searchUrl: 'https://api.jikan.moe/v4/characters' },

  // Rank
  rank: { enabled: String(process.env.RANK_ENABLED || 'true').toLowerCase() !== 'false', validMatchPct: 0.10, demoteLosses: 7, peakStartHour: 8, peakEndHour: 11 },
};

if (!config.telegramToken && config.env === 'production') {
  console.error('[config] FATAL: TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

module.exports = config;