'use strict';
const assert = require('assert');
const animated = require('../src/animated-card');

assert.strictEqual(animated.DURATION, 6);
assert.strictEqual(animated.WIDTH, 700);
assert.strictEqual(animated.HEIGHT, 900);
assert.strictEqual(animated.validateInput(Buffer.from('fake'), { mimeType: 'video/mp4', duration: 6 }), true);
assert.throws(() => animated.validateInput(Buffer.alloc(0), { mimeType: 'video/mp4' }), /empty/i);
assert.throws(() => animated.validateInput(Buffer.from('fake'), { mimeType: 'text/plain' }), /GIF, MP4/i);
assert.throws(() => animated.validateInput(Buffer.from('fake'), { mimeType: 'video/mp4', duration: 9 }), /8 seconds/i);
assert.ok(animated.STYLE.gen2 && animated.STYLE.oldgen && animated.STYLE.signature && animated.STYLE.ai);
console.log('ANIMATED CARD TEST OK');
