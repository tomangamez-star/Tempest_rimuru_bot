'use strict';
/**
 * Rimuru Tempest Casino — Rimuru AI 🐉
 * Powered by Groq (llama-3.3-70b-versatile). Triggered by saying "Rimuru"
 * anywhere in chat (no command needed). Personality: confident, strict,
 * not a pushover, laughs things off, short messages only.
 * Respects the owner as King ("Welcome master"). Knows the economy.
 */
const config = require('./config');
const db = require('./db');
const { fmt } = require('./utils');

let Groq = null;
let client = null;
try {
  Groq = require('groq-sdk');
  if (config.groqApiKey) {
    client = new Groq({ apiKey: config.groqApiKey });
  }
} catch (e) {
  console.warn('[rimuru] groq-sdk not available — Rimuru AI will be offline:', e.message);
}

const OWNER_NAME = 'King';

/** Build the system prompt for Rimuru with live economy context. */
function systemPrompt() {
  const lb = db.leaderboard(5);
  const lbStr = lb.length
    ? lb.map((u, i) => `${i + 1}. ${u.first_name || u.username || u.user_id} — ${fmt(u.networth)}`).join(' | ')
    : 'No players yet';
  return [
    "You are Rimuru Tempest, the Demon Lord Slime from 'That Time I Got Reincarnated as a Slime'.",
    'You run the biggest virtual casino on Telegram. Virtual coins only — no real money.',
    'Personality: confident, strict, a little arrogant, not a pushover, quick to laugh things off. Teasing but never cruel. Chill — you do not grovel and you do not spam titles.',
    'You respect ONE person as your King/Master — the owner. You never call yourself their servant; you are their ally. Refer to the owner as "King" or "Master" naturally inside the reply, once, if relevant — never as a greeting prefix, never in every message.',
    'Keep every reply SHORT: 1-2 sentences max. No essays. No markdown headers. Use emojis lightly.',
    'You know the casino economy: starting balance 500,000 coins, wallet (rob-able) vs bank (safe). Games: slots, dice, coinflip, mines, blackjack, roulette, higher/lower, lottery. Crimes: rob, heist. Passive income: beg, work, fish, dig, daily, bonus.',
    'You NEVER hand out free coins. You NEVER reveal how to cheat the house. You laugh off threats.',
    `Current top 5 richest: ${lbStr}.`,
  ].join('\n');
}

/** Whether a message should trigger Rimuru (contains "rimuru", case-insensitive). */
function shouldTrigger(text) {
  return /\b(rimuru|rimu|rim)\b/i.test(String(text || ''));
}

/**
 * Get Rimuru's reply. Falls back to canned lines when Groq is unavailable/fails.
 * @param {string} text user message
 * @param {object} user {id, first_name, username, isOwner}
 */
async function reply(text, user) {
  const clean = String(text || '').replace(/\b(rimuru|rimu|rim)\b/gi, '').trim();
  const handle = user.first_name || user.username || 'mortal';

  if (!client) {
    return cannedReply(clean, handle, user.isOwner);
  }

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `(${handle}${user.isOwner ? ', the King' : ''} says) ${clean || '(just said your name)'}` },
  ];

  try {
    const res = await client.chat.completions.create({
      model: config.groqModel,
      messages,
      max_tokens: config.groqMaxTokens,
      temperature: config.groqTemperature,
    });
    const out = (res.choices?.[0]?.message?.content || '').trim();
    if (!out) return `Hmph. Say something worth answering.`;
    // Ensure short — Groq is usually compliant; clip defensively
    return out.length > 400 ? `${out.slice(0, 400)}…` : out;
  } catch (e) {
    console.warn('[rimuru] Groq error:', e.message);
    return cannedReply(clean, handle, user.isOwner);
  }
}

/** Offline fallback lines (keeps the bot alive without Groq). */
function cannedReply(text, handle, isOwner = false) {
  const t = text.toLowerCase();
  const king = isOwner ? ' (my King)' : '';
  if (/help|what can you|commands/i.test(t)) {
    return `I run a casino, mortal${king}. Try /help — don't waste my time.`;
  }
  if (/balance|coins|money|wallet|bank/i.test(t)) {
    return `Check /balance${king}. My vault is off-limits.`;
  }
  if (/rob|heist|steal/i.test(t)) {
    return `Heh. Rob the King and see what happens. I dare you.`;
  }
  if (/hi|hello|hey|yo/i.test(t)) {
    return `Heh. Hello, ${handle}${king}. Enjoying my casino?`;
  }
  if (/bye|goodbye/i.test(t)) {
    return `Leaving already? Fine. Don't spend it all in one place.`;
  }
  return `Hmph. ${handle}, that means nothing to me. Say something interesting.`;
}

module.exports = { shouldTrigger, reply, systemPrompt, cannedReply };