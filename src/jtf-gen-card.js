'use strict';

// JTF Signature renderer (renderer #3).
// Geometry is traced from the supplied 700x900 Gen 2 PSD rather than inferred
// from the existing JTF renderers. The PSD stays a design master; Rimuru only
// carries lightweight runtime code/assets.

const WIDTH = 700;
const HEIGHT = 900;
const ART = { left: 60, top: 84, width: 580, height: 480 };

const TIERS = {
  1: { symbol: 'C', label: 'COMMON', base1: '#FF7A1A', base2: '#FFB14A' },
  2: { symbol: 'R', label: 'RARE', base1: '#28C76F', base2: '#72F1A5' },
  3: { symbol: 'M', label: 'MYTHICAL', base1: '#8C4BFF', base2: '#C57AFF' },
  4: { symbol: 'L', label: 'LEGACY', base1: '#3478FF', base2: '#6EC7FF' },
  5: { symbol: 'U', label: 'ULTIMATE', base1: '#FF3E91', base2: '#FF9B45' },
  6: { symbol: '✦', label: 'GODLIKE', base1: '#FFB300', base2: '#FF4E3E' },
};

let sharpModule;
let sharpLoadAttempted = false;
function getSharp() {
  if (sharpLoadAttempted) return sharpModule || null;
  sharpLoadAttempted = true;
  try { sharpModule = require('sharp'); }
  catch (e) {
    sharpModule = null;
    console.warn(`[signature-cards] sharp unavailable; JTF Signature rendering disabled: ${e.message}`);
  }
  return sharpModule;
}
function available() { return !!getSharp(); }

function clean(value, max = 700) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function esc(value) {
  return clean(value, 1500)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function clamp(v, lo = 0, hi = 255) { return Math.max(lo, Math.min(hi, v)); }
function rgbToHex(rgb) { return `#${rgb.map((x) => clamp(Math.round(x)).toString(16).padStart(2, '0')).join('')}`.toUpperCase(); }
function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  return s.length === 6 ? [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)] : [255,128,64];
}
function mixHex(a, b, amount = 0.5) {
  const A = hexToRgb(a), B = hexToRgb(b), t = Math.max(0, Math.min(1, amount));
  return rgbToHex(A.map((v, i) => v * (1 - t) + B[i] * t));
}
function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let h=0;
  if (d) {
    if (mx===r) h=((g-b)/d)%6;
    else if (mx===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h=(h*60+360)%360;
  }
  return [h, mx ? d/mx : 0, mx];
}
function colorDistance(a,b) { const dr=a[0]-b[0],dg=a[1]-b[1],db=a[2]-b[2]; return Math.sqrt(dr*dr+dg*dg+db*db); }

function tierFor(card) {
  const rawForced = Number(card && (card.forced_tier || card.preview_tier)) || 0;
  const forced = rawForced > 0 ? Math.max(1, Math.min(6, rawForced)) : 0;
  if (forced) return { tier: forced, ...TIERS[forced] };
  const f = Math.max(0, Number(card && card.favorites) || 0);
  const tier = f >= 80000 ? 6 : f >= 50000 ? 5 : f >= 20000 ? 4 : f >= 5000 ? 3 : f >= 500 ? 2 : 1;
  return { tier, ...TIERS[tier] };
}

async function analyzeArtwork(imageBuffer, tier) {
  const sharp = getSharp();
  const { data, info } = await sharp(imageBuffer).rotate().resize(84,84,{fit:'fill'}).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = Array.from({ length: 24 }, () => ({ w:0, r:0, g:0, b:0 }));
  const border = [];
  const edge = 6;
  let lumSum=0, lumSq=0, pxCount=0;
  for (let y=0;y<info.height;y++) for (let x=0;x<info.width;x++) {
    const i=(y*info.width+x)*info.channels, r=data[i],g=data[i+1],b=data[i+2];
    const [h,s,v]=rgbToHsv(r,g,b), lum=.2126*r+.7152*g+.0722*b;
    lumSum+=lum; lumSq+=lum*lum; pxCount++;
    if (x<edge||x>=info.width-edge||y<edge||y>=info.height-edge) border.push([r,g,b]);
    // Ignore black/white/gray when choosing an artwork accent. Colorful light
    // sources get extra weight, exactly for the "black art -> use next bright color" rule.
    if (s>=0.22 && v>=0.24 && v<=0.98) {
      const bi=Math.min(23,Math.floor(h/15));
      const w=(0.25+s*s)*(0.35+v)*Math.max(.15,1-Math.abs(v-.72)*.55);
      bins[bi].w+=w; bins[bi].r+=r*w; bins[bi].g+=g*w; bins[bi].b+=b*w;
    }
  }
  bins.sort((a,b)=>b.w-a.w);
  const picked=[];
  for (const bin of bins) {
    if (!bin.w) continue;
    const c=[bin.r/bin.w,bin.g/bin.w,bin.b/bin.w];
    if (picked.every((p)=>colorDistance(p,c)>54)) picked.push(c);
    if (picked.length>=3) break;
  }
  const base1=tier.base1, base2=tier.base2;
  const p1=picked[0]?rgbToHex(picked[0]):base1;
  const p2=picked[1]?rgbToHex(picked[1]):(picked[0]?mixHex(p1,base2,.45):base2);
  // Tier establishes identity; art pushes the hue/personality.
  const accent1=mixHex(p1,base1,tier.tier<=3?.28:tier.tier===4?.18:.10), accent2=mixHex(p2,base2,tier.tier<=3?.30:tier.tier===4?.18:.10);

  const bg = border.length ? border.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/border.length) : [128,128,128];
  const spread = border.length ? border.reduce((s,p)=>s+colorDistance(p,bg),0)/border.length : 99;
  const [,bgSat,bgVal]=rgbToHsv(...bg);
  const whiteLike = bgVal>.90 && bgSat<.10;
  const flatColored = spread<28 && bgSat>.14 && bgVal>.24;
  const flatNeutral = spread<19 && !whiteLike && bgVal>.18 && bgVal<.86;
  const mean=lumSum/Math.max(1,pxCount), std=Math.sqrt(Math.max(0,lumSq/Math.max(1,pxCount)-mean*mean));
  const colorChaos = bgSat>.42 && spread>52;
  const mode = (flatColored || flatNeutral) ? 'isolated' : (colorChaos || spread<48 || std<48 ? 'hybrid' : 'scene');
  return { accent1, accent2, palette:[p1,p2,...picked.slice(2).map(rgbToHex)], bg: bg.map(Math.round), borderSpread:spread, mode, whiteLike };
}

function wrap(value, chars=49, lines=4) {
  const words=clean(value,chars*lines*3).split(/\s+/).filter(Boolean),out=[]; let line='';
  for (const w of words) {
    const n=line?`${line} ${w}`:w;
    if (n.length>chars && line) { out.push(line); line=w; if(out.length>=lines-1) break; }
    else line=n;
  }
  if(line&&out.length<lines)out.push(line);
  if(!out.length)out.push('A JTF Signature collectible has entered the archive.');
  return out;
}
function verticalNameSize(name){const n=clean(name,100).length;return n<=10?34:n<=16?30:n<=23?25:21;}
function signatureFont(name, tier) {
  const s=clean(name,100).toLowerCase();
  if (/makima|aizen|sukuna|madara|demon|devil|curse/.test(s)) return 'Nimbus Sans Narrow,DejaVu Sans Condensed,Arial Narrow,sans-serif';
  if (/frieren|violet|emilia|asuna|holo|historia/.test(s)) return 'URW Bookman,DejaVu Serif,serif';
  if (/gojo|rimuru|zero two|kirito|sung jin/.test(s)) return 'URW Gothic,DejaVu Sans,sans-serif';
  return Number(tier)>=4?'Nimbus Sans Narrow,DejaVu Sans Condensed,Arial Narrow,sans-serif':'DejaVu Sans Condensed,Arial Narrow,sans-serif';
}
function seriesSize(series){const n=clean(series,100).length;return n<=24?20:n<=38?17:n<=54?14:12;}

function starsSvg(tier, a1, a2) {
  const n=Math.max(1,Math.min(6,Number(tier)||1));
  const premium=n>=4, spacing=n>=6?57:64,total=(n-1)*spacing,start=350-total/2,mid=(n-1)/2;
  return Array.from({length:n},(_,i)=>{
    const d=Math.abs(i-mid), scale=premium?(d<.6?1.34:d<1.6?1.12:.94):1;
    const rot=premium?(i-mid)*-4:0;
    return `<g transform="translate(${start+i*spacing} 570) scale(${scale}) rotate(${rot})" filter="url(#starGlow)"><polygon points="0,-25 7,-8 25,-8 11,3 16,21 0,11 -16,21 -11,3 -25,-8 -7,-8" fill="url(#starPremium)" stroke="#FFF" stroke-opacity=".94" stroke-width="1.5"/><polygon points="0,-17 5,-5 17,-5 8,2 11,14 0,8 -11,14 -8,2 -17,-5 -5,-5" fill="none" stroke="#FFF" stroke-opacity="${premium?'.55':'.18'}" stroke-width="1"/></g>`;
  }).join('');
}

function generatedBackdropSvg(a1,a2,tier,mode) {
  const op=mode==='isolated'?1:mode==='hybrid'?.25:.10;
  const extra=tier>=5?0.16:tier>=3?0.10:0.05;
  let shapes='';
  const polys=[
    '35,55 175,18 225,126 100,170','390,25 545,62 515,165 365,142','20,300 150,245 210,372 76,425','405,265 575,210 590,355 460,420',
  ];
  polys.forEach((p,i)=>{shapes+=`<polygon points="${p}" fill="${i%2?a2:a1}" fill-opacity="${(0.10+extra).toFixed(2)}"/>`;});
  for(let i=0;i<7;i++){const x=70+i*75,y=100+(i%3)*105;shapes+=`<polygon points="${x},${y-22} ${x+20},${y-11} ${x+20},${y+11} ${x},${y+22} ${x-20},${y+11} ${x-20},${y-11}" fill="none" stroke="${i%2?a2:a1}" stroke-opacity="${(0.22+extra).toFixed(2)}" stroke-width="3"/>`;}
  return Buffer.from(`<svg width="${ART.width}" height="${ART.height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#F8F8F8"/><stop offset=".38" stop-color="${a1}" stop-opacity=".32"/><stop offset="1" stop-color="${a2}" stop-opacity=".52"/></linearGradient><radialGradient id="light"><stop stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="${a2}" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#bg)" opacity="${op}"/><circle cx="460" cy="125" r="185" fill="url(#light)" opacity=".65"/>${shapes}<path d="M-20 390 L190 170 M35 470 L270 225 M360 -10 L600 240" stroke="#fff" stroke-opacity=".30" stroke-width="5"/></svg>`);
}

async function flatBackgroundSubject(imageBuffer, analysis) {
  const sharp=getSharp();
  if (!sharp || (analysis.mode!=='isolated' && !(analysis.mode==='hybrid' && Number(analysis.borderSpread)<50))) return null;
  const prepared=sharp(imageBuffer).rotate().resize(ART.width,ART.height,{fit:'contain',position:'centre',background:{r:0,g:0,b:0,alpha:0}}).ensureAlpha();
  const {data,info}=await prepared.raw().toBuffer({resolveWithObject:true});
  const bg=analysis.bg, out=Buffer.from(data);
  let kept=0,removed=0,opaque=0;
  for(let i=0;i<out.length;i+=4){
    const oa=out[i+3]; if(!oa) continue; opaque++;
    const d=colorDistance([out[i],out[i+1],out[i+2]],bg);
    const alpha=Math.max(0,Math.min(1,(d-24)/62));
    out[i+3]=Math.round(oa*alpha);
    if(out[i+3]>80)kept++;else removed++;
  }
  const keepRatio=opaque?kept/opaque:0,removeRatio=opaque?removed/opaque:0;
  // Reject suspicious mattes rather than amputating a character.
  if (keepRatio<.12 || removeRatio<.12) return null;
  return sharp(out,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
}

async function externalBackgroundSubject(imageBuffer) {
  const key=String(process.env.REMOVEBG_API_KEY||'').trim();
  if(!key || typeof FormData==='undefined' || typeof Blob==='undefined') return null;
  try{
    const form=new FormData(); form.append('image_file',new Blob([imageBuffer]),'artwork.png');form.append('size','auto');
    const res=await fetch('https://api.remove.bg/v1.0/removebg',{method:'POST',headers:{'X-Api-Key':key},body:form});
    if(!res.ok)throw Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }catch(e){console.warn(`[signature-cards] remove.bg fallback failed: ${e.message}`);return null;}
}

function overlaySvg(card, analysis) {
  const tier=tierFor(card),a1=analysis.accent1,a2=analysis.accent2;
  const nameRaw=clean(card.name||'CHARACTER NAME',100),name=esc(nameRaw),seriesRaw=clean(card.series||'SERIES NAME',90).toUpperCase(),series=esc(seriesRaw);
  const id=esc(String(card.character_id||card.id||'signature').replace(/^anilist-/i,''));
  const lines=wrap(card.bio||card.description||'',52,4).map(esc);
  const desc=lines.map((l,i)=>`<text x="350" y="${673+i*29}" text-anchor="middle" font-size="19" font-family="DejaVu Sans,Arial,sans-serif" font-weight="700" fill="#FFF">${l}</text>`).join('');
  const ns=verticalNameSize(nameRaw),ss=seriesSize(seriesRaw),t=tier.tier,font=signatureFont(nameRaw,t);
  const tierDetail=t>=4?`<path d="M83 152 C120 122 152 140 188 104" fill="none" stroke="url(#sigAccent)" stroke-width="${t>=6?7:t>=5?5:3}" opacity="${t>=5?'.60':'.35'}"/><path d="M535 136 C565 100 596 118 624 88" fill="none" stroke="url(#sigAccent)" stroke-width="${t>=6?7:t>=5?5:3}" opacity="${t>=5?'.60':'.35'}"/>${t>=5?'<circle cx="350" cy="450" r="270" fill="none" stroke="url(#sigAccent)" stroke-opacity=".16" stroke-width="18"/>':''}`:'';
  return Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs>
    <linearGradient id="sigAccent" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a1}"/><stop offset=".55" stop-color="${a2}"/><stop offset="1" stop-color="${tier.base2}"/></linearGradient>
    <linearGradient id="infoBg" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${a1}" stop-opacity="${t>=5?'.10':t===4?'.17':'.24'}"/><stop offset="1" stop-color="${a2}" stop-opacity="${t>=5?'.50':t===4?'.64':'.78'}"/></linearGradient><radialGradient id="starPremium"><stop stop-color="#FFFFFF"/><stop offset=".20" stop-color="${a2}"/><stop offset=".58" stop-color="${a1}"/><stop offset="1" stop-color="${tier.base2}"/></radialGradient>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/><feOffset dy="5" result="o"/><feComponentTransfer in="o"><feFuncA type="linear" slope=".45"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="starGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <!-- faithful PSD white angular silhouette -->
  <path d="M62 51 H608 L650 93 V750 L590 835 H144 L61 754 Z" fill="#F7F7F7" fill-opacity=".06" stroke="#0C0D11" stroke-opacity=".28" stroke-width="14" filter="url(#shadow)"/>
  <path d="M62 51 H608 L650 93 V750 L590 835 H144 L61 754 Z" fill="none" stroke="#FFFFFF" stroke-width="9"/>
  <path d="M62 51 H608 L650 93 V750 L590 835 H144 L61 754 Z" fill="none" stroke="url(#sigAccent)" stroke-opacity=".60" stroke-width="3"/>
  ${tierDetail}
  <!-- Signature v2: the old top ribbon is deliberately gone so the isolated
       head/hair can escape the frame. The name now owns a vertical left rail. -->
  <path d="M22 158 L48 135 H93 L104 151 V511 L82 535 H38 L22 518 Z" fill="#090A0F" fill-opacity=".74" stroke="url(#sigAccent)" stroke-width="4" filter="url(#shadow)"/>
  <path d="M34 178 V493" stroke="#FFF" stroke-opacity=".24" stroke-width="2"/>
  <text x="64" y="337" text-anchor="middle" transform="rotate(-90 64 337)" font-size="${ns}" font-family="${font}" font-style="italic" font-weight="900" letter-spacing="${t>=5?'2.4':'1.1'}" fill="#FFF" stroke="${a1}" stroke-width="${t>=5?'3.2':'2.2'}" paint-order="stroke" filter="url(#starGlow)">${name}</text>
  <g filter="url(#shadow)"><circle cx="61" cy="105" r="40" fill="#090A0F" fill-opacity=".80" stroke="url(#sigAccent)" stroke-width="4"/><text x="61" y="124" text-anchor="middle" font-size="58" font-family="${font}" font-style="italic" font-weight="900" fill="#FFF" stroke="#111" stroke-width="2.5" paint-order="stroke">${esc(tier.symbol)}</text></g>
  <text x="62" y="154" text-anchor="middle" font-size="11" font-family="${font}" font-weight="900" fill="${a2}">T${t} ${tier.label}</text>
  <!-- art-window edge / PSD glow box -->
  <path d="M61 82 H639 V555 L618 565 H82 L61 555 Z" fill="none" stroke="url(#sigAccent)" stroke-opacity=".48" stroke-width="3"/>
  <!-- PSD star divider at ~557..585 -->
  <path d="M26 568 L42 558 H321 L350 545 L379 558 H660 L677 568 L660 579 H379 L350 592 L321 579 H42 Z" fill="#FFF" stroke="url(#sigAccent)" stroke-width="5" filter="url(#shadow)"/>
  ${starsSvg(t,a1,a2)}
  <!-- lower PSD information field with adaptive tint/pattern -->
  <path d="M62 588 H640 V750 L589 835 H144 L62 754 Z" fill="url(#infoBg)"/>
  <g opacity=".16" stroke="#FFF" fill="none"><polygon points="95,630 140,606 185,630 185,677 140,701 95,677"/><polygon points="475,640 526,612 576,640 576,696 526,724 475,696"/><path d="M78 735 L240 602 M430 805 L622 642" stroke-width="5"/></g>
  <text x="350" y="635" text-anchor="middle" font-size="18" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFF" opacity=".92">DESCRIPTION</text>
  ${desc}
  <!-- series footer matches PSD placement at y811..831 -->
  <path d="M144 802 H607 L589 835 H144 L115 804 Z" fill="url(#sigAccent)" fill-opacity=".90"/>
  <text x="360" y="827" text-anchor="middle" font-size="${ss}" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFF" stroke="#111" stroke-width="1" paint-order="stroke">${series}</text>
  <text x="606" y="785" text-anchor="end" transform="rotate(-45 606 785)" font-size="18" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFF">INFO</text>
  <!-- our signature, intentionally integrated instead of a pasted badge -->
  <text x="85" y="827" font-size="11" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFF" opacity=".72">#${id}</text>
  <text x="598" y="857" text-anchor="end" font-size="14" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" letter-spacing="1.2" fill="url(#sigAccent)">♦ JTF SIGNATURE</text>
  </svg>`);
}

function artMaskSvg() {
  return Buffer.from(`<svg width="${ART.width}" height="${ART.height}" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 H580 V461 L558 480 H22 L0 461 Z" fill="#fff"/></svg>`);
}

async function render(card, imageBuffer) {
  const sharp=getSharp();
  if(!sharp || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length)return null;
  const tier=tierFor(card),analysis=await analyzeArtwork(imageBuffer,tier);
  const backdrop=generatedBackdropSvg(analysis.accent1,analysis.accent2,tier.tier,analysis.mode);

  let art, isolatedSubject=null, alignedSubject=null;
  // A real transparent subject is also used for the head-escape layer. When
  // remove.bg is configured it works for complex scenes; the conservative
  // local matte is retained only for genuinely flat/isolated artwork.
  if(String(process.env.REMOVEBG_API_KEY||'').trim()) isolatedSubject=await externalBackgroundSubject(imageBuffer);
  if(!isolatedSubject && (analysis.mode==='isolated'||analysis.mode==='hybrid')) isolatedSubject=await flatBackgroundSubject(imageBuffer,analysis);
  if(isolatedSubject) alignedSubject=await sharp(isolatedSubject).trim({background:{r:0,g:0,b:0,alpha:0},threshold:8}).resize(ART.width,564,{fit:'contain',position:'bottom',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  if(analysis.mode!=='scene' && isolatedSubject) {
      const subjectFit=await sharp(alignedSubject).extract({left:0,top:84,width:ART.width,height:ART.height}).png().toBuffer();
      art=await sharp({create:{width:ART.width,height:ART.height,channels:4,background:'#F5F5F5'}}).composite([{input:backdrop},{input:subjectFit}]).png().toBuffer();
  }
  if(!art) {
    // Preserve strong scenes. Hybrid gets subtle JTF props; scene mode barely
    // touches the source beyond template tint so gorgeous artwork stays intact.
    const hero=await sharp(imageBuffer).rotate().resize(ART.width,ART.height,{fit:'cover',position:'attention'}).modulate({saturation:1.04,brightness:1.00}).png().toBuffer();
    art=analysis.mode==='scene'?hero:await sharp(hero).composite([{input:backdrop,blend:'screen'}]).png().toBuffer();
  }
  const masked=await sharp(art).composite([{input:artMaskSvg(),blend:'dest-in'}]).png().toBuffer();

  // The lower half follows the supplied PSD: a colorable background + pattern
  // beneath the description rather than a generic black box.
  const lower=Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${analysis.accent1}" stop-opacity=".22"/><stop offset=".55" stop-color="#F7F7F7"/><stop offset="1" stop-color="${analysis.accent2}" stop-opacity=".55"/></linearGradient></defs><rect width="700" height="900" fill="#F4F4F4"/><path d="M62 51 H608 L650 93 V750 L590 835 H144 L61 754 Z" fill="url(#l)"/><g fill="${analysis.accent1}" opacity=".13"><polygon points="90,690 145,660 200,690 200,750 145,780 90,750"/><polygon points="430,620 490,588 550,620 550,684 490,716 430,684"/></g></svg>`);

  let headEscape=null;
  if(alignedSubject){
    // The lower 480px align with the normal art window. Only the upper slice,
    // minus the left name rail, is allowed above the border.
    const escapeMask=Buffer.from(`<svg width="580" height="180" xmlns="http://www.w3.org/2000/svg"><path d="M112 0 H568 Q580 0 580 12 V180 H112 Z" fill="#fff"/></svg>`);
    headEscape=await sharp(alignedSubject).extract({left:0,top:0,width:580,height:180}).composite([{input:escapeMask,blend:'dest-in'}]).png().toBuffer();
  }
  const layers=[{input:lower,left:0,top:0}];
  layers.push({input:masked,left:ART.left,top:ART.top},{input:overlaySvg(card,analysis),left:0,top:0});
  if(headEscape) layers.push({input:headEscape,left:ART.left,top:0,blend:'over'});
  const buffer=await sharp({create:{width:WIDTH,height:HEIGHT,channels:4,background:'#F5F5F5'}})
    .composite(layers)
    .png({compressionLevel:9,adaptiveFiltering:true})
    .toBuffer();

  return {buffer,tier,width:WIDTH,height:HEIGHT,style:'jtf-signature',composition:analysis.mode,palette:analysis.palette,accents:[analysis.accent1,analysis.accent2]};
}

module.exports={WIDTH,HEIGHT,ART,TIERS,available,tierFor,analyzeArtwork,overlaySvg,render};
