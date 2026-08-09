'use strict';
/**
 * Rimuru Tempest Casino — Heist 🏦
 * /heist (reply to target). No amount.
 *  - Needs 30% of target's networth in YOUR networth to attempt.
 *  - Can't heist empty bank. Can't heist the owner.
 *  - Open 60s for others to /join. Max 5 members (leader counts as 1/5).
 *  - Leader starts at 65% risk; each additional member lowers risk / raises victory chance.
 *  - Win → up to half of target's bank, split equally among members.
 *  - Fail → each member loses 10% of their own networth.
 *  - 20 min cooldown (on the leader).
 *
 * /join — join an open heist (any heist currently open in the group).
 */
const config = require('../config');
const db = require('../db');
const { fmt, chance, esc } = require('../utils');

/** Risk for a heist with n members (leader base 65%, -12.5% per extra member). */
function riskFor(n) {
  const risk = config.heist.leaderBaseRisk - (n - 1) * 0.125;
  return Math.max(0.2, Math.min(1, risk));
}

/** Win probability = 1 - risk. */
function victoryChance(n) {
  return 1 - riskFor(n);
}

/**
 * Start a heist.
 * @returns {ok, message, heist?}
 */
function start(leaderId, targetId, meta = {}) {
  if (leaderId === targetId) {
    return { ok: false, message: '🤨 Heist yourself? The bank is in your own house, genius.' };
  }
  if (String(targetId) === config.ownerId) {
    return { ok: false, message: '👑 Touch the King\'s vault and I\'ll turn you into soup. Absolutely not.' };
  }

  const leader = db.getOrCreateUser(leaderId, meta);
  const target = db.getOrCreateUser(targetId);

  if (target.bank <= 0) {
    return { ok: false, message: `🏦 ${target.first_name || 'Target'}\'s bank is empty — nothing to heist.` };
  }

  const leaderNW = leader.wallet + leader.bank;
  const targetNW = target.wallet + target.bank;
  if (leaderNW < targetNW * config.heist.minNetworthShare) {
    return {
      ok: false,
      message: `🚫 To heist **${target.first_name || 'this target'}** you need at least **${fmt(Math.ceil(targetNW * config.heist.minNetworthShare))}** networth (30% of their ${fmt(targetNW)}). You have ${fmt(leaderNW)}.`,
    };
  }

  const existing = db.getHeist(leaderId);
  if (existing && existing.status === 'open') {
    return { ok: false, message: '⏳ You already have a heist open! Waiting for members to /join.' };
  }

  const heist = {
    leader_id: leaderId,
    leader_name: leader.first_name || meta.username || String(leaderId),
    target_id: targetId,
    target_name: target.first_name || String(targetId),
    members: [{ user_id: leaderId, name: leader.first_name || meta.username || String(leaderId) }],
    started_at: Date.now(),
    status: 'open',
  };
  db.createHeist(heist);

  return {
    ok: true,
    heist,
    message:
      `🏦 **HEIST LAUNCHED!**\n\n` +
      `👤 Leader: ${heist.leader_name}\n` +
      `🎯 Target: ${heist.target_name} (bank: ${fmt(target.bank)})\n` +
      `👥 Members: 1/${config.heist.maxMembers}\n` +
      `⚖️ Risk: **${Math.round(riskFor(1) * 100)}%** | Victory: **${Math.round(victoryChance(1) * 100)}%**\n\n` +
      `⏳ **/join** within 60 seconds to join the crew! Max ${config.heist.maxMembers} members. More members = lower risk.`,
  };
}

/**
 * Join an open heist. Scans ALL open heists (any user's) — a user joins the
 * most recently started open one.
 */
function join(userId, meta = {}) {
  const open = db.db.prepare("SELECT * FROM heists WHERE status = 'open' ORDER BY started_at DESC").all();
  if (!open.length) {
    return { ok: false, message: '🕳️ No open heists right now. Start one with `/heist` (reply to a target).' };
  }
  const heist = open[0];
  const members = JSON.parse(heist.members); // raw row → members is a JSON string
  if (members.some((m) => m.user_id === userId)) {
    return { ok: false, message: '🤨 You\'re already in this crew.' };
  }
  if (members.length >= config.heist.maxMembers) {
    return { ok: false, message: `👥 This crew is full (${config.heist.maxMembers} members).` };
  }
  const u = db.getOrCreateUser(userId, meta);
  members.push({ user_id: userId, name: u.first_name || meta.username || String(userId) });
  db.updateHeistMembers(heist.leader_id, members);
  db.updateHeistStatus(heist.leader_id, 'open');

  const n = members.length;
  return {
    ok: true,
    message:
      `🤝 **JOINED THE HEIST!**\n` +
      `Leader: ${heist.leader_name} → Target: ${heist.target_name}\n` +
      `👥 Members: ${n}/${config.heist.maxMembers}\n` +
      `⚖️ Risk: **${Math.round(riskFor(n) * 100)}%** | Victory: **${Math.round(victoryChance(n) * 100)}%**`,
  };
}

/**
 * Execute a heist (called after the 60s window, or immediately if full).
 * @returns {ok, message, heist?, members}
 */
function execute(leaderId) {
  const heist = db.getHeist(leaderId);
  if (!heist) return { ok: false, message: '❌ Heist not found.' };
  if (heist.status !== 'open') return { ok: false, message: '❌ This heist already ran.' };

  const target = db.getUser(heist.target_id);
  if (!target || target.bank <= 0) {
    db.deleteHeist(leaderId);
    return { ok: false, message: '🏦 The target\'s bank is empty — heist called off.' };
  }

  const members = heist.members;
  const n = members.length;
  db.updateHeistStatus(leaderId, 'running');

  const success = chance(victoryChance(n));
  const pot = Math.floor(target.bank * config.heist.winShare);
  const share = Math.floor(pot / n);

  if (success) {
    db.addBank(heist.target_id, -share * n);
    for (const m of members) {
      db.addWallet(m.user_id, share);
    }
    const names = members.map((m) => `<a href="tg://user?id=${m.user_id}">${esc(m.name, false)}</a>`).join(', ');
    db.deleteHeist(leaderId);
    return {
      ok: true,
      success: true,
      pot: share * n,
      share,
      message:
        `🏆 **HEIST SUCCESSFUL!**\n\n` +
        `🎯 Target: ${heist.target_name} — raided for **${fmt(share * n)}** (half of their ${fmt(target.bank)} bank)\n` +
        `👥 Crew (${n}): ${names}\n` +
        `💵 Each member gets: **${fmt(share)}**`,
    };
  }

  // Failure: each member loses 10% of own networth
  const losses = [];
  for (const m of members) {
    const u = db.getUser(m.user_id);
    if (!u) continue;
    const nw = u.wallet + u.bank;
    const loss = Math.min(Math.floor(nw * config.heist.failPenalty), u.wallet + u.bank);
    const walletLoss = Math.min(loss, u.wallet);
    const bankLoss = loss - walletLoss;
    if (walletLoss > 0) db.addWallet(m.user_id, -walletLoss);
    if (bankLoss > 0) db.addBank(m.user_id, -bankLoss);
    losses.push({ name: m.name, loss });
  }
  const lossStr = losses.map((l) => `• ${l.name}: -${fmt(l.loss)}`).join('\n');
  db.deleteHeist(leaderId);
  return {
    ok: true,
    success: false,
    message:
      `🚨 **HEIST FAILED!** Security was too tight.\n\n` +
      `Each crew member lost **10% of their networth**:\n${lossStr}`,
  };
}

module.exports = { start, join, execute, riskFor, victoryChance };