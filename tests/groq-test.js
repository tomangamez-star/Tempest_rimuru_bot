'use strict';
/**
 * Quick Groq integration test for Rimuru AI.
 * Run: GROQ_API_KEY=gsk_xxx node tests/groq-test.js
 */
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `rimuru-groq-test-${Date.now()}.db`);
process.env.DATA_DIR = os.tmpdir();
process.env.NODE_ENV = 'test';

const config = require('../src/config');
const rimuru = require('../src/rimuru');

(async () => {
  const key = process.env.GROQ_API_KEY || config.groqApiKey;
  if (!key) {
    console.log('SKIP: No GROQ_API_KEY set — test skipped');
    process.exit(0);
  }
  config.groqApiKey = key;

  const r = await rimuru.reply('Rimuru, what games do you have?', {
    id: 12345,
    first_name: 'TestUser',
    username: 'tester',
    isOwner: false,
    isStaff: false,
  });

  console.log('REPLY:', r);

  const isCanned = r.includes('Hmm?') || r.includes('canned') || r.includes('nothing to me');
  if (r && r.length > 10 && !isCanned) {
    console.log('GROQ TEST: PASSED — real AI response received');
    process.exit(0);
  } else {
    console.log('GROQ TEST: WARN — response appears canned or too short');
    process.exit(1);
  }
})().catch((e) => {
  console.error('GROQ TEST ERROR:', e.message);
  process.exit(1);
});
