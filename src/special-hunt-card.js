'use strict';

// JTF Cards — Old Gen / Special Hunt renderer.
// Inspired by the layered 700x900 ASN old-generation template supplied by the
// owner. The PSD itself is NOT bundled at runtime; Rimuru recreates the layout
// with Sharp/SVG so deploys stay lightweight.

const baseRenderer = require('./hunt-card');

const WIDTH = 700;
const HEIGHT = 900;

const OLD_GEN = {
  1: { symbol: 'C', label: 'COMMON', accent: '#8FC9FF', accent2: '#D9EEFF', glow: '#4B9CE8' },
  2: { symbol: 'R', label: 'RARE', accent: '#51F28D', accent2: '#B9FFD1', glow: '#22C55E' },
  3: { symbol: 'M', label: 'MYTHICAL', accent: '#B96CFF', accent2: '#F0C8FF', glow: '#7C3AED' },
  4: { symbol: 'L', label: 'LEGACY', accent: '#A96AFF', accent2: '#FFD066', glow: '#7E22CE' },
  5: { symbol: 'U', label: 'ULTIMATE', accent: '#FFD34F', accent2: '#FF8A2A', glow: '#EF6C00' },
  6: { symbol: '✦', label: 'GODLIKE', accent: '#FFE476', accent2: '#FF4D3D', glow: '#FFB300' },
};

let sharpModule;
let sharpLoadAttempted = false;
function getSharp() {
  if (sharpLoadAttempted) return sharpModule || null;
  sharpLoadAttempted = true;
  try { sharpModule = require('sharp'); }
  catch (e) {
    sharpModule = null;
    console.warn(`[special-cards] sharp unavailable; Old Gen rendering disabled: ${e.message}`);
  }
  return sharpModule;
}
function available() { return !!getSharp(); }

function clean(value, max = 600) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function escapeXml(value) {
  return clean(value, 1200)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function tierFor(card) { return baseRenderer.tierFor(card); }
function oldTier(card) {
  const t = tierFor(card);
  return { ...t, ...(OLD_GEN[t.tier] || OLD_GEN[1]) };
}
function nameSize(name) {
  const n = clean(name, 100).length;
  if (n <= 9) return 61;
  if (n <= 14) return 53;
  if (n <= 20) return 45;
  if (n <= 28) return 37;
  return 31;
}
function wrap(value, chars = 50, lines = 4) {
  const words = clean(value, chars * lines * 2).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > chars && line) {
      out.push(line); line = word;
      if (out.length >= lines - 1) break;
    } else line = next;
  }
  if (line && out.length < lines) out.push(line);
  if (!out.length) out.push('A rare JTF collectible has entered the archive.');
  return out;
}
function starRow(tier, accent) {
  const n = Math.max(1, Math.min(6, Number(tier) || 1));
  const spacing = n >= 6 ? 53 : 58;
  const start = WIDTH / 2 - ((n - 1) * spacing) / 2;
  return Array.from({ length: n }, (_, i) =>
    `<text x="${start + i * spacing}" y="633" text-anchor="middle" font-size="46" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${accent}" stroke="#FFF4D0" stroke-width="1.6" paint-order="stroke">★</text>`
  ).join('');
}
function chainPath(x1, y1, x2, y2, accent, opacity = 0.7) {
  const parts = 13;
  let rings = '';
  for (let i = 0; i <= parts; i++) {
    const p = i / parts;
    const x = x1 + (x2 - x1) * p;
    const y = y1 + (y2 - y1) * p;
    const rot = i % 2 ? 36 : -36;
    rings += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="10" ry="5" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" fill="none" stroke="${accent}" stroke-width="3" opacity="${opacity}"/>`;
  }
  return rings;
}
function motif(cx, cy, r, accent) {
  return `<g opacity="0.48"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#08070A" fill-opacity="0.35" stroke="${accent}" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="${r * .62}" fill="none" stroke="${accent}" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="${r * .28}" fill="${accent}" fill-opacity="0.25" stroke="${accent}" stroke-width="3"/></g>`;
}
function overlaySvg(card) {
  const tier = oldTier(card);
  const nameRaw = clean(card.name || 'UNKNOWN', 100);
  const name = escapeXml(nameRaw);
  const seriesRaw = clean(card.series || 'UNKNOWN SERIES', 70).toUpperCase();
  const series = escapeXml(seriesRaw);
  const rawId = String(card.character_id || card.id || 'unknown').replace(/^anilist-/i, '');
  const id = escapeXml(rawId);
  const infoLines = wrap(card.bio || card.description || '', 44, 4).map(escapeXml);
  const info = infoLines.map((line, i) => `<text x="350" y="${716 + i * 30}" text-anchor="middle" font-size="19" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="700" fill="#FFF7E3">${line}</text>`).join('');
  const ns = nameSize(nameRaw);
  const label = escapeXml(tier.label);
  const symbol = escapeXml(tier.symbol);
  const seriesSize = seriesRaw.length < 24 ? 22 : seriesRaw.length < 38 ? 18 : 14;

  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tier.accent}"/><stop offset="1" stop-color="${tier.accent2}"/></linearGradient>
    <linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050407" stop-opacity="0.05"/><stop offset="1" stop-color="#050407" stop-opacity="0.96"/></linearGradient>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/><feOffset dy="4" result="o"/><feComponentTransfer in="o"><feFuncA type="linear" slope="0.75"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>

  <!-- Old Gen outer frame / supplied PSD proportions -->
  <rect x="30" y="27" width="640" height="846" rx="12" fill="none" stroke="#08090B" stroke-width="17"/>
  <rect x="39" y="36" width="622" height="828" rx="8" fill="none" stroke="url(#edge)" stroke-width="6" filter="url(#glow)"/>
  <rect x="48" y="45" width="604" height="810" rx="4" fill="none" stroke="#FFF7E4" stroke-opacity="0.8" stroke-width="2"/>

  <!-- tier-specific ambience -->
  ${motif(583, 230, 62, tier.accent)}
  ${motif(117, 760, 42, tier.accent)}
  ${chainPath(70, 110, 180, 650, tier.accent, 0.56)}
  ${chainPath(629, 92, 558, 665, tier.accent, 0.58)}
  ${chainPath(85, 825, 300, 650, tier.accent, 0.42)}
  ${chainPath(615, 820, 432, 650, tier.accent, 0.42)}

  <!-- lower cinematic shade integrated over the art -->
  <rect x="49" y="440" width="602" height="414" fill="url(#bottom)"/>

  <!-- old-gen tier glyph -->
  <path d="M54 49 L97 38 L128 65 L115 116 L73 130 L43 102 Z" fill="#09090D" fill-opacity="0.88" stroke="url(#edge)" stroke-width="4" filter="url(#shadow)"/>
  <text x="84" y="93" text-anchor="middle" font-size="48" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="${tier.accent}" stroke="#160E09" stroke-width="1.4" paint-order="stroke">${symbol}</text>
  <text x="84" y="116" text-anchor="middle" font-size="10" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.3" fill="#FFF7E4">T${tier.tier} ${label}</text>

  <!-- character name dominates the composition like Old Gen cards -->
  <text x="350" y="571" text-anchor="middle" font-size="${ns}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFE7A1" stroke="#7A2512" stroke-width="3.5" paint-order="stroke" filter="url(#shadow)">${name}</text>
  ${starRow(tier.tier, tier.accent)}

  <text x="78" y="664" font-size="18" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${tier.accent2}">INFO</text>
  <text x="622" y="664" text-anchor="end" font-size="15" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${tier.accent2}">${label}</text>

  <rect x="102" y="676" width="496" height="132" rx="12" fill="#08080C" fill-opacity="0.66" stroke="${tier.accent}" stroke-opacity="0.6" stroke-width="2"/>
  ${info}

  <text x="620" y="835" text-anchor="end" font-size="${seriesSize}" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${tier.accent2}" stroke="#1C0E0C" stroke-width="1.3" paint-order="stroke">${series}</text>
  <text x="74" y="842" font-size="12" font-family="DejaVu Sans,Arial,sans-serif" font-weight="800" fill="#FFF7E4" opacity="0.8">#${id}</text>
  <rect x="503" y="846" width="123" height="25" rx="7" fill="#09090D" fill-opacity="0.88" stroke="${tier.accent}" stroke-width="1.5"/>
  <text x="565" y="864" text-anchor="middle" font-size="15" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="0.8" fill="#FFF7E4">JTF OLD GEN</text>
  </svg>`);
}

async function render(card, imageBuffer) {
  const sharp = getSharp();
  if (!sharp || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;
  const tier = oldTier(card);

  // Special Hunt intentionally uses portrait Zerochan art and a full-bleed
  // cover crop. Unlike normal /hunt, there are no blurred sidebars: Old Gen is
  // supposed to feel composed around the character rather than framed around a
  // contained source picture.
  const hero = await sharp(imageBuffer)
    .rotate()
    .resize(604, 810, { fit: 'cover', position: 'attention' })
    .modulate({ saturation: 1.08, brightness: 0.98 })
    .png()
    .toBuffer();

  const ambience = Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g"><stop offset="0" stop-color="${tier.accent}" stop-opacity="0.25"/><stop offset="1" stop-color="#050508" stop-opacity="0.92"/></radialGradient></defs><rect width="700" height="900" fill="#050508"/><rect width="700" height="900" fill="url(#g)"/></svg>`);

  const buffer = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#050508' } })
    .composite([
      { input: ambience, left: 0, top: 0 },
      { input: hero, left: 48, top: 45 },
      { input: overlaySvg(card), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'old-gen' };
}

module.exports = { WIDTH, HEIGHT, OLD_GEN, available, tierFor, oldTier, overlaySvg, render };
