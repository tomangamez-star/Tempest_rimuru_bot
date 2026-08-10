'use strict';
/**
 * Rimuru Tempest Casino — Blackjack ♣
 * Standard casino rules: dealer stands on 17+, blackjack pays 3:2,
 * double down allowed on first two cards (bet doubled).
 *
 * Callback payload: bj:<userId>:<action>  (hit | stand | double)
 */
const config = require('../config');
const { fmt, shuffle, randInt, esc } = require('../utils');

const sessions = new Map(); // userId -> {bet, deck, player[], dealer[], doubled, done}

function makeDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s);
  return shuffle(deck);
}

function cardValue(card) {
  const r = card.slice(0, -1);
  if (r === 'A') return 11;
  if (['K', 'Q', 'J'].includes(r)) return 10;
  return parseInt(r, 10);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    const v = cardValue(c);
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

function handStr(hand, hideFirst = false) {
  if (hideFirst) return ['🂠', ...hand.slice(1)].join(' ');
  return hand.join(' ');
}

function createSession(userId, bet) {
  const s = { userId, bet, deck: makeDeck(), player: [], dealer: [], doubled: false, done: false };
  s.player.push(s.deck.pop(), s.deck.pop());
  s.dealer.push(s.deck.pop(), s.deck.pop());
  sessions.set(userId, s);
  return s;
}

function render(s) {
  const pv = handValue(s.player);
  const dv = handValue(s.dealer);
  let lines = [
    `♣ <b>BLACKJACK</b> — bet ${fmt(s.bet)}${s.doubled ? ' (doubled)' : ''}`,
    '',
    `Dealer: ${esc(handStr(s.dealer, true))} (${dv === 21 && s.dealer.length === 2 ? 'BJ?' : '?'})`,
    `You: ${esc(handStr(s.player))} — <b>${pv}</b>`,
  ];
  if (s.done) {
    lines[1] = `Dealer: ${esc(handStr(s.dealer))} — <b>${dv}</b>`;
  }
  return lines.join('\n');
}

function keyboard(s) {
  const pv = handValue(s.player);
  const canDouble = !s.doubled && s.player.length === 2 && s.done === false;
  const buttons = [
    { text: '🎯 Hit', callback_data: `bj:${s.userId}:hit` },
    { text: '✋ Stand', callback_data: `bj:${s.userId}:stand` },
  ];
  if (canDouble) buttons.push({ text: '2️⃣ Double', callback_data: `bj:${s.userId}:double` });
  return { inline_keyboard: [buttons] };
}

async function play(ctx) {
  const { bot, msg, args, eco, cd, chatId, userId, reply } = ctx;
  const bet = parseBet(args[0], eco, userId);
  if (bet.error) return reply(bet.error);

  const g = cd.guardGame(userId, 'blackjack', 'Blackjack');
  if (g.blocked) return reply(g.message);

  if (sessions.has(userId)) {
    return reply('⏳ You already have a blackjack game running. Finish it first.');
  }

  const charge = eco.chargeWallet(userId, bet.amount, 'blackjack hand');
  if (!charge.ok) return reply(charge.message);
  cd.startGame(userId, 'blackjack', config.perGameCooldownMs);

  const s = createSession(userId, bet.amount);

  // Immediate blackjack check
  if (isBlackjack(s.player)) {
    s.done = true;
    const payout = Math.floor(bet.amount * config.blackjack.blackjackPayout);
    eco.creditWallet(userId, payout);
    s.payout = payout;
    await reply(`${render(s)}\n\n♣ <b>BLACKJACK!</b> 3:2 — you get ${fmt(payout)} (net +${fmt(payout - bet.amount)})`, { html: true });
    sessions.delete(userId);
    return;
  }

  const sent = await reply(render(s), { html: true, reply_markup: keyboard(s), alwaysShowMarkup: true });
  return { sent, session: s };
}

async function onAction(ctx, { bot, chatId, userId, reply, editMsg, answerCb, eco }) {
  const s = sessions.get(userId);
  if (!s || s.done) {
    await answerCb('No active blackjack game.');
    return;
  }
  const action = ctx.data.split(':')[2];
  let outcome = null;

  if (action === 'hit') {
    s.player.push(s.deck.pop());
    const pv = handValue(s.player);
    if (pv > 21) outcome = 'bust';
    else if (pv === 21) outcome = 'autoStand';
  } else if (action === 'double') {
    // Double down: bet doubled, one card, then dealer plays
    const u = eco.balance(userId);
    if (u.wallet < s.bet) {
      await answerCb(`❌ Not enough wallet for double (need ${fmt(s.bet)}).`);
      return;
    }
    eco.chargeWallet(userId, s.bet, 'double down');
    s.bet *= 2;
    s.doubled = true;
    s.player.push(s.deck.pop());
    if (handValue(s.player) > 21) outcome = 'bust';
    else outcome = 'stand';
  } else if (action === 'stand') {
    outcome = 'stand';
  }

  if (outcome === 'bust') {
    s.done = true;
    const text = `${render(s)}\n\n💥 <b>BUST!</b> You lost ${fmt(s.bet)}.`;
    await editMsg(text, { parse_mode: 'HTML' });
    await answerCb('💥 Bust!');
    sessions.delete(userId);
    return;
  }

  if (outcome === 'autoStand' || outcome === 'stand') {
    // Dealer plays
    while (handValue(s.dealer) < 17) s.dealer.push(s.deck.pop());
    const pv = handValue(s.player);
    const dv = handValue(s.dealer);
    s.done = true;
    let result;
    let payout = 0;
    if (dv > 21 || pv > dv) {
      result = 'win';
      payout = s.bet * 2;
    } else if (pv === dv) {
      result = 'push';
      payout = s.bet; // return bet
    } else {
      result = 'lose';
    }
    if (payout > 0) eco.creditWallet(userId, payout);
    s.payout = payout;
    const emoji = result === 'win' ? '✅ <b>YOU WIN!</b>' : result === 'push' ? '🤝 <b>PUSH</b>' : '❌ <b>DEALER WINS</b>';
    const net = result === 'win' ? `+${fmt(payout - s.bet)}` : result === 'push' ? '0' : `-${fmt(s.bet)}`;
    const text = `${render(s)}\n\n${emoji} (${net})`;
    await editMsg(text, { parse_mode: 'HTML' });
    await answerCb(result === 'win' ? '✅ Win!' : result === 'push' ? '🤝 Push' : '❌ Lost');
    sessions.delete(userId);
    return;
  }

  // Still playing — update board
  // alwaysShowMarkup: Hit/Stand/Double are GAMEPLAY buttons — they must
  // render even when SHOW_INLINE_BUTTONS=false (fixes "no button to press").
  await editMsg(render(s), { parse_mode: 'HTML', reply_markup: keyboard(s), alwaysShowMarkup: true });
  await answerCb('🎯 Dealt.');
}

function parseBet(raw, eco, userId) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  if (!raw || !Number.isFinite(n) || n <= 0) {
    return { error: '🎩 Usage: `/bj [amount]` — e.g. `/bj 10000`' };
  }
  return { amount: Math.floor(n) };
}

module.exports = { play, onAction, createSession, handValue, isBlackjack, sessions };