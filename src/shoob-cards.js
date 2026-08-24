'use strict';
const crypto = require('crypto');
const db = require('./db');
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();

function normalizeName(value) { return db.normalizeShoobSearch(value); }
function tierOf(card) { const m = String(card && card.tier || '').match(/[1-6]/); return m ? Number(m[0]) : 0; }
function cardIdOf(card) { const m = String(card && card.source_url || '').match(/\/cards\/info\/([^/?#]+)/i); return m ? m[1] : String(card && card.telegram_message_id || 'archive'); }
function seriesOf(card) { return String(card && card.series || '').trim(); }
function parseQuery(input) {
  let query = String(input || '').trim(), tier = 0;
  const match = query.match(/(?:^|\s)t([1-6])\s*$/i);
  if (match) { tier = Number(match[1]); query = query.slice(0, match.index).trim(); }
  return { query, tier };
}
function exactCandidates(docs, name, requestedTier = 0) {
  const wanted = normalizeName(name);
  return (Array.isArray(docs) ? docs : []).filter((c) => normalizeName(c.name) === wanted)
    .filter((c) => !requestedTier || tierOf(c) === Number(requestedTier)).sort((a, b) => tierOf(b) - tierOf(a));
}
async function findMatches(name, requestedTier = 0, options = {}) { return db.searchShoobCards(name, requestedTier, options.limit || 24, options.offset || 0); }
async function findExact(name, requestedTier = 0) {
  const result = await findMatches(name, requestedTier, { limit: 24 });
  return exactCandidates(result.rows, name, requestedTier)[0] || result.rows[0] || null;
}
function compactNumber(value) { return Number(value || 0).toLocaleString('en-US'); }
function duration(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (!seconds) return 'calculating';
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), mins = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', mins || (!days && !hours) ? `${mins}m` : ''].filter(Boolean).join(' ');
}
function dateText(value) { if (!value) return 'Never'; const d = new Date(value); return Number.isNaN(d.getTime()) ? 'Unknown' : d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
async function catalogueDashboard() {
  let s;
  try { s = await db.shoobCatalogueStats(); }
  catch (e) {
    console.error('[cstats] catalogue query:', e.message);
    return '⚠️ The Shoob catalogue database is busy right now. No cards were lost—try /cstats again shortly.';
  }
  if (s.unavailable) return '⚠️ Postgres is unavailable, so catalogue statistics cannot be read.';
  const totalPages = s.total_pages || 2404, completedPage = s.last_completed_page || 0;
  const remainingPages = Math.max(0, totalPages - completedPage);
  const avgPerPage = completedPage > 0 ? s.total / completedPage : 0;
  const remainingCards = Math.round(remainingPages * avgPerPage);
  const perMinute = s.elapsed_seconds > 0 ? s.cards_archived_latest / (s.elapsed_seconds / 60) : 0;
  const etaSeconds = perMinute > 0 ? (remainingCards / perMinute) * 60 : 0;
  const statusMap = { running: '🟢 RUNNING', waiting: '🟡 WAITING', completed: '✅ COMPLETED', stalled: '🔴 STALLED', new: '⚪ NEW' };
  const status = statusMap[String(s.status || '').toLowerCase()] || `⚪ ${String(s.status || 'UNKNOWN').toUpperCase()}`;
  return [
    '🎴 SHOOB CATALOGUE — LIVE',
    '',
    `📚 Archived cards: ${compactNumber(s.total)}`,
    `👤 Unique characters: ${compactNumber(s.characters)}`,
    `🎬 Anime series: ${compactNumber(s.series)}`,
    '',
    `🖼 Photos: ${compactNumber(s.photos)}`,
    `✨ GIFs: ${compactNumber(s.animations)}`,
    `🎞 Videos: ${compactNumber(s.videos)}`,
    `📦 Other files: ${compactNumber(s.documents)}`,
    '',
    `⭐ T1 ${compactNumber(s.t1)} • T2 ${compactNumber(s.t2)} • T3 ${compactNumber(s.t3)}`,
    `⭐ T4 ${compactNumber(s.t4)} • T5 ${compactNumber(s.t5)} • T6 ${compactNumber(s.t6)}`,
    '',
    `⚙️ Scraper: ${status}`,
    `📄 Gallery progress: ${compactNumber(completedPage)}/${compactNumber(totalPages)} pages`,
    `📍 Current/next page: ${compactNumber(s.current_page || s.next_page || 1)}/${compactNumber(s.next_page || 1)}`,
    `🆕 Latest run: +${compactNumber(s.cards_archived_latest)} archived • ${compactNumber(s.cards_skipped_latest)} skipped • ${compactNumber(s.cards_failed_latest)} failed`,
    `✅ Pages completed this run: ${compactNumber(s.pages_completed_latest)}`,
    `⏱ Archive rate: ${perMinute ? perMinute.toFixed(2) : '0.00'} cards/min`,
    `⚡ Throughput: ${perMinute ? (perMinute / 60).toFixed(3) : '0.000'} cards/sec`,
    `🧮 Estimated remaining: ${avgPerPage ? `≈${compactNumber(remainingCards)} cards` : 'calculating'}`,
    `🏁 Estimated completion: ${etaSeconds ? duration(etaSeconds) : 'calculating'}`,
    '',
    `🌐 Shoob page response: ${Math.round(s.gallery_avg_ms || 0)} ms`,
    `✈️ Telegram upload: ${Math.round(s.telegram_avg_ms || 0)} ms`,
    `🐘 Postgres write: ${Math.round(s.postgres_avg_ms || 0)} ms`,
    `🔎 Dashboard query: ${Math.round(s.query_ms || 0)} ms`,
    `🕒 Last successful archive: ${dateText(s.last_success_at)}`,
    s.last_error ? `⚠️ Last error: ${String(s.last_error).slice(0, 240)}` : '',
  ].join('\n').trim();
}
function caption(card, index = 0, total = 1) {
  const position = total > 1 ? `\n📚 Result ${index + 1}/${total}` : '';
  return [`🎴 ${card.name}`, card.series ? `🎬 ${card.series}` : '', `⭐ T${tierOf(card) || '?'} SHOOB ORIGINAL`, `🆔 Shoob Card: ${cardIdOf(card)}${position}`].filter(Boolean).join('\n');
}
function inputMediaType(card) { const type = String(card.telegram_media_type || 'photo').toLowerCase(); return ['photo', 'video', 'animation', 'document'].includes(type) ? type : 'photo'; }
function buttons(sessionId, index, total) {
  if (!sessionId || total <= 1) return undefined;
  const row = [];
  if (index > 0) row.push({ text: '⬅️ Previous', callback_data: `shoob:${sessionId}:${index - 1}` });
  row.push({ text: `${index + 1}/${total}`, callback_data: `shoob:${sessionId}:same` });
  if (index + 1 < total) row.push({ text: 'Next ➡️', callback_data: `shoob:${sessionId}:${index + 1}` });
  return { inline_keyboard: [row] };
}
async function sendArchived(bot, chatId, card, options = {}) {
  if (!card || !card.telegram_file_id) throw new Error('Shoob archive record has no Telegram file_id');
  const type = inputMediaType(card);
  const opts = { caption: caption(card, options.index || 0, options.total || 1), reply_markup: buttons(options.sessionId, options.index || 0, options.total || 1) };
  if (type === 'video') return bot.sendVideo(chatId, card.telegram_file_id, opts);
  if (type === 'animation') return bot.sendAnimation(chatId, card.telegram_file_id, opts);
  if (type === 'document') return bot.sendDocument(chatId, card.telegram_file_id, opts);
  return bot.sendPhoto(chatId, card.telegram_file_id, opts);
}
function sweepSessions() { const now = Date.now(); for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id); }
async function startSearch(bot, chatId, userId, rawQuery) {
  sweepSessions();
  const parsed = parseQuery(rawQuery);
  if (!parsed.query) return { ok: false, message: 'Usage: /shoob &lt;character name&gt; [T1–T6]' };
  let result;
  try { result = await findMatches(parsed.query, parsed.tier, { limit: 24 }); }
  catch (e) {
    console.error('[shoob] catalogue search:', e.message);
    return { ok: false, message: 'The Shoob catalogue database is busy right now. No cards were lost—try again shortly.' };
  }
  if (result.unavailable) return { ok: false, message: 'The Shoob archive needs Postgres to be connected.' };
  if (!result.rows.length) return { ok: false, message: `No archived Shoob cards found for ${parsed.query}${parsed.tier ? ` at T${parsed.tier}` : ''}. The catalogue may still be ingesting.` };
  const id = crypto.randomBytes(4).toString('hex');
  const session = { id, userId: Number(userId), rows: result.rows, total: result.rows.length, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(id, session);
  await sendArchived(bot, chatId, session.rows[0], { sessionId: id, index: 0, total: session.total });
  return { ok: true, total: result.total };
}
async function handleNavigation(bot, query) {
  const parts = String(query.data || '').split(':');
  if (parts[0] !== 'shoob') return false;
  const session = sessions.get(parts[1]);
  if (!session || session.expiresAt <= Date.now()) { sessions.delete(parts[1]); await bot.answerCallbackQuery(query.id, { text: 'This Shoob search expired. Run /shoob again.', show_alert: true }).catch(() => {}); return true; }
  if (Number(query.from && query.from.id) !== session.userId) { await bot.answerCallbackQuery(query.id, { text: 'Only the search owner can browse these cards.' }).catch(() => {}); return true; }
  if (parts[2] === 'same') { await bot.answerCallbackQuery(query.id, { text: `${session.total} archived matches` }).catch(() => {}); return true; }
  const index = Math.max(0, Math.min(session.total - 1, Number(parts[2]) || 0));
  const card = session.rows[index];
  try {
    await bot.editMessageMedia({ type: inputMediaType(card), media: card.telegram_file_id, caption: caption(card, index, session.total) }, { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: buttons(session.id, index, session.total) });
  } catch (_) { await sendArchived(bot, query.message.chat.id, card, { sessionId: session.id, index, total: session.total }); }
  await bot.answerCallbackQuery(query.id).catch(() => {});
  return true;
}

module.exports = { normalizeName, tierOf, cardIdOf, seriesOf, parseQuery, exactCandidates, findMatches, findExact, catalogueDashboard, caption, inputMediaType, sendArchived, startSearch, handleNavigation, _sessions: sessions };
