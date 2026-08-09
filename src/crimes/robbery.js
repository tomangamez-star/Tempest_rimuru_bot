'use strict';
/**
 * Rimuru Tempest Casino — Robbery 🦹
 * /rob (reply to target). No amount — take up to 15% of target's wallet.
 * Can't rob broke users (<10k wallet). Can't rob the owner.
 * Failure → robber pays a fine scaling with the robber's wallet (5%).
 * 10 min cooldown.
 */
const config = require('../config');
const db = require('../db');
const { fmt, chance } = require('../utils');

/**
 * Attempt a robbery.
 * @param robberId, @param targetId, @param meta {first_name, username}
 */
function attempt(robberId, targetId, meta = {}) {
  if (robberId === targetId) {
    return { ok: false, message: '🤨 Rob yourself? That\'s just losing money with extra steps.' };
  }
  if (String(targetId) === config.ownerId) {
    return { ok: false, message: '👑 Are you insane? You do NOT rob the King. Ever.' };
  }

  const robber = db.getOrCreateUser(robberId, meta);
  const target = db.getOrCreateUser(targetId);

  if (target.wallet < config.rob.minTargetWallet) {
    return { ok: false, message: `🕳️ ${target.first_name || 'They'} is too broke to rob (< ${fmt(config.rob.minTargetWallet)} in wallet).` };
  }
  if (robber.wallet < config.rob.minTargetWallet) {
    return { ok: false, message: `🕳️ You need at least ${fmt(config.rob.minTargetWallet)} in your wallet to go robbing.` };
  }

  const take = Math.min(Math.floor(target.wallet * config.rob.maxTakePct), robber.wallet);
  if (take <= 0) {
    return { ok: false, message: '🕳️ Nothing worth taking right now.' };
  }

  const success = chance(config.rob.successRate);
  if (success) {
    db.addWallet(targetId, -take);
    db.addWallet(robberId, take);
    return {
      ok: true,
      success: true,
      take,
      message: `🦹 **ROBBERY SUCCESS!** You lifted **${fmt(take)}** from ${target.first_name || 'your target'}.\nYour wallet: ${fmt(robber.wallet + take)}`,
    };
  }

  // Failure → fine scales with robber's wallet
  const fine = Math.max(1, Math.floor(robber.wallet * config.rob.finePct));
  db.addWallet(robberId, -fine);
  return {
    ok: true,
    success: false,
    fine,
    message: `🚔 **ROBBERY FAILED!** ${target.first_name || 'Your target'} fought back and the guards caught you.\nYou paid a fine of **${fmt(fine)}**.`,
  };
}

module.exports = { attempt };
