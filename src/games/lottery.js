'use strict';
/**
 * Rimuru Tempest Casino — Lottery 🎟️
 * Ticket = 10,000 coins. Users can buy multiple tickets (better odds, not guaranteed).
 * Needs 5 buyers for a draw. Base jackpot 5,000,000; grows with tickets sold.
 * Winner takes the pot. Winner picked weighted by tickets held.
 */
const config = require('../config');
const db = require('../db');
const { fmt, esc } = require('../utils');

/**
 * Buy tickets.
 * @returns {ok, message, pot, buyers, ticketCount}
 */
function buy(userId, count, meta = {}) {
  const countN = Math.floor(Number(count) || 1);
  if (!Number.isFinite(countN) || countN < 1) {
    return { ok: false, message: '🎩 Usage: `/lottery buy [tickets]` — e.g. `/lottery buy 3`' };
  }
  const u = db.getOrCreateUser(userId, meta);
  const cost = config.lottery.ticketPrice * countN;
  if (u.wallet < cost) {
    return { ok: false, message: `❌ ${countN} ticket(s) cost ${fmt(cost)} — your wallet has ${fmt(u.wallet)}.` };
  }

  const lot = db.getLottery();
  const tickets = lot.tickets;
  const existing = tickets.find((t) => t.user_id === userId);
  if (existing) existing.count += countN;
  else tickets.push({ user_id: userId, name: meta.first_name || meta.username || String(userId), count: countN });

  const newPot = lot.pot + cost;
  const newCount = lot.ticket_count + countN;
  db.addWallet(userId, -cost);
  db.saveLottery(newPot, newCount, tickets);

  const buyerCount = tickets.length;
  const msg =
    `🎟️ **TICKET BOUGHT!** ${countN}× (${fmt(cost)})\n\n` +
    `📊 Pot: **${fmt(newPot)}** | Tickets in draw: ${newCount} | Buyers: ${buyerCount}/${config.lottery.minBuyers}\n` +
    (buyerCount >= config.lottery.minBuyers
      ? `\n✅ **Enough buyers!** The draw happens on the next ticket purchase, or with \`/lottery draw\`.`
      : `\n⏳ Need ${config.lottery.minBuyers - buyerCount} more buyer(s) for the draw.`);

  return { ok: true, message: msg, pot: newPot, buyers: buyerCount, ticketCount: newCount };
}

/**
 * Run the draw. Only possible with >= minBuyers buyers.
 * Winner weighted by ticket count. Pot fully awarded to winner (house takes nothing).
 */
function draw() {
  const lot = db.getLottery();
  if (lot.tickets.length < config.lottery.minBuyers) {
    return {
      ok: false,
      message: `⏳ Only ${lot.tickets.length}/${config.lottery.minBuyers} buyers — not enough for a draw yet.`,
    };
  }

  // Weighted pick by ticket count
  const total = lot.tickets.reduce((s, t) => s + t.count, 0);
  let r = Math.floor(Math.random() * total);
  let winner = lot.tickets[0];
  for (const t of lot.tickets) {
    r -= t.count;
    if (r < 0) { winner = t; break; }
  }

  const pot = lot.pot;
  db.addWallet(winner.user_id, pot);
  db.saveLottery(config.lottery.baseJackpot, 0, []);

  return {
    ok: true,
    winner,
    pot,
    message:
      `🎉 <b>LOTTERY DRAW!</b>\n\n` +
      `🏆 Winner: <a href="tg://user?id=${winner.user_id}">${esc(winner.name, false)}</a>\n` +
      `💰 Prize: <b>${fmt(pot)}</b>\n\n` +
      `The jackpot resets to ${fmt(config.lottery.baseJackpot)} for the next round. 🎟️ /lottery`,
  };
}

/** Status of the current lottery. */
function status() {
  const lot = db.getLottery();
  return (
    `🎟️ **LOTTERY**\n\n` +
    `Pot: **${fmt(lot.pot)}**\n` +
    `Tickets: ${lot.ticket_count} | Buyers: ${lot.tickets.length}/${config.lottery.minBuyers}\n` +
    `Ticket price: ${fmt(config.lottery.ticketPrice)}\n\n` +
    (lot.tickets.length
      ? `Buyers:\n${lot.tickets.map((t) => `• ${t.name} — ${t.count} ticket(s)`).join('\n')}`
      : 'No tickets yet — be the first! 🎟️')
  );
}

module.exports = { buy, draw, status };