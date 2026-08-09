# 🐉 Rimuru Tempest Casino Bot

A Telegram casino bot themed around **Rimuru Tempest** (from *That Time I Got Reincarnated as a Slime*). Rimuru is the house — confident, strict, not a pushover. **Virtual coins only. No real money. For fun.**

Built with **Node.js + node-telegram-bot-api + better-sqlite3**, with **Rimuru AI** powered by the **Groq API** (just say *"Rimuru"* in chat — no command needed).

---

## ✨ Features

### 🎮 Games (per-game cooldown — no global gambling cooldown)
| Command | Description |
|---|---|
| `/slots [amt]` | 3-reel slots. 2 match = 2×, 3 match = 4× |
| `/dice [1-6] [amt]` | Telegram animated dice. Hit your number = 6× (rare) |
| `/cf [heads\|tails] [amt]` | Coin flip. Win = 2× |
| `/mines [amt]` | 5×5 minefield, 3 hidden mines, inline-button grid. Safe pick → 💎 (the tapped cell grows bigger!) and multiplier climbs (1.25× → 1.5× → …). Cash out anytime. Hit a mine = lose everything |
| `/bj [amt]` | Blackjack. Hit/Stand/Double, dealer stands on 17+, blackjack pays 3:2 |
| `/roulette … [amt]` | `color red/black`, `even/odd`, `low/high`, `dozen 1-3`, `column 1-3`, `straight 0-36` (36×), `split a,b` (18×) |
| `/hl [amt]` | Higher or Lower. Streak multiplier, cash out anytime, wrong guess = bust |
| `/lottery [buy\|draw\|status] [n]` | Ticket = 10,000. Base pot 5,000,000 grows with tickets. 5 buyers needed for the draw. Weighted winner takes the pot |

> ⚡ **No global cooldown** — you can jump between games instantly. Each game
> has its own individual cooldown (2 min) so you can't spam the same table.

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
`/lb` — live top 10 by net worth (wallet + bank), shiny gold medals 🥇–🔟.

### 📜 Menus
- **Persistent command menu** under the input box: 🏆 Leaderboard · 💰 Balance · 🎰 Casino · 🎮 Games · 💼 Economy · ❓ Help (set via `setMyCommands` on boot)
- **`/menu`** — multi-level inline menu: main page → **Casino** (Blackjack, Roulette, Slots, Lottery) and **Games** (Coin Flip, Mines, Dice, Higher/Lower) sub-pages with ⬅️ Back buttons. Leaderboard/Balance/Help/Game-details reply *threaded under* the menu message.

### 🐉 Rimuru AI
- Say **"Rimuru"** anywhere in chat — or simply **reply to one of the bot's messages** — and Rimuru replies via **Groq** (`llama-3.3-70b-versatile`), with full knowledge of the economy and live leaderboard context. Short, confident, teasing. He respects the King (owner) naturally — no "Welcome master" spam. Falls back to canned lines if Groq is down.
- **Stickers** — every Rimuru reply sends a random sticker from the pack `Tensei_Shitara_Slime_Datta_Ken2` (a big Tensura/Rimuru pack). Set `STICKER_PACK` to change it; unset/invalid → stickers are skipped gracefully.

### 👑 Owner perks
- **Smart emoji reactions**: Rimuru reacts to the *owner's* messages with a fitting emoji — `die`→☠️, `lol`/`haha`→😂, `win`/`rich`→💰, `lose`/`broke`→💸, `love`→❤️, `mad`/`angry`→😡, `gg`/`nice`→👏, `?`→🤔, otherwise 🐉.

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
- **Free tier:** the filesystem is **ephemeral** — the SQLite DB (`. /data/rimuru.db`) resets whenever the service restarts/idles (~15 min of no traffic). The bot works fine on free tier; it creates the DB file at runtime in the working directory. Economy just resets on sleep/restart — fine for testing.
- **Starter ($7/mo) + persistent disk:** attach a disk so the DB **survives restarts**. In Render's dashboard: your service → **Disks** → **Add Disk** (mount path `/data`, 1 GB), then set these env vars:
  - `DB_PATH=/data/rimuru.db`
  - `DATA_DIR=/data`
- **Blueprint users:** the `disk:` block is commented out in `render.yaml` because **Render free tier rejects disks** (`services[0] disks are not supported for free tier services`). After upgrading your plan, uncomment it to provision the disk automatically:
  ```yaml
  # in render.yaml, under the service:
  disk:
    name: rimuru-data
    mountPath: /data
    sizeGB: 1
  ```

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
| `DASHBOARD_PASSWORD` | auto-generated | Admin dashboard login password (owner + mods) |
| `DASHBOARD_ENABLED` | `true` | Set `false` to disable the web dashboard |

---

## 🖥️ Admin Dashboard

A full web admin panel is served by the bot itself on the same port as
`/health` — no extra service, no extra cost.

**Access:** `https://<your-service>.onrender.com/` (or `http://localhost:10000/`
in dev). The `/health` endpoint still works for Render health checks.

**Login:** your Telegram user ID (`8781690556`) + `DASHBOARD_PASSWORD`
(set it in Render's env vars; if unset the bot prints a generated password
once to the logs on boot).

**Features**
- **Overview** — total users, active users, groups, coins in circulation,
  games played, messages logged, bans, lottery pot + top-10 leaderboard.
- **Users** — search, per-user detail (balance history, game history, chat
  logs, cooldowns) and one-click moderation: give / deduct / set / fine /
  jail / suspend / mute / ban / unban. Actions hit the live SQLite DB and
  take effect in Telegram immediately (the bot's penalty gate checks the
  same DB).
- **Chat logs** — every user message the bot has seen (live capture).
- **Game history** — every game / crime / mission result with win/loss and
  coin deltas.
- **Events & Missions** — create missions from the dashboard; they go LIVE
  in the bot: players see them with `/missions` and attempt them with
  `/mission [id]`, `/heistrimuru` or `/fightrimuru` (cooldown 5 min).
- **Broadcast** — send a note-styled message to every chat the bot has seen
  (users / groups / all). Delivered with the blockquote margin bar.
- **Activity feed** — live stream of logins, moderation, broadcasts, events.
- **Moderators** — the owner can add/remove moderators (each gets a login).
- **Mod chat room** — real-time Socket.IO room for owner + mods.
- **Rimuru mini-assistant** — chat with the Groq-powered Rimuru AI from the
  dashboard (bottom-right 🐉 button).

**Storage:** all dashboard data lives in the same SQLite DB as the bot.
On Render's FREE tier the filesystem is ephemeral — data persists within a
running instance and resets on redeploy/restart. True cross-redeploy
persistence needs an external DB (Postgres/Supabase) or a paid persistent
disk (see "Storage notes" below).

---

## ⚖️ Fair-play / notes
- **Virtual coins only** — no real money, no real-world value.
- House edge is intentionally **55/45** on pure-chance games (except lottery, which is winner-takes-pot).
- Unofficial bots risk Telegram/WhatsApp-style platform bans — use a dedicated account and don't spam.
- 18+ entertainment only. If gambling stops being fun, stop.

Made with 💜 by the King's favorite slime. Don't rob the King.