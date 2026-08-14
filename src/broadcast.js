'use strict';
/**
 * Rimuru Tempest Casino — broadcast helpers.
 *
 * Centralizes the "is this a relevant Rimuru message?" check (used to gate
 * moderator broadcasts) and the announcement-text builders for events /
 * missions / giveaways so the Telegram /broadcast command and the admin
 * dashboard announce through the SAME pipeline.
 *
 * The relevance check is layered:
 *   1. Deterministic keyword scoring (fast, works offline and in tests).
 *   2. Optional Groq AI verdict for messages with no obvious keyword — only
 *      used when a Groq key is configured; otherwise the keyword result wins.
 * The owner always bypasses this check at the call site (never gated here).
 */
const config = require('./config');
const { fmt } = require('./utils');

const EVENT_TYPES = ['mission', 'event', 'giveaway', 'trivia', 'challenge'];

/** HTML-escape untrusted text for Telegram parse_mode=HTML. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Is this a valid event type (as used by db.createEvent)? */
function isEventType(t) {
  return EVENT_TYPES.includes(String(t || '').toLowerCase());
}

/**
 * Deterministic relevance score for a broadcast body. Returns a number of
 * matching Rimuru/bot topic keywords — the call site treats >= 1 as relevant.
 */
function keywordRelevance(message) {
  const t = String(message || '').toLowerCase();
  const terms = [
    'rimuru', 'casino', 'coin', 'balance', 'bank', 'wallet', 'economy',
    'event', 'mission', 'giveaway', 'trivia', 'challenge', 'command',
    'bet', 'slots', 'dice', 'blackjack', 'roulette', 'lottery', 'shop',
    'crime', 'heist', 'rob', 'leaderboard', 'reward', 'deposit', 'withdraw',
    'daily', 'bonus', 'update', 'maintenance', 'game', 'profile', 'badge',
    'redeem', 'transfer', 'donate', 'income', 'fish', 'dig', 'work', 'beg',
  ];
  let score = 0;
  for (const k of terms) if (t.includes(k)) score++;
  return score;
}

/**
 * Is this message a relevant Rimuru bot announcement (not random/unrelated)?
 * Moderators must pass this; the owner bypasses it at the call site.
 *
 * @param {string} message
 * @returns {Promise<{ok: boolean, reason: string, via: 'keyword'|'ai'}>}
 */
async function isRelevant(message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, reason: 'empty message', via: 'keyword' };
  if (keywordRelevance(text) >= 1) {
    return { ok: true, reason: 'matches Rimuru bot topics', via: 'keyword' };
  }

  // No keyword match — ask Groq for a verdict only when a key is configured.
  if (config.groqApiKey) {
    try {
      // Lazy-load so this module never requires the SDK when Groq is off.
      const Groq = require('groq-sdk');
      const client = new Groq({ apiKey: config.groqApiKey });
      const res = await client.chat.completions.create({
        model: config.groqModel,
        messages: [
          {
            role: 'system',
            content:
              'You are a Telegram bot content moderator. Reply with exactly YES or NO (nothing else). ' +
              'A broadcast is allowed ONLY if it is a relevant announcement for a Rimuru Tempest casino bot ' +
              '(about the bot, its economy/coins, games, commands, events, missions, giveaways, shop, crimes, ' +
              'maintenance, or community). Reject random, unrelated, spam, scam, off-topic, or promotional content.',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 5,
        temperature: 0,
      });
      const verdict = String(res.choices?.[0]?.message?.content || '').trim().toUpperCase();
      if (verdict.startsWith('YES')) {
        return { ok: true, reason: 'AI-approved as relevant Rimuru content', via: 'ai' };
      }
      return { ok: false, reason: 'AI rejected as not relevant to the Rimuru bot', via: 'ai' };
    } catch (e) {
      // AI unavailable/failed — fall through to the conservative keyword result.
    }
  }

  return { ok: false, reason: 'message is not related to the Rimuru bot', via: 'keyword' };
}

/** Human-readable type label for announcements. */
function typeLabel(type) {
  return (
    { mission: '⚔️ Mission', event: '🎉 Event', giveaway: '🎁 Giveaway', trivia: '🧠 Trivia', challenge: '🏆 Challenge' }[
      String(type || '').toLowerCase()
    ] || '📜 Event'
  );
}

/** Build the announcement body for a dashboard/bot-created event. */
function buildEventAnnouncement(ev) {
  const title = escHtml(ev.title || 'New event');
  const desc = escHtml(ev.description || '');
  const reward = Number(ev.reward) || 0;
  const label = typeLabel(ev.type);
  const rewardLine = reward > 0 ? `💰 Reward: <b>${fmt(reward)}</b> coins\n` : '';
  const idLine = ev.id ? `Try <code>/mission ${ev.id}</code> to claim it, mortal.` : '';
  return (
    `${label}: <b>${title}</b>\n` +
    `${desc ? desc + '\n' : ''}` +
    rewardLine +
    (idLine ? idLine + '\n' : '')
  ).trim();
}

module.exports = {
  EVENT_TYPES,
  isEventType,
  escHtml,
  keywordRelevance,
  isRelevant,
  buildEventAnnouncement,
};
