'use strict';
const assert = require('assert');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
for (const file of ['hunt-card.js', 'special-hunt-card.js', 'jtf-gen-card.js', 'ai-template-card.js']) {
  require.cache[path.join(src, file)] = { id: file, filename: file, loaded: true, exports: { render: async () => ({ buffer: Buffer.from('png') }) } };
}
require.cache[path.join(src, 'custom-cards.js')] = {
  id: 'custom-cards', filename: 'custom-cards', loaded: true,
  exports: { count: () => 0, mark: () => 1, upload: async () => 'x.png', save: (v) => v, newId: () => 'JTFTEST' },
};

const crender = require('../src/crender');
const replies = [];
let invoice = null;
let checkout = null;
const bot = {
  getFileLink: async () => 'https://telegram.invalid/file',
  sendInvoice: async (...args) => { invoice = args; return {}; },
  answerPreCheckoutQuery: async (...args) => { checkout = args; },
};
const deps = { bot, reply: async (_chat, text) => { replies.push(text); }, eco: {}, db: {} };
const originalFetch = global.fetch;
global.fetch = async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });

async function send(text, extra = {}) {
  return crender.handleMessage({ chat: { id: 10 }, from: { id: 20 }, text, ...extra }, deps);
}

(async () => {
  await crender.start({ chatId: 10, userId: 20, isStaff: false, reply: deps.reply });
  await send('5');
  assert.strictEqual(crender._sessions.get('10:20').renderer, 'animation');
  assert.strictEqual(crender._sessions.get('10:20').tier, 6);
  await send('Goku');
  await send('Dragon Ball');
  await send('skip');
  await send('skip');
  assert.strictEqual(crender._sessions.get('10:20').step, 'signature');
  await send('@PremiumOwner');
  await send('', { animation: { file_id: 'motion', mime_type: 'video/mp4', duration: 6, file_size: 3 } });
  await send('confirm');
  assert.ok(invoice, 'Telegram Stars invoice was not sent');
  assert.strictEqual(invoice[5], 'XTR');
  assert.deepStrictEqual(invoice[6], [{ label: 'T6 Premium Motion Render', amount: 10 }]);
  const session = crender._sessions.get('10:20');
  assert.strictEqual(session.step, 'awaiting_payment');
  await crender.handlePreCheckout({ id: 'pc1', from: { id: 20 }, invoice_payload: session.invoicePayload, currency: 'XTR', total_amount: 10 }, deps);
  assert.strictEqual(checkout[1], true);
  crender.cancel(10, 20);
  console.log('CRENDER PREMIUM TEST OK');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
