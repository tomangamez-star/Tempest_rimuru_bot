'use strict';
/**
 * Rimuru Tempest Casino — Events & Missions ⚔️
 *
 * Events are created from the ADMIN DASHBOARD (src/dashboard) and stored in
 * the bot_events table. This module makes them LIVE inside the bot:
 *
 *   /missions — list active events/missions created from the dashboard
 *   /mission  — start/attempt an active mission (by id or the latest)
 *   /heistrimuru — classic event: attempt to heist Rimuru and survive
 *   /fightrimuru — classic event: fight Rimuru, win = reward, lose = fine
 *
 * Every mission has a reward (coins) and a risk. Attempts are logged to the
 * dashboard (game_history + activity feed) so the owner can watch live.
 */
const config = require('./config');
const db = require('./db');
const cd = require('./cooldowns');
const { fmt, randInt, chance, pick } = require('./utils');

const MISSION_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between mission attempts

/* ---------------- helpers ---------------- */

function displayName(meta = {}) {
  return meta.first_name || meta.username || 'mortal';
}

/** A random "heist Rimuru" scenario outcome. */
function heistRimuru(userId, meta = {}) {
  // 55% survive → reward 2x bet-ish; 45% fail → fine 10% of wallet
  const u = db.getUser(userId) || { wallet: 0 };
  const stake = Math.max(1000, Math.floor(u.wallet * 0.10));
  const survive = chance(0.55);
  const reward = randInt(20000, 60000);
  if (survive) {
    db.addWallet(userId, reward);
    db.logGameHistory({ user_id: userId, username: meta.username || '', game: 'heist_rimuru', bet: 0, result: 'win', amount: reward, meta: { type: 'event' } });
    return {
      win: true,
      message:
        `🎭 <b>HEIST ON RIMURU</b>\n\n` +
        `You slipped into the vault while Rimuru was napping…\n` +
        `But the slime's shadow moved first. <b>"Did you really think I sleep?"</b> 🐉\n\n` +
        `— Except the "vault" was a decoy, and your distraction worked perfectly. ` +
        `<b>You escaped with ${fmt(reward)} coins!</b> 🏃💨\n` +
        `Wallet: ${fmt(db.getUser(userId).wallet)}`,
    };
  }
  db.addWallet(userId, -stake);
  db.logGameHistory({ user_id: userId, username: meta.username || '', game: 'heist_rimuru', bet: stake, result: 'lose', amount: -stake, meta: { type: 'event' } });
  return {
    win: false,
    message:
      `🎭 <b>HEIST ON RIMURU</b>\n\n` +
      `You crept toward the vault… and stepped on a slime-shaped tripwire. 🚨\n` +
      `<b>"Cute. Now pay for the alarm."</b> — Rimuru's tendrils relieved you of ${fmt(stake)} coins. 🐉\n` +
      `Wallet: ${fmt(db.getUser(userId).wallet)}`,
  };
}

/** A random "fight Rimuru" scenario outcome. */
function fightRimuru(userId, meta = {}) {
  const u = db.getUser(userId) || { wallet: 0 };
  const stake = Math.max(1000, Math.floor(u.wallet * 0.05));
  const win = chance(0.40); // Rimuru is a Demon Lord — losing is more likely
  const reward = randInt(30000, 80000);
  if (win) {
    db.addWallet(userId, reward);
    db.logGameHistory({ user_id: userId, username: meta.username || '', game: 'fight_rimuru', bet: stake, result: 'win', amount: reward, meta: { type: 'event' } });
    return {
      win: true,
      message:
        `⚔️ <b>FIGHT RIMURU</b>\n\n` +
        `You squared up against the Demon Lord Slime…\n` +
        `<b>"Interesting."</b> A single tendril flicked — and you <i>dodged it</i>?!\n\n` +
        `Rimuru laughed, genuinely amused, and tossed you ${fmt(reward)} coins as a prize. 🏆\n` +
        `Wallet: ${fmt(db.getUser(userId).wallet)}`,
    };
  }
  db.addWallet(userId, -stake);
  db.logGameHistory({ user_id: userId, username: meta.username || '', game: 'fight_rimuru', bet: stake, result: 'lose', amount: -stake, meta: { type: 'event' } });
  return {
    win: false,
    message:
      `⚔️ <b>FIGHT RIMURU</b>\n\n` +
      `You threw a punch. The slime <i>absorbed it</i> without moving. 🐉\n` +
      `<b>"Good form. Terrible target choice."</b>\n\n` +
      `A gentle tendril flick sent you tumbling — and ${fmt(stake)} coins flew out of your pocket. 💸\n` +
      `Wallet: ${fmt(db.getUser(userId).wallet)}`,
  };
}

/** Attempt a dashboard-created mission (by id, or the latest active). */
function attemptMission(userId, meta = {}, missionId = null) {
  const g = cd.guard(userId, 'mission', 'Mission');
  if (g.blocked) return { ok: false, message: g.message };

  const events = db.activeEvents();
  if (!events.length) {
    return {
      ok: false,
      message: `📜 <b>No active events right now.</b>\nThe King hasn't opened any missions yet. Check back later!`,
    };
  }

  const ev = missionId ? events.find((e) => e.id === missionId) : events[0];
  if (!ev) {
    return { ok: false, message: `📜 No event found with id ${missionId}. Try /missions to see the list.` };
  }

  // Different event types resolve differently:
  let result;
  if (ev.type === 'trivia') {
    // Simple auto-complete (AI question flow is handled by the dashboard
    // chat; in-bot we reward participation).
    const reward = ev.reward || randInt(10000, 30000);
    db.addWallet(userId, reward);
    result = {
      win: true,
      message:
        `📜 <b>${ev.title}</b>\n\n` +
        `${ev.description || ''}\n\n` +
        `✨ Participation reward: <b>+${fmt(reward)} coins</b>! Answer Rimuru's questions in the dashboard to win more.`,
    };
  } else {
    // mission / event / giveaway → roll
    const successChance = ev.type === 'giveaway' ? 0.20 : 0.50;
    const win = chance(successChance);
    const reward = ev.reward || randInt(15000, 50000);
    const fine = Math.max(1000, Math.floor((db.getUser(userId) || { wallet: 0 }).wallet * 0.05));
    if (win) {
      db.addWallet(userId, reward);
      result = {
        win: true,
        message:
          `📜 <b>${ev.title}</b>\n\n` +
          `${ev.description || ''}\n\n` +
          `✅ <b>MISSION COMPLETE!</b> Rimuru nods approvingly. Reward: <b>+${fmt(reward)} coins</b> 🏆\n` +
          `Wallet: ${fmt(db.getUser(userId).wallet)}`,
      };
    } else {
      db.addWallet(userId, -fine);
      result = {
        win: false,
        message:
          `📜 <b>${ev.title}</b>\n\n` +
          `${ev.description || ''}\n\n` +
          `❌ <b>MISSION FAILED.</b> Rimuru sighs. "Better luck next time, mortal." You lost ${fmt(fine)} coins. 💸\n` +
          `Wallet: ${fmt(db.getUser(userId).wallet)}`,
      };
    }
    db.logGameHistory({ user_id: userId, username: meta.username || '', game: `event_${ev.type}`, bet: 0, result: result.win ? 'win' : 'lose', amount: result.win ? reward : -fine, meta: { event_id: ev.id, event_title: ev.title } });
  }

  cd.start(userId, 'mission', MISSION_COOLDOWN_MS);
  if (result.win) db.incrementEventCompletions(ev.id);
  db.logActivity('event', `${displayName(meta)} ${result.win ? 'completed' : 'failed'} "${ev.title}"`, { event_id: ev.id });
  return { ok: true, ...result };
}

/** List active missions as a formatted message. */
function listMissions() {
  const events = db.activeEvents();
  if (!events.length) {
    return `📜 <b>NO ACTIVE EVENTS</b>\n\nThe King hasn't opened any missions yet. Check back later! 🐉`;
  }
  const lines = events.map((e) => {
    const typeEmoji = { mission: '⚔️', event: '🎉', giveaway: '🎁', trivia: '🧠' }[e.type] || '📜';
    const reward = e.reward ? ` · reward <b>${fmt(e.reward)}</b>` : '';
    return `${typeEmoji} <b>${e.title}</b>${reward}\n${e.description || ''}\n<code>/mission ${e.id}</code>`;
  });
  return `📜 <b>ACTIVE EVENTS & MISSIONS</b>\n\n${lines.join('\n\n')}\n\n<i>Attempt one with /mission [id]. Mind the cooldown.</i>`;
}

module.exports = {
  heistRimuru,
  fightRimuru,
  attemptMission,
  listMissions,
  MISSION_COOLDOWN_MS,
};
