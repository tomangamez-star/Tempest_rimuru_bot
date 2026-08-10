'use strict';
/**
 * Rimuru Tempest Casino — Crime 🕵️
 * /crime [amount] — bet coins on a risky crime. Higher bet = higher payout,
 * but never guaranteed. Uses shop items:
 *   - ROBBERY-type crimes need: crowbar + gun + mask (all three).
 *   - Item bonuses raise success (lockpick, lucky charm, drill).
 *   - security raises YOUR escape odds when others /rob you (handled here
 *     via a helper the robbery module can call too).
 *   - cyber security raises the chance a heist on you FAILS.
 *
 * Crime types (payout multiplier on the bet):
 *   petty theft      (no items)        2.0x
 *   house robbery    (crowbar+mask)    3.0x
 *   armed robbery    (crowbar+gun+mask)4.5x
 *   vault heist      (all + drill)     7.0x
 */
const config = require('../config');
const db = require('../db');
const { fmt, chance, pick } = require('../utils');

const CRIMES = [
  { id: 'petty', name: 'Petty Theft', emoji: '🪙', mult: 2.0, need: [], desc: 'pick a pocket in the market' },
  { id: 'house', name: 'House Robbery', emoji: '🏠', mult: 3.0, need: ['crowbar', 'mask'], desc: 'crack a house with your crowbar' },
  { id: 'armed', name: 'Armed Robbery', emoji: '🔫', mult: 4.5, need: ['crowbar', 'gun', 'mask'], desc: 'a proper stick-up' },
  { id: 'vault', name: 'Vault Heist', emoji: '🏦', mult: 7.0, need: ['crowbar', 'gun', 'mask', 'drill'], desc: 'the big one — drill the vault' },
];

/** Crime definitions (exported for tests / menus). */
function crimeTypes() {
  return CRIMES;
}

/** Item success bonus (flat, once per distinct item owned). */
function itemBonus(userId) {
  const cfg = config.shop.crime.itemBonus || {};
  let bonus = 0;
  for (const [itemId, b] of Object.entries(cfg)) {
    if (db.hasItem(userId, itemId)) bonus += b;
  }
  return bonus;
}

/** Which crime the user can actually pull off (highest available). */
function bestCrime(userId) {
  for (let i = CRIMES.length - 1; i >= 0; i--) {
    const c = CRIMES[i];
    const hasAll = c.need.every((id) => db.hasItem(userId, id));
    if (hasAll) return c;
  }
  return null;
}

/** Bonus to escape /rob attempts (from Security item). */
function escapeBonus(userId) {
  return db.hasItem(userId, 'security') ? (config.shop.crime.securityEscapeBonus || 0.10) : 0;
}

/** Bonus chance a heist on you FAILS (from Cyber Security item). */
function defenseBonus(userId) {
  return db.hasItem(userId, 'cyber') ? (config.shop.crime.cyberDefenseBonus || 0.15) : 0;
}

/**
 * /crime [amount] — risk coins for a bigger payout.
 * @returns { ok, message, crime?, bet?, payout?, success? }
 */
function commit(userId, rawBet, meta = {}) {
  const n = Number(String(rawBet || '').replace(/,/g, ''));
  if (!rawBet || !Number.isFinite(n) || n <= 0) {
    return { ok: false, message: '🎯 Usage: `/crime [amount]` — e.g. `/crime 50000`' };
  }
  const bet = Math.floor(n);
  const cfg = config.shop.crime || {};
  if (bet < (cfg.minBet || 5000)) {
    return { ok: false, message: `🕵️ The minimum crime bet is <b>${fmt(cfg.minBet)}</b>.` };
  }
  if (bet > (cfg.maxBet || 2000000)) {
    return { ok: false, message: `🕵️ The maximum crime bet is <b>${fmt(cfg.maxBet)}</b>. Even the King has limits.` };
  }

  const u = db.getOrCreateUser(userId, meta);
  if (u.wallet < bet) {
    return { ok: false, message: `❌ You need <b>${fmt(bet)}</b> for that crime — your wallet has ${fmt(u.wallet)}.` };
  }

  const crime = bestCrime(userId);
  const successRate = Math.min(0.9, Math.max(0.15, (cfg.baseSuccess || 0.45) + itemBonus(userId)));

  db.addWallet(userId, -bet); // stake the bet
  const success = chance(successRate);

  if (success) {
    const payout = Math.floor(bet * crime.mult);
    db.addWallet(userId, payout);
    db.logActivity('user', `🕵️ ${crime.name} win ${fmt(payout)} (bet ${fmt(bet)}) -> ${meta.first_name || userId}`, {
      target: userId, crime: crime.id, bet, payout,
    });
    return {
      ok: true,
      success: true,
      crime,
      bet,
      payout,
      message:
        `🕵️ <b>CRIME SUCCESS!</b> You pulled off <b>${crime.emoji} ${crime.name}</b> — ${crime.desc}.\n` +
        `🎯 Bet: <b>${fmt(bet)}</b> · 💰 Payout: <b>${fmt(payout)}</b> (net <b>+${fmt(payout - bet)}</b>)\n` +
        `👛 Wallet: <b>${fmt(u.wallet - bet + payout)}</b>`,
    };
  }

  db.logActivity('user', `🕵️ ${crime.name} FAIL (lost ${fmt(bet)}) -> ${meta.first_name || userId}`, {
    target: userId, crime: crime.id, bet,
  });
  return {
    ok: true,
    success: false,
    crime,
    bet,
    message:
      `🚔 <b>CRIME FAILED!</b> Your <b>${crime.emoji} ${crime.name}</b> went sideways — ${pick([
        'the guards were waiting',
        'a witness screamed',
        'you tripped over your own getaway',
        'the vault was locked tight',
      ])}.\n` +
      `💸 You lost the whole bet: <b>${fmt(bet)}</b>\n` +
      `👛 Wallet: <b>${fmt(u.wallet - bet)}</b>`,
  };
}

module.exports = { commit, crimeTypes, bestCrime, itemBonus, escapeBonus, defenseBonus, CRIMES };
