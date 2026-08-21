'use strict';
const db=require('./db');
const crypto=require('crypto');
const BUCKET=process.env.SUPABASE_CARDS_BUCKET||'jtf-cards';
function projectUrl(){ if(process.env.SUPABASE_URL)return process.env.SUPABASE_URL.replace(/\/$/,''); const m=String(process.env.DATABASE_URL||'').match(/postgres\.([a-z0-9]+):/i); return m?`https://${m[1]}.supabase.co`:''; }
function key(){return process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||'';}
function ready(){return !!(projectUrl()&&key());}
function dayKey(){return new Date().toISOString().slice(0,10);}
function normName(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function overrideKey(name,tier){return `${normName(name)}:t${Number(tier)||0}`;}
function newId(){return `JTF${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;}
let bucketReady=false; async function ensureBucket(){if(bucketReady)return;const r=await fetch(`${projectUrl()}/storage/v1/bucket`,{method:'POST',headers:{Authorization:`Bearer ${key()}`,apikey:key(),'Content-Type':'application/json'},body:JSON.stringify({id:BUCKET,name:BUCKET,public:false,file_size_limit:20971520})});if(!r.ok&&r.status!==409){const text=await r.text();if(!/already exists/i.test(text))throw new Error(`Supabase bucket HTTP ${r.status}: ${text.slice(0,120)}`);}bucketReady=true;}
async function upload(cardId,buffer){ if(!ready())throw new Error('Supabase card storage key is not configured (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY)'); await ensureBucket(); const path=`custom/${cardId}.png`,url=`${projectUrl()}/storage/v1/object/${BUCKET}/${path}`; const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${key()}`,apikey:key(),'Content-Type':'image/png','x-upsert':'true'},body:buffer}); if(!r.ok)throw new Error(`Supabase Storage HTTP ${r.status}: ${(await r.text()).slice(0,120)}`); return path; }
async function download(path){ if(!ready())throw new Error('Supabase card storage is not configured'); const r=await fetch(`${projectUrl()}/storage/v1/object/authenticated/${BUCKET}/${path}`,{headers:{Authorization:`Bearer ${key()}`,apikey:key()}}); if(!r.ok)throw new Error(`Supabase Storage download HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
function count(userId){return db.getCustomRenderCount(userId,dayKey());}
function mark(userId){return db.incrementCustomRenderCount(userId,dayKey());}
function save(meta,path){return db.saveCustomCard({...meta,storage_path:path,created_at:Date.now()});}
function findLatestByNameTier(name,tier){return db.getLatestCustomCardByNameTier(name,tier);}
function list(userId){return db.getUserCustomCards(userId,50);}
function get(id){return db.getCustomCard(String(id||'').replace(/^#/,'').toUpperCase());}
function setOverride(cardId,ownerId){const c=get(cardId);if(!c)return null; return db.setCardOverride({override_key:overrideKey(c.name,c.tier),card_id:c.card_id,name:c.name,tier:c.tier,renderer:c.renderer,set_by:ownerId,created_at:Date.now()});}
function resetOverride(name,tier){const k=overrideKey(name,tier);db.deleteCardOverride(k);return k;}
function findOverride(name,tier){const o=db.getCardOverride(overrideKey(name,tier)); if(!o)return null; const c=get(o.card_id); return c?{...o,card:c}:null;}
module.exports={ready,BUCKET,newId,upload,download,count,mark,save,list,get,setOverride,resetOverride,findOverride,overrideKey,findLatestByNameTier};
