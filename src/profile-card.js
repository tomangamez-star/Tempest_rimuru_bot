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

function xml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function skinKey(userId) { return `profile_skin:${Number(userId)}`; }

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
  } catch (_) { return null; }
}
async function circleAvatar(input, name) {
  let base;
  if (input) {
    base = await sharp(input).resize(184, 184, { fit: 'cover' }).png().toBuffer();
  } else {
    const initial = xml(String(name || '?').trim().charAt(0).toUpperCase() || '?');
    base = Buffer.from(`<svg width="184" height="184" xmlns="http://www.w3.org/2000/svg">
      <rect width="184" height="184" fill="#16202c"/>
      <text x="92" y="116" text-anchor="middle" font-family="Arial" font-size="86" font-weight="700" fill="#dff7ff">${initial}</text>
    </svg>`);
  }
  const mask = Buffer.from(`<svg width="184" height="184" xmlns="http://www.w3.org/2000/svg"><circle cx="92" cy="92" r="88" fill="white"/></svg>`);
  return sharp(base).resize(184, 184).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
function progressInfo(user) {
  const r = rank.normalizeRank(user.rank);
  const idx = rank.rankIndex(r);
  const have = Number(user.rank_valid_matches) || 0;
  if (idx >= rank.RANKS.length - 1) {
    return { rank: r, nextRank: null, ratio: 1, have, remaining: 0, text: 'MAX RANK' };
  }
  const floor = rank.THRESHOLDS[idx];
  const next = rank.THRESHOLDS[idx + 1];
  const ratio = Math.max(0, Math.min(1, (have - floor) / Math.max(1, next - floor)));
  const remaining = Math.max(0, next - have);
  return { rank: r, nextRank: rank.RANKS[idx + 1], ratio, have, remaining,
    text: `${remaining} valid match${remaining === 1 ? '' : 'es'} to ${rank.RANKS[idx + 1].toUpperCase()}` };
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

  const [avatarRaw, characterPng, rankPng] = await Promise.all([
    fetchAvatar(bot, targetId),
    sharp(skinPath).resize(500, 620, { fit: 'contain', withoutEnlargement: true }).png().toBuffer(),
    sharp(rankPath).resize(132, 132, { fit: 'contain', withoutEnlargement: true }).png().toBuffer(),
  ]);
  const avatar = await circleAvatar(avatarRaw, name);

  const barWidth = 440, filled = Math.round(barWidth * progress.ratio);
  const maxOrNext = progress.nextRank ? progress.text : 'MYTHIC · MAX RANK';

  const svg = Buffer.from(`<svg width="1200" height="700" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#07111b"/><stop offset="0.55" stop-color="#101b28"/><stop offset="1" stop-color="#070b12"/>
      </linearGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#34d7ff"/><stop offset="1" stop-color="#d8f7ff"/></linearGradient>
    </defs>
    <rect width="1200" height="700" rx="34" fill="url(#bg)"/>
    <rect x="18" y="18" width="1164" height="664" rx="28" fill="none" stroke="#2b6072" stroke-width="2"/>
    <text x="608" y="72" text-anchor="middle" font-family="Arial" font-size="18" letter-spacing="5" fill="#79dfff">JTF PROFILE</text>

    <circle cx="166" cy="184" r="100" fill="#0b1620" stroke="#48cfe9" stroke-width="3"/>
    <text x="74" y="318" font-family="Arial" font-size="34" font-weight="700" fill="#f4fbff">${xml(name)}</text>
    <text x="74" y="353" font-family="Arial" font-size="19" fill="#8aa7b8">@${xml(user.username || 'no_username')}</text>
    <text x="74" y="387" font-family="Arial" font-size="22" font-weight="700" fill="#d6f7ff">${xml(pinfo.emoji + ' ' + pinfo.title)}</text>

    <rect x="68" y="417" width="310" height="150" rx="20" fill="#0b151f" stroke="#21394a"/>
    <text x="92" y="452" font-family="Arial" font-size="17" fill="#7f9fb0">WALLET</text>
    <text x="92" y="484" font-family="Arial" font-size="26" font-weight="700" fill="#f6fbff">${xml(fmt(Number(user.wallet) || 0))}</text>
    <text x="92" y="522" font-family="Arial" font-size="17" fill="#7f9fb0">BANK</text>
    <text x="92" y="554" font-family="Arial" font-size="26" font-weight="700" fill="#f6fbff">${xml(fmt(Number(user.bank) || 0))}</text>

    <text x="595" y="118" text-anchor="middle" font-family="Arial" font-size="29" font-weight="700" fill="#e8fbff">${xml(picked.character.name + ' · ' + picked.character.title)}</text>

    <text x="858" y="332" font-family="Arial" font-size="20" fill="#7f9fb0">CURRENT RANK</text>
    <text x="858" y="376" font-family="Arial" font-size="39" font-weight="800" fill="#edfaff">${xml(progress.rank.toUpperCase())}</text>
    <text x="858" y="412" font-family="Arial" font-size="17" fill="#8ab5c6">${progress.have} valid matches</text>

    <rect x="690" y="525" width="${barWidth}" height="24" rx="12" fill="#162936"/>
    <rect x="690" y="525" width="${Math.max(8, filled)}" height="24" rx="12" fill="url(#bar)"${filled <= 0 ? ' opacity="0"' : ''}/>
    <text x="690" y="588" font-family="Arial" font-size="21" font-weight="700" fill="#f0fbff">${xml(maxOrNext)}</text>
    <text x="690" y="620" font-family="Arial" font-size="16" fill="#7394a5">Rank progress uses valid matches, not coins.</text>
    <text x="72" y="640" font-family="Arial" font-size="15" fill="#587483">Skin: ${xml(picked.value)}</text>
    <text x="1090" y="662" text-anchor="end" font-family="Arial" font-size="14" fill="#416070">RIMURU · JTF</text>
  </svg>`);

  const buffer = await sharp(svg).composite([
    { input: avatar, left: 74, top: 92 },
    { input: characterPng, left: 360, top: 86 },
    { input: rankPng, left: 1004, top: 300 },
  ]).png().toBuffer();

  return { buffer, targetId, user, picked, progress, profile: pinfo };
}

module.exports = { render, listSkins, setSkin, selectedSkin, resolveTarget, progressInfo };
