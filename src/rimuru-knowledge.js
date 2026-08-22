'use strict';

// Curated support reference. Live values (balance, rank, sessions and
// leaderboards) are appended separately, so this never invents player data.
const KNOWLEDGE = `
RIMURU BOT SUPPORT REFERENCE
- Core: /start opens the bot, /menu shows categories, /help lists commands, /health checks service health, /verify checks required-group membership.
- Economy: /balance shows wallet/bank/net worth; /dep and /deposit protect wallet coins in bank; /wd and /withdraw move bank coins to wallet; /donate and /transfer send coins; /shop lists items; /buy purchases; /inv shows inventory; /profile shows badges/profile.
- Income: /beg, /work, /daily, /bonus, /fish and /dig earn virtual coins with their own cooldowns. Wallet is rob-able; bank is safe.
- Casino games: /slots [amount] (two matches 2x, three 4x); /dice [1-6] [amount] (correct number 6x); /cf [heads|tails] [amount] (2x); /mines [amount] (5x5, four moving mines, cash out); /bj [amount] (blackjack, natural 3:2); /roulette; /hl [amount] higher/lower; /guess [amount] three guesses; /crash; /wheel; /rps; /ttt; /duel; /cfs; /num; /race; /lottery [tickets] (1 billion per ticket, five unique buyers triggers draw).
- Crime: /rob targets a user; /crime runs crime; /heist starts a group heist and /join joins one; /hide temporarily protects a player from robbery/heists.
- Rank: /rank shows the player's visual rank and progress. /ranks shows Bronze, Silver, Gold, Platinum, Diamond, Master, Legend and Mythic. Only qualifying wagers count as valid matches; seven consecutive qualifying losses can demote a rank.
- Waifu: /waifu and /swaifu are owner spawn tools; /collection lists owned waifus; /viewwaifu [number] opens one; /wlb is the waifu leaderboard.
- JTF cards: /hunt spawns Gen2; /shunt spawns Old Gen; /card spawns JTF Signature. /char [name] searches using the user's /cardstyle choice. /characters lists owned cards, /viewchar opens one, /clb is the card leaderboard.
- Shoob originals: /shoob <name> [T1-T6] searches the pre-ingested Telegram archive and offers Previous/Next buttons. Shoob media is stored by Telegram; Supabase stores metadata/file_ids only. /cardstyle option 4 makes /char use Shoob originals.
- Custom cards: /crender offers Gen2, OldGen, JTF Signature, JTF AI Custom and dedicated premium JTF Animation. /customcards lists saved renders, /cview opens one. /cset and /creset are owner official-card controls. JTF Animation is T6, costs 10 Telegram Stars for normal users and is free for the owner.
- Memory: users may tell Rimuru facts about themselves, including birthdays and preferences. /remember and /recall are owner bot-fact controls. Rimuru must never expose another user's private memories.
- Staff: /mod appoints moderators; /broadcast or /bd broadcasts; /sb and /purge change balances; /attack, /FBI and /SWAT are owner actions; /backup manages backups; moderation commands include /ban, /sus, /mute and their reversals. Never tell ordinary users how to invoke destructive/admin internals beyond saying they are staff-only.
- /chatid is owner-only and reports the exact current chat ID for archive setup.
- The owner is Rimuru's King/Master. Do not claim the owner is whichever user is asking unless live context explicitly marks them owner.
- Never promise free coins, never expose tokens/passwords/database URLs, and never reveal private memories or hidden game answers.
`;

function text() { return KNOWLEDGE.trim(); }
module.exports = { text, KNOWLEDGE };
