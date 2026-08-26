'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WIDTH = 700, HEIGHT = 900, FPS = 20, DURATION = 6;
const MAX_INPUT_BYTES = 15 * 1024 * 1024, MAX_OUTPUT_BYTES = 19 * 1024 * 1024;
const BORDER_DIR = path.join(__dirname, 'assets', 'motion-borders');
const BORDERS = [
  { key: 'cyber-blue', file: 'cyber-blue.mp4', primary: '#54D8FF', secondary: '#D8FAFF', hue: 205 },
  { key: 'cyber-red', file: 'cyber-red.mp4', primary: '#FF304C', secondary: '#FFB04A', hue: 355 },
  { key: 'electric-green', file: 'electric-green.mp4', primary: '#64FF32', secondary: '#E1FF69', hue: 112 },
  { key: 'neon-purple', file: 'neon-purple.mp4', primary: '#E238FF', secondary: '#5AE7FF', hue: 292 },
];

function ffmpegPath() { try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } }
function sharp() { try { return require('sharp'); } catch (_) { throw new Error('sharp is not installed'); } }
function run(args, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('animation rendering timed out')); }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr.split('\n').slice(-8).join(' ').trim()}`));
    });
  });
}
function extFor(mime = '') {
  const value = String(mime).toLowerCase();
  if (value.includes('gif')) return '.gif';
  if (value.includes('webm')) return '.webm';
  if (value.includes('quicktime')) return '.mov';
  return '.mp4';
}
function validateInput(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The animation file is empty');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('Animation must be 15 MB or smaller');
  if ((Number(meta.duration) || 0) > 8.5) throw new Error('Animation must be 8 seconds or shorter');
  const mime = String(meta.mimeType || '').toLowerCase();
  if (mime && !/(gif|video|mp4|webm|quicktime)/.test(mime)) throw new Error('Send a GIF, MP4, MOV, or WEBM animation');
  return true;
}
async function workspace(buffer, mime) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jtf-animation-'));
  const input = path.join(dir, `input${extFor(mime)}`);
  await fs.promises.writeFile(input, buffer);
  return { dir, input };
}
async function extractPoster(buffer, meta = {}) {
  validateInput(buffer, meta);
  const temp = await workspace(buffer, meta.mimeType), output = path.join(temp.dir, 'poster.png');
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.10', '-i', temp.input,
      '-vf', 'scale=700:900:force_original_aspect_ratio=decrease', '-frames:v', '1', output], 30000);
    return await fs.promises.readFile(output);
  } finally { await fs.promises.rm(temp.dir, { recursive: true, force: true }); }
}
function rgbHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}
function hueDistance(a, b) { const d = Math.abs(a - b); return Math.min(d, 360 - d); }
async function chooseBorderByArtwork(poster) {
  const { data } = await sharp()(poster).resize(72, 72, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scores = new Array(BORDERS.length).fill(0);
  for (let i = 0; i < data.length; i += 3) {
    const color = rgbHsv(data[i], data[i + 1], data[i + 2]);
    if (color.s < .24 || color.v < .16 || color.v > .97) continue;
    if (color.h >= 12 && color.h <= 48 && color.s < .72 && color.v > .35) continue;
    const weight = color.s * color.s * (.35 + color.v);
    let best = 0, distance = 999;
    for (let j = 0; j < BORDERS.length; j++) {
      const current = hueDistance(color.h, BORDERS[j].hue);
      if (current < distance) { distance = current; best = j; }
    }
    scores[best] += weight * Math.max(.1, 1 - distance / 100);
  }
  let winner = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[winner]) winner = i;
  return { ...BORDERS[winner], scores: scores.map((x) => Math.round(x * 100) / 100) };
}
function esc(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
function cleanSignature(value) { return String(value || '').replace(/[^@a-z0-9_. -]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'JTF COLLECTOR'; }
function clean(value, max = 200) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function wrap(value, chars = 50, max = 3) {
  const words = clean(value, 500).split(' ').filter(Boolean), out = []; let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > chars && line) { out.push(line); line = word; if (out.length >= max - 1) break; } else line = next;
  }
  if (line && out.length < max) out.push(line);
  return out.length ? out : ['A one-of-one animated JTF collectible.'];
}
function nameSize(value) { const n = clean(value, 80).length; return n <= 11 ? 54 : n <= 18 ? 45 : n <= 26 ? 37 : 31; }

// Retrying a card produces the same motion, but different cards get different choreography.
function motionPlan(seedText = '') {
  const hash = crypto.createHash('sha256').update(String(seedText)).digest();
  const orders = [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [0, 2, 4, 5, 3, 1],
    [2, 3, 1, 4, 0, 5], [0, 5, 1, 4, 2, 3]];
  const order = orders[hash[0] % orders.length], rank = new Array(6);
  order.forEach((star, index) => { rank[star] = index; });
  return Array.from({ length: 6 }, (_, i) => ({
    index: i,
    phase: Number((rank[i] * .16 + (hash[i + 1] % 7) / 100).toFixed(2)),
    direction: hash[i + 7] % 2 ? 1 : -1,
    turns: Number((.34 + (hash[i + 13] % 30) / 100).toFixed(2)),
    jump: 14 + (hash[i + 19] % 15),
    sway: 2 + (hash[i + 25] % 5),
  }));
}
async function makeTemplate(dir, border, options) {
  const output = path.join(dir, 'template.png');
  const name = esc(clean(options.name || 'CHARACTER', 80).toUpperCase());
  const series = esc(clean(options.series || 'JTF', 90).toUpperCase());
  const signature = esc(cleanSignature(options.signature));
  const info = wrap([options.info, options.quote ? `“${options.quote}”` : ''].filter(Boolean).join(' — '), 52, 3)
    .map((line, i) => `<text x="350" y="${730 + i * 29}" text-anchor="middle" font-size="18" font-family="URW Gothic,DejaVu Sans,sans-serif" font-style="italic" font-weight="700" fill="#fff">${esc(line)}</text>`).join('');
  const svg = Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs>
<linearGradient id="p"><stop stop-color="${border.primary}"/><stop offset=".52" stop-color="${border.secondary}"/><stop offset="1" stop-color="#fff"/></linearGradient>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#05060a" stop-opacity="0"/><stop offset=".61" stop-color="#05060a" stop-opacity=".12"/><stop offset="1" stop-color="#05060a" stop-opacity=".95"/></linearGradient>
<filter id="g" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect width="700" height="900" fill="url(#shade)"/><path d="M32 30 H668 V870 H32 Z" fill="none" stroke="#06070b" stroke-width="14"/><path d="M38 36 H662 V864 H38 Z" fill="none" stroke="url(#p)" stroke-width="3" opacity=".72"/>
<text x="57" y="72" font-size="14" font-family="Nimbus Sans Narrow,DejaVu Sans,sans-serif" font-weight="900" letter-spacing="4" fill="${border.secondary}">JTF ANIMATION</text>
<text x="584" y="103" text-anchor="middle" font-size="39" font-family="URW Chancery L,URW Bookman,DejaVu Serif,serif" font-style="italic" font-weight="900" letter-spacing="4" fill="url(#p)" stroke="#08090d" stroke-width="2" paint-order="stroke" filter="url(#g)">VIP</text>
<text x="350" y="535" text-anchor="middle" font-size="${nameSize(name)}" font-family="URW Bookman,DejaVu Serif,serif" font-style="italic" font-weight="900" letter-spacing="1.5" fill="#fff" stroke="${border.primary}" stroke-width="3.5" paint-order="stroke" filter="url(#g)">${name}</text>
<path d="M66 608 H634" stroke="#08090d" stroke-width="15" opacity=".72"/><path d="M66 608 H634" stroke="url(#p)" stroke-width="3" filter="url(#g)"/>
<path d="M55 681 H645 V824 L615 851 H85 L55 824 Z" fill="#05060b" fill-opacity=".73" stroke="url(#p)" stroke-width="3"/><text x="350" y="707" text-anchor="middle" font-size="13" font-family="Nimbus Sans Narrow,DejaVu Sans,sans-serif" font-weight="900" letter-spacing="4" fill="${border.secondary}">PREMIUM PROFILE</text>${info}
<path d="M105 820 H595 L620 843 L595 865 H105 L80 843 Z" fill="#07080d" fill-opacity=".86" stroke="url(#p)" stroke-width="2"/><text x="350" y="851" text-anchor="middle" font-size="20" font-family="URW Gothic,DejaVu Sans,sans-serif" font-style="italic" font-weight="900" fill="#fff">${series}</text><text x="350" y="885" text-anchor="middle" font-size="17" font-family="URW Bookman,DejaVu Serif,serif" font-style="italic" font-weight="900" letter-spacing="2" fill="${border.secondary}" stroke="#07080d" stroke-width="1" paint-order="stroke">${signature}</text></svg>`);
  await sharp()(svg).png().toFile(output);
  return output;
}
async function makeStar(dir, border, index) {
  const output = path.join(dir, `star-${index}.png`), size = index === 2 || index === 3 ? 94 : 82;
  const svg = Buffer.from(`<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>
<linearGradient id="f" x1=".15" y1="0" x2=".85" y2="1"><stop stop-color="#fff"/><stop offset=".18" stop-color="${border.secondary}"/><stop offset=".52" stop-color="${border.primary}"/><stop offset="1" stop-color="#050817"/></linearGradient>
<filter id="glow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="5" result="b"/><feFlood flood-color="${border.primary}"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<path d="M60 5 L73 43 L114 44 L81 68 L92 108 L60 84 L28 108 L39 68 L6 44 L47 43 Z" fill="url(#f)" stroke="${border.secondary}" stroke-width="3" filter="url(#glow)"/>
<path d="M60 10 L60 60 L73 43 Z M60 60 L110 46 L81 68 Z M60 60 L89 104 L60 84 Z M60 60 L31 104 L39 68 Z M60 60 L10 46 L47 43 Z" fill="#fff" opacity=".20"/><circle cx="60" cy="60" r="7" fill="#fff"/><circle cx="60" cy="60" r="3" fill="${border.primary}"/></svg>`);
  await sharp()(svg).png().toFile(output);
  return output;
}
async function makeShine(dir, border) {
  const output = path.join(dir, 'shine.png');
  const svg = Buffer.from(`<svg width="560" height="1180" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="s"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".30" stop-color="${border.primary}" stop-opacity=".16"/><stop offset=".46" stop-color="#fff" stop-opacity=".72"/><stop offset=".52" stop-color="#fff" stop-opacity=".94"/><stop offset=".66" stop-color="${border.secondary}" stop-opacity=".20"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="g"><feGaussianBlur stdDeviation="9"/></filter></defs><path d="M390 -100 H550 L160 1280 H0 Z" fill="url(#s)" filter="url(#g)"/></svg>`);
  await sharp()(svg).png().toFile(output);
  return output;
}
function starFilters(plan) {
  const x = [92, 178, 264, 350, 436, 522], filters = []; let previous = 'bordered';
  plan.forEach((star, i) => {
    const label = `star${i}`, output = `stars${i}`;
    const angle = `${star.direction}*2*PI*${star.turns}*t+0.10*sin(2*PI*t/${(1.25 + i * .11).toFixed(2)})`;
    const q = `mod(t-${star.phase}+2.15,2.15)`, baseY = i === 2 || i === 3 ? 552 : 558;
    const y = `if(lt(${q},0.48),${baseY}-${star.jump}*sin(PI*${q}/0.48),${baseY})`;
    const sway = `${x[i]}+${star.sway}*sin(2*PI*t/${(1.55 + i * .13).toFixed(2)})`;
    filters.push(`[${4 + i}:v]format=rgba,rotate=a='${angle}':ow=iw:oh=ih:c=none[${label}]`);
    filters.push(`[${previous}][${label}]overlay=x='${sway}':y='${y}':shortest=0[${output}]`);
    previous = output;
  });
  return { filters, output: previous };
}
async function render(options = {}) {
  validateInput(options.mediaBuffer, { mimeType: options.mimeType, duration: options.duration });
  const temp = await workspace(options.mediaBuffer, options.mimeType), output = path.join(temp.dir, 'jtf-animation.mp4');
  try {
    const poster = await extractPoster(options.mediaBuffer, { mimeType: options.mimeType, duration: options.duration });
    const chosen = await chooseBorderByArtwork(poster), border = path.join(BORDER_DIR, chosen.file);
    if (!fs.existsSync(border)) throw new Error(`JTF Animation border is missing: ${chosen.file}`);
    const template = await makeTemplate(temp.dir, chosen, options), shine = await makeShine(temp.dir, chosen);
    const starFiles = await Promise.all(Array.from({ length: 6 }, (_, i) => makeStar(temp.dir, chosen, i)));
    const plan = motionPlan(`${options.name}|${options.series}|${options.signature}|${chosen.key}`), stars = starFilters(plan);
    const filter = [
      `[0:v]fps=${FPS},split=2[bg0][hero0]`,
      `[bg0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=13:2,eq=brightness=-0.14:saturation=1.12[bg]`,
      '[hero0]scale=620:570:force_original_aspect_ratio=increase,crop=620:570,eq=saturation=1.08:contrast=1.03[hero]',
      '[bg][hero]overlay=x=40:y=42:shortest=0[art]',
      '[2:v]format=rgba[template]', '[art][template]overlay=0:0:shortest=0[typed]',
      `[1:v]fps=${FPS},format=rgba,colorkey=0x000000:0.18:0.10,colorchannelmixer=aa=.96[border]`,
      '[typed][border]overlay=0:0:shortest=0[bordered]', ...stars.filters,
      '[3:v]format=rgba[shine]',
      `[${stars.output}][shine]overlay=x='if(lt(mod(t,2.25),0.58),-590+mod(t,2.25)*2350,-1400)':y=-135:shortest=0,vignette=PI/9,format=yuv420p[out]`,
    ].join(';');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', temp.input,
      '-stream_loop', '-1', '-i', border, '-loop', '1', '-i', template, '-loop', '1', '-i', shine];
    for (const star of starFiles) args.push('-loop', '1', '-i', star);
    args.push('-filter_complex', filter, '-map', '[out]', '-an', '-t', String(DURATION), '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
    await run(args);
    const buffer = await fs.promises.readFile(output);
    if (!buffer.length) throw new Error('FFmpeg produced an empty animation');
    if (buffer.length > MAX_OUTPUT_BYTES) throw new Error('Animated card exceeded Telegram-safe size');
    return { buffer, contentType: 'video/mp4', duration: DURATION, width: WIDTH, height: HEIGHT,
      border: chosen.key, paletteScores: chosen.scores, choreography: plan.map((x) => x.phase) };
  } finally { await fs.promises.rm(temp.dir, { recursive: true, force: true }); }
}
module.exports = { WIDTH, HEIGHT, FPS, DURATION, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, BORDERS,
  validateInput, extractPoster, chooseBorderByArtwork, cleanSignature, motionPlan, render, _run: run };
