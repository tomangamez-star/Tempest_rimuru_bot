'use strict';
const assert = require('assert');
const Module = require('module');

async function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body ? JSON.stringify(body) : '' };
}

async function run() {
  const config = { githubActions: { token: 'test-token', repository: 'owner/repo', workflow: 'shoob-archive.yml', ref: 'main' } };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './config' && parent && /shoob-workflow\.js$/.test(parent.filename)) return config;
    return originalLoad.call(this, request, parent, isMain);
  };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, { workflow_runs: [{ status: 'in_progress', run_number: 9, html_url: 'https://example/run/9' }] });
  };
  delete require.cache[require.resolve('../src/shoob-workflow')];
  const workflow = require('../src/shoob-workflow');
  const active = await workflow.forceStart();
  assert.strictEqual(active.alreadyActive, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('/actions/workflows/shoob-archive.yml/runs'));

  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if ((options.method || 'GET') === 'POST') return response(204, null);
    return response(200, { workflow_runs: [] });
  };
  const started = await workflow.forceStart();
  assert.strictEqual(started.started, true);
  assert.strictEqual(calls.at(-1).options.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls.at(-1).options.body), { ref: 'main' });
  Module._load = originalLoad;
  console.log('SHOOB WORKFLOW TEST OK');
}

run().catch((error) => { console.error(error); process.exit(1); });
