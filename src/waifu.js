'use strict';
const config = require('./config');
const db = require('./db');

const ANILIST_URL = 'https://graphql.anilist.co';
const WAIFU_IM_URL = 'https://api.waifu.im/images';
const MAX_TELEGRAM_PHOTO_BYTES = 9_500_000;

const RARITY_TIERS = [
  { key: 'mythic', emoji: '🔴', label: 'MYTHIC', min: 50000 },
  { key: 'legendary', emoji: '🟠', label: 'LEGENDARY', min: 20000 },
  { key: 'epic', emoji: '🟣', label: 'EPIC', min: 5000 },
  { key: 'rare', emoji: '🔵', label: 'RARE', min: 500 },
  { key: 'common', emoji: '⚪', label: 'COMMON', min: 0 },
];

const CHARACTER_NAMES = [
  'Rem','Ram','Emilia','Asuna Yuuki','Mikasa Ackerman','Zero Two','Hinata Hyuga',
  'Nezuko Kamado','Mai Sakurajima','Chika Fujiwara','Rias Gremory','Yor Forger',
  'Aqua','Megumin','Raphtalia','Holo','Saber','Rin Tohsaka','Erza Scarlet','Nami',
  'Nico Robin','Boa Hancock','Bulma','Android 18','Tsunade','Rukia Kuchiki','Yoruichi',
  'Shion','Shuna','Milim Nava','Albedo','Shalltear Bloodfallen','Makima','Power',
  'Miku Nakano','Nino Nakano','Kaguya Shinomiya','Ai Hayasaka','Chizuru Ichinose',
];

const BOLD_UPPER = '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙';
const BOLD_LOWER = '𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳';
const BOLD_NUM = '𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗';
function fancy(s) {
  return String(s || '').replace(/[A-Za-z0-9]/g, (c) => {
    if (c >= 'A' && c <= 'Z') return BOLD_UPPER[c.charCodeAt(0) - 65];
    if (c >= 'a' && c <= 'z') return BOLD_LOWER[c.charCodeAt(0) - 97];
    return BOLD_NUM[c.charCodeAt(0) - 48];
  });
}
function stripUrls(s) { return String(s || '').replace(/https?:\/\/\S+/gi, '').replace(/www\.\S+/gi, '').trim(); }
function stripHtml(s) { return stripUrls(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim(); }
function truncate(s, max = 300) { const t = stripHtml(s); return t.length <= max ? t : `${t.slice(0, max - 1).trim()}…`; }
function wrapText(s, width = 34, maxLines = 6) {
  const words = truncate(s, width * maxLines).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const word of words) {
    if ((line + (line ? ' ' : '') + word).length > width) { if (line) lines.push(line); line = word; if (lines.length >= maxLines - 1) break; }
    else line += (line ? ' ' : '') + word;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}
function displaySeries(s) { const t = stripUrls(String(s || '').trim()); return !t || /^https?:\/\//i.test(t) ? '' : t; }
function randomCharacterName() { return CHARACTER_NAMES[Math.floor(Math.random() * CHARACTER_NAMES.length)]; }
function characterIdFor(value) { return `waifu-${String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`; }
function rarityFor(favorites) { const f = Number(favorites) || 0; return (RARITY_TIERS.find((t) => f >= t.min) || RARITY_TIERS[RARITY_TIERS.length - 1]).key; }
function rarityMeta(key) { return RARITY_TIERS.find((t) => t.key === key) || RARITY_TIERS[RARITY_TIERS.length - 1]; }
function isSpawnClaimable(spawn, now = Date.now()) { return !!spawn && Number(spawn.claimed) !== 1 && !(Number(spawn.expires_at) > 0 && Number(spawn.expires_at) <= now); }
function secondsRemaining(spawn, now = Date.now()) { return spawn ? Math.max(0, Math.ceil((Number(spawn.expires_at) - now) / 1000)) : 0; }

function normalizeCharacter(raw, source = 'anilist') {
  if (!raw || typeof raw !== 'object') return null;
  if (source === 'anilist') {
    const id = Number(raw.id) || 0;
    const imageUrl = raw.image && (raw.image.large || raw.image.medium) || '';
    const name = raw.name && (raw.name.full || raw.name.userPreferred) || '';
    if (!id || !imageUrl || !name) return null;
    const media = raw.media && raw.media.nodes || [];
    const title = (media[0] && media[0].title) || {};
    const series = title.english || title.romaji || title.native || '';
    const favorites = Number(raw.favourites) || 0;
    return { character_id: `anilist-${id}`, name: stripUrls(name), series: displaySeries(series), image_url: imageUrl, bio: stripHtml(raw.description || ''), favorites, rarity: rarityFor(favorites), source: 'AniList' };
  }
  const imageUrl = String(raw.url || '').trim();
  if (!imageUrl) return null;
  return { character_id: characterIdFor(imageUrl), name: randomCharacterName(), series: '', image_url: imageUrl, bio: '', favorites: 0, rarity: 'common', source };
}

function waifuCaption(char, spawn, claimerName = null, superDrop = false) {
  const meta = rarityMeta(char.rarity);
  const secs = secondsRemaining(spawn);
  const name = char.name || (superDrop ? 'Mysterious Super Waifu' : 'Mysterious Waifu');
  const intro = superDrop ? '✨ 𝐀 𝐒𝐔𝐏𝐄𝐑 𝐖𝐀𝐈𝐅𝐔 𝐉𝐔𝐒𝐓 𝐒𝐓𝐄𝐏𝐏𝐄𝐃 𝐓𝐇𝐑𝐎𝐔𝐆𝐇 𝐓𝐇𝐄 𝐉𝐓𝐅 𝐃𝐎𝐎𝐑𝐒! ✨' : '💫 𝐀 𝐖𝐀𝐈𝐅𝐔 𝐉𝐔𝐒𝐓 𝐄𝐍𝐓𝐄𝐑𝐄𝐃 𝐓𝐇𝐄 𝐉𝐓𝐅 𝐃𝐎𝐎𝐑𝐒! 💫';
  const bioLines = wrapText(char.bio || (superDrop ? 'A premium visitor from beyond the JTF doors.' : 'A mysterious visitor has arrived.'), 34, 5);
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
    `          💝  ${superDrop ? '𝐒𝐔𝐏𝐄𝐑 𝐖𝐀𝐈𝐅𝐔' : '𝐖𝐀𝐈𝐅𝐔 𝐃𝐑𝐎𝐏'}  💝`,
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '',
    `      ${intro}`,
    '',
    `              👤 ${fancy(name)}`,
    `                 #${stripUrls(char.character_id || '')}`,
  ];
  if (displaySeries(char.series)) lines.push('', `      🎬 ${fancy(displaySeries(char.series))}`);
  lines.push('', `          ${meta.emoji} 『 ${fancy(meta.label)} 』`, '', '╭──────────────────────────────╮', `📖 ${fancy('WAIFU INFO')}`, '', ...bioLines, '╰──────────────────────────────╯', '');
  if (claimerName) lines.push(`        ✅ ${fancy('CLAIMED BY')} ${stripUrls(claimerName)}`);
  else lines.push(`        ⏱️ ${fancy(String(secs))}𝐬 ${fancy('REMAINING')}`, `           ⚡ ${fancy('First claim wins!')}`);
  return lines.join('\n').slice(0, 1024);
}
function cardCaption(char, spawn, claimerName = null, superDrop = false) { return waifuCaption(char, spawn, claimerName, superDrop); }

function collectionCaption(rows) {
  if (!rows || !rows.length) return `💝 ${fancy('YOUR WAIFU COLLECTION')}\n\nYou haven't claimed anyone yet. Wait for a waifu drop!`;
  return `💝 ${fancy('YOUR WAIFU COLLECTION')}\n\n${rows.map((r, i) => `${i + 1}. ${fancy(stripUrls(r.name || 'Unknown'))}${displaySeries(r.series) ? ` — ${fancy(displaySeries(r.series))}` : ''}`).join('\n')}\n\n📚 ${fancy(String(rows.length))} waifu${rows.length === 1 ? '' : 's'} claimed.`;
}
function detailCaption(row) { if (!row) return '💔 Not found.'; const meta = rarityMeta(row.rarity); return [`💝 ${fancy(stripUrls(row.name || 'Unknown'))}`, `🆔 #${stripUrls(row.character_id || '')}`, displaySeries(row.series) ? `🎬 ${fancy(displaySeries(row.series))}` : '', `${meta.emoji} ${fancy(meta.label)}`].filter(Boolean).join('\n'); }
function leaderboardCaption(rows) { if (!rows || !rows.length) return `💝 ${fancy('WAIFU LEADERBOARD')}\n\nNobody has claimed a waifu yet.`; return `💝 ${fancy('WAIFU COLLECTION LEADERBOARD')}\n\n${rows.map((r, i) => `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`} ${fancy(stripUrls(r.first_name || r.username || `User ${r.user_id}`))} — ${Number(r.count) || 0}`).join('\n')}`; }
function characterCaption(rows) { return collectionCaption(rows); }
function claimMarkup() { return { inline_keyboard: [[{ text: '💝 CLAIM WAIFU', callback_data: 'waifu:claim' }]] }; }

async function fetchAniListPage(page) {
  const query = `query ($page: Int) { Page(page: $page, perPage: 25) { characters(sort: FAVOURITES_DESC) { id gender name { full userPreferred } image { large medium } description(asHtml: false) favourites media(perPage: 3, sort: POPULARITY_DESC) { nodes { title { romaji english native } } } } } }`;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), config.waifu.fetchTimeoutMs || 10000); timer.unref && timer.unref();
  try {
    const res = await fetch(ANILIST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': config.waifu.userAgent || 'RimuruTempestCasino/1.0' }, body: JSON.stringify({ query, variables: { page } }), signal: ac.signal });
    if (!res.ok) return [];
    const json = await res.json();
    return json && json.data && json.data.Page && Array.isArray(json.data.Page.characters) ? json.data.Page.characters : [];
  } catch (_) { return []; } finally { clearTimeout(timer); }
}
async function fetchFromJikanByName(name) {
  const base = config.hunt && config.hunt.searchUrl || 'https://api.jikan.moe/v4/characters';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), config.waifu.fetchTimeoutMs || 10000); timer.unref && timer.unref();
  try {
    const res = await fetch(`${base}?q=${encodeURIComponent(name)}&limit=1`, { headers: { Accept: 'application/json', 'User-Agent': config.waifu.userAgent || 'RimuruTempestCasino/1.0' }, signal: ac.signal });
    if (!res.ok) return null;
    const json = await res.json(); const raw = json && json.data && json.data[0]; if (!raw) return null;
    const imageUrl = raw.images && raw.images.jpg && (raw.images.jpg.large_image_url || raw.images.jpg.image_url) || ''; if (!imageUrl) return null;
    const favorites = Number(raw.favorites) || 0;
    return { character_id: `jikan-${raw.mal_id}`, name: stripUrls(raw.name || name), series: '', image_url: imageUrl, bio: stripHtml(raw.about || ''), favorites, rarity: rarityFor(favorites), source: 'Jikan' };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}
async function fetchFromWaifuIm() {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), config.waifu.fetchTimeoutMs || 10000); timer.unref && timer.unref();
  try {
    const url = `${WAIFU_IM_URL}?IncludedTags=waifu&IsNsfw=False&PageSize=30`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': config.waifu.userAgent || 'RimuruTempestCasino/1.0' }, signal: ac.signal });
    if (!res.ok) return null;
    const json = await res.json(); const items = Array.isArray(json && json.items) ? json.items : []; if (!items.length) return null;
    const score = (x) => (Number(x.width) || 0) * (Number(x.height) || 0) + Math.min(Number(x.byte_size || x.file_size || 0) || 0, 20_000_000);
    const candidates = items.filter((x) => Number(x.byte_size || x.file_size || 0) <= MAX_TELEGRAM_PHOTO_BYTES || !Number(x.byte_size || x.file_size || 0)).sort((a,b) => score(b) - score(a));
    const best = candidates[0] || items[0]; const imageUrl = best && (best.url || best.image_url); if (!imageUrl) return null;
    const rawId = best.image_id || best.id || imageUrl;
    return { character_id: `waifuim-${String(rawId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0,48)}`, name: 'Mysterious Super Waifu', series: '', image_url: String(imageUrl), bio: 'A premium waifu has crossed the JTF threshold.', favorites: 20000, rarity: 'legendary', source: 'Waifu.im' };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}
async function fetchCharacter() {
  for (let attempt=0; attempt<5; attempt++) {
    const chars = await fetchAniListPage(1 + Math.floor(Math.random()*80));
    const females = chars.filter((c) => String(c.gender || '').toLowerCase() === 'female');
    for (let i=females.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [females[i],females[j]]=[females[j],females[i]]; }
    for (const raw of females) { const card=normalizeCharacter(raw,'anilist'); if (card && !db.isWaifuCharacterClaimed(card.character_id)) return card; }
  }
  for (let attempt=0; attempt<4; attempt++) { const card=await fetchFromJikanByName(randomCharacterName()); if (card && !db.isWaifuCharacterClaimed(card.character_id)) return card; }
  return null;
}

let deps=null;
function attach(d){ deps=d||null; return module.exports; }
async function reply(chatId,text,opts={}){ if(deps&&typeof deps.reply==='function') try{return await deps.reply(chatId,text,opts);}catch(e){console.warn('[waifu] reply:',e.message);} return null; }
async function fetchImageBuffer(url) {
  const ac = new AbortController(); const timer=setTimeout(()=>ac.abort(), config.waifu.fetchTimeoutMs || 10000); timer.unref&&timer.unref();
  try {
    const res=await fetch(url,{headers:{Accept:'image/*','User-Agent':config.waifu.userAgent||'RimuruTempestCasino/1.0'},signal:ac.signal});
    if(!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type=String(res.headers.get('content-type')||'image/jpeg').split(';')[0];
    if(!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    const arr=await res.arrayBuffer(); if(arr.byteLength>MAX_TELEGRAM_PHOTO_BYTES) throw new Error('image too large for Telegram photo');
    return {buffer:Buffer.from(arr), contentType:type};
  } finally { clearTimeout(timer); }
}
async function sendPhoto(chatId,imageUrl,caption,markup){
  if(!deps||typeof deps.sendPhoto!=='function') return null;
  let firstError=null;
  try { const img=await fetchImageBuffer(imageUrl); return await deps.sendPhoto(chatId,img.buffer,{caption,reply_markup:markup},{filename:`waifu.${img.contentType.includes('png')?'png':'jpg'}`,contentType:img.contentType}); } catch(e){ firstError=e; console.warn('[waifu] buffered photo:',e.message); }
  try { return await deps.sendPhoto(chatId,imageUrl,{caption,reply_markup:markup}); } catch(e){ console.warn('[waifu] URL photo:',e.message); }
  return reply(chatId,caption,{title:'💝 WAIFU',reply_markup:markup,alwaysShowMarkup:true});
}
async function answerCb(text){ if(deps&&typeof deps.answerCb==='function') try{await deps.answerCb(text);}catch(_){} }

async function spawn(opts={}){
  if(!config.waifu.enabled)return{ok:false,message:'The waifu collection is disabled.'}; expireIfNeeded();
  const existing=db.getActiveWaifu(); if(isSpawnClaimable(existing))return{ok:false,message:`💝 A waifu is already up for grabs (${secondsRemaining(existing)}s left).`}; if(existing)db.clearActiveWaifu();
  const card=await fetchCharacter(); if(!card)return{ok:false,message:'💔 The waifu portal is quiet right now. Try again shortly.'};
  const expiresAt=Date.now()+config.waifu.claimWindowMs; db.setActiveWaifu(card,expiresAt,Number(opts.chatId)||0); const row=db.getActiveWaifu();
  await sendPhoto(opts.chatId,card.image_url,waifuCaption(card,row,null,false),claimMarkup()); return{ok:true,character:card,expiresAt};
}
async function spawnSuper(opts={}){
  if(!config.waifu.enabled)return{ok:false,message:'The waifu collection is disabled.'}; expireIfNeeded();
  const existing=db.getActiveWaifu(); if(isSpawnClaimable(existing))return{ok:false,message:`💍 A waifu is already up for grabs (${secondsRemaining(existing)}s left).`}; if(existing)db.clearActiveWaifu();
  let card=null; for(let attempt=0;attempt<4;attempt++){const c=await fetchFromWaifuIm(); if(c&&!db.isWaifuCharacterClaimed(c.character_id)){card=c;break;}}
  if(!card)return{ok:false,message:'💔 The SUPER waifu portal is quiet right now. Try again shortly.'};
  const expiresAt=Date.now()+config.waifu.claimWindowMs; db.setActiveWaifu(card,expiresAt,Number(opts.chatId)||0); const row=db.getActiveWaifu();
  await sendPhoto(opts.chatId,card.image_url,waifuCaption(card,row,null,true),claimMarkup()); return{ok:true,character:card,expiresAt,super:true};
}
async function claim(userId,opts={}){
  const answer=typeof opts.answerCb==='function'?opts.answerCb:answerCb,row=db.getActiveWaifu(); if(!row)return await answer('No waifu is up for grabs right now.'),{ok:false,reason:'no-active-spawn'}; if(!isSpawnClaimable(row))return await answer('This waifu already expired or was claimed.'),{ok:false,reason:'not-claimable'};
  const char={character_id:row.character_id,name:row.name,series:row.series,image_url:row.image_url,bio:row.bio,favorites:row.favorites,rarity:row.rarity}; if(!db.claimWaifuCharacter(userId,char))return await answer('Someone else already claimed this waifu!'),{ok:false,reason:'already-claimed'};
  db.clearActiveWaifu(); const user=db.getUser(userId)||{},claimer=user.username?`@${user.username}`:user.first_name||`user ${userId}`; await reply(opts.chatId||row.chat_id,waifuCaption(char,row,claimer,false),{title:'💝 CLAIMED'}); return{ok:true,character:char,userId};
}
function expireIfNeeded(now=Date.now()){const row=db.getActiveWaifu();if(!row||isSpawnClaimable(row,now))return 0;db.clearActiveWaifu();return 1;}
async function autoSpawnTick(env={}){expireIfNeeded();if(isSpawnClaimable(db.getActiveWaifu()))return;const groups=(typeof env.getChatIds==='function'?env.getChatIds():[]).filter((id)=>Number(id)<0);if(!groups.length)return;const card=await fetchCharacter();if(!card)return;const expiresAt=Date.now()+config.waifu.claimWindowMs;db.setActiveWaifu(card,expiresAt,groups[0]);const row=db.getActiveWaifu();for(const gid of groups)await sendPhoto(gid,card.image_url,waifuCaption(card,row,null,false),claimMarkup());}
let autoSpawnTimer=null,autoSpawnKickoff=null;
function msUntilMinute(minute){const now=new Date(),next=new Date(now);next.setSeconds(0,0);next.setMinutes(minute);if(next<=now)next.setHours(next.getHours()+1);return next-now;}
function startAutoSpawn(_bot,env={}){if(autoSpawnTimer||autoSpawnKickoff||!config.waifu.enabled)return autoSpawnTimer||autoSpawnKickoff;autoSpawnKickoff=setTimeout(()=>{autoSpawnKickoff=null;autoSpawnTick(env).catch((e)=>console.warn('[waifu] auto:',e.message));autoSpawnTimer=setInterval(()=>autoSpawnTick(env).catch((e)=>console.warn('[waifu] auto:',e.message)),3600000);autoSpawnTimer.unref&&autoSpawnTimer.unref();},msUntilMinute(15));autoSpawnKickoff.unref&&autoSpawnKickoff.unref();console.log('[waifu] hourly auto-spawn scheduled at :15');return autoSpawnKickoff;}
function state(){return{activeSpawn:db.getActiveWaifu()||null,enabled:config.waifu.enabled};}
module.exports={CHARACTER_NAMES,RARITY_TIERS,randomCharacterName,characterIdFor,rarityFor,rarityMeta,normalizeCharacter,isSpawnClaimable,secondsRemaining,cardCaption,waifuCaption,collectionCaption,detailCaption,leaderboardCaption,characterCaption,claimMarkup,fetchCharacter,fetchAniListPage,fetchFromJikanByName,fetchFromWaifuIm,attach,spawn,spawnSuper,claim,expireIfNeeded,startAutoSpawn,autoSpawnTick,state,_clear:()=>db.clearActiveWaifu()};
