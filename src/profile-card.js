'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('./db');
const rank = require('./rank');
const profile = require('./profile');
const { fmt } = require('./utils');

const ROOT = path.resolve(__dirname, '..');
const ROSTER_PATH = path.join(ROOT, 'assets', 'skins', 'roster.json');
const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
const characters = Array.isArray(roster.characters) ? roster.characters : [];

const W = 900;
const H = 1400;

function xml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function clamp(n, min = 0, max = 255) {
  return Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
}

function rgbHex(rgb) {
  return `#${[rgb.r, rgb.g, rgb.b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, amount) {
  const t = Math.max(0, Math.min(1, Number(amount) || 0));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function luminance(c) {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

function saturation(c) {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  return max <= 0 ? 0 : (max - min) / max;
}

/**
 * Pick a saturated theme directly from the transparent skin.
 * White/grey hair and transparent pixels are intentionally down-weighted.
 * Quantising prevents a single tiny highlight from becoming the whole theme.
 */
async function paletteFromSkin(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .resize(72, 108, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Map();
  let fallback = { r: 130, g: 55, b: 65 };
  let fallbackScore = -1;

  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3];
    if (a < 64) continue;

    const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
    const sat = saturation(c);
    const lum = luminance(c);

    // Prefer saturated mid/dark costume colors and VFX.
    const vivid = sat * sat * (0.40 + (1 - Math.abs(lum - 0.48)) * 0.60) * (a / 255);
    if (vivid > fallbackScore) {
      fallbackScore = vivid;
      fallback = c;
    }
    if (sat < 0.22 || lum < 0.08 || lum > 0.94) continue;

    const q = {
      r: Math.round(c.r / 32) * 32,
      g: Math.round(c.g / 32) * 32,
      b: Math.round(c.b / 32) * 32,
    };
    const key = `${q.r},${q.g},${q.b}`;
    const score = vivid * (0.6 + sat * 1.4);
    const row = bins.get(key) || { ...q, score: 0, count: 0 };
    row.score += score;
    row.count += 1;
    bins.set(key, row);
  }

  let dominant = [...bins.values()].sort((a, b) => b.score - a.score)[0] || fallback;

  // Prevent muddy near-grey themes.
  if (saturation(dominant) < 0.25) dominant = fallback;

  const black = { r: 6, g: 7, b: 10 };
  const white = { r: 240, g: 246, b: 250 };
  const bg = mix(dominant, black, 0.88);
  const bg2 = mix(dominant, black, 0.78);
  const panel = mix(dominant, black, 0.82);
  const accent = mix(dominant, white, 0.10);
  const bright = mix(dominant, white, 0.36);
  const dim = mix(dominant, black, 0.38);

  return {
    bg: rgbHex(bg),
    bg2: rgbHex(bg2),
    panel: rgbHex(panel),
    accent: rgbHex(accent),
    bright: rgbHex(bright),
    dim: rgbHex(dim),
    raw: rgbHex(dominant),
  };
}

function skinKey(userId) {
  return `profile_skin:${Number(userId)}`;
}

function parseSkin(value) {
  const [characterId, skinId = 'default'] = String(value || '').toLowerCase().split('/');
  const character = characters.find((c) => c.id === characterId) || characters[0];
  if (!character) throw new Error('No profile characters are configured');
  const skin = (character.skins || []).find((s) => s.id === skinId) || (character.skins || [])[0];
  if (!skin) throw new Error(`No skins configured for ${character.id}`);
  return { character, skin, value: `${character.id}/${skin.id}` };
}

function selectedSkin(userId) {
  return parseSkin(db.getSetting(skinKey(userId)) || `${characters[0]?.id || 'kael'}/default`);
}

function listSkins() {
  return characters.map((c) => `${c.id} — ${c.name} · ${c.title}`).join('\n');
}

function setSkin(userId, requested) {
  const q = String(requested || '').trim().toLowerCase();
  const character = characters.find((c) => c.id === q || String(c.name).toLowerCase() === q);
  if (!character) return { ok: false, message: `Unknown skin. Available:\n${listSkins()}` };
  const skin = (character.skins || [])[0];
  if (!skin) return { ok: false, message: `${character.name} has no usable skin.` };
  const value = `${character.id}/${skin.id}`;
  db.setSetting(skinKey(userId), value);
  return { ok: true, value, character, skin };
}

function resolveTarget(ctx) {
  const replied = ctx.msg && ctx.msg.reply_to_message && ctx.msg.reply_to_message.from;
  if (replied && replied.id) return Number(replied.id);
  const mention = (ctx.args || []).find((a) => String(a).startsWith('@'));
  if (mention && db.findUserByUsername) {
    const row = db.findUserByUsername(String(mention).slice(1).toLowerCase());
    if (row) return Number(row.user_id);
  }
  return Number(ctx.userId);
}

async function fetchAvatar(bot, userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    const photo = photos && photos.photos && photos.photos[0];
    if (!photo || !photo.length) return null;
    const url = await bot.getFileLink(photo[photo.length - 1].file_id);
    if (typeof fetch !== 'function') return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (_) {
    return null;
  }
}

async function circleAvatar(input, name) {
  let base;
  if (input) {
    base = await sharp(input).resize(132, 132, { fit: 'cover' }).png().toBuffer();
  } else {
    const initial = xml(String(name || '?').trim().charAt(0).toUpperCase() || '?');
    base = Buffer.from(`<svg width="132" height="132" xmlns="http://www.w3.org/2000/svg">
      <rect width="132" height="132" fill="#15181e"/>
      <text x="66" y="85" text-anchor="middle" font-family="Arial" font-size="60" font-weight="700" fill="#f4f7fa">${initial}</text>
    </svg>`);
  }
  const mask = Buffer.from(`<svg width="132" height="132" xmlns="http://www.w3.org/2000/svg">
    <circle cx="66" cy="66" r="63" fill="white"/>
  </svg>`);
  return sharp(base).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function progressInfo(user) {
  const r = rank.normalizeRank(user.rank);
  const idx = rank.rankIndex(r);
  const have = Number(user.rank_valid_matches) || 0;
  if (idx >= rank.RANKS.length - 1) {
    return { rank: r, nextRank: null, ratio: 1, have, remaining: 0, localHave: 0, localNeed: 0, text: 'MAX RANK' };
  }
  const floor = Number(rank.THRESHOLDS[idx]) || 0;
  const next = Number(rank.THRESHOLDS[idx + 1]) || floor;
  const localHave = Math.max(0, have - floor);
  const localNeed = Math.max(1, next - floor);
  const ratio = Math.max(0, Math.min(1, localHave / localNeed));
  const remaining = Math.max(0, next - have);
  return {
    rank: r,
    nextRank: rank.RANKS[idx + 1],
    ratio,
    have,
    remaining,
    localHave,
    localNeed,
    text: `${remaining} valid match${remaining === 1 ? '' : 'es'} to ${rank.RANKS[idx + 1].toUpperCase()}`,
  };
}

function initialsTitle(value, max = 22) {
  const s = String(value || '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function backgroundSvg(theme, picked) {
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${theme.bg}"/>
        <stop offset=".52" stop-color="${theme.bg2}"/>
        <stop offset="1" stop-color="#050609"/>
      </linearGradient>
      <radialGradient id="halo" cx="50%" cy="47%" r="54%">
        <stop offset="0" stop-color="${theme.raw}" stop-opacity=".54"/>
        <stop offset=".47" stop-color="${theme.raw}" stop-opacity=".17"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="ember" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="${theme.dim}" stop-opacity=".08"/>
        <stop offset=".5" stop-color="${theme.accent}" stop-opacity=".24"/>
        <stop offset="1" stop-color="${theme.bright}" stop-opacity=".04"/>
      </linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="24"/></filter>
      <filter id="soft"><feGaussianBlur stdDeviation="8"/></filter>
    </defs>

    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <ellipse cx="455" cy="700" rx="390" ry="590" fill="url(#halo)"/>
    <path d="M0 1130 C170 1025 225 1205 390 1108 C548 1014 620 1190 900 1028 L900 1400 L0 1400 Z"
          fill="url(#ember)"/>

    <circle cx="105" cy="1070" r="115" fill="${theme.raw}" opacity=".08" filter="url(#blur)"/>
    <circle cx="774" cy="505" r="150" fill="${theme.raw}" opacity=".09" filter="url(#blur)"/>

    <rect x="16" y="16" width="868" height="1368" rx="32" fill="none" stroke="${theme.dim}" stroke-width="2"/>
    <rect x="27" y="27" width="846" height="1346" rx="27" fill="none" stroke="${theme.raw}" stroke-opacity=".32"/>

    <path d="M48 102 H300 M600 102 H852" stroke="${theme.dim}" stroke-width="2"/>
    <circle cx="450" cy="102" r="4" fill="${theme.bright}"/>
    <path d="M438 102 H462 M450 90 V114" stroke="${theme.bright}" stroke-width="1"/>

    <text x="450" y="74" text-anchor="middle" font-family="Arial" font-size="25" letter-spacing="8" fill="#eef3f6">JTF PROFILE</text>
    <text x="450" y="126" text-anchor="middle" font-family="Arial" font-size="12" letter-spacing="6" fill="${theme.bright}">RIMURU TEMPEST</text>

    <text x="450" y="222" text-anchor="middle" font-family="Arial" font-size="36" font-weight="800" fill="#f7f7f8">${xml(String(picked.character.name || '').toUpperCase())}</text>
    <text x="450" y="253" text-anchor="middle" font-family="Arial" font-size="14" letter-spacing="6" fill="${theme.bright}">${xml(String(picked.character.title || '').toUpperCase())}</text>

    <path d="M92 288 H808" stroke="${theme.raw}" stroke-opacity=".23"/>
    <path d="M300 1195 H600" stroke="${theme.raw}" stroke-opacity=".25"/>

    <!-- subtle decorative scratches -->
    <path d="M42 440 L75 410 M46 456 L83 421 M830 980 L862 946 M818 997 L856 956"
          stroke="${theme.bright}" stroke-opacity=".20" stroke-width="2"/>
  </svg>`);
}

function foregroundSvg(theme, user, picked, progress, pinfo) {
  const barX = 556, barY = 300, barW = 248, barH = 14;
  const fillW = Math.round(barW * progress.ratio);
  const userName = initialsTitle(user.first_name || user.username || `User ${user.user_id}`, 20);
  const handle = user.username ? `@${user.username}` : `ID ${user.user_id}`;
  const title = initialsTitle(pinfo.title || 'Tempest Regular', 22);
  const rankName = String(progress.rank || 'bronze').toUpperCase();
  const nextName = progress.nextRank ? String(progress.nextRank).toUpperCase() : 'MAX';

  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${theme.dim}"/>
        <stop offset=".55" stop-color="${theme.accent}"/>
        <stop offset="1" stop-color="${theme.bright}"/>
      </linearGradient>
    </defs>

    <!-- identity -->
    <text x="73" y="196" font-family="Arial" font-size="26" font-weight="800" fill="#f5f6f7">${xml(userName)}</text>
    <text x="73" y="224" font-family="Arial" font-size="15" fill="#a9b0b7">${xml(handle)}</text>
    <rect x="69" y="241" width="226" height="47" rx="14" fill="${theme.panel}" stroke="${theme.raw}" stroke-opacity=".58"/>
    <text x="86" y="271" font-family="Arial" font-size="16" font-weight="700" fill="${theme.bright}">${xml(title.toUpperCase())}</text>

    <!-- rank -->
    <text x="557" y="188" font-family="Arial" font-size="12" letter-spacing="3" fill="#9fa9b1">CURRENT RANK</text>
    <text x="557" y="226" font-family="Arial" font-size="32" font-weight="800" fill="#f2f3f4">${xml(rankName)}</text>
    <text x="557" y="252" font-family="Arial" font-size="14" fill="#a6adb4">${progress.have} valid matches</text>

    <text x="${barX}" y="286" font-family="Arial" font-size="13" font-weight="700" fill="#e8ebed">${xml(rankName)} → ${xml(nextName)}</text>
    <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="7" fill="#292d32"/>
    <rect x="${barX}" y="${barY}" width="${Math.max(0, fillW)}" height="${barH}" rx="7" fill="url(#bar)"/>
    <text x="${barX}" y="337" font-family="Arial" font-size="13" fill="#dce0e3">${
      progress.nextRank
        ? `${progress.localHave} / ${progress.localNeed} · ${progress.remaining} remaining`
        : 'MAX RANK'
    }</text>

    <!-- character label -->
    <text x="55" y="796" font-family="Arial" font-size="96" font-weight="900" fill="${theme.raw}" fill-opacity=".34">${xml(String(picked.character.name || '').toUpperCase())}</text>
    <text x="60" y="836" font-family="Arial" font-size="16" letter-spacing="8" fill="${theme.bright}" fill-opacity=".88">${xml(String(picked.character.title || '').toUpperCase())}</text>

    <!-- economy -->
    <rect x="74" y="1180" width="350" height="112" rx="24" fill="${theme.panel}" fill-opacity=".93" stroke="${theme.raw}" stroke-opacity=".55"/>
    <text x="101" y="1217" font-family="Arial" font-size="13" letter-spacing="3" fill="#aeb6bc">WALLET</text>
    <text x="101" y="1262" font-family="Arial" font-size="33" font-weight="800" fill="#f7f8f9">${xml(fmt(Number(user.wallet) || 0))}</text>

    <rect x="476" y="1180" width="350" height="112" rx="24" fill="${theme.panel}" fill-opacity=".93" stroke="${theme.raw}" stroke-opacity=".55"/>
    <text x="503" y="1217" font-family="Arial" font-size="13" letter-spacing="3" fill="#aeb6bc">BANK</text>
    <text x="503" y="1262" font-family="Arial" font-size="33" font-weight="800" fill="#f7f8f9">${xml(fmt(Number(user.bank) || 0))}</text>

    <!-- footer -->
    <text x="450" y="1340" text-anchor="middle" font-family="Arial" font-size="12" letter-spacing="5" fill="${theme.bright}">JTF · MORE THAN A BOT</text>
    <text x="450" y="1363" text-anchor="middle" font-family="Arial" font-size="9" letter-spacing="6" fill="#767f86">ANIME · GAMES · COMMUNITY</text>
  </svg>`);
}

async function render(ctx, bot) {
  const targetId = resolveTarget(ctx);
  const user = db.getOrCreateUser(targetId);
  const name = user.first_name || user.username || `User ${targetId}`;
  const picked = selectedSkin(targetId);
  const progress = progressInfo(user);
  const pinfo = profile.rankOf(targetId);

  const skinPath = path.join(ROOT, picked.skin.image);
  const rankPath = path.join(ROOT, 'assets', 'ranks', `${progress.rank}.png`);

  if (!fs.existsSync(skinPath)) throw new Error(`Missing profile skin: ${picked.skin.image}`);
  if (!fs.existsSync(rankPath)) throw new Error(`Missing rank icon: assets/ranks/${progress.rank}.png`);

  const theme = await paletteFromSkin(skinPath);

  const [avatarRaw, character, rankIcon] = await Promise.all([
    fetchAvatar(bot, targetId),
    sharp(skinPath)
      .resize(650, 900, { fit: 'contain', withoutEnlargement: true })
      .png()
      .toBuffer(),
    sharp(rankPath)
      .resize(104, 104, { fit: 'contain', withoutEnlargement: true })
      .png()
      .toBuffer(),
  ]);

  const avatar = await circleAvatar(avatarRaw, name);

  // A very soft shadow/halo generated from the actual transparent character.
  const characterGlow = await sharp(character)
    .blur(18)
    .modulate({ brightness: 0.72, saturation: 1.25 })
    .png()
    .toBuffer();

  const base = backgroundSvg(theme, picked);
  const foreground = foregroundSvg(theme, user, picked, progress, pinfo);

  const buffer = await sharp(base)
    .composite([
      // character atmosphere
      { input: characterGlow, left: 125, top: 300, blend: 'screen', opacity: 0.34 },

      // full-body skin — no box, no side bars
      { input: character, left: 125, top: 300 },

      // identity/rank images remain above the character
      { input: avatar, left: 72, top: 112 },
      { input: rankIcon, left: 743, top: 160 },

      // all labels/panels are last so they stay readable
      { input: foreground, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { buffer, targetId, user, picked, progress, profile: pinfo, theme };
}

module.exports = {
  render,
  listSkins,
  setSkin,
  selectedSkin,
  resolveTarget,
  progressInfo,
  paletteFromSkin,
};
