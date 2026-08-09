# 🐉 Rimuru Tempest Casino Bot

A Telegram casino bot themed around **Rimuru Tempest** (from *That Time I Got Reincarnated as a Slime*). Rimuru is the house — confident, strict, not a pushover. **Virtual coins only. No real money. For fun.**

Built with **Node.js + node-telegram-bot-api + better-sqlite3**, with **Rimuru AI** powered by the **Groq API** (just say *"Rimuru"* in chat — no command needed).

---

## ✨ Features

### 🎮 Games (2 min cooldown)
| Command | Description |
|---|---|
| `/slots [amt]` | 3-reel slots. 2 match = 2×, 3 match = 4× |
| `/dice [1-6] [amt]` | Telegram animated dice. Hit your number = 6× (rare) |
| `/cf [heads\|tails] [amt]` | Coin flip. Win = 2× |
| `/mines [amt]` | 5×5 minefield, 3 hidden mines, inline-button grid. Safe pick → 💎 and multiplier climbs (1.25× → 1.5× → …). Cash out anytime. Hit a mine = lose everything |
| `/bj [amt]` | Blackjack. Hit/Stand/Double, dealer stands on 17+, blackjack pays 3:2 |
| `/roulette … [amt]` | `color red/black`, `even/odd`, `low/high`, `dozen 1-3`, `column 1-3`, `straight 0-36` (36×), `split a,b` (18×) |
| `/hl [amt]` | Higher or Lower. Streak multiplier, cash out anytime, wrong guess = bust |
| `/lottery [buy\|draw\|status] [n]` | Ticket = 10,000. Base pot 5,000,000 grows with tickets. 5 buyers needed for the draw. Weighted winner takes the pot |

### 💰 Economy
- New users start with **500,000 coins**
- **Wallet** (rob-able) vs **Bank** (safe from robbers)
- `/balance` · `/dep [amt|all]` (wallet → bank) · `/wd [amt|all]` (bank → wallet)
- `/donate [amt]` (reply, from wallet) · `/transfer [amt]` (reply, from bank)
- House edge: **55/45 in the house's favor** on chance games

### 🦹 Crime
- **`/rob`** (reply to target, 10 min cooldown) — take up to 15% of their wallet. Can't rob broke users (<10k) or the owner. **Fail = fine** scaled to your wallet (5%)
- **`/heist`** (reply to target, 20 min cooldown) — need 30% of target's networth. Open **60s** for others to **`/join`**. Max **5 members** (leader counts as 1/5, starts at 65% risk; each member lowers risk). **Win** = up to half the target's bank split equally; **Fail** = everyone loses 10% of their own networth. Can't heist an empty bank or the owner

### 💵 Passive income
`/beg` · `/work` · `/fish` · `/dig` · `/daily` (24h) · `/bonus` (weekly, manual claim)

### 👑 Admin controls (owner only — reply to a user)
| Command | Effect |
|---|---|
| `/ban [duration] [reason]` | Full ban — no bot interaction at all |
| `/sus [duration] [reason]` | Can still chat, but no gambling / no Rimuru |
| `/mute [duration] [reason]` | Silenced completely |
| `/unban` `/unsus` `/unmute` | Lift early |

Durations like `30m`, `2h`, `1d`, `1w` — omit for permanent. Reason + duration are announced when the penalty ends.

### 🏆 Leaderboard
`/lb` — live top 10 by net worth (wallet + bank), shiny medals 🥇–🔟.

### 🤖 Rimuru AI
Say **"Rimuru"** anywhere in chat → he replies via **Groq** (`llama-3.3-70b-versatile`), with full knowledge of the economy and live leaderboard context. Short, confident, teasing replies. He greets the King (owner) with *"Welcome master"*. Falls back to canned lines if Groq is down.

---

## 🚀 Quick start (local)

```bash
git clone <repo-url> rimuru-casino
cd rimuru-casino

# 1. Create your token with @BotFather, then:
cp .env.example .env
#    edit .env → TELEGRAM_TOKEN, OWNER_ID (your numeric ID), GROQ_API_KEY

# 2. Install + run
npm install
npm start
```

The health server listens on `PORT` (default `10000`): `GET /health` → `{"ok":true}`.

> ⚠️ **Never commit `.env`** (it's gitignored).

---

## 🧪 Tests

```bash
npm test          # 34 smoke tests — economy, games, crimes, admin, income, cooldowns
npm run check     # node --check on every file
```

---

## ☁️ Deploy on Render

### Option A — Blueprint (easiest)
1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo.
3. `render.yaml` is auto-detected. Set the **sync:false** env vars in the dashboard:
   - `TELEGRAM_TOKEN` = your BotFather token
   - `GROQ_API_KEY` = your Groq key
4. Deploy. Done.

### Option B — Manual Web Service
1. Render → **New → Web Service** → connect repo.
2. Settings:
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `npm start`
   - **Health Check Path:** `/health`
   - **Plan:** Free (or Starter $7/mo)
3. Add env vars (same as above) + `PORT=10000`.
4. Deploy.

### Storage notes (important)
- **Free tier:** the filesystem is **ephemeral** — the SQLite DB resets whenever the service restarts/idles (~15 min of no traffic). Fine for testing; economy resets.
- **Starter ($7/mo)+:** attach a **disk** (render.yaml includes a `/data` mount) and set `DB_PATH=/data/rimuru.db`, `DATA_DIR=/data` so the DB **persists** across restarts.

---

## 📁 Project structure

```
rimuru-casino/
├── package.json          # deps + scripts
├── .node-version         # Node 20 (Render uses this)
├── render.yaml           # Render Blueprint
├── .env.example          # env template
├── src/
│   ├── index.js          # entrypoint + health server
│   ├── bot.js            # command router, callbacks, penalties, Rimuru trigger
│   ├── config.js         # all tunables (cooldowns, payouts, edges)
│   ├── db.js             # better-sqlite3 data layer (users, cooldowns, lottery, heists)
│   ├── economy.js        # wallet/bank, dep/wd, donate/transfer
│   ├── admin.js          # ban/sus/mute + duration parsing
│   ├── cooldowns.js      # cooldown guards
│   ├── income.js         # beg/work/fish/dig/daily/bonus
│   ├── leaderboard.js    # top 10 by net worth
│   ├── rimuru.js         # Groq-powered Rimuru AI
│   ├── games/
│   │   ├── slots.js  dice.js  coinflip.js
│   │   ├── mines.js  blackjack.js  roulette.js
│   │   ├── higherlower.js  lottery.js
│   └── crimes/
│       ├── robbery.js  heist.js
└── tests/
    └── smoke.js         # 34 assertions, temp DB
```

---

## ⚙️ Environment variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | — | BotFather token (**required**) |
| `OWNER_ID` | — | Owner's numeric Telegram ID (never robbed/heisted) |
| `GROQ_API_KEY` | — | Groq key for Rimuru AI |
| `PORT` | `10000` | Health server port |
| `DB_PATH` | `/tmp/rimuru.db` | SQLite file (use `/data/…` on paid Render for persistence) |
| `DATA_DIR` | `/tmp/rimuru-data` | Misc data dir |
| `NODE_ENV` | `production` | Runtime mode |
| `ALLOWED_UPDATES` | `messages,callback_query` | Telegram polling updates |

---

## ⚖️ Fair-play / notes
- **Virtual coins only** — no real money, no real-world value.
- House edge is intentionally **55/45** on pure-chance games (except lottery, which is winner-takes-pot).
- Unofficial bots risk Telegram/WhatsApp-style platform bans — use a dedicated account and don't spam.
- 18+ entertainment only. If gambling stops being fun, stop.

Made with 💜 by the King's favorite slime. Don't rob the King.
