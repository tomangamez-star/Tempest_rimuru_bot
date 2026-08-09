'use strict';
/**
 * Rimuru Tempest Casino — Leaderboard 🏆
 * /lb — top 10 richest by NET WORTH, live & accurate every run.
 * Shiny bright numbers (not pale) for ranks 1-10.
 */
const db = require('./db');
const { fmt } = require('./utils');

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function render() {
  const top = db.leaderboard(10);
  if (!top.length) return '🏆 No players yet. Be the first!';

  const lines = top.map((u, i) => {
    const name = u.first_name || u.username || `User${u.user_id}`;
    const rank = MEDALS[i] || `${i + 1}.`;
    // "Shiny bright" numbers via Markdown bold — full-width styling pops on dark themes
    return `${rank} **${name}** — 💎 **${fmt(u.networth)}**`;
  });

  return `🏆 **RIMURU'S RICHEST**\n\n${lines.join('\n')}\n\n_Net worth = wallet + bank. Updated live._`;
}

module.exports = { render };
