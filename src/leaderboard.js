'use strict';
/**
 * Rimuru Tempest Casino — Leaderboard 🏆
 * /lb — top 10 richest by NET WORTH, live & accurate every run.
 *
 * Output mirrors the classic "Top elite magnates" style:
 *   ╭━🏆 LEADERBOARD 🏆━╮
 *      𝖳𝗈𝗉 𝖾𝗅𝗂𝗍𝖾 ⅿ𝖺𝗀𝗇𝖺𝗍𝖾𝗌 𝖺𝖼𝗋𝗈𝗌𝗌 𝗍𝗁𝖾 𝗀𝗅𝗈𝖻𝖾
 *
 *   1️⃣ Name
 *   ┗━━ Net Worth: 454,022,762,148
 *
 *   ... blank gap between entries ...
 *
 *   • 𝖴𝗉𝖽𝖺𝗍𝖾𝖽 𝗅𝗂𝗏𝖾 𝖿𝗋𝗈𝗆 𝖼𝖾𝗇𝗍𝗋𝖺𝗅 𝗋𝖾𝗀𝗂𝗌𝗍𝗋𝗒 •
 */
const db = require('./db');
const { fmt, esc } = require('./utils');

// Top 3 = medals 🥇🥈🥉, 4th-10th = keycap numbers (4️⃣ … 9️⃣, 1️⃣ 0️⃣ for 10th)
const RANKS = [
  '🥇', '🥈', '🥉', '4\ufe0f\u20e3', '5\ufe0f\u20e3',
  '6\ufe0f\u20e3', '7\ufe0f\u20e3', '8\ufe0f\u20e3', '9\ufe0f\u20e3', '1\ufe0f\u20e3 0\ufe0f\u20e3',
];

const HEADER = '╭━🏆 LEADERBOARD 🏆━╮';
const TAGLINE = '   𝖳𝗈𝗉  𝖾𝗅𝗂𝗍𝖾  ⅿ𝖺𝗀𝗇𝖺𝗍𝖾𝗌  𝖺𝖼𝗋𝗈𝗌𝗌  𝗍𝗁𝖾  𝗀𝗅𝗈𝖻𝖾';
const FOOTER = '• 𝖴𝗉𝖽𝖺𝗍𝖾𝖽 𝗅𝗂𝗏𝖾 𝖿𝗋𝗈𝗆 𝖼𝖾𝗇𝗍𝗋𝖺𝗅 𝗋𝖾𝗀𝗂𝗌𝗍𝗋𝗒 •';

/** Render the leaderboard as an HTML string (safe inside a note body). */
function render() {
  const top = db.leaderboard(10);
  if (!top.length) return '🏆 No players yet. Be the first!';

  const entries = top.map((u, i) => {
    const name = esc(u.first_name || u.username || `User${u.user_id}`, false);
    const rank = RANKS[i] || `${i + 1}.`;
    // Name on its own line, then the net-worth line — blank gap added between entries.
    return `${rank} <b>${name}</b>\n┗━━ Net Worth: <b>${fmt(u.networth)}</b>`;
  });

  return (
    `${HEADER}\n` +
    `${TAGLINE}\n\n` +
    entries.join('\n\n') +
    `\n\n${FOOTER}`
  );
}

module.exports = { render, HEADER, TAGLINE, FOOTER };
