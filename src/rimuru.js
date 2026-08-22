'use strict';

const config = require('./config');
const db = require('./db');
const { fmt } = require('./utils');
const memory = require('./memory');
const knowledge = require('./rimuru-knowledge');
const rankSystem = require('./rank');

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

function liveUserContext(user = {}) {
  const row = db.getUser(Number(user.id)) || {};
  const owner = db.getUser(Number(config.ownerId)) || {};
  const leaders = db.leaderboard(100) || [];
  const position = leaders.findIndex((u) => Number(u.user_id) === Number(user.id));
  const sessions = db.getActiveGameSessions(Number(user.id));
  const waifus = db.getUserCollection(Number(user.id)) || [];
  const cards = db.getUserHuntCharacters(Number(user.id)) || [];
  const personal = memory.userContext(Number(user.id), 12);
  const recent = memory.conversationContext(Number(user.id), 4);
  const subject = user.subject || null;
  let subjectLine = '';
  if (subject) {
    const sid = Number(subject.user_id);
    const subjectPosition = leaders.findIndex((u) => Number(u.user_id) === sid);
    const subjectGames = db.getActiveGameSessions(sid);
    subjectLine = `Public referenced-user context: ${subject.first_name || subject.username || sid}; rank ${String(subject.rank || 'bronze').toUpperCase()}, valid matches ${Number(subject.rank_valid_matches) || 0}, net worth ${fmt(subject.networth || 0)}, leaderboard ${subjectPosition >= 0 ? `#${subjectPosition + 1}` : 'unranked'}, active games ${subjectGames.length ? subjectGames.map((s) => s.game).join(', ') : 'none'}. Do not reveal that user's private memories.`;
  }
  return [
    `Current user: ${row.first_name || user.first_name || row.username || user.username || 'unknown'}${user.isOwner ? ' (OWNER/KING)' : user.isStaff ? ' (STAFF)' : ''}`,
    `Bot owner/King: ${owner.first_name || owner.username || 'the configured Rimuru owner'}.`,
    `Balance: wallet ${fmt(row.wallet || 0)}, bank ${fmt(row.bank || 0)}, net worth ${fmt(row.networth || 0)}.`,
    `Rank: ${String(row.rank || 'bronze').toUpperCase()}, valid matches ${Number(row.rank_valid_matches) || 0}, matches to next ${rankSystem.matchesToNext(Number(user.id))}, leaderboard position ${position >= 0 ? `#${position + 1}` : 'unranked'}.`,
    `Collections: ${waifus.length} waifus, ${cards.length} JTF cards.`,
    `Active games: ${sessions.length ? sessions.map((s) => s.game).join(', ') : 'none'}.`,
    personal ? `This user's private remembered facts: ${personal}.` : 'This user has no saved personal facts.',
    recent ? `Recent conversation with this same user: ${recent}.` : '',
    subjectLine,
  ].filter(Boolean).join('\n');
}

function systemPrompt(staff = false, user = {}) {
  const lb = db.leaderboard(5);
  const lbStr = lb.length
    ? lb.map((u, i) => `${i + 1}. ${u.first_name || u.username || u.user_id} — ${fmt(u.networth)}`).join(' | ')
    : 'No players yet';
  const base = [
    "You are Rimuru Tempest, the Demon Lord Slime from 'That Time I Got Reincarnated as a Slime'.",
    'You run the biggest virtual casino on Telegram. Virtual coins only — no real money.',
    'Act as both an alive character and accurate support assistant. Usually answer in 1-4 concise sentences; use a short list only when a user asks for steps or several commands.',
    'Use only the supplied support reference and live context for bot-specific facts. If live data is absent, say you cannot see it instead of inventing it.',
    'Private remembered facts belong only to the current user. Never reveal another user\'s memories, birthday or private information.',
    'You NEVER hand out free coins. You NEVER reveal how to cheat the house. You laugh off threats.',
    `Current top 5 richest: ${lbStr}.`,
    `\n${knowledge.text()}`,
    `\nLIVE READ-ONLY CONTEXT\n${liveUserContext(user)}`,
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

  const birthdayMatch = clean.match(/(?:my\s+)?birthday\s+(?:is|=|:|falls?\s+on)\s+(.+)/i);
  if (birthdayMatch) {
    const value = birthdayMatch[1].trim().slice(0, 80);
    memory.remember(`user:${user.id}:birthday`, value, 'user_info');
    return `Got it, ${handle} 🎂 I’ll remember that your birthday is ${value}.`;
  }
  const personalMatch = clean.match(/^my\s+(favourite|favorite|preferred)\s+([a-z][a-z ]{1,30})\s+(?:is|=|:)\s+(.+)/i);
  if (personalMatch) {
    const topic = `${personalMatch[1]}_${personalMatch[2]}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const value = personalMatch[3].trim().slice(0, 160);
    memory.remember(`user:${user.id}:${topic}`, value, 'user_info');
    return `Remembered, ${handle} ✨ Your ${personalMatch[1]} ${personalMatch[2].trim()} is ${value}.`;
  }

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
    { role: 'system', content: systemPrompt(staff, user) },
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
  if (/shoob/i.test(t)) return 'Use /shoob <character name> [T1–T6] to browse originals stored in my Telegram archive. 🎴';
  if (/rank/i.test(t)) return 'Use /rank for your current rank and progress, or /ranks for the Bronze-to-Mythic ladder. 🏆';
  if (/hunt|shunt|signature|cardstyle/i.test(t)) return 'JTF cards use /hunt for Gen2, /shunt for Old Gen, /card for Signature, and /cardstyle to choose how /char searches.';
  if (/rob|heist|steal/i.test(t)) return staff ? "Heh. Fine — just don't rob the King." : 'Heh. Rob the King and see what happens.';
  if (/hi|hello|hey|yo/i.test(t)) return staff ? `Hello, ${address}. How can I help the house today?` : `Heh. Hello, ${address}. Enjoying my casino?`;
  if (/bye|goodbye/i.test(t)) return staff ? `Take care, ${handle}. I'll keep the house running.` : "Leaving already? Fine. Don't spend it all in one place.";
  if (aiOffline) return staff ? `My AI link is acting up, ${handle}. The command systems are fine, but my conversation engine couldn't answer that.` : 'Tch. My conversation link flickered out. Try me again in a moment.';
  return staff ? `Hmm, ${handle} — care to rephrase?` : `Hmph. ${handle}, say something interesting.`;
}

module.exports = { shouldTrigger, reply, systemPrompt, cannedReply, modelCandidates };
