'use strict';
const assert = require('assert');
const shoob = require('../src/shoob-cards');

async function run() {
  assert.strictEqual(shoob.normalizeName('  Rimurú—Tempest! '), 'rimuru tempest');
  const docs = [
    { _id: 't2', name: 'Rimuru Tempest', tier: 2, version: 1 },
    { _id: 't5', name: 'Rimuru Tempest', tier: 5, version: 3 },
    { _id: 'wrong', name: 'Rimuru', tier: 5, version: 99 },
  ];
  assert.strictEqual(shoob.exactCandidates(docs, 'RIMURU TEMPEST')[0]._id, 't5');
  assert.strictEqual(shoob.exactCandidates(docs, 'Rimuru Tempest', 2)[0]._id, 't2');
  assert.strictEqual(shoob.exactCandidates(docs, 'Rimuru Tempest', 4).length, 0);

  let request;
  const socketFactory = () => ({
    on(event, listener) {
      if (event === 'connect') setImmediate(listener);
      if (event === 'cardindexres') this.catalogueListener = listener;
      return this;
    },
    emit(event, payload) {
      if (event === 'cardindex') {
        request = { event, payload };
        setImmediate(() => this.catalogueListener({ data: { docs } }));
      }
    },
    close() {},
  });
  const found = await shoob.findExact('Rimuru Tempest', 2, { socketFactory, timeoutMs: 500 });
  assert.strictEqual(found._id, 't2');
  assert.deepStrictEqual(request, {
    event: 'cardindex',
    payload: { page: 1, category: '2', search: 'Rimuru Tempest', series: null },
  });
  console.log('SHOOB CARDS TEST OK');
}

run().catch((error) => { console.error(error); process.exit(1); });
