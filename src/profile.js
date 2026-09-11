'use strict';
/**
 * Rimuru Tempest Casino — profile & badges.
 * Exclusive badges/titles are calculated globally so only the actual holder
 * owns them (for example, Biggest Gambler).
 */
const db = require('./db');
const { fmt, esc } = require('./utils');

const TITLES = {
  1: { title: 'Premium User', emoji: '👑', color: 'gold' },
  2: { title: 'Elite Magnate', emoji: '🥈', color: 'red' },
  3: { title: 'Rising Star', emoji: '🥉', color: 'bronze' },
  4: { title: 'Road to Top 3', emoji: '🛤️', color: 'grey' },
};
const DEFAULT_TITLE = { title: 'Tempest Regular', emoji: '🌀', color: 'grey' };

const BORDERS = {
  gold: { top: '🟨', line: '🟨', bottom: '🟨' },
  red: { top: '🟥', line: '🟥', bottom: '🟥' },
  bronze: { top: '🟧', line: '🟧', bottom: '🟧' },
  grey: { top: '⬜', line: '⬜', bottom: '⬜' },
};

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

/**
 * Exactly ONE holder. Ties are broken by the earliest recorded bet and then id.
 * This prevents several users from simultaneously owning "Biggest Gambler".
 */
function biggestGambler() {
  try {
    return db.db.prepare(`
      SELECT user_id, bet, game, played_at
      FROM game_history
      WHERE COALESCE(bet, 0) > 0
      ORDER BY bet DESC, played_at ASC, id ASC
      LIMIT 1
    `).get() || null;
  } catch (e) {
    return null;
  }
}

function exclusiveTitleOf(userId) {
  const biggest = biggestGambler();
  if (biggest && Number(biggest.user_id) === Number(userId)) {
    return { title: 'Biggest Gambler', emoji: '🎰', color: 'gold', value: Number(biggest.bet) || 0 };
  }
  return null;
}

function rankOf(userId) {
  const u = db.getUser(userId);
  const net = u ? Number(u.wallet || 0) + Number(u.bank || 0) : 0;
  const top = db.leaderboard(10) || [];
  const idx = top.findIndex((r) => Number(r.user_id) === Number(userId));
  const wealthRank = idx === -1 ? null : idx + 1;
  const exclusive = exclusiveTitleOf(userId);
  const t = exclusive || (wealthRank && TITLES[wealthRank]) || DEFAULT_TITLE;
  return {
    rank: wealthRank,
    net,
    title: t.title,
    emoji: t.emoji,
    color: t.color,
    exclusive: !!exclusive,
  };
}

function badgesOf(userId) {
  const out = [];
  const r = rankOf(userId);
  const s = gameStats(userId);
  const net = r.net;
  const biggest = biggestGambler();

  if (r.rank === 1) out.push('🥇 #1 Richest');
  if (r.rank === 2) out.push('🥈 #2 Richest');
  if (r.rank === 3) out.push('🥉 #3 Richest');
  if (r.rank && r.rank <= 3) out.push('🌟 Top 3 Member');
  if (r.rank && r.rank <= 5) out.push('✨ Top 5 Member');

  if (biggest && Number(biggest.user_id) === Number(userId)) {
    out.push(`🎰 Biggest Gambler (${fmt(Number(biggest.bet) || 0)} bet)`);
  }

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

function profileText(ctx, userId) {
  const { targetId } = resolveTarget(ctx, userId);
  const u = db.getOrCreateUser(targetId);
  const r = rankOf(targetId);
  const s = gameStats(targetId);
  const b = BORDERS[r.color] || BORDERS.grey;
  const badges = badgesOf(targetId);
  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '—';
  const days = u.created_at ? Math.max(1, Math.floor((Date.now() - u.created_at) / 86400000)) : 0;
  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);

  return [
    `${b.top}`,
    `${b.line} ${r.emoji} <b>${nameLine}</b>`,
    `${b.line} ${r.emoji} <b>${esc(r.title, false)}</b>`,
    `${b.line} Wealth rank: <b>${r.rank ? '#' + r.rank : 'Unranked'}</b> · Net worth: <b>${fmt(r.net)}</b>`,
    `${b.line} Wallet: <b>${fmt(u.wallet)}</b> · Bank: <b>${fmt(u.bank)}</b>`,
    `${b.line} Games: <b>${s.played}</b> · Won <b>${s.won}</b> · Lost <b>${s.lost}</b> · Win rate <b>${s.winPct}%</b>`,
    `${b.line} Joined: <b>${joined}</b> (${days} day${days === 1 ? '' : 's'} ago)`,
    `${b.line} Badges: ${badges.slice(0, 3).map((x) => x.split(' ')[0]).join(' ')}`,
    `${b.bottom}`,
    `\n<b>🪙 Total coins:</b> ${fmt(Number(u.wallet || 0) + Number(u.bank || 0))}`,
  ].join('\n');
}

function badgesText(ctx, userId) {
  const { targetId } = resolveTarget(ctx, userId);
  const r = rankOf(targetId);
  const badges = badgesOf(targetId);
  const u = db.getOrCreateUser(targetId);
  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);
  return `${r.emoji} <b>${nameLine}</b> — ${esc(r.title, false)}\n\n${badges.map((b) => `• ${b}`).join('\n')}`;
}

function idCardText(ctx, userId) {
  const { targetId } = resolveTarget(ctx, userId);
  const u = db.getOrCreateUser(targetId);
  const r = rankOf(targetId);
  const s = gameStats(targetId);
  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '—';
  const badges = badgesOf(targetId);
  const nameLine = esc(u.first_name || u.username || `User${targetId}`, false);
  return [
    `╭─────────── ID CARD ───────────╮`,
    `🪪 <b>${nameLine}</b>`,
    `${r.emoji} ${esc(r.title, false)} (Wealth ${r.rank ? '#' + r.rank : '—'})`,
    `📅 Joined: ${joined}`,
    `🪙 Total: <b>${fmt(Number(u.wallet || 0) + Number(u.bank || 0))}</b>`,
    `🎮 Games: ${s.played} (${s.winPct}% win rate)`,
    `🏅 ${badges.slice(0, 4).join(' · ')}`,
    `╰─────────────────────────────────╯`,
  ].join('\n');
}

module.exports = {
  profileText, badgesText, idCardText, rankOf, badgesOf, gameStats,
  biggestGambler, exclusiveTitleOf, TITLES, BORDERS,
};
