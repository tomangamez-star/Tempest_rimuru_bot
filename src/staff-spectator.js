'use strict';
const db = require('./db');
const config = require('./config');
const { esc } = require('./utils');

let bot = null;
const active = new Map(); // game:chat:player -> { ... , dm: Map<staffId,messageId> }

function attach(b){ bot=b; }
function key(game, chatId, playerId){ return `${game}:${chatId}:${playerId}`; }
function staffIds(){
  const ids=new Set([Number(config.ownerId)]);
  try{ for(const r of db.listAdminUsers()) if(r && r.user_id) ids.add(Number(r.user_id)); }catch(e){}
  return [...ids].filter(Number.isFinite);
}
function playerLabel(s){
  if(s.playerName) return s.playerName;
  try{ const u=db.getUser(Number(s.userId)); return (u && (u.first_name||u.username)) || String(s.userId); }catch(e){ return String(s.userId); }
}
async function publish(game,s,body,secrets=[]){
  if(!bot || !s || !Number.isFinite(Number(s.chatId)) || Number(s.chatId)>=0) return;
  const k=key(game,Number(s.chatId),Number(s.userId));
  let rec=active.get(k);
  if(!rec){rec={game,chatId:Number(s.chatId),playerId:Number(s.userId),dm:new Map()};active.set(k,rec);}
  rec.secrets=new Set((secrets||[]).map(v=>String(v).toLowerCase()));
  rec.updatedAt=Date.now();
  const txt=`🕵️ <b>STAFF GAME PREVIEW</b>\n\n🎮 <b>${esc(game.toUpperCase())}</b>\n👤 Player: <b>${esc(playerLabel(s))}</b> <code>${s.userId}</code>\n💬 Group: <code>${s.chatId}</code>\n\n${body}\n\n⚠️ <i>Do not leak active answers. Staff playing this round are excluded.</i>`;
  await Promise.allSettled(staffIds().map(async sid=>{
    if(Number(sid)===Number(s.userId)) return;
    const mid=rec.dm.get(sid);
    if(mid){
      try{await bot.editMessageText(txt,{chat_id:sid,message_id:mid,parse_mode:'HTML'});return;}catch(e){}
    }
    try{const m=await bot.sendMessage(sid,txt,{parse_mode:'HTML'});rec.dm.set(sid,m.message_id);}catch(e){}
  }));
}
async function end(game,s,reason='Round ended'){
  if(!bot || !s) return;
  const k=key(game,Number(s.chatId),Number(s.userId)),rec=active.get(k); if(!rec)return;
  active.delete(k);
  const txt=`✅ <b>STAFF GAME PREVIEW — ENDED</b>\n\n🎮 <b>${esc(game.toUpperCase())}</b>\n👤 Player: <code>${s.userId}</code>\n${esc(reason)}`;
  await Promise.allSettled([...rec.dm.entries()].map(async([sid,mid])=>{try{await bot.editMessageText(txt,{chat_id:sid,message_id:mid,parse_mode:'HTML'});}catch(e){}}));
}

function mines(s){const cells=[...s.mines].map(n=>Number(n)+1).sort((a,b)=>a-b);return publish('mines',s,`💣 Mine cells: <b>${cells.join(', ')}</b>\n🔄 These update after every safe pick.`,cells);}
function guess(s){return publish('guess',s,`🎯 Correct answer: <b>${s.answer}</b>`,[s.answer]);}
function higherLower(s){const next=s.deck && s.deck.length?s.deck[s.deck.length-1]:null;return publish('higher/lower',s,`🂠 Current: <b>${esc(s.current ? `${s.current.rank}${s.current.suit}`:'?')}</b>\n➡️ Next card: <b>${esc(next?`${next.rank}${next.suit}`:'?')}</b>`,next?[`${next.rank}${next.suit}`,next.rank]:[]);}
function blackjack(s){const hole=s.dealer&&s.dealer[0],next=s.deck&&s.deck.length?s.deck[s.deck.length-1]:null;return publish('blackjack',s,`♣ Dealer full hand: <b>${esc((s.dealer||[]).join(' '))}</b>\n➡️ Next deck card: <b>${esc(next||'?')}</b>`,[hole,next].filter(Boolean));}
function crash(s){return publish('crash',s,`💥 Crash point: <b>${Number(s.crashPoint).toFixed(2)}x</b>`,[Number(s.crashPoint).toFixed(2),`${Number(s.crashPoint).toFixed(2)}x`]);}

async function checkAndStripLeak(msg,isStaff){
  if(!bot || !isStaff || !msg || !msg.chat || Number(msg.chat.id)>=0 || !msg.from) return false;
  if(Number(msg.from.id)===Number(config.ownerId)) return false; // owner is trusted; anti-leak enforcement targets moderators
  const text=String(msg.text||msg.caption||'').trim(); if(!text || text.startsWith('/')) return false;
  const lower=text.toLowerCase();
  for(const rec of active.values()){
    if(rec.chatId!==Number(msg.chat.id) || rec.playerId===Number(msg.from.id) || !rec.secrets || !rec.secrets.size) continue;
    let hit=false;
    for(const secret of rec.secrets){
      if(!secret)continue;
      if(/^\d+(?:\.\d+)?$/.test(secret)){
        const re=new RegExp(`(^|\\D)${secret.replace('.','\\.')}(?:x)?($|\\D)`,'i'); if(re.test(lower)&&lower.length<=80){hit=true;break;}
      }else if(lower.length<=80 && lower.includes(secret)){hit=true;break;}
    }
    if(hit){
      try{await bot.deleteMessage(msg.chat.id,msg.message_id);}catch(e){}
      try{db.logActivity('staff_cheat_blocked',`Staff preview leak blocked from user ${msg.from.id}`,{staff:Number(msg.from.id),chat:Number(msg.chat.id),game:rec.game,player:rec.playerId});}catch(e){}
      try{await bot.sendMessage(msg.from.id,`⚠️ <b>STAFF PREVIEW LEAK BLOCKED</b>\nYour message matched an active ${esc(rec.game)} secret and was removed.`,{parse_mode:'HTML'});}catch(e){}
      return true;
    }
  }
  return false;
}

module.exports={attach,mines,guess,higherLower,blackjack,crash,end,checkAndStripLeak,_active:active};
