'use strict';
/**
 * Rimuru Tempest Casino â€” hybrid data layer.
 *
 * SQLite (better-sqlite3) stays the hot synchronous cache â€” every game,
 * economy and dashboard module calls these functions synchronously, so we
 * keep that exact API. When DATABASE_URL (Supabase/Postgres) is configured,
 * every mutation is ALSO mirrored to Postgres (async, batched), and on boot
 * the SQLite cache is rehydrated from Postgres â€” so balances, leaderboard,
 * moderators and the economy SURVIVE every redeploy/restart on Render.
 *
 * Tables (same schema in SQLite and Postgres): users, cooldowns, lottery,
 * heists, chat_logs, game_history, admin_users, bot_events, broadcasts,
 * activity_feed, audit_log.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { ensureDir } = require('./utils');

/* ================= SQLite (hot cache) ================= */

ensureDir(path.dirname(config.dbPath));

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('[db] better-sqlite3 failed to load:', e.message);
  console.error('[db] Run: npm install');
  process.exit(1);
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  wallet     INTEGER NOT NULL DEFAULT 0,
  bank       INTEGER NOT NULL DEFAULT 0,
  status     TEXT DEFAULT 'active',      -- active | muted | suspected | banned
  status_reason TEXT DEFAULT '',
  status_until INTEGER DEFAULT 0,         -- 0 = permanent
  hidden_until INTEGER DEFAULT 0,         -- hide-in-shadows expiry (ms epoch)
  rank        TEXT DEFAULT 'bronze',      -- rank ladder (see src/rank.js)
  rank_valid_matches INTEGER DEFAULT 0,   -- valid matches played (bet >= 10% balance)
  rank_consecutive_losses INTEGER DEFAULT 0, -- current losing streak (7 â†’ demote)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0  -- version stamp: ONLY timestamp ordering decides which state wins
);

CREATE TABLE IF NOT EXISTS time_wallet (
  user_id    INTEGER PRIMARY KEY,
  amount     INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,  -- ms epoch; 0 = no expiry
  source     TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id "INTEGER NOT NULL,
  action   TEXT NOT NULL,
  until    INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);

CREATE TABLE IF NOT EXISTS lottery (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pot        INTEGER NOT NULL DEFAULT 0,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  tickets    TEXT NOT NULL DEFAULT '[]'   -- JSON array of {user_id, count}
);

CREATE TABLE IF NOT EXISTS heists (
  leader_id    INTEGER PRIMARY KEY,
  leader_name  TEXT DEFAULT '',
  target_id    INTEGER NOT NULL,
  target_name  TEXT DEFAULT '',
  members      TEXT NOT NULL DEFAULT '[]',   -- JSON [{user_id, name}]
  started_at   INTEGER NOT NULL,
  status       TEXT DEFAULT 'open'            -- open | running
);

---=================== DASHBOARD TABLES =====================
CREATE TABLE IF NOT EXISTS chat_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  chat_id    INTEGER NOT NULL,
  chat_title TEXT DEFAULT '',
  text       TEXT DEFAULT '',
  is_command INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS game_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  username    TEXT DEFAULT '',
  game        TEXT NOT NULL,        -- slots, dice, bj, mines, race, rob, ...
  bet         INTEGER DEFAULT 0,
  result      TEXT DEFAULT '',      -- win | lose | push | success | fail | ...
  amount      INTEGER DEFAULT 0,    -- net change (+/-)
  meta        TEXT DEFAULT '{}',    -- JSON extra (reels, multiplier, ...)
  created_at  INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS admin_users (
  user_id      INTEGER PRIMARY KEY,  -- Telegram user ID
  username    TEXT DEFAULT '',
  role        TEXT DEFAULT 'mod',   -- owner | mod
  password    TEXT DEFAULT '',      -- dashboard login password (owner + mods)
  created_at  INTEGER NOT NULL,
  last_login "INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'mission',  -- mission | event | giveaway | trivia
  reward      INTEGER DEFAULT 0,       -- coin reward on completion
  starts_at   INTEGER DEFAULT 0,
  ends_at     INTEGER DEFAULT 0,       -- 0 = forever
  active      INTEGER DEFAULT 1,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  completions INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  target      TEXT DEFAULT 'all',    -- all | users | groups
  sent_count  INTEGER DEFAULT 0,
  created_by  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS activity_feed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT DEFAULT 'event',  -- event | user | game | mod | broadcast
  text        TEXT NOT NULL,
  meta        TEXT DEFAULT '{}',
  created_at  INTEGER NOT NULLL);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,
  actor_name  TEXT DEFAULT '',
  action      TEXT NOT NULL,         -- give | deduct | ban | unban | ...
  target_id   INTEGER DEFAULT 0,
  detail      TEXT DEFAULT '',
  created_at  INTEGER NOT NULLL);

CREATE TABLE IF NOT EXISTS inventory (
  user_id  INTEGER NOT NULL,
  item_id  TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code       TEXT PRIMARY KEY,
  amount     INTEGER NOT NULL,
  max_uses   INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,           -- Telegram user ID of the creator
  creator_role TEXT DEFAULT 'owner',     -- owner | mod (mods are capped at 50M)
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS redeem_redemptions (
  code       TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY code, user_id
);

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename  TEXT NOT NULL,
  data       TEXT NOT NULL,             -- full JSON snapshot (users + inventory)
  user_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS waifu_claims (
  character_id TEXT FRIMARY KEY,
  user_id     INTEGER NOT NULL,
  name         TEXT DEFAULT '',
  series       TEXT DEFAULT '',
  image_url    TEXT DEFAULT '',
  claimed_at  "INTEGER NOT NULL,
);

CREATE TABLE IF NOT EXISTS waifu_spawn (
  id          "INTEGER PRIMARY KEY CHECK (id = 1),
  character_id TEXT DEFAULT '',
  name         TEXT DEFAULT '',
  series       TEXT DEFAULT '',
  image_url    TEXT DEFAULT '',
  spawned_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  claimed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hunt_cache (
  character_id TEXT PRIMARY KEY,
  name         TEXT DEFAULT '',
  series       TEXT DEFAULT '',
  anime        TEXT DEFAULT '',
  image_url    TEXT DEFAULT '',
  bio          TEXT DEFAULT '',
  favorites    INTEGER NOT NULL DEFAULT 0,
  rarity       TEXT DEFAULT 'common',
  cached_at    INTEGER NOT NULL
NÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ[ØÛZ[\È
ˆÚ\˜XÝ\—ÚYV’SPT–HÑVKˆ\Ù\—ÚYS•QÑTˆ“Õ•Sˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆ˜\š]HVQUS	ØÛÛ[[Û‰ËˆÛZ[YYØ]S•QÑTˆ“Õ•S
NÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ[ÜÜ]Ûˆ
ˆY’S•QÑTˆ’SPT–HÑVHÒPÒÈ
YHJKˆÚ\˜XÝ\—ÚYVQUS	ÉËˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆ˜\š]HVQUS	ØÛÛ[[Û‰ËˆÜ]Û™YØ]S•QÑTˆ“Õ•Sˆ^\™\×Ø]S•QÑTˆ“Õ•SˆÛZ[YYS•QÑTˆ“Õ•SQUSˆÚ]ÚYS•QÑTˆ“Õ•SQUSŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ›ÝÛY[[ÜžH
ˆÙ^HV’SPT–HÑVKˆ˜[YHV“Õ•SˆØ]YÛÜžHV“Õ•SQUS	ÙÙ[™\˜[	Ëˆ\]YØ]’S•QÑTˆ“Õ•SŠNÂ˜
NÂ‚‹ËÈKKKHØY™HZYÜ˜][Ûˆ›ÜˆVTÕS‘ÈÔS]HœÈ
Ô‘PUHQˆ“ÕVTÕÈÛÛ‰ÝYHÛÛ[[ŠHKKKB‹ËÈ]™\žH\Ù\‹Y]HÜš]H›ÝÈÝ[\Èœ]YØ]ÛÈÝ[HÛ˜\ÚÝÈØ[ˆ‘U‘T‚‹ËÈÝ™\Üš]H™]Ù\ˆ]H[ˆZ]\ˆ\™XÝ[Ûˆ
ÔS]HOˆÜÝÜ™\ÊK‚˜ÛÛœÝTÑT—ÐÓÓÈH‹œ™\\™J	ÔQÓPHX›WÚ[™›Ê\Ù\œÊIÊK˜[

K›X\

ÊHOˆË›˜[YJNÂšYˆ
UTÑT—ÐÓÓËš[˜ÛY\Ê	Ý\]YØ]	ÊJHÂˆ‹™^XÊ	ÐSTˆP“H\Ù\œÈQÓÓSSˆ\]YØ]S•QÑTˆ“Õ•SQUS	ÊNÂˆËÈ˜XÚÙš[YØXÞH›ÝÜÈÚ]HÙ[œÚX›H[Y\Ý[\
Z\ˆÜ™X][Ûˆ[YJK‚ˆ‹™^XÊ•TUH\Ù\œÈÑU\]YØ]HÜ™X]YØ]ÒT‘H\]YØ]HŠNÂŸB‹ËÈ˜[šÈÞ\Ý[HÛÛ[[œÈ
Y[\Ý[8 %Ô‘PUH‘ˆ“ÕVTÕÈÛÛ‰ÝY[HÈ[‚‹ËÈ^\Ý[™È\Ù\œÈX›KÛÈZYÜ˜]H[ˆXÙHÚ]Ý]ÝXÚ[™È[žH]JK‚šYˆ
UTÑT—ÐÓÓËš[˜ÛY\Ê	Ü˜[šÉÊJHÂˆ‹™^XÊSTˆP“H\Ù\œÈQÓÓSSˆ˜[šÈVQUS	Øœ›Ûž™IÈŠNÂŸBšYˆ
UTÑT—ÐÓÓËš[˜ÛY\Ê	Ü˜[š×Ý˜[YÛX]Ú\ÉÊJHÂˆ‹™^XÊ	ÐSTˆP“HœÈQÓÓSSˆ˜[š×Ý˜[YÛX]Ú\ÈS•QÑTˆ“Õ•SQUS	ÊNÂŸBšYˆ
UTÑT—ÐÓÓËš[˜ÛY\Ê	Ü˜[š×ØÛÛœÙXÝ]]™WÛÜÜÙ\ÉÊJHÂˆ‹™^XÊ	ÐSTˆP“H\Ù\œÈQÓÓSSˆ˜[š×ØÛÛœÙXÝ]]™WÛÜÜÙ\ÈS•QÑTˆ“Õ•SQUS	ÊNÂŸB‚‹ÊˆOOOOOOOOOOOOOOOOHÜÝÜ™\È
\˜X›HÝÜ™JHOOOOOOOOOOOOOOOOH
‹Â‚˜ÛÛœÝUPTÑWÕT“H
ÛÛ™šYË™]X˜\ÙU\›	ÉÊKš[J
NÂ˜ÛÛœÝÑ[˜X›YHUPTÑWÕT“›[™ÝˆÂ›]ÛÛH[Â‚‹ËÈš[X\žK]Üš]\ˆYš\ÛÜžK[ØÚÈÝ]KˆÜÝÜ™TÑSYš\ÛÜžHØÚÜÈ\™HÑTÔÒSÓ‹\ØÛÜY‹ËÈÛÈHÝÛš[™ÈÛY[UTÕ™[XZ[ˆÚXÚÙYÝ]›ÜˆHY™][YHÙˆH›ØÙ\ÜË‚›][œÝ[˜ÙSØÚÐÛY[H[Â›][œÝ[˜ÙSØÚÒÙ^HH[Â›][œÝ[˜ÙSØÚÒ[H˜[ÙNÂ›][œÝ[˜ÙSØÚÒX\™X]H[Â‚‹ËÈ\š]™YÛÛ›™XÝ[Ûˆ[™›È›ÜˆX[ÛÙÙÚ[™È
\ÜÝÛÜ™[Ø^\È™YXÝY
K‚›]ÒÜÝH	ÉÎÂ›]ÔÜHÂžHÂˆYˆ
Ñ[˜X›Y
HÂˆÛÛœÝHH™]ÈT“
UPTÑWÕT“œ™\XÙJ×œÜÝÜ™\Î—×ËÚK	ÜÜÝÜ™\Ü[‹ËÉÊJNÂˆÒÜÝHKšÜÝ˜[YH	ÉÎÂˆÔÜH[X™\ŠKœÜ
HMÌŽÂˆBŸHØ]Ú
JHÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—HÛÝ[›Ý\œÙHUPTÑWÕT“‰ËK›Y\ÜØYÙJNÂŸB‚šYˆ
Ñ[˜X›Y
HÂˆžHÂˆÛÛH™]ÈÛÛ
ÂˆÛÛ›™XÝ[Û”Ýš[™ÎˆUPTÑWÕT“ˆX^ˆKˆÛÛ›™XÝ[Û•[Y[Ý]Z[\ÎˆMLˆYU[Y[Ý]Z[\ÎˆÌˆËÈÙ\™\‹\ÚYH[Y[Ý]ˆÜÝÜ™TÔS]Ù[ˆÝÜÈ^XÝ][™ÈHÝ][Y[ˆËÈÛ˜ÙH\È[Z]\È™XXÚY‚ˆÝ][Y[Ý[Y[Ý]ˆLˆËÈÝ\X˜\ÙH™\]Z\™\ÈÔÓ›Üˆ]ÈÜÝÜ™\È
\™XÝMÌˆS‘ÛÛ\ˆMÊK‚ˆËÈ\ÙHÜÛ[ÙO\™\]Z\™H
™\Ù[[ˆÛÛ\ˆT“ÊHÚ[ˆ]˜Z[X›KÝ\Ú\ÙBˆËÈY˜][ÈÈÚ]Ù\˜[Y][Ûˆ™[^Y›ÜˆÝ\X˜\ÙK˜ÛÈÜÝË‚ˆÜÛ‚ˆ×ÜÛ[ÙO\™\]Z\™W‹ÚK\Ý
UPTÑWÕT“
BˆÈÈ™Z™XÝ[˜]]Üš^™Yˆ˜[ÙHBˆˆÜÝ\X˜\ÙW˜ÛËÚK\Ý
UPTÑWÕT“
BˆÈÈ™Z™XÝ[˜]]Üš^™Yˆ˜[ÙHBˆˆ[™Yš[™YˆJNÂˆÛÛ›ÛŠ	Ù\œ›Ü‰Ë
\œŠHOˆÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—HÜÝÜ™\ÈÛÛ\œ›ÜŽ‰Ë\œˆ	‰ˆ\œ‹›Y\ÜØYÙHÈ\œ‹›Y\ÜØYÙHˆ\œŠNÂˆ™XÛÜ™Ñ˜Z[\™J\œˆ™]È\œ›ÜŠ	Ý[šÛ›ÝÛˆÈÛÛ\œ›Ü‰ÊK	ÜÛÛ	ÊNÂˆJNÂˆHØ]Ú
JHÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—H[˜[YUPTÑWÕT“8 %˜[[™È˜XÚÈÈÔS]K[Û›N‰ËK›Y\ÜØYÙJNÂˆÛÛH[ÂˆÓ\Ý\œ›ÜˆH˜YUPTÑWÕT“ˆ	ÊK›Y\ÜØYÙHÝš[™ÊJJKœÛXÙJÌ
_XÂˆÓ\Ý\œ›Ü]H]K››ÝÊ
NÂˆÐÛÛ›™XÝ]š]HH	ÙYÜ˜YY	ÎÂˆBŸB‚šYˆ
\Ñ[˜X›Y
HÂˆÛÛœÛÛKØ\›Šˆ	ÖÙ—H8¦¨UPTÑWÕT“›ÝÙ]8 %[›š[™ÈÔS]K[Û›H
\[Y\˜[
Kˆ	È
Âˆ	Ð˜[[˜Ù\ÈÚ[‘TÑUÛˆ™Y\ÞKˆÙ]UPTÑWÕT“
Ý\X˜\ÙKÔÜÝÜ™\ÊH›Üˆ\˜X›H\œÚ\Ý[˜ÙK‰Âˆ
NÂŸH[ÙHÂˆÛÛœÛÛK›ÙÊÙ—HÜÝÜ™\ÈZ\œ›ÜˆÓÓ‘’QÕT‘Q
	ÜÒÜÝN‰ÔÜJH8 %ØZ][™È›ÜˆÛÛ›™XÝ[Û¸ )˜
NÂŸB‚˜ÛÛœÝ×ÔÐÒSPHHÔ‘PUHP“HQˆ“ÕVTÕÈ\Ù\œÈ
ˆ\Ù\—ÚY’QÒS•’SPT–HÑVKˆ\Ù\›˜[YHVQUS	ÉËˆš\œÝÛ˜[YHVQUS	ÉËˆØ[]’QÒS•“Õ•SQUSˆ˜[šÈ’QÒS•“Õ•SQUSˆÝ]\ÈVQUS	ØXÝ]™IËˆÝ]\×Ü™X\ÛÛˆVQUS	ÉËˆÝ]\×Ý[[’QÒS•QUSˆY[—Ý[[’QÒS•QUSˆ˜[šÈVQUS	Øœ›Ûž™IËˆ˜[š×Ý˜[YÛX]Ú\È’QÒS•QUSˆ˜[š×ØÛÛœÙXÝ]]™WÛÜÜÙ\È’QÒS•QUSˆÜ™X]YØ]’QÒS•“Õ•Sˆ\]YØ]’QÒS•“Õ•SQUSKH™\œÚ[ÛˆÝ[\ˆÓ“H[Y\Ý[\Ü™\š[™ÈXÚY\ÈÚXÚÝ]HÚ[œÂŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ[YWÝØ[]
ˆ\Ù\—ÚY’QÒS•’SPT–HÑVKˆ[[Ý[’QÒS•“Õ•SQUSˆ^\™\×Ø]’QÒS•“Õ•SQUSˆÛÝ\˜ÙHVQUS	ÉËˆÜ™X]YØ]’QÒS•“Õ•Sˆ\]YØ]’QÒS•“Õ•SQUSŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈÛÛÛÝÛœÈ
ˆ\Ù\—ÚY’QÒS•“Õ•SˆXÝ[ÛˆV“Õ•Sˆ[[’QÒS•“Õ•Sˆ’SPT–HÑVH
\Ù\—ÚYXÝ[ÛŠBŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈÝ\žH
ˆYÓPSS•’SPT–HÑVHÒPÒÈ
YHJKˆÝ’QÒS•“Õ•SQUSˆXÚÙ]ØÛÝ[’QÒS•“Õ•SQUSˆXÚÙ]ÈV“Õ•SQUS	Ö×IÂŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈZ\ÝÈ
ˆXY\—ÚY’QÒS•’SPT–HÑVKˆXY\—Û˜[YHVQUS	ÉËˆ\™Ù]ÚY’QÒS•“Õ•Sˆ\™Ù]Û˜[YHVQUS	ÉËˆY[X™\œÈV“Õ•SQUS	Ö×IËˆÝ\YØ]’QÒS•“Õ•SˆÝ]\ÈVQUS	ÛÜ[‰ÂŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈÚ]ÛÙÜÈ
ˆY’QÔÑT’PS’SPT–HÑVKˆ\Ù\—ÚY’QÒS•“Õ•Sˆ\Ù\›˜[YHVQUS	ÉËˆš\œÝÛ˜[YHVQUS	ÉËˆÚ]ÚY’QÒS•“Õ•SˆÚ]Ý]HVQUS	ÉËˆ^VQUS	ÉËˆ\×ØÛÛ[X[™ÓPSS•QUSˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈØ[YWÚ\ÝÜžH
ˆY’QÔÑT’PS’SPT–HÑVKˆ\Ù\—ÚY’QÒS•“Õ•Sˆ\Ù\›˜[YHVQUS	ÉËˆØ[YHV“Õ•Sˆ™]’QÒS•QUSˆ™\Ý[VQUS	ÉËˆ[[Ý[’QÒS•QUSˆY]HVQUS	ÞßIËˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈYZ[—Ý\Ù\œÈ
ˆ\Ù\—ÚY’QÒS•’SPT–HÑVKˆ\Ù\›˜[YHVQUS	ÉËˆ›ÛHVQUS	Û[Ù	Ëˆ\ÜÝÛÜ™VQUS	ÉËˆÜ™X]YØ]’QÒS•“Õ•Sˆ\ÝÛÙÚ[ˆ’QÒS•QUSŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ›ÝÙ]™[È
ˆY’QÔÑT’PS’SPT–HÑVKˆ]HV“Õ•Sˆ\ØÜš\[ÛˆVQUS	ÉËˆ\HVQUS	ÛZ\ÜÚ[Û‰Ëˆ™]Ø\™’QÒS•QUSˆÝ\×Ø]’QÒS•QUSˆ[™×Ø]’QÒS•QUSˆXÝ]™HÓPSS•QUSKˆÜ™X]YØžH’QÒS•QUSˆÜ™X]YØ]’QÒS•“Õ•SˆÛÛ\][ÛœÈ’QÒS•QUSŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈœ›ØYØ\ÝÈ
ˆY’QÔÑT’PS’SPT–HÑVKˆY\ÜØYÙHV“Õ•Sˆ\™Ù]VQUS	Ø[	ËˆÙ[ØÛÝ[’QÒS•QUSˆÜ™X]YØžH’QÒS•QUSˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈXÝ]š]WÙ™YY
ˆY’QÔÑT’PS’SPT–HÑVKˆ\HVQUS	Ù]™[	Ëˆ^V“Õ•SˆY]HVQUS	ÞßIËˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ]Y]ÛÙÈ
ˆY’QÔÑT’PS’SPT–HÑVKˆXÝÜ—ÚY’QÒS•“Õ•SˆXÝÜ—Û˜[YHVQUS	ÉËˆXÝ[ÛˆV“Õ•Sˆ\™Ù]ÚY’QÒS•QUSˆ]Z[VQUS	ÉËˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ[™[ÜžH
ˆ\Ù\—ÚY’QÒS•“Õ•Sˆ][WÚYV“Õ•Sˆ]X[]H’QÒS•“Õ•SQUSˆ\]YØ]’QÒS•“Õ•Sˆ’SPT–HÑVH
\Ù\—ÚY][WÚY
BŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ™YY[WØÛÙ\È
ˆÛÙHV’SPT–HÑVKˆ[[Ý[’QÒS•“Õ•SˆX^Ý\Ù\È’QÒS•“Õ•Sˆ\ÙYØÛÝ[’QÒS•“Õ•SQUSˆÜ™X]YØžH’QÒS•“Õ•SˆÜ™X]Ü—Ü›ÛHVQUS	ÛÝÛ™\‰ËˆÜ™X]YØ]’QÒS•“Õ•SŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ™YY[WÜ™Y[\[ÛœÈ
ˆÛÙHV“Õ•Sˆ\Ù\—ÚY’QÒS•“Õ•Sˆ™YY[YYØ]’QÒS•“Õ•Sˆ’SPT–HÑVH
ÛÙK\Ù\—ÚY
BŠNÂÔ‘PUHP“HQˆ“ÕVTÕÈ˜XÚÝ\È
ˆY’QÔÑT’PS’SPT–HÑVKˆš[[˜[YHV“Õ•Sˆ]HV“Õ•Sˆ\Ù\—ØÛÝ[’QÒS•“Õ•SQUSˆÜ™X]YØžH’QÒS•QUSˆÜ™X]YØ]’QÒS•“Õ•SŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈÙ][™ÜÈ
ˆÙ^HV’SPT–HÑVKˆ˜[YHV“Õ•Sˆ\]YØ]’QÒS•“Õ•SŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈØZYWØÛZ[\È
ˆÚ\˜XÝ\—ÚYV’SPT–HÑVKˆ\Ù\—ÚY’QÒS•“Õ•Sˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆÛZ[YYØ]’QÒS•“Õ•SŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈØZYWÜÜ]Ûˆ
ˆYÓPSS•’SPT–HÑVHÒPÒÈ
YHJKˆÚ\˜XÝ\—ÚYVQUS	ÉËˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆÜ]Û™YØ]’QÒS•“Õ•Sˆ^\™\×Ø]’QÒS•“Õ•SˆÛZ[YYÓPSS•“Õ•SQUSŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ[ØØXÚH
ˆÚ\˜XÝ\—ÚYV’SPT–HÑVKˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[š[YHVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆš[ÈVQUS	ÉËˆ˜]›Üš]\È’QÒS•“Õ•SQUSˆ˜\š]HVQUS	ØÛÛ[[Û‰ËˆØXÚYØ]’QÒS•“Õ•SŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ[ØÛZ[\È
ˆÚ\˜XÝ\—ÚYV’SPT–HÑVKˆ\Ù\—ÚY’QÒS•“Õ•Sˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆ˜\š]HVQUS	ØÛÛ[[Û‰ËˆÛZ[YYØ]’QÒS•“Õ•SŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ[ÜÜ]Ûˆ
ˆYÓPSS•’SPT–HÑVHÒPÒÈ
YHJKˆÚ\˜XÝ\—ÚYVQUS	ÉËˆ˜[YHVQUS	ÉËˆÙ\šY\ÈVQUS	ÉËˆ[XYÙWÝ\›VQUS	ÉËˆ˜\š]HVQUS	ØÛÛ[[Û‰ËˆÜ]Û™YØ]’QÒS•“Õ•Sˆ^\™\×Ø]’QÒS•“Õ•SˆÛZ[YYÓPSS•“Õ•SQUSˆÚ]ÚY’QÒS•“Õ•SQUSŠNÂ‚Ô‘PUHP“HQˆ“ÕVTÕÈ›ÝÛY[[ÜžH
ˆÙ^HV’SPT–HÑVKˆ˜[YHV“Õ•SˆØ]YÛÜžHV“Õ•SQUS	ÙÙ[™\˜[	Ëˆ\]YØ]’QÒS•“Õ•SŠNÂ˜Â‚‹ËÈØY™HZYÜ˜][Ûˆ›ÜˆVTÕS‘ÈÜÝÜ™\ÈœÈ
Ô‘PUHP“HQˆ“ÕVTÕÈ\Â‹ËÈH›Ë[ÜÚ[ˆHX›H[™XYH^\ÝËÛÈH™]ÈÛÛ[[ˆ]\Ý™HYY‹ËÈ^XÚ]JKˆ˜Z[\™\È\™HÛ\˜]Y8 %Hœ™\Ú\ÞHÙˆH™]ÈÛÙHÚ[‹ËÈÝ[\\]YØ]Ûˆ]™\žHÜš]H[ž]Ø^K‚˜ÛÛœÝ×ÐST”ÈHÂˆSTˆP“H\Ù\œÈQÓÓSSˆQˆ“ÕVTÕÈ\]YØ]’QÒS•“Õ•SQUS‹ˆ•TUH\Ù\œÈÑU\]YØ]HÜ™X]YØ]ÒT‘H\]YØ]H‹ˆSTˆP“HœÈQÓÓSSˆQˆ“ÕVTÕÈ˜[šÈVQUS	Øœ›Ûž™IÈ‹ˆSTˆP“H\Ù\œÈQÓÓSSˆQˆ“ÕVTÕÈ˜[š×Ý˜[YÛX]Ú\È’QÒS•“Õ•SQUS‹ˆSTˆP“H\Ù\œÈQÓÓSSˆQˆ“ÕVTÕÈ˜[š×ØÛÛœÙXÝ]]™WÛÜÜÙ\È’QÒS•“Õ•SQUS‹—NÂ‚‹ÊŠˆÜ™X]HÜÝÜ™\ÈX›\È
Y[\Ý[
Kˆ™]\›œÈYHÛˆÝXØÙ\ÜËˆ
‹Â˜\Þ[˜È[˜Ý[Ûˆ[š]Ê
HÂˆYˆ
\ÛÛ
H™]\›ˆ˜[ÙNÂˆžHÂˆËÈZYÜ˜]H^\Ý[™ÈX›\Èš\œÝ
Y\]YØ]È\Ù\œÈÛˆÛœÊKˆËÈ[ˆÜ™X]H[žHZ\ÜÚ[™ÈX›\Ë‚ˆ›Üˆ
ÛÛœÝÝ]Ùˆ×ÐST”ÊHÂˆžHÂˆ]ØZ]ÛÛœ]Y\žJÝ]
NÂˆHØ]Ú
JHÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—HÈZYÜ˜][ÛˆÚÚ\Y‰ËÝ]œÜ]
	È	ÊKœÛXÙJŠKš›Ú[Š	È	ÊK	ËO‰ËK›Y\ÜØYÙJNÂˆBˆBˆ]ØZ]ÛÛœ]Y\žJ×ÔÐÒSPJNÂˆ™]\›ˆYNÂˆHØ]Ú
JHÂˆËÈØ\\™HHVPÕ™X\ÛÛˆ
]]˜Z[YÈ[Y[Ý]È›ØÚÙYÜÈ˜YÜÝ
BˆËÈÛÈÚX[ÙXYÈ[™›ÛÝÙÜÈÚÝÈÚHHÛÛ›™XÝ[Ûˆ\È˜Z[[™Ë‚ˆÛÛœÝÛÙHHK˜ÛÙHÈÉK˜ÛÙWXˆ	ÉÎÂˆÛÛœÝ]Z[H
K›Y\ÜØYÙHÝš[™ÊJJKœÛXÙJÌ
NÂˆÓ\Ý\œ›ÜˆH[š]˜Z[Y	ØÛÙ_Nˆ	Ù]Z[XÂˆÓ\Ý\œ›Ü]H]K››ÝÊ
NÂˆÐÛÛ›™XÝ]š]HH	ÙYÜ˜YY	ÎÂˆÑ˜Z[\™\ÊÊÎÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—HÜÝÜ™\ÈØÚ[XH[š]˜Z[Y
ÛÛ[Z[™ÈÔS]K[Û›JN‰Ë]Z[
NÂˆ™]\›ˆ˜[ÙNÂˆBŸB‚‹ÊŠ‚ˆ
ˆÜÝÜ™\ÈÜš]H\[[™H8 %Õ’PÕÜš]K]›ÝYÚÚ]™\šYšXØ][Û‹‚ˆ
‚ˆ
ˆ]™\žH]]][ÛˆÈÔS]H\ÈSÓÈÜš][ˆÈÜÝÜ™\Ë[™HÜš]H\Âˆ
ˆ‘PQPÒÈœ›ÛHÜÝÜ™\È™Y›Ü™H]\ÈÛÛœÚY\™Y™\šYšYYˆÜš]\È›ÜˆBˆ
ˆØ[YHX›H\™HÝšXÝHÜ™\™Y
H]\ˆÜš]HÈ\Ù\ˆØ[ˆ™]™\ˆ[™ˆ
ˆ™Y›Ü™H[ˆX\›Y\ˆÛ™H[™™HÝ™\Üš][ˆžHÝ[H]JK[™]™\žH]Y\žBˆ
ˆ[œÈ[™\ˆH\™[Y[Ý]ÛÈH[™ÈÛÛ\ˆÛÛ›™XÝ[ÛˆØ[ˆ‘U‘TˆÙYÙHBˆ
ˆ\[[™HÚ[[K‚ˆ
‚ˆ
ˆHÛ\ÚYÛˆØÚY[Yš\™KX[™Y›Ü™Ù]Z\œ›ÜœÈÛˆÛ™HÙ\šX[^™Y›ÛZ\ÙBˆ
ˆÚZ[ˆÚ]“È[Y[Ý]ˆHÚ[™ÛH›ÜYÙ\ÜÚ[Û‹\ÛÛ\ˆÛÛ›™XÝ[ÛˆYÛ™Bˆ
ˆ[™È]Y\žH›ØÚÚ[™ÈHÚÛH]Y]YH›Ü™]™\‹Ú[HÚX[Ù\ÚÝÚ[™Âˆ
ˆ¸§hHÛÛ›™XÝY
Z\œ›ÜœÎˆ[›š[™ÊHˆ™XØ]\ÙH\ÝZ\œ›Ü]Ø\ÈÝ[\Y]ˆ
ˆÐÒQSH[YK›ÝÛÛ\][Û‹ˆ˜[[˜Ù\È[ˆ™]™\YÈÝ[H˜[Y\ÈÛ‚ˆ
ˆ]™\žH™ZY˜]Kˆ\È™]Üš]H™[[Ý™\È][\™H˜Z[\™HÛ\ÜË‚ˆ
‹Â›]Ô™XYHH˜[ÙNÂ›]Ò[š]›ÛZ\ÙHH[Â›]Ñ˜Z[\™\ÈHÂ›]Ó\Ý\œ›ÜˆH	ÉÎÂ›]Ó\Ý\œ›Ü]HÂ›]ÐÛÛ›™XÝ]š]HH	Ý[šÛ›ÝÛ‰ÎÈËÈ[šÛ›ÝÛˆÛÛ›™XÝ[™ÈÛÛ›™XÝYYÜ˜YY›]Ó\ÝÜš]P]HÈËÈÚ[ˆH\ÝÈÜš]HÕPÐÑQQQ
\ÊB›]Ó\Ý™\šYžP]HÈËÈÚ[ˆH\Ý™XYX˜XÚÈ™\šYšXØ][Ûˆ\ÜÙY
\ÊB›]ÕÜš]\ÓÚÈHÈËÈÝ[™\šYšYYÜš]\Â›]ÕÜš]\Ñ˜Z[YHÈËÈÝ[˜Z[YÜš]\Â›]\ÝZ\œ›Ü]HÈËÈÚ[ˆH\š[ÙXÈ[\Þ[˜È\ÝSˆ
ÛÛ\]Y
B›]\œÚ\Ý[˜ÙQYÜ˜YYH˜[ÙNÂ›][Z\œ›Ü’[‘›YÚH˜[ÙNÂ˜ÛÛœÝ×ÐÔ’UPÐSÑRST‘TÈHÎÂ˜ÛÛœÝ×ÔUQT–WÕSQSÕUÓTÈHLÈËÈ\™\‹\]Y\žH[Y[Ý]8 %H[™ÈÛÛ\ˆ™]™\ˆÙYÙ\ÈH\[[™B‚‹ÊˆOOOOOOOOOOOOOOOOH\K]˜XÚÚ[™È
˜[™ÚYš^
HOOOOOOOOOOOOOOOOBˆ
ˆHÌÈ[Z\œ›Ü[

X™K\Ù[]™\žH›ÝÈÙˆ]™\žHX›H]™[ˆÚ[ˆBˆ
ˆ›ÝØ\ÈYH8 %HÛZ[˜[YÜ™\ÜÈÛÜÝˆÙH›ÝÈ˜XÚÈÒPÒX›\ËÜ›ÝÜÂˆ
ˆXÝX[HÚ[™ÙY[™Z\œ›ÜˆÛ›HÜÙKˆH\˜Xš[]H\˜Ú]XÝ\™Bˆ
ˆ
Yš\ÛÜžHØÚËY˜][Û‹˜Z[XÛÜÙY™[˜Ú[™Ë™\œÚ[ÛˆÜ™\š[™ÊH\Âˆ
ˆ[ÝXÚYˆ\ÈÛ›HÚ[™Ù\ÈH
œÞ[˜È^[ØYÚ\H
ÈØY[˜ÙJ‹‚ˆ
‹Â˜ÛÛœÝÖS×ÔÒÒTÕP“TÈH™]ÈÙ]
ÉØ˜XÚÝ\É×JNÈËÈ˜XÚÝ\È[™XYHÜš]HÛ˜ÙHšXHØ]™P˜XÚÝ\Ê
B˜ÛÛœÝ‘PÓÓÒSWÒS•T•SÓTÈHMH
ˆŒ
ˆLÈËÈØY™]K[™][™XÛÛ˜Ú[X][ÛˆØY[˜ÙB˜ÛÛœÝ\UX›\ÈH™]ÈÙ]

NÈËÈX›\ÈÚ][œÞ[˜ÙYØØ[Ú[™Ù\Â˜ÛÛœÝ\T›ÝÒÙ^\ÈH™]ÈX\

NÈËÈX›HOˆÙ]ÙˆÚ[™ÛKTÈÙ^HÝš[™ÜÂ›]›ÝÜÓZ\œ›Ü™YHÈËÈÝ[][]]™H›ÝÜÈ\Ù\YÈÜÝÜ™\Â›]ž]\ÓZ\œ›Ü™YHÈËÈÝ[][]]™H\Ý[X]Y^[ØYž]\Â›]Z\œ›Ü[[œÈHÈËÈ\K\Þ[˜È[œÈ
\š[ÙXÊB›]™XÛÛ˜Ú[T[œÈHÈËÈ[™XÛÛ˜Ú[X][Ûˆ[œÂ›]\Ý[™XÛÛ˜Ú[P]HÈËÈÚ[ˆH\Ý[™XÛÛ˜Ú[X][ÛˆÛÛ\]Y›]\ÝZ\œ›Ü”›ÝÜÈHÂ›]\ÝZ\œ›Üž]\ÈHÂ›]\ÝZ\œ›Ü•X›\ÈHÂ‚‹ÊŠˆX\šÈHX›H
[™Ü[Û˜[HÛ™H›ÝË›ÜˆÚ[™ÛKTÈX›\ÊH\ÈÚ[™ÙYˆ
‹Â™[˜Ý[ÛˆX\šÑ\JX›KÕ˜[YHH[
HÂˆ\UX›\Ë˜Y
X›JNÂˆYˆ
Õ˜[YHOH[	‰ˆP“WÔÔÖÝX›WH	‰ˆP“WÔÔÖÝX›WK›[™ÝOOHJHÂˆYˆ
Y\T›ÝÒÙ^\Ëš\ÊX›JJH\T›ÝÒÙ^\ËœÙ]
X›K™]ÈÙ]

JNÂˆ\T›ÝÒÙ^\Ë™Ù]
X›JK˜Y
Ýš[™ÊÕ˜[YJJNÂˆBŸB‚‹ÊŠˆ]ÛZXØ[HZÙH
ÈÛX\ˆH\HX\šÙ\œÈ›ÜˆÛ™HX›Kˆ
‹Â™[˜Ý[ÛˆØ\\™Q\JX›JHÂˆÛÛœÝÙ^\ÈH\T›ÝÒÙ^\Ë™Ù]
X›JH[Âˆ\T›ÝÒÙ^\Ë™[]JX›JNÂˆ\UX›\Ë™[]JX›JNÂˆ™]\›ˆÙ^\ÎÂŸB‚‹ÊŠˆÙ[XÝ›ÝÜÈ›ÜˆHÚ[™ÛKTÈX›HžHš[X\žKZÙ^H˜[Y\È
[œÚYHH]Y]YJKˆ
‹Â™[˜Ý[ÛˆÙ[XÝ›ÝÜÐžTÚ[™ÛTÊX›KÕ˜[Y\ÊHÂˆÛÛœÝÛÛÈHP“WÐÓÓÖÝX›WKœÜ]
	Ë	ÊNÂˆÛÛœÝÐÛÛHP“WÔÔÖÝX›WVÌNÂˆÛÛœÝXÙZÛ\œÈHÕ˜[Y\Ë›X\


HOˆ	ÏÉÊKš›Ú[Š	Ë	ÊNÂˆ™]\›ˆ‹œ™\\™JÑSPÕ	ØÛÛËš›Ú[Š	Ë	Ê_H”“ÓH	ÝX›_HÒT‘H	ÜÐÛÛHSˆ
	ÜXÙZÛ\œßJX
K˜[
‹‹œÕ˜[Y\ÊNÂŸB‚‹ÊŠ‚ˆ
ˆ[[YYX][HZ\œ›ÜˆÓ‘HÚ[™ÙY›ÝÈ
Ú[™ÛKTÈX›\ÊHÚ]H˜]ÚY\Ù\‚ˆ
ˆ\È\ÈHÊJK\\‹]Üš]H™\XÙ[Y[›ÜˆZ\œ›Ü•X›J	Ý\Ù\œÉÊXÎˆ]X\šÜÂˆ
ˆH›ÝÈ\K\Ú\ÈÛ›H]›ÝË[™ÛX\œÈHX\šÙ\ˆÛˆÝXØÙ\ÜËˆYˆBˆ
ˆ\Ú˜Z[È
YÜ˜YY[ÙJKHX\šÙ\ˆ‘SPRS”ÈÛÈH\š[ÙXÈÛÜÜˆBˆ
ˆ™XÛÛ›™XÝ™XÛÛ˜Ú[H™]šY\È]8 %\˜Xš[]H\È™\Ù\™YYÜ™\ÜÈ\ÈÛÛ\ÙY‚ˆ
‹Â™[˜Ý[ÛˆZ\œ›ÜÚ[™ÙY›ÝÊX›KÕ˜[YJHÂˆYˆ
UP“WÔÔÖÝX›WHP“WÔÔÖÝX›WK›[™ÝOOHJHÂˆËÈ›ÈÚ[™ÛHÈ8¡¤ˆØ[‰Ý\™Ù]Û™H›ÝÎÈ˜[˜XÚÈÈH\HÚÛK]X›HZ\œ›Ü‹‚ˆX\šÑ\JX›JNÂˆ™]\›ˆZ\œ›Ü•X›JX›JNÂˆBˆÛÛœÝÙ^HHÝš[™ÊÕ˜[YJNÂˆX\šÑ\JX›KÕ˜[YJNÂˆ™]\›ˆ]Y]YTÕÜš]JX›K\Þ[˜È

HOˆÂˆYˆ
\ÛÛ\Ô™XYH\Þ[˜Ñ[˜X›Y\œÚ\Ý[˜ÙQYÜ˜YY
H™]\›ˆÂˆYˆ
Ñ[˜X›Y	‰ˆZ[œÝ[˜ÙSØÚÒ[
H™]\›ˆÂˆÛÛœÝ›ÝÜÈHÙ[XÝ›ÝÜÐžTÚ[™ÛTÊX›KÚÙ^WJNÂˆYˆ
\›ÝÜË›[™Ý
H™]\›ˆÂˆÛÛœÝÛY[H]ØZ]ÛÛ˜ÛÛ›™XÝ

NÂˆžHÂˆÛÛœÝÜš][ˆH]ØZ]\Ù\›ÝÜÐ˜]ÚY
ÛY[X›K›ÝÜÊNÂˆËÈÛX\ˆ\È›ÝÉÜÈ\HX\šÙ\ˆÛ›HY\ˆHÝXØÙ\ÜÙ[\Ú‚ˆÛÛœÝÈH\T›ÝÒÙ^\Ë™Ù]
X›JNÂˆYˆ
ÊHÂˆË™[]JÙ^JNÂˆYˆ
ËœÚ^™HOOH
HÂˆ\T›ÝÒÙ^\Ë™[]JX›JNÂˆ\UX›\Ë™[]JX›JNÂˆBˆBˆ›ÝÜÓZ\œ›Ü™Y
ÏHÜš][ŽÂˆž]\ÓZ\œ›Ü™Y
ÏH›ÝÜËœ™YXÙJ
‹ŠHOˆˆ
È”ÓÓ‹œÝš[™ÚYžJŠK›[™Ý
È
NÂˆ™]\›ˆÜš][ŽÂˆHš[˜[HÂˆÛY[œ™[X\ÙJ
NÂˆBˆJNÂŸB‚‹ËÈ\‹]X›HÜš]HÚZ[ˆÛÈÜš]\ÈÈHØ[YHX›HÝ^HÝšXÝHÜ™\™Y‚˜ÛÛœÝÐÚZ[œÈHßNÂ™[˜Ý[ÛˆX›PÚZ[ŠX›JHÂˆYˆ
\ÐÚZ[œÖÝX›WJHÐÚZ[œÖÝX›WHH›ÛZ\ÙKœ™\ÛÛ™J
NÂˆ™]\›ˆÐÚZ[œÖÝX›WNÂŸB‚‹ÊŠˆ[X[‹\™XYX›H[\ÙY[YH[\ˆ›ÜˆX[Ý]]ˆ
‹Â™[˜Ý[ÛˆYÛÓX™[
ÊHÂˆYˆ
]ÊH™]\›ˆ	Û™]™\‰ÎÂˆÛÛœÝ\ÈH]K››ÝÊ
HHÎÂˆYˆ
\ÈL
H™]\›ˆ	Ú\Ý›ÝÉÎÂˆYˆ
\ÈŒ
H™]\›ˆ	ÓX]™›ÛÜŠ\ÈÈL
_\ÈYÛØÂˆYˆ
\ÈÍŒ
H™]\›ˆ	ÓX]™›ÛÜŠ\ÈÈŒ
_[H	ÓX]™›ÛÜŠ
\È	HŒ
HÈL
_\ÈYÛØÂˆ™]\›ˆ	ÓX]™›ÛÜŠ\ÈÈÍŒ
_Z	ÓX]™›ÛÜŠ
\È	HÍŒ
HÈŒ
_[HYÛØÂŸB‚‹ÊŠ‚ˆ
ˆ[ˆÛ™H]Y\žHÛˆÜÝÜ™\È[™\ˆH\™[Y[Ý]ˆ™Z™XÝÈÛˆ[Y[Ý]Ù\œ›ÜŽÂˆ
ˆHØ[\ˆXÚY\ÈÚ]ÈÝ\™˜XÙKˆ\Ù\ÈHÛÛ\™XÝHÛÈH]Y\žH\Âˆ
ˆ[™\[™[Ùˆ[žHÚZ[ˆÝ]K‚ˆ
‹Â˜\Þ[˜È[˜Ý[ÛˆÔ]Y\žUÚ][Y[Ý]
Ü[\˜[\ÈH×KÛY[H[
HÂˆÛÛœÝ[›™\ˆHÛY[ÛÛÂˆYˆ
\[›™\ŠH›ÝÈ™]È\œ›ÜŠ	ÔÜÝÜ™\ÈÛY[ÜÛÛ[˜]˜Z[X›IÊNÂˆ][Y\ŽÂˆžHÂˆ™]\›ˆ]ØZ]›ÛZ\ÙKœ˜XÙJÂˆ[›™\‹œ]Y\žJÜ[\˜[\ÊKˆ™]È›ÛZ\ÙJ
Ë™Z™XÝ
HOˆÂˆ[Y\ˆHÙ][Y[Ý]


HOˆ™Z™XÝ
™]È\œ›ÜŠÈ]Y\žH[Y[Ý]Y\ˆ	Ô×ÔUQT–WÕSQSÕUÓTß[\Ø
JK×ÔUQT–WÕSQSÕUÓTÊNÂˆ[Y\‹[œ™Yˆ	‰ˆ[Y\‹[œ™YŠ
NÂˆJKˆJNÂˆHš[˜[HÂˆYˆ
[Y\ŠHÛX\•[Y[Ý]
[Y\ŠNÂˆBŸB‚‹ÊŠ‚ˆ
ˆØZ]›ÜˆHÜÝÜ™\ÈÛÛÈ™H‘PQH
Ô™XYHYJH[™HØÚ[XKÚY˜][Û‚ˆ
ˆÈÛÛ\]Kˆ\ÙYžHHYš\ÛÜžK[ØÚÈ]ÛÈ]Ø[ˆ™]™\ˆš\™H™Y›Ü™Bˆ
ˆ[š]\œÚ\Ý[˜ÙJ
H\È›\YÔ™XYKˆ™]\›œÈYHÚ[ˆÈ\È™XYK‚ˆ
‹Â˜\Þ[˜È[˜Ý[Ûˆ[œÝ\™TÔ™XYJ
HÂˆYˆ
\Ñ[˜X›Y\ÛÛ
H™]\›ˆ˜[ÙNÂˆYˆ
Ô™XYJH™]\›ˆYNÂˆYˆ
Ò[š]›ÛZ\ÙJHÂˆžHÈ]ØZ]Ò[š]›ÛZ\ÙNÈHØ]Ú
JHÈÊˆ[š]˜Z[\™\ÈX]™HÔ™XYH˜[ÙH
‹ÈBˆBˆ™]\›ˆÔ™XYHOOHYNÂŸB‚‹ÊŠ‚ˆ
ˆ™XÛÜ™HÈ˜Z[\™H
Ú\™YžH[Üš]H]ÊKˆÙ]ÈÛÛ›™XÝ]š]HÂˆ
ˆ	ÙYÜ˜YY	È[™Ý\™˜XÙ\ÈHVPÕ™X\ÛÛˆ[ˆÙXYÈ
ÈÚX[‚ˆ
‹Â™[˜Ý[Ûˆ™XÛÜ™Ñ˜Z[\™J\œ‹X™[
HÂˆÑ˜Z[\™\ÊÊÎÂˆÛÛœÝÛÙHH\œˆ	‰ˆ\œ‹˜ÛÙHÈÉÙ\œ‹˜ÛÙ_WXˆ	ÉÎÂˆÓ\Ý\œ›ÜˆH	ÛX™[	ÜÉßNˆ	ÔÝš[™Ê
\œˆ	‰ˆ\œ‹›Y\ÜØYÙJH\œŠKœÛXÙJÌ
_IØÛÙ_XÂˆÓ\Ý\œ›Ü]H]K››ÝÊ
NÂˆÐÛÛ›™XÝ]š]HH	ÙYÜ˜YY	ÎÂˆ\œÚ\Ý[˜ÙQYÜ˜YYHYNÂ‚ˆËÈSTÔ•S•ˆÈ“Õ\›Z[˜]HH™[™\ˆ›ØÙ\ÜÈÛˆ˜[œÚY[ÜÝÜ™\ÂˆËÈÛÛ›™XÝ[Ûˆ˜Z[\™\ËˆH\™›ØÙ\ÜÈ^]Ü™X]\ÈH™\Ý\ÍLˆÛÜ[™ˆËÈXZÙ\ÈXYÛ›ÜÚ\È\™\‹ˆ[œÝXY™[˜ÙHHÜš]H\[[™KÙY\ÚX[ˆËÈ[]™K[™™XÛÝ™\ˆH\˜X›HÛÛ›™XÝ[Ûˆ[ˆH˜XÚÙÜ›Ý[™‚ˆÞ[˜Ñ[˜X›YH˜[ÙNÂˆYˆ
Þ[˜Õ[Y\ŠHÈÛX\’[\˜[
Þ[˜Õ[Y\ŠNÈÞ[˜Õ[Y\ˆH[ÈB‚ˆYˆ
Ñ˜Z[\™\ÈH×ÐÔ’UPÐSÑRST‘TÊHÂˆÛÛœÛÛK™\œ›ÜŠˆÙ—H8§cÜÝÜ™\ÈÜš]H˜Z[\™\È™XXÚY	ÜÑ˜Z[\™\ßH
\Ýˆ	ÜÓ\Ý\œ›ÜŸJKˆ
Âˆ	Ô\œÚ\Ý[˜ÙH\ÈYÜ˜YYÈXÛÛ›ÛZXÈÜš]\È\™H™[˜ÙY[™˜XÚÙÜ›Ý[™™XÛÝ™\žH\ÈXÝ]™K‰Âˆ
NÂˆH[ÙHÂˆÛÛœÛÛK™\œ›ÜŠ	ÖÙ—HÈÜš]H\œ›ÜŽ‰ËÓ\Ý\œ›ÜŠNÂˆB‚ˆËÈX\šÈHÛÛ\È›Ý™XYHÛÈ]Y]YYÜš]\ÈÝÜ[[YYX][H[™BˆËÈ^\Ý[™È™XÛÛ›™XÝ]Ø[ˆ™KY\ÝX›\ÚHÛÛ›™XÝ[Ûˆ[™™ZY˜]K‚ˆÔ™XYHH˜[ÙNÂˆØÚY[TÔ™]žJ
NÂŸB‚‹ÊŠ‚ˆ
ˆ^XÝ]HHÈÜš]HÛˆHX›IÜÈÜ™\™YÚZ[‹ˆH]Y\žH[œÈ[™\ˆBˆ
ˆ\™[Y[Ý]ÈÛˆÝXØÙ\ÜÈ\ÝÜš]P]Û\Ý™\šYžP]\™HÝ[\YÛˆ˜Z[\™Bˆ
ˆH\œ›Üˆ\È™XÛÜ™Y
™]™\ˆÝØ[ÝÙY
H[™HÚZ[ˆÛÛ[Y\ÈÛÈBˆ
ˆ‘VÜš]H›Üˆ]X›HØ[ˆÝ[ÛÈ›ÝYÚ‚ˆ
‹Â™[˜Ý[Ûˆ]Y]YTÕÜš]JX›K\ÚÊHÂˆYˆ
\ÛÛ\Ô™XYH\Þ[˜Ñ[˜X›Y\œÚ\Ý[˜ÙQYÜ˜YY
H™]\›ˆ›ÛZ\ÙKœ™\ÛÛ™J˜[ÙJNÂˆYˆ
Ñ[˜X›Y	‰ˆZ[œÝ[˜ÙSØÚÒ[
H™]\›ˆ›ÛZ\ÙKœ™\ÛÛ™J˜[ÙJNÂˆÛÛœÝÚZ[ˆHX›PÚZ[ŠX›JNÂˆÛÛœÝ[ˆHÚZ[‹[Š\Þ[˜È

HOˆÂˆžHÂˆÛÛœÝ™\Ý[H]ØZ]\ÚÊ
NÂˆÕÜš]\ÓÚÊÊÎÂˆÓ\ÝÜš]P]H]K››ÝÊ
NÂˆËÈHÚ[™ÛHÝXØÙ\ÜÙ[]Y]YYÜš]HÙ\È›Ý[[YYX][HÛX\ˆHYÜ˜YYˆËÈÝ]Kˆ™XÛÝ™\žH\Èš[˜[^™YÛ›HY\ˆH™XÛÛ›™XÝ]ÛÛ\]\ÈBˆËÈœ™\Ú[š]
ÈY˜][Ûˆ
ÈØÚÈÚXÚËˆ\È™]™[ÈH