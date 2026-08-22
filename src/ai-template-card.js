'use strict';

// Renderer #4 — JTF AI Custom.
// AI supplies a compact, text-free art-direction blueprint. Sharp owns the
// final pixels and every factual string, so names/series can never be invented
// or misspelled by an image model.

const crypto = require('crypto');
const signature = require('./jtf-gen-card');

const WIDTH = 700;
const HEIGHT = 900;
const blueprintCache = new Map();
let sharpModule;
function sharp() { if (sharpModule === undefined) { try { sharpModule=require('sharp'); } catch (_) { sharpModule=null; } } return sharpModule; }
function available() { return !!sharp(); }
function clean(v,max=500){return String(v==null?'':v).replace(/<[^>]+>/g,' ').replace(/https?:\/\/\S+/gi,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function esc(v){return clean(v,1200).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function validHex(v,fallback){return /^#[0-9a-f]{6}$/i.test(String(v||''))?String(v).toUpperCase():fallback;}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,Number(v)||0));}
function hash(card,image){return crypto.createHash('sha256').update(String(card.name||'')).update(String(card.series||'')).update(image).digest('hex').slice(0,24);}
function extractJson(text){const s=String(text||'');const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<=a)return null;try{return JSON.parse(s.slice(a,b+1));}catch(_){return null;}}

function localBlueprint(card, analysis, tier) {
  const source=`${clean(card.name)} ${clean(card.series)} ${clean(card.bio||card.description)}`.toLowerCase();
  let motif='crystal',font='tech',mood='radiant';
  if(/chainsaw|makima|denji|devil|chain/.test(source)){motif='chains';font='brush';mood='ominous';}
  else if(/naruto|uchiha|madara|shinobi|ninja/.test(source)){motif='chakra';font='impact';mood='ferocious';}
  else if(/jujutsu|gojo|sukuna|curse/.test(source)){motif='runes';font='tech';mood='infinite';}
  else if(/demon slayer|nezuko|tanjiro|hashira/.test(source)){motif='petals';font='elegant';mood='dramatic';}
  else if(/rimuru|slime|water|aqua/.test(source)){motif='bubbles';font='rounded';mood='luminous';}
  else if(/christmas|holiday|santa|snow/.test(source)){motif='snow';font='rounded';mood='festive';}
  return {theme:`${clean(card.series||'JTF')} ${mood}`,motif,font,mood,primary:analysis.accent1,secondary:analysis.accent2,accent:tier.base2,energy:Math.min(10,4+tier.tier),frame:'full-art'};
}

async function aiBlueprint(card,imageBuffer,analysis,tier){
  const key=String(process.env.GROQ_API_KEY||'').trim();
  if(!key)return localBlueprint(card,analysis,tier);
  const ck=hash(card,imageBuffer);if(blueprintCache.has(ck))return blueprintCache.get(ck);
  try{
    const preview=await sharp()(imageBuffer).rotate().resize({width:768,height:768,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
    const prompt=`Act as art director for a premium anime collectible card. Character: ${clean(card.name,80)}. Series: ${clean(card.series,100)}. Tier: T${tier.tier} ${tier.label}. Analyze the supplied artwork only. Return JSON only with: theme (short), motif (one of chains,chakra,runes,petals,bubbles,snow,flames,lightning,crystal,stars), font (one of impact,brush,elegant,tech,rounded), mood (short), primary (#RRGGBB), secondary (#RRGGBB), accent (#RRGGBB), energy (1-10), frame (full-art). Do not generate or spell any card text.`;
    const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:String(process.env.GROQ_VISION_MODEL||'qwen/qwen3.6-27b'),temperature:.35,max_tokens:260,response_format:{type:'json_object'},messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${preview.toString('base64')}`}}]}]})});
    if(!res.ok)throw Error(`Groq HTTP ${res.status}`);
    const json=await res.json(),raw=json&&json.choices&&json.choices[0]&&json.choices[0].message&&json.choices[0].message.content;
    const parsed=extractJson(raw)||{};
    const bp={...localBlueprint(card,analysis,tier),...parsed};
    bp.primary=validHex(bp.primary,analysis.accent1);bp.secondary=validHex(bp.secondary,analysis.accent2);bp.accent=validHex(bp.accent,tier.base2);
    bp.energy=clamp(bp.energy,1,10);bp.motif=['chains','chakra','runes','petals','bubbles','snow','flames','lightning','crystal','stars'].includes(bp.motif)?bp.motif:'crystal';
    bp.font=['impact','brush','elegant','tech','rounded'].includes(bp.font)?bp.font:'tech';
    blueprintCache.set(ck,bp);while(blueprintCache.size>30)blueprintCache.delete(blueprintCache.keys().next().value);
    return bp;
  }catch(e){console.warn(`[ai-template] blueprint fallback for ${card.name||'card'}: ${e.message}`);return localBlueprint(card,analysis,tier);}
}

function fontFamily(style){
  return ({impact:'Nimbus Sans Narrow,DejaVu Sans Condensed,sans-serif',brush:'URW Gothic,DejaVu Sans,sans-serif',elegant:'URW Bookman,DejaVu Serif,serif',tech:'Nimbus Sans,DejaVu Sans,sans-serif',rounded:'URW Bookman,DejaVu Sans,sans-serif'})[style]||'DejaVu Sans,sans-serif';
}
function nameSize(name){const n=clean(name,100).length;return n<=10?58:n<=16?49:n<=23?40:33;}
function seriesSize(s){const n=clean(s,100).length;return n<=22?23:n<=38?19:15;}
function wrap(v,chars=48,lines=3){const words=clean(v,500).split(/\s+/).filter(Boolean),out=[];let line='';for(const w of words){const next=line?`${line} ${w}`:w;if(next.length>chars&&line){out.push(line);line=w;if(out.length>=lines-1)break;}else line=next;}if(line&&out.length<lines)out.push(line);return out.length?out:['A one-of-one JTF custom collectible.'];}
function starRow(n){n=clamp(n,1,6);const gap=n===6?63:70,start=350-((n-1)*gap)/2;return Array.from({length:n},(_,i)=>`<g transform="translate(${start+i*gap} 596)" filter="url(#glow)"><polygon points="0,-29 8,-9 29,-9 12,4 18,25 0,13 -18,25 -12,4 -29,-9 -8,-9" fill="url(#metal)" stroke="#fff" stroke-width="2"/><polygon points="0,-18 5,-6 18,-6 8,2 11,15 0,8 -11,15 -8,2 -18,-6 -5,-6" fill="none" stroke="#fff" stroke-opacity=".6"/></g>`).join('');}
function motifSvg(bp){const p=bp.primary,s=bp.secondary,a=bp.accent,e=.16+bp.energy*.025;let out='';
  if(bp.motif==='chains'){for(let i=0;i<11;i++){const x=20+i*68,y=110+(i%2)*560;out+=`<ellipse cx="${x}" cy="${y}" rx="11" ry="25" transform="rotate(${i%2?42:-42} ${x} ${y})" fill="none" stroke="${i%2?s:a}" stroke-width="6" opacity="${e}"/>`;}}
  else if(bp.motif==='bubbles'||bp.motif==='snow'||bp.motif==='stars'){for(let i=0;i<22;i++){const x=(i*97)%680,y=55+((i*149)%790),r=5+(i%5)*4;out+=bp.motif==='stars'?`<polygon points="${x},${y-r} ${x+r*.3},${y-r*.2} ${x+r},${y} ${x+r*.3},${y+r*.2} ${x},${y+r} ${x-r*.3},${y+r*.2} ${x-r},${y} ${x-r*.3},${y-r*.2}" fill="${i%2?p:s}" opacity="${e}"/>`:`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${i%2?p:s}" stroke-width="3" opacity="${e}"/>`;}}
  else if(bp.motif==='petals'){for(let i=0;i<18;i++){const x=(i*113)%690,y=40+((i*173)%820);out+=`<ellipse cx="${x}" cy="${y}" rx="7" ry="20" transform="rotate(${i*31} ${x} ${y})" fill="${i%2?p:s}" opacity="${e}"/>`;}}
  else {for(let i=0;i<13;i++){const x=(i*79)%700,y=60+((i*137)%780);out+=`<polygon points="${x},${y-28} ${x+24},${y-14} ${x+24},${y+14} ${x},${y+28} ${x-24},${y+14} ${x-24},${y-14}" fill="none" stroke="${i%2?p:s}" stroke-width="${2+i%3}" opacity="${e}"/>`;}}
  return out;
}
function overlay(card,bp,tier){const name=esc(clean(card.name||'CHARACTER',100).toUpperCase()),series=esc(clean(card.series||'JTF',100).toUpperCase()),font=fontFamily(bp.font),desc=wrap(card.bio||card.description,48,3).map((x,i)=>`<text x="350" y="${705+i*29}" text-anchor="middle" font-size="19" font-family="Nimbus Sans,DejaVu Sans,sans-serif" font-weight="700" fill="#fff">${esc(x)}</text>`).join('');
  return Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="edge"><stop stop-color="${bp.primary}"/><stop offset=".5" stop-color="${bp.accent}"/><stop offset="1" stop-color="${bp.secondary}"/></linearGradient><radialGradient id="metal"><stop stop-color="#fff"/><stop offset=".28" stop-color="${bp.secondary}"/><stop offset=".72" stop-color="${bp.primary}"/><stop offset="1" stop-color="${bp.accent}"/></radialGradient><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#000" stop-opacity="0"/><stop offset=".62" stop-color="#07060d" stop-opacity=".20"/><stop offset="1" stop-color="#07060d" stop-opacity=".92"/></linearGradient><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="shadow"><feGaussianBlur in="SourceAlpha" stdDeviation="5"/><feOffset dy="5"/><feComponentTransfer><feFuncA type="linear" slope=".6"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${motifSvg(bp)}<rect x="25" y="25" width="650" height="850" rx="18" fill="none" stroke="#07070a" stroke-width="16"/><rect x="31" y="31" width="638" height="838" rx="14" fill="none" stroke="url(#edge)" stroke-width="7"/><path d="M42 625 H658 V858 H42 Z" fill="url(#shade)"/><path d="M64 572 H636 L663 594 L636 616 H64 L37 594 Z" fill="#090811" fill-opacity=".72" stroke="url(#edge)" stroke-width="5" filter="url(#shadow)"/>${starRow(tier.tier)}<text x="350" y="535" text-anchor="middle" font-size="${nameSize(name)}" font-family="${font}" font-style="${bp.font==='elegant'?'italic':'normal'}" font-weight="900" letter-spacing="${bp.font==='tech'?'3':'1'}" fill="#fff" stroke="${bp.primary}" stroke-width="4" paint-order="stroke" filter="url(#glow)">${name}</text><text x="62" y="75" font-size="19" font-family="${font}" font-weight="900" fill="#fff" stroke="#111" stroke-width="2" paint-order="stroke">T${tier.tier} ${tier.label}</text><text x="350" y="665" text-anchor="middle" font-size="12" font-family="Nimbus Sans,DejaVu Sans,sans-serif" letter-spacing="3" fill="${bp.accent}">${esc(clean(bp.theme,55).toUpperCase())}</text>${desc}<path d="M95 810 H605 L630 839 L605 862 H95 L70 839 Z" fill="#090811" fill-opacity=".80" stroke="url(#edge)" stroke-width="3"/><text x="350" y="848" text-anchor="middle" font-size="${seriesSize(series)}" font-family="${font}" font-weight="900" fill="#fff">${series}</text><text x="650" y="884" text-anchor="end" font-size="13" font-family="Nimbus Sans,DejaVu Sans,sans-serif" font-weight="900" fill="${bp.secondary}">✦ JTF AI CUSTOM</text></svg>`);
}

async function render(card,imageBuffer){const sh=sharp();if(!sh||!Buffer.isBuffer(imageBuffer)||!imageBuffer.length)return null;const tier=signature.tierFor(card),analysis=await signature.analyzeArtwork(imageBuffer,tier),bp=await aiBlueprint(card,imageBuffer,analysis,tier);const hero=await sh(imageBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'attention'}).modulate({saturation:1.08,brightness:.91}).png().toBuffer();const aura=Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="a"><stop stop-color="${bp.secondary}" stop-opacity=".08"/><stop offset=".62" stop-color="${bp.primary}" stop-opacity=".10"/><stop offset="1" stop-color="#050509" stop-opacity=".72"/></radialGradient></defs><rect width="700" height="900" fill="url(#a)"/></svg>`);const buffer=await sh({create:{width:WIDTH,height:HEIGHT,channels:4,background:'#08080c'}}).composite([{input:hero},{input:aura,blend:'over'},{input:overlay(card,bp,tier)}]).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();return{buffer,tier,width:WIDTH,height:HEIGHT,style:'ai-template',blueprint:bp,composition:'ai-directed',accents:[bp.primary,bp.secondary,bp.accent]};}

module.exports={WIDTH,HEIGHT,available,render,aiBlueprint,localBlueprint,_cache:blueprintCache};
