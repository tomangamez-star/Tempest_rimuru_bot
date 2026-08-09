'use strict';
/* Functional check: note() output is valid Telegram HTML with a non-empty blockquote. */
const { note, esc, sanitizeHtml } = require('../src/utils');

const plain = note('💰 BALANCE', esc('Wallet: 1,000,000 <b>bold</b> **really**', false));
const game = note('💎 MINES', sanitizeHtml('<b>MINES</b> — bet 5,000\n💙 💙 💙 💙 💙\nSafe picks: 0/22 | Next: <b>1.25x</b>'), { html: true });
const rimuruReply = note('🐉 RIMURU', esc('Heh. Welcome master, enjoy the casino.', false));

function check(label, s) {
  const hasBq = s.startsWith('<blockquote>') && s.includes('</blockquote>');
  const nonEmpty = s.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim().length > 0;
  const noSpan = !/<span/i.test(s);
  const noAttr = !/<[a-z]+\s+[a-z]+=/i.test(s);
  console.log(label, '| blockquote:', hasBq, '| non-empty:', nonEmpty, '| no-span:', noSpan, '| no-attr:', noAttr);
  console.log('   →', JSON.stringify(s.slice(0, 120)));
}

check('PLAIN', plain);
check('GAME-HTML', game);
check('RIMURU', rimuruReply);

process.env.SHOW_INLINE_BUTTONS = 'false';
const send = require('../src/send');
console.log('inlineMarkup(flag=false):', send.inlineMarkup({ inline_keyboard: [[]] }));
process.env.SHOW_INLINE_BUTTONS = 'true';
delete require.cache[require.resolve('../src/config')];
const send2 = require('../src/send');
console.log('inlineMarkup(flag=true):', JSON.stringify(send2.inlineMarkup({ inline_keyboard: [[{ text: 'X', callback_data: 'y' }]] })));
