'use strict';
const assert = require('assert');
const animated = require('../src/animated-card');

assert.strictEqual(animated.DURATION, 6);
assert.strictEqual(animated.WIDTH, 700);
assert.strictEqual(animated.HEIGHT, 900);
assert.strictEqual(animated.FPS, 20);
assert.strictEqual(animated.validateInput(Buffer.from('fake'), { mimeType: 'video/mp4', duration: 6 }), true);
assert.throws(() => animated.validateInput(Buffer.alloc(0), { mimeType: 'video/mp4' }), /empty/i);
assert.throws(() => animated.validateInput(Buffer.from('fake'), { mimeType: 'text/plain' }), /GIF, MP4/i);
assert.throws(() => animated.validateInput(Buffer.from('fake'), { mimeType: 'video/mp4', duration: 9 }), /8 seconds/i);
assert.ok(animated.LAYOUTS.gen2 && animated.LAYOUTS.oldgen && animated.LAYOUTS.signature && animated.LAYOUTS.ai);
assert.strictEqual(animated.BORDERS.length, 4);
assert.strictEqual(animated.cleanSignature('@Caleb🔥 Bj'), '@Caleb Bj');
console.log('ANIMATED CARD TEST OK');
