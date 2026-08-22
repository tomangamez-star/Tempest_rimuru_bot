'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WIDTH = 700;
const HEIGHT = 900;
const FPS = 24;
const DURATION = 6;
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 19 * 1024 * 1024;

const STYLE = {
  gen2: { color: '66D9FF', second: 'FFFFFF', speed: 34, label: 'GEN 2 MOTION' },
  oldgen: { color: 'FF6A00', second: 'FFD34E', speed: 48, label: 'OLD GEN MOTION' },
  signature: { color: 'D26BFF', second: '73E7FF', speed: 40, label: 'JTF SIGNATURE MOTION' },
  ai: { color: 'FF4FD8', second: '68F7FF', speed: 56, label: 'AI CUSTOM MOTION' },
};

function ffmpegPath() {
  try { return require('ffmpeg-static'); }
  catch (_) { throw new Error('ffmpeg-static is not installed'); }
}

function run(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('animation rendering timed out'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.split('\n').slice(-4).join(' ').trim()}`));
    });
  });
}

function extFor(mime = '') {
  const value = String(mime).toLowerCase();
  if (value.includes('gif')) return '.gif';
  if (value.includes('webm')) return '.webm';
  return '.mp4';
}

function validateInput(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The animation file is empty');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('Animation must be 15 MB or smaller');
  const duration = Number(meta.duration) || 0;
  if (duration > 8.5) throw new Error('Animation must be 8 seconds or shorter');
  const mime = String(meta.mimeType || '').toLowerCase();
  if (mime && !/(gif|video|mp4|webm|quicktime)/.test(mime)) throw new Error('Send a GIF, MP4, MOV, or WEBM animation');
  return true;
}

async function workspace(mediaBuffer, mimeType) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rimuru-motion-'));
  const input = path.join(dir, `input${extFor(mimeType)}`);
  await fs.promises.writeFile(input, mediaBuffer);
  return { dir, input };
}

async function extractPoster(mediaBuffer, meta = {}) {
  validateInput(mediaBuffer, meta);
  const temp = await workspace(mediaBuffer, meta.mimeType);
  const poster = path.join(temp.dir, 'poster.png');
  try {
    await run([
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.10', '-i', temp.input,
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`,
      '-frames:v', '1', poster,
    ], 30000);
    return await fs.promises.readFile(poster);
  } finally { await fs.promises.rm(temp.dir, { recursive: true, force: true }); }
}

function effectFilter(renderer) {
  const s = STYLE[renderer] || STYLE.gen2;
  const star = (size, x, y, phase, alpha) =>
    `drawtext=text='*':fontsize=${size}:fontcolor=white@${alpha}:x='mod(${x}+t*${s.speed},w+40)-20':y='${y}+${phase}*sin(t*1.4)'`;
  return [
    `drawbox=x=7:y=7:w=${WIDTH - 14}:h=${HEIGHT - 14}:color=0x${s.color}@0.72:t=5`,
    `drawbox=x=15:y=15:w=${WIDTH - 30}:h=${HEIGHT - 30}:color=0x${s.second}@0.35:t=2`,
    star(24, 20, 90, 16, 0.82),
    star(17, 170, 240, 24, 0.70),
    star(28, 340, 460, 18, 0.76),
    star(15, 510, 690, 28, 0.68),
    `drawtext=text='${s.label}':fontsize=14:fontcolor=0x${s.second}@0.58:x=w-tw-24:y=24+6*sin(t*2)`,
    'vignette=PI/5',
  ].join(',');
}

async function render(options = {}) {
  const mediaBuffer = options.mediaBuffer;
  const staticBuffer = options.staticBuffer;
  const meta = { mimeType: options.mimeType, duration: options.duration };
  validateInput(mediaBuffer, meta);
  if (!Buffer.isBuffer(staticBuffer) || !staticBuffer.length) throw new Error('Static card base is missing');
  const temp = await workspace(mediaBuffer, options.mimeType);
  const staticPath = path.join(temp.dir, 'card.png');
  const output = path.join(temp.dir, 'animated-card.mp4');
  await fs.promises.writeFile(staticPath, staticBuffer);
  const effects = effectFilter(options.renderer);
  try {
    const filter = [
      `[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=rgba[motion]`,
      `[1:v]scale=${WIDTH}:${HEIGHT},format=rgba,colorchannelmixer=aa=0.80[card]`,
      `[motion][card]overlay=0:0:shortest=0,${effects},format=yuv420p[out]`,
    ].join(';');
    await run([
      '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', temp.input,
      '-loop', '1', '-i', staticPath,
      '-filter_complex', filter, '-map', '[out]', '-an', '-t', String(DURATION),
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-movflags', '+faststart', output,
    ]);
    const buffer = await fs.promises.readFile(output);
    if (!buffer.length) throw new Error('FFmpeg produced an empty animation');
    if (buffer.length > MAX_OUTPUT_BYTES) throw new Error('Animated card exceeded Telegram-safe size');
    return { buffer, contentType: 'video/mp4', duration: DURATION, width: WIDTH, height: HEIGHT };
  } finally { await fs.promises.rm(temp.dir, { recursive: true, force: true }); }
}

module.exports = {
  WIDTH, HEIGHT, FPS, DURATION, MAX_INPUT_BYTES, STYLE,
  validateInput, extractPoster, render, _run: run,
};
