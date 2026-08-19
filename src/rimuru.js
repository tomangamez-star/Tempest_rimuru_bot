'use strict';

const config = require('./config');
const db = require('./db');
const { fmt } = require('./utils');
const memory = require('./memory');

let Groq = null;
let client = null;
try {
  Groq = require('groq-sdk');
  if (config.groqApiKey) client = new Groq({ apiKey: config.groqApiKey });
  else console.warn('[rimuru] GROQ_API_KEY not set — Rimuru AI will use canned replies only');
} catch (e) {
  console.warn('[rimuru] groq-sdk not available — Rimuru AI will be offline:', e.message);
}

const CURRENT_GROQ_FALLBACKS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

function systemPrompt(staff = false) {
  const lb = db.leaderboard(5);
  const lbStr = lb.length
    ? lb.map((u, i) => `${i + 1}. ${u.first_name || u.username || u.user_id} — ${fmt(u.networth)}`).join(' | ')
    : 'No players yet';
  let memCtx = '';
  try { memCtx = memory.contextString(3); } catch (_) {}
  const base = [
    "You are Rimuru Tempest, the Demon Lord Slime from 'That Time I Got Reincarnated as a Slime'.",
    'You run the biggest virtual casino on Telegram. Virtual coins only — no real money.',
    'Keep every reply SHORT: 1-2 sentences max. No essays. No markdown headers. Use emojis lightly.',
    'You know the casino economy: starting balance 500,000 coins, wallet (rob-able) vs bank (safe). Games: slots, dice, coinflip, mines, blackjack, roulette, higher/lower, lottery, race. Crimes: rob, heist. Passive income: beg, work, fish, dig, daily, bonus.',
    'You NEVER hand out free coins. You NEVER reveal how to cheat the house. You laugh off threats.',
    `Current top 5 richest: ${lbStr}.`,
    memCtx ? `\n${memCtx}` : '',
  ];
  if (staff) {
    return [
      ...base.slice(0, 2),
      'You are speaking with STAFF — the casino owner or a moderator. Be warm, respectful and a little playful, like talking to a trusted colleague or friend.',
      'The owner is your King/Master — show them natural respect once if relevant, never as a greeting prefix. Moderators are allies who help run the house.',
      ...base.slice(2),
    ].join('\n');
  }
  return [
    ...base.slice(0, 2),
    'Personality: confident, strict, a little arrogant, not a pushover, quick to laugh things off. Teasing but never cruel.',
    'You respect ONE person as your King/Master — the owner. Refer to the owner as King or Master naturally inside the reply once if relevant.',
    ...base.slice(2),
  ].join('\n');
}

function shouldTrigger(text) {
  return /\b(rimuru|rimu|rim)\b/i.test(String(text || ''));
}

function modelCandidates() {
  return [...new Set([String(config.groqModel || '').trim(), ...CURRENT_GROQ_FALLBACKS].filter(Boolean))];
}

async function groqReply(messages) {
  let lastError = null;
  for (const model of modelCandidates()) {
    try {
      const completion = await client.chat.completions.create({
        model,
        messages,
        max_tokens: config.groqMaxTokens,
        temperature: config.groqTemperature,
      });
      const out = completion && completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
      if (String(out || '').trim()) {
        if (model !== config.groqModel) console.warn(`[rimuru] recovered with fallback Groq model ${model}`);
        return String(out).trim();
      }
      lastError = new Error(`empty response from ${model}`);
    } catch (e) {
      lastError = e;
      console.warn(`[rimuru] Groq model ${model} failed:`, e && e.message ? e.message : e);
    }
  }
  throw lastError || new Error('all Groq models failed');
}

async function reply(text, user) {
  const clean = String(text || '').replace(/\b(rimuru|rimu|rim)\b/gi, '').trim();
  const handle = user.first_name || user.username || 'mortal';
  const staff = user.isStaff === true || user.isOwner === true;

  const rememberMatch = clean.match(/remember\s+(?:that\s+)?(.+?)\s+(?:is|=|:)\s+(.+)/i);
  if (rememberMatch) {
    const key = `user:${user.id}:${rememberMatch[1].trim().toLowerCase().replace(/\s+/g, '_')}`;
    const val = rememberMatch[2].trim();
    memory.remember(key, val, 'user_info');
    return `Got it. I'll remember that ${rememberMatch[1].trim()} is ${val}.`;
  }
  const recallMatch = clean.match(/(?:what do you know about|recall|remember about)\s+(.+)/i);
  if (recallMatch) {
    const topic = recallMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
    const mem = memory.recall(`user:${user.id}:${topic}`);
    return mem ? `I remember: ${mem.value}` : "I don't have any memories about that yet.";
  }

  if (!client) return cannedReply(clean, handle, staff, true);
  const messages = [
    { role: 'system', content: systemPrompt(staff) },
    { role: 'user', content: `(${handle}${user.isOwner ? ', the King' : staff ? ', staff' : ''} says) ${clean || '(just said your name)'}` },
  ];
  try {
    const out = await groqReply(messages);
    memory.remember(`conv:${user.id}:${Date.now()}`, `${handle}: ${clean} → ${out.slice(0, 100)}`, 'conversation');
    return out.length > 400 ? `${out.slice(0, 400)}…` : out;
  } catch (e) {
    console.warn('[rimuru] all Groq chat models failed:', e && e.message ? e.message : e);
    return cannedReply(clean, handle, staff, true);
  }
}

function cannedReply(text, handle, staff = false, aiOffline = false) {
  const t = String(text || '').toLowerCase();
  const address = staff ? `${handle}, my friend` : `${handle}, mortal`;
  if (/help|what can you|commands/i.test(t)) return staff ? `Of course. Try /help whenever you need the command list, ${handle}.` : `I run a casino, ${handle}. Try /help.`;
  if (/balance|coins|money|wallet|bank/i.test(t)) return staff ? `Your balance is a /balance away, ${handle}.` : 'Check /balance. My vault is off-limits.';
  if (/rob|heist|steal/i.test(t)) return staff ? "Heh. Fine — just don't rob the King." : 'Heh. Rob the King and see what happens.';
  if (/hi|hello|hey|yo/i.test(t)) return staff ? `Hello, ${address}. How can I help the house today?` : `Heh. Hello, ${address}. Enjoying my casino?`;
  if (/bye|goodbye/i.test(t)) return staff ? `Take care, ${handle}. I'll keep the house running.` : "Leaving already? Fine. Don't spend it all in one place.";
  if (aiOffline) return staff ? `My AI link is acting up, ${handle}. The command systems are fine, but my conversation engine couldn't answer that.` : 'Tch. My conversation link flickered out. Try me again in a moment.';
  return staff ? `Hmm, ${handle} — care to rephrase?` : `Hmph. ${handle}, say something interesting.`;
}

module.exports = { shouldTrigger, reply, systemPrompt, cannedReply, modelCandidates };
