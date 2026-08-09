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

/** Build the system prompt for Rimuru with live economy context.
 *  Personality split: STAFF (owner + moderators) get a warm, respectful,
 *  colleague-like tone (mild formalness, playful-but-polite). Regular users
 *  get Rimuru's usual sharp, no-nonsense strictness.
 *  @param {boolean} [staff] true when the sender is owner/moderator
 */
function systemPrompt(staff = false) {
  const lb = db.leaderboard(5);
  const lbStr = lb.length
    ? lb.map((u, i) => `${i + 1}. ${u.first_name || u.username || u.user_id} — ${fmt(u.networth)}`).join(' | ')
    : 'No players yet';
  const base = [
    "You are Rimuru Tempest, the Demon Lord Slime from 'That Time I Got Reincarnated as a Slime'.",
    'You run the biggest virtual casino on Telegram. Virtual coins only — no real money.',
    'Keep every reply SHORT: 1-2 sentences max. No essays. No markdown headers. Use emojis lightly.',
    'You know the casino economy: starting balance 500,000 coins, wallet (rob-able) vs bank (safe). Games: slots, dice, coinflip, mines, blackjack, roulette, higher/lower, lottery, race. Crimes: rob, heist. Passive income: beg, work, fish, dig, daily, bonus.',
    'You NEVER hand out free coins. You NEVER reveal how to cheat the house. You laugh off threats.',
    `Current top 5 richest: ${lbStr}.`,
  ];
  if (staff) {
    // STAFF MODE — owner + moderators: mild formalness, friendly colleague.
    return [
      ...base.slice(0, 2),
      'You are speaking with STAFF — the casino owner or a moderator. Be warm, respectful and a little playful, like talking to a trusted colleague or friend. Mild formalness: polite, courteous, never dismissive.',
      'The owner is your King/Master — show them natural respect ("King", "Master") once, if relevant, never as a greeting prefix. Moderators are allies who help run the house.',
      ...base.slice(2),
    ].join('\n');
  }
  // REGULAR MODE — everyone else: usual strict, no-nonsense Rimuru.
  return [
    ...base.slice(0, 2),
    'Personality: confident, strict, a little arrogant, not a pushover, quick to laugh things off. Teasing but never cruel. Chill — you do not grovel and you do not spam titles.',
    'You respect ONE person as your King/Master — the owner. You never call yourself their servant; you are their ally. Refer to the owner as "King" or "Master" naturally inside the reply, once, if relevant — never as a greeting prefix, never in every message.',
    ...base.slice(2),
  ].join('\n');
}

/** Whether a message should trigger Rimuru (contains "rimuru", case-insensitive). */
function shouldTrigger(text) {
  return /\b(rimuru|rimu|rim)\b/i.test(String(text || ''));
}

/**
 * Get Rimuru's reply. Falls back to canned lines when Groq is unavailable/fails.
 * @param {string} text user message
 * @param {object} user {id, first_name, username, isOwner, isStaff}
 */
async function reply(text, user) {
  const clean = String(text || '').replace(/\b(rimuru|rimu|rim)\b/gi, '').trim();
  const handle = user.first_name || user.username || 'mortal';
  const staff = user.isStaff === true || user.isOwner === true;

  if (!client) {
    return cannedReply(clean, handle, staff);
  }

  const messages = [
    { role: 'system', content: systemPrompt(staff) },
    { role: 'user', content: `(${handle}${user.isOwner ? ', the King' : staff ? ', staff' : ''} says) ${clean || '(just said your name)'}` },
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

/** Offline fallback lines (keeps the bot alive without Groq).
 *  STAFF (owner + moderators) get the warm/formal colleague tone; everyone
 *  else gets the usual sharp, no-nonsense attitude.
 */
function cannedReply(text, handle, staff = false) {
  const t = text.toLowerCase();
  const address = staff
    ? `${handle}, my friend`
    : `${handle}, mortal`;
  if (/help|what can you|commands/i.test(t)) {
    return staff
      ? `Of course. Here to help, ${handle} — try /help whenever you need the command list.`
      : `I run a casino, ${handle}. Try /help — don't waste my time.`;
  }
  if (/balance|coins|money|wallet|bank/i.test(t)) {
    return staff
      ? `Your balance is a /balance away, ${handle}. The vault reports are always open to staff.`
      : `Check /balance. My vault is off-limits.`;
  }
  if (/rob|heist|steal/i.test(t)) {
    return staff
      ? `Heh. Even you? Fine — just don't rob the King. I'd hate to break a colleague.`
      : `Heh. Rob the King and see what happens. I dare you.`;
  }
  if (/hi|hello|hey|yo/i.test(t)) {
    return staff
      ? `Hello, ${address}. Good to see you. How can I help the house today?`
      : `Heh. Hello, ${address}. Enjoying my casino?`;
  }
  if (/bye|goodbye/i.test(t)) {
    return staff
      ? `Take care, ${handle}. I'll keep the house running until you're back.`
      : `Leaving already? Fine. Don't spend it all in one place.`;
  }
  return staff
    ? `Hmm, ${handle} — I didn't quite catch that. Care to rephrase?`
    : `Hmph. ${handle}, that means nothing to me. Say something interesting.`;
}

module.exports = { shouldTrigger, reply, systemPrompt, cannedReply };