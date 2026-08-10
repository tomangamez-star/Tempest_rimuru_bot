'use strict';
// Functional check: gameplay inline buttons must survive gatedOpts when
// alwaysShowMarkup:true, and be stripped otherwise (SHOW_INLINE_BUTTONS=false).
process.env.DB_PATH = '/tmp/rimuru-func.db';
process.env.DATA_DIR = '/tmp';
process.env.NODE_ENV = 'test';
const assert = require('assert');
const send = require('../src/send');

const bjKb = { inline_keyboard: [[{ text: '🎯 Hit', callback_data: 'bj:1:hit' }, { text: '✋ Stand', callback_data: 'bj:1:stand' }]] };
const hlKb = { inline_keyboard: [[{ text: '⬆️ Higher', callback_data: 'hl:1:high' }]] };

// with alwaysShowMarkup -> kept
assert.ok(send.gatedOpts({ reply_markup: bjKb, alwaysShowMarkup: true }).reply_markup, 'bj buttons must render');
assert.ok(send.gatedOpts({ reply_markup: hlKb, alwaysShowMarkup: true }).reply_markup, 'hl buttons must render');
// control: without alwaysShowMarkup -> stripped (gate works for non-gameplay)
assert.ok(!send.gatedOpts({ reply_markup: bjKb }).reply_markup, 'non-gameplay buttons still gated');

console.log('✅ blackjack buttons render');
console.log('✅ higherlower buttons render');
console.log('✅ non-gameplay buttons still gated');
console.log('ALL BUTTON CHECKS PASSED ✅');
