'use strict';
/**
 * Rimuru Tempest Casino — profile & badges.
 * /p [@user|reply]  — rich text profile card
 * /badges [@user|reply] — list earned badges
 * /id [@user|reply] — text ID card
 *
 * Titles by leaderboard position (net worth):
 *   1st = Premium User (gold) · 2nd = Elite Magnate (red/silver)
 *   3rd = Rising Star (bronze) · 4th = Road to Top 3 (grey)
 *   rest = standard user title.
 */
const db = require('./db');
const { fmt, esc, humanDuration } = require('./utils');

/* ---------- titles ---------- */
const TITLES = {
  1: { title: 'Premium User', emoji: '👑', color: 'gold' },
  2: { title: 'Elite Magnate', emoji: '🥈', color: 'red' },
  3: { title: 'Rising Star', emoji: '🥉', color: 'bronze' },
  4: { title: 'Road to Top 3', emoji: '🛤️', color: 'grey' },
};
const DEFAULT_TITLE = { title: 'Tempest Regular', emoji: '🌀', color: 'grey' };

/** Border emoji by rank (gold / silver-red / bronze / grey). */
const BORDERS = {
  gold: { top: '🟨', line: '🟨', bottom: '🟨' },
  red: { top: '🟥', line: '🟥', bottom: '🟥' },
  bronze: { top: '🟧', line: '🟧', bottom: '🟧' },
  grey: { top: '⬜', line: '⬜', bottom: '⬜' },
};

/** Resolve the user row + rank for a command (replied user > @mention > sender). */
function resolveTarget(ctx, userId) {
  const replied = ctx.msg && ctx.msg.reply_to_message && ctx.msg.reply_to_message.from;
  if (replied && replied.id) return { targetId: replied.id, name: replied.first_name || replied.username || '' };
  const mention = (ctx.args || []).find((a) => String(a).startsWith('@'));
  if (mention) {
    const row = db.findUserByUsername(String(mention).slice(1).toLowerCase());
    if (row) return { targetId: row.user_id, name: row.first_name || row.username || '' };
  }
  return { targetId: userId, name: '' };
}

/** Games played / won / lost + win% from game_history. */
function gameStats(userId) {
  let rows = [];
  try {
    rows = db.db.prepare('SELECT game, result FROM game_history WHERE user_id = ?').all(userId);
  } catch (e) { rows = []; }
  const played = rows.length;
  const won = rows.filter((r) => r.result === 'win').length;
  const lost = rows.filter((r) => r.result === 'lose').length;
  const winPct = played ? Math.round((won / played) * 100) : 0;
  return { played, won, lost, winPct };
}

/** Rank + title for a user (by net worth). */
function rankOf(userId) {
  const u = db.getUser(userId);
  const net = u ? u.wallet + u.bank : 0;
  const top = db.leaderboard(10) || [];
  const idx = top.findIndex((r) => Number(r.user_id) === Number(userId));
  const rank = idx === -1 ? null : idx + 1;
  const t = (rank && TITLES[rank]) || DEFAULT_TITLE;
  return { rank, net, title: t.title, emoji: t.emoji, color: t.color };
}

/** Badges earned by a user. */
function badgesOf(userId) {
  const out = [];
  const r = rankOf(userId);
  const s = gameStats(userId);
  const u = db.getUser(userId);
  const net = r.net;

  if (r.rank === 1) out.push('🥇 #1 Richest');
  if (r.rank === 2) out.push('🥈 #2 Richest');
  if (r.rank === 3) out.push('🥉 #3 Richest');
  if (r.rank && r.rank <= 3) out.push('🌟 Top 3 Member');
  if (r.rank && r.rank <= 5) out.push('✨ Top 5 Member');

  // Biggest single gamble: largest bet in game_history
  let biggestBet = 0;
  try {
    const row = db.db.prepare('SELECT MAX(bet) AS m FROM game_history WHERE user_id = ?').get(userId);
    biggestBet = Number((row && row.m) || 0);
  } catch (e) { /* no history */ }
  if (biggestBet >= 1000000) out.push(`🎰 Biggest Gambler (${fmt(biggestBet)} bet)`);

  if (s.played >= 100) out.push('🎮 Veteran Player (100+ games)');
  else if (s.played >= 25) out.push('🎮 Regular Player (25+ games)');

  if (s.winPct >= 60 && s.played >= 10) out.push('📈 Sharp Shooter (60%+ win rate)');
  if (s.won >= 10) out.push('🏅 Ten-Time Winner');

  if (net >= 1000000000) out.push('💰 Billionaire');
  else if (net >= 100000000) out.push('💰 Millionaire');

  const inv = db.getInventory ? db.getInventory(userId) : [];
  if (inv && inv.length) out.push(`🛒 Collector (${inv.length} item types)`);

  if (!out.length) out.push('🌱 Newcomer');
  return out;
}

/** /p — rich text profile card. */
function profileText(ctx, userId) {
  const { targetId, name } = resolveTarget(ctx, userId);
  const u = db.getOrCreateUser(targetId);
  const r = rankOf(targetId);
  const s = gameStats(targetId);
  const b = BORDERS[r.color] || BORDERS.grey;
  const border = b.line.repeat(16);
  const badges = badgesOf(targetId);
  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '—';
  const days = u.created_at ? Math.max(1, Math.floor((Date.now() - u.created_at) / 86400000)) : 0;

  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);
  const titleLine = `${r.emoji} <b>${esc(r.title, false)}</b>`;

  const lines = [
    `${b.top}`,
    `${b.line} ${r.emoji} <b>${nameLine}</b>`,
    `${b.line} ${titleLine}`,
    `${b.line} Rank: <b>${r.rank ? '#' + r.rank : 'Unranked'}</b> · Net worth: <b>${fmt(r.net)}</b>`,
    `${b.line} Wallet: <b>${fmt(u.wallet)}</b> · Bank: <b>${fmt(u.bank)}</b>`,
    `${b.line} Games: <b>${s.played}</b> · Won <b>${s.won}</b> · Lost <b>${s.lost}</b> · Win rate <b>${s.winPct}%</b>`,
    `${b.line} Joined: <b>${joined}</b> (${days} day${days === 1 ? '' : 's'} ago)`,
    `${b.line} Badges: ${badges.slice(0, 3).map((x) => x.split(' ')[0]).join(' ')}`,
    `${b.bottom}`,
    `\n<b>🪙 Total coins:</b> ${fmt(u.wallet + u.bank)}`,
  ];
  return lines.join('\n');
}

/** /badges — list of earned badges. */
function badgesText(ctx, userId) {
  const { targetId, name } = resolveTarget(ctx, userId);
  const r = rankOf(targetId);
  const badges = badgesOf(targetId);
  const u = db.getOrCreateUser(targetId);
  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);
  return (
    `${r.emoji} <b>${nameLine}</b> — ${esc(r.title, false)}\n\n` +
    badges.map((b) => `• ${b}`).join('\n')
  );
}

/** /id — text ID card (primary; no image dependency). */
function idCardText(ctx, userId) {
  const { targetId, name } = resolveTarget(ctx, userId);
  const u = db.getOrCreateUser(targetId);
  const r = rankOf(targetId);
  const s = gameStats(targetId);
  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '—';
  const badges = badgesOf(targetId);
  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);

  const lines = [
    `╭─────────── ID CARD ───────────╮`,
    `🪪 <b>${nameLine}</b>`,
    `🎖️ ${esc(r.title, false)} (Rank ${r.rank ? '#' + r.rank : '—'})`,
    `📅 Joined: ${joined}`,
    `🪙 Total: <b>${fmt(u.wallet + u.bank)}</b>`,
    `🎮 Games: ${s.played} (${s.winPct}% win rate)`,
    `🏅 ${badges.slice(0, 4).join(' · ')}`,
    `╰─────────────────────────────────╯`,
  ];
  return lines.join('\n');
}

module.exports = { profileText, badgesText, idCardText, rankOf, badgesOf, gameStats, TITLES, BORDERS };