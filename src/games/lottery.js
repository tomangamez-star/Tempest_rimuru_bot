'use strict';
const config = require('../config');
const db = require('../db');
const { fmt, esc } = require('../utils');

function buy(userId, count = 1, meta = {}) {
  const countN = Math.max(1, Math.min(1000, Math.floor(Number(count) || 1)));
  const u = db.getOrCreateUser(userId, meta);
  const cost = config.lottery.ticketPrice * countN;
  if (Number(u.wallet) < cost) return { ok: false, message: `❌ ${countN} ticket(s) cost <b>${fmt(cost)}</b> — your wallet has <b>${fmt(u.wallet)}</b>.` };
  const lot = db.getLottery();
  const tickets = Array.isArray(lot.tickets) ? lot.tickets : [];
  const existing = tickets.find((t) => Number(t.user_id) === Number(userId));
  if (existing) existing.count = (Number(existing.count) || 0) + countN;
  else tickets.push({ user_id: Number(userId), name: meta.first_name || meta.username || String(userId), count: countN });
  const newPot = Number(lot.pot) + cost;
  const newCount = Number(lot.ticket_count) + countN;
  db.addWallet(userId, -cost);
  db.saveLottery(newPot, newCount, tickets);
  return { ok: true, pot: newPot, buyers: tickets.length, ticketCount: newCount, count: countN, cost };
}

function draw() {
  const lot = db.getLottery();
  const tickets = Array.isArray(lot.tickets) ? lot.tickets : [];
  if (tickets.length < config.lottery.minBuyers) return { ok: false, message: `⏳ Only <b>${tickets.length}/${config.lottery.minBuyers}</b> unique buyers — not enough for a draw yet.` };
  const total = tickets.reduce((sum, t) => sum + Math.max(0, Number(t.count) || 0), 0);
  if (!total) return { ok: false, message: '🎟️ No valid tickets are in the draw.' };
  let roll = Math.floor(Math.random() * total);
  let winner = tickets[0];
  for (const t of tickets) { roll -= Number(t.count) || 0; if (roll < 0) { winner = t; break; } }
  const pot = Number(lot.pot) || config.lottery.baseJackpot;
  db.getOrCreateUser(Number(winner.user_id), { first_name: winner.name || '' });
  db.addWallet(Number(winner.user_id), pot);
  db.saveLottery(config.lottery.baseJackpot, 0, []);
  return { ok: true, winner, pot, message: `🎉 <b>LOTTERY DRAW!</b>\n\n🏆 Winner: <a href="tg://user?id=${winner.user_id}">${esc(winner.name || String(winner.user_id), false)}</a>\n🎫 Winning tickets: <b>${Number(winner.count) || 1}/${total}</b>\n💰 Prize: <b>${fmt(pot)}</b>\n\nThe jackpot resets to <b>${fmt(config.lottery.baseJackpot)}</b>.` };
}

function status() {
  const lot = db.getLottery();
  const tickets = Array.isArray(lot.tickets) ? lot.tickets : [];
  return `🎟️ <b>JTF LOTTERY</b>\n\n💰 Pot: <b>${fmt(lot.pot)}</b>\n🎫 Tickets: <b>${lot.ticket_count}</b>\n👥 Buyers: <b>${tickets.length}/${config.lottery.minBuyers}</b>\n💵 Ticket price: <b>${fmt(config.lottery.ticketPrice)}</b>\n\nEvery extra ticket improves your odds, but nothing is guaranteed.`;
}

async function play(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const first = String(args[0] || '').toLowerCase();
  if (first === 'status') return ctx.reply(status(), { title: '🎟️ LOTTERY', html: true });
  if (first === 'draw') {
    const r = draw();
    return ctx.reply(r.message, { title: '🎟️ LOTTERY', html: true });
  }
  const count = first === 'buy' ? args[1] : (first && /^\d+$/.test(first) ? first : 1);
  const from = ctx.msg && ctx.msg.from || {};
  const r = buy(ctx.userId, count, { username: from.username || '', first_name: from.first_name || '' });
  if (!r.ok) return ctx.reply(r.message, { title: '🎟️ LOTTERY', html: true });
  let msg = `🎟️ <b>TICKET${r.count === 1 ? '' : 'S'} BOUGHT!</b>\n\nYou bought <b>${r.count}</b> for <b>${fmt(r.cost)}</b>.\n💰 Pot: <b>${fmt(r.pot)}</b>\n🎫 Tickets: <b>${r.ticketCount}</b>\n👥 Buyers: <b>${r.buyers}/${config.lottery.minBuyers}</b>`;
  if (r.buyers >= config.lottery.minBuyers) {
    const d = draw();
    msg += `\n\n${d.message}`;
  } else msg += `\n\n⏳ ${config.lottery.minBuyers - r.buyers} more unique buyer(s) needed.`;
  return ctx.reply(msg, { title: '🎟️ LOTTERY', html: true });
}

module.exports = { buy, draw, status, play };
