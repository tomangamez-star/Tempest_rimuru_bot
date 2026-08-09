'use strict';
/**
 * Rimuru Tempest Casino — Leaderboard 🏆
 * /lb — top 10 richest by NET WORTH, live & accurate every run.
 * Shiny bright gold numbers (not pale) for ranks 1-10.
 */
const db = require('./db');
const { fmt } = require('./utils');

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Render the leaderboard as an HTML string (safe inside a note body). */
function render() {
  const top = db.leaderboard(10);
  if (!top.length) return '🏆 No players yet. Be the first!';

  const lines = top.map((u, i) => {
    const name = u.first_name || u.username || `User${u.user_id}`;
    const rank = MEDALS[i] || `${i + 1}.`;
    // Shiny bright gold numbers — pop on dark themes
    return `${rank} <b>${name}</b> — 💎 <b><span style="color:#FFD54F">${fmt(u.networth)}</span></b>`;
  });

  return (
    `🏆 <b>RIMURU'S RICHEST</b>\n\n` +
    lines.join('\n') +
    `\n\n<i>Net worth = wallet + bank. Updated live.</i>`
  );
}

module.exports = { render };
