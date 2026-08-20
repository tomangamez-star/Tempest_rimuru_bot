'use strict';

// Rimuru Cards renderer.
// The layout is adapted to the 700x900 Gen 2 T1-T6 template supplied by the
// owner, but is rendered at runtime so every character can use fresh artwork.
// No font files are bundled: the SVG uses system sans-serif fonts.

const WIDTH = 700;
const HEIGHT = 900;

const CARD_TIERS = [
  { tier: 6, key: 'godlike', label: 'GODLIKE', min: 80000, accent: '#FFD34E', accent2: '#FF7A00' },
  { tier: 5, key: 'ultimate', label: 'ULTIMATE', min: 50000, accent: '#FF3D8D', accent2: '#7B2CFF' },
  { tier: 4, key: 'legacy', label: 'LEGACY', min: 20000, accent: '#FF7A38', accent2: '#FFD24A' },
  { tier: 3, key: 'mythical', label: 'MYTHICAL', min: 5000, accent: '#A45CFF', accent2: '#5B37FF' },
  { tier: 2, key: 'rare', label: 'RARE', min: 500, accent: '#38B9FF', accent2: '#2868FF' },
  { tier: 1, key: 'common', label: 'COMMON', min: 0, accent: '#B7CBDC', accent2: '#627A91' },
];

let sharpModule;
let sharpLoadAttempted = false;

function getSharp() {
  if (sharpLoadAttempted) return sharpModule || null;
  sharpLoadAttempted = true;
  try {
    sharpModule = require('sharp');
  } catch (e) {
    sharpModule = null;
    console.warn(`[cards] sharp unavailable; generated card rendering disabled: ${e.message}`);
  }
  return sharpModule;
}

function available() { return !!getSharp(); }

function clean(value, max = 500) {
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
  return clean(value, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tierFor(input) {
  const card = typeof input === 'object' && input ? input : { favorites: input };
  const forcedTier = Math.max(0, Math.min(6, Number(card.forced_tier || card.preview_tier) || 0));
  if (forcedTier) return CARD_TIERS.find((t) => t.tier === forcedTier) || CARD_TIERS[CARD_TIERS.length - 1];
  const favorites = Number(card.favorites) || 0;
  if (favorites > 0) return CARD_TIERS.find((t) => favorites >= t.min) || CARD_TIERS[CARD_TIERS.length - 1];

  // Claimed-card rows from older installs do not persist favourites. Preserve a
  // sensible T1-T5 mapping from the existing rarity key instead of touching the
  // claim-table schema/persistence path.
  const byRarity = {
    common: 1,
    rare: 2,
    epic: 3,
    legendary: 4,
    mythic: 5,
    godlike: 6,
  };
  const n = byRarity[String(card.rarity || '').toLowerCase()] || 1;
  return CARD_TIERS.find((t) => t.tier === n) || CARD_TIERS[CARD_TIERS.length - 1];
}

function wrapLines(value, maxChars = 48, maxLines = 4) {
  const words = clean(value, maxChars * maxLines * 2).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines - 1) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (!lines.length) lines.push('A mysterious presence has entered the JTF card collection.');
  return lines;
}

function nameFontSize(name) {
  const n = clean(name, 100).length;
  if (n <= 12) return 46;
  if (n <= 18) return 40;
  if (n <= 26) return 34;
  return 29;
}

function starRow(tier, accent) {
  const count = Math.max(1, Math.min(6, Number(tier) || 1));
  const spacing = 56;
  const total = (count - 1) * spacing;
  const start = WIDTH / 2 - total / 2;
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = start + i * spacing;
    out += `<text x="${x}" y="604" text-anchor="middle" font-size="46" font-family="DejaVu Sans,Arial,sans-serif" font-weight="800" fill="${accent}" stroke="#fff" stroke-width="1.6" paint-order="stroke">★</text>`;
  }
  return out;
}

function buildOverlaySvg(card) {
  const tier = tierFor(card);
  const name = escapeXml(card.name || 'UNKNOWN');
  const seriesRaw = clean(card.series || 'UNKNOWN SERIES', 56);
  const series = escapeXml(seriesRaw);
  const seriesSize = seriesRaw.length <= 24 ? 18 : seriesRaw.length <= 38 ? 15 : 13;
  const id = escapeXml(card.character_id || card.id || 'unknown');
  const desc = wrapLines(card.bio || card.description || '', 49, 4).map(escapeXml);
  const fontSize = nameFontSize(name);
  const t6 = tier.tier === 6;
  const descSvg = desc.map((line, i) => `<text x="350" y="${708 + i * 31}" text-anchor="middle" font-size="20" font-family="DejaVu Sans,Arial,sans-serif" font-weight="600" fill="#F6F7FB">${line}</text>`).join('');

  return Buffer.from(`
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${tier.accent}"/>
        <stop offset="1" stop-color="${tier.accent2}"/>
      </linearGradient>
      <linearGradient id="info" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#111522" stop-opacity="0.76"/>
        <stop offset="1" stop-color="#060811" stop-opacity="0.96"/>
      </linearGradient>
      <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="${t6 ? 10 : 6}" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blurShadow"/>
        <feOffset in="blurShadow" dx="0" dy="5" result="offsetShadow"/>
        <feComponentTransfer in="offsetShadow" result="darkShadow"><feFuncA type="linear" slope="0.65"/></feComponentTransfer>
        <feMerge><feMergeNode in="darkShadow"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- outer collector-card silhouette -->
    <path d="M55 25 H645 L682 63 V842 L642 878 H58 L18 842 V63 Z" fill="none" stroke="#0A0D17" stroke-width="12"/>
    <path d="M58 31 H642 L675 66 V838 L638 869 H62 L25 838 V66 Z" fill="none" stroke="url(#accent)" stroke-width="8" filter="url(#glow)"/>
    <path d="M68 44 H632 L660 72 V828 L628 855 H72 L40 828 V72 Z" fill="none" stroke="#F7F8FC" stroke-opacity="0.88" stroke-width="3"/>

    <!-- image window frame -->
    <path d="M48 92 H652 V574 L622 598 H78 L48 574 Z" fill="none" stroke="url(#accent)" stroke-width="7" filter="url(#shadow)"/>
    <path d="M57 101 H643 V568 L616 589 H84 L57 568 Z" fill="none" stroke="#FFFFFF" stroke-opacity="0.70" stroke-width="2"/>

    <!-- top name banner -->
    <path d="M125 29 H626 L657 54 L628 84 H126 L99 57 Z" fill="url(#accent)" filter="url(#shadow)"/>
    <path d="M145 36 H605" stroke="#fff" stroke-opacity="0.35" stroke-width="2"/>
    <text x="377" y="68" text-anchor="middle" font-size="${fontSize}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFFFFF" stroke="#10131B" stroke-width="2.2" paint-order="stroke">${name}</text>

    <!-- tier crest -->
    <path d="M37 36 L86 25 L116 57 L101 112 L58 124 L27 91 Z" fill="#0B0E18" stroke="url(#accent)" stroke-width="6" filter="url(#glow)"/>
    <text x="70" y="82" text-anchor="middle" font-size="34" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${tier.accent}">T${tier.tier}</text>
    <text x="70" y="105" text-anchor="middle" font-size="11" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1" fill="#FFFFFF">${tier.label}</text>

    <!-- separator / stars -->
    <path d="M45 584 H655" stroke="#060811" stroke-width="18" opacity="0.8"/>
    <path d="M45 584 H655" stroke="url(#accent)" stroke-width="7" filter="url(#glow)"/>
    ${starRow(tier.tier, tier.accent)}

    <!-- lower information panel -->
    <path d="M53 616 H647 V822 L615 854 H85 L53 822 Z" fill="url(#info)" stroke="url(#accent)" stroke-width="3"/>
    <path d="M69 637 H631" stroke="${tier.accent}" stroke-opacity="0.55" stroke-width="2"/>
    <text x="350" y="674" text-anchor="middle" font-size="27" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${tier.accent}">INFO</text>
    ${descSvg}

    <!-- footer -->
    <path d="M82 823 H618 L600 846 H100 Z" fill="url(#accent)" opacity="0.92"/>
    <text x="350" y="842" text-anchor="middle" font-size="${seriesSize}" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF" stroke="#111" stroke-width="1" paint-order="stroke">${series}</text>
    <text x="76" y="869" font-size="12" font-family="DejaVu Sans,Arial,sans-serif" font-weight="700" fill="#FFFFFF" opacity="0.78">#${id}</text>
    <rect x="505" y="850" width="127" height="27" rx="8" fill="#070A12" fill-opacity="0.86" stroke="${tier.accent}" stroke-width="1.8"/>
    <text x="568" y="870" text-anchor="middle" font-size="17" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="0.8" fill="#FFFFFF" stroke="${tier.accent2}" stroke-width="0.7" paint-order="stroke">JTF CARDS</text>

  </svg>`);
}

function artMaskSvg() {
  return Buffer.from(`
    <svg width="604" height="490" viewBox="0 0 604 490" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0 H604 V466 L576 490 H28 L0 466 Z" fill="#fff"/>
    </svg>`);
}

async function render(card, imageBuffer) {
  const sharp = getSharp();
  if (!sharp || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;

  const background = await sharp(imageBuffer)
    .rotate()
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
    .blur(20)
    .modulate({ brightness: 0.48, saturation: 1.18 })
    .png()
    .toBuffer();

  // Preserve the actual character composition instead of forcing every source
  // into a landscape cover crop (which used to turn portraits into giant eyes).
  // A soft blurred copy fills any spare space while the real artwork is fitted
  // intact on top.
  const heroBackdrop = await sharp(imageBuffer)
    .rotate()
    .resize(604, 490, { fit: 'cover', position: 'attention' })
    .blur(16)
    .modulate({ brightness: 0.62, saturation: 1.05 })
    .png()
    .toBuffer();

  const heroForeground = await sharp(imageBuffer)
    .rotate()
    .resize(604, 490, { fit: 'contain', position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const hero = await sharp({ create: { width: 604, height: 490, channels: 4, background: { r: 5, g: 7, b: 17, alpha: 1 } } })
    .composite([
      { input: heroBackdrop, left: 0, top: 0 },
      { input: heroForeground, left: 0, top: 0 },
      { input: artMaskSvg(), blend: 'dest-in' },
    ])
    .png()
    .toBuffer();

  const shade = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.05"/><stop offset="0.64" stop-color="#000" stop-opacity="0.18"/><stop offset="1" stop-color="#000" stop-opacity="0.70"/></linearGradient></defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#v)"/>
    </svg>`);

  const buffer = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#050711' } })
    .composite([
      { input: background, left: 0, top: 0 },
      { input: shade, left: 0, top: 0 },
      { input: hero, left: 48, top: 101 },
      { input: buildOverlaySvg(card), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  return { buffer, tier: tierFor(card), width: WIDTH, height: HEIGHT };
}

module.exports = {
  WIDTH,
  HEIGHT,
  CARD_TIERS,
  available,
  tierFor,
  wrapLines,
  buildOverlaySvg,
  render,
};
