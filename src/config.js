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

  // ===================== EXTERNAL POSTGRES (SUPABASE) =====================
  // Durable cross-redeploy persistence. Set DATABASE_URL (a Postgres
  // connection string) on Render. The local SQLite file stays as the hot
  // synchronous cache; every write is mirrored to Postgres and on boot the
  // cache is rehydrated from Postgres, so balances/leaderboard/mods survive
  // every redeploy.
  //   - REQUIRED: DATABASE_URL (or SUPABASE_URL) — a postgres://… string.
  //   - Supabase CONNECTION STRING TYPES:
  //       • "Session pooler" (recommended) — host db.<ref>.supabase.co,
  //         PORT 6543, usually has ?sslmode=require. Best for serverless
  //         and long-lived connections.
  //       • "Direct connection" — same host, PORT 5432. On Supabase FREE
  //         tier direct IPv6 connections are often BLOCKED; use the pooler.
  //     The code enables TLS automatically for supabase.co hosts.
  //   - Optional: DB_SYNC_INTERVAL_MS (default 1500ms) — mirror flush cadence.
  //   - No env var → bot runs SQLite-only (ephemeral) with a clear warning.
  //   - If DATABASE_URL is set but Postgres is unreachable the bot FAILS
  //     LOUDLY (logs + /health + /debug) and retries every 15s — it never
  //     silently pretends persistence is on.
  databaseUrl: process.env.DATABASE_URL || process.env.SUPABASE_URL || '',
  dbSyncIntervalMs: Number(process.env.DB_SYNC_INTERVAL_MS || 1500),

  // ===================== AUTO-BACKUP (hidden safety net) =====================
  // Automatic backups run on a 40-minute cycle: every 5 min for the first
  // 25 min, every 2 min for the next 10 min, every 30s for the last 5 min
  // (20 backups per cycle). Retention keeps a ROLLING WINDOW (default 5)
  // instead of "only the latest" — so a pre-regression snapshot always
  // survives. Before writing, the new snapshot is checked for REGRESSION
  // (total coins in circulation / user count vs the previous backup): a
  // sharp, unexplained drop is flagged as suspicious and the good backup is
  // KEPT instead of being overwritten by the regressed state.
  //  - AUTO_BACKUP_ENABLED=false  disables the scheduler entirely.
  //  - AUTO_BACKUP_CHECK_MS      how often the scheduler ticks (default 30s).
  //  - AUTO_BACKUP_KEEP          rolling window size (default 5).
  //  - AUTO_BACKUP_REGRESSION_PCT  total-supply drop that looks like a
  //                                rollback (default 0.20 = 20%).
  autoBackup: {
    enabled: String(process.env.AUTO_BACKUP_ENABLED || 'true').toLowerCase() !== 'false',
    checkMs: Math.max(5000, Number(process.env.AUTO_BACKUP_CHECK_MS || 30000)),
    keep: Math.max(2, Number(process.env.AUTO_BACKUP_KEEP || 5)),
    regressionPct: Math.min(0.9, Math.max(0.05, Number(process.env.AUTO_BACKUP_REGRESSION_PCT || 0.20))),
    // Flat schedule: one backup every 5 minutes, continuously. (The old
    // 40-min multi-phase cycle — 25min@5 + 10min@2 + 5min@30s — was removed;
    // the bursts raced the snapshot/retention logic.)
    intervalMs: 5 * 60 * 1000,
  },

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
    hide: 30 * 60 * 1000,     // /hide cooldown (30 min)
  },

  // /hide — vanish from robs & heists for 60s
  hide: {
    price: 50000000,          // 50,000,000 coins
    durationMs: 60 * 1000,    // 1 minute hidden
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
    // 4 mines total: only 3 are revealed when you blow up (the 4th stays
    // hidden forever) and the board RE-RANDOMIZES after every safe pick.
    mineCount: 4,
    visibleMines: 3,
    // The mines move after every safe pick — the board reshuffles each turn.
    reshuffleAfterPick: true,
    // Reward: no payout before the 1st move. Every safe pick adds +25% of the
    // original wager to the cash-out. Cash-out = bet + bet × 0.25 × picks.
    // multiplier for the NEXT pick = 1 + 0.25 × picks_completed.
    multPerPick: 0.25,
    maxPicks: 22, // 25 cells − 3 visible mines (the hidden 4th is never cleared)
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

  // ===================== SHOP / INVENTORY =====================
  // Items bought with coins (virtual). Some are REQUIRED for features
  // (crowbar/gun/mask → /crime robbery; fishing hook → /fish); others give
  // passive boosts (security → better escape odds, cyber security → better
  // defense). Every item is one-shot consumable unless noted (unlimited).
  shop: {
    items: [
      { id: 'crowbar', name: 'Crowbar', emoji: '🪓', price: 25000, desc: 'Required for robbery-type crimes. Pry open anything.' },
      { id: 'gun', name: 'Gun', emoji: '🔫', price: 75000, desc: 'Required for armed robbery crimes. Adds real threat.' },
      { id: 'mask', name: 'Robbery Mask', emoji: '🎭', price: 20000, desc: 'Required for robbery crimes. Hides your identity.' },
      { id: 'hook', name: 'Fishing Hook', emoji: '🎣', price: 15000, desc: 'Required to /fish. The fish are waiting.' },
      { id: 'security', name: 'Security', emoji: '🛡️', price: 100000, desc: 'Boosts your odds of escaping robs (+10%).' },
      { id: 'cyber', name: 'Cyber Security', emoji: '💻', price: 200000, desc: 'Defense against heists — higher chance they fail (+15%).' },
      { id: 'lockpick', name: 'Lockpick', emoji: '🗝️', price: 30000, desc: 'One-time lockpick for the safe — +8% crime success.' },
      { id: 'lucky', name: "Lucky Charm", emoji: '🍀', price: 50000, desc: 'A lucky charm. +5% crime success, feels illegal.' },
      { id: 'drill', name: 'Drill', emoji: '🛠️', price: 125000, desc: 'Heavy drill for vault jobs — +12% crime success.' },
    ],
    // Crime config (used by /crime)
    crime: {
      minBet: 5000,
      maxBet: 2000000,
      baseSuccess: 0.45,
      // Flat success bonus per item owned (once each)
      itemBonus: {
        crowbar: 0.10,
        gun: 0.12,
        mask: 0.06,
        lockpick: 0.08,
        lucky: 0.05,
        drill: 0.12,
      },
      // Security raises your escape odds from /rob
      securityEscapeBonus: 0.10,
      // Cyber security raises the chance a heist on you FAILS
      cyberDefenseBonus: 0.15,
    },
  },

  // /fish rewards when you own a fishing hook
  fish: {
    catchLines: [
      (c) => `🐟 You reel in a fat carp — sold for **${c}**.`,
      (c) => `🐠 A shimmering tuna! **${c}**.`,
      (c) => `🦑 A rare squid — the market pays **${c}**.`,
      (c) => `🦞 A lobster! Dinner AND profit: **${c}**.`,
    ],
    junkLines: [
      `👢 You hooked an old boot. Nothing but shame.`,
      `🪣 A rusty bucket. The fish laughed at you.`,
      `🌿 Just seaweed. The ocean is mocking you.`,
    ],
  },
};

// Guard: critical config missing
if (!config.telegramToken && config.env === 'production') {
  console.error('[config] FATAL: TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

module.exports = config;