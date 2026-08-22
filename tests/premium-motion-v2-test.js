'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const animated=require('../src/animated-card');
const oldgen=require('../src/special-hunt-card');
(async()=>{const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'rimuru-v2-test-')),input=path.join(dir,'input.mp4'),preview=path.join(dir,'preview.mp4');try{
  await animated._run(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=700x900:rate=24','-t','6','-c:v','libx264','-pix_fmt','yuv420p',input],30000);
  const media=await fs.promises.readFile(input),poster=await animated.extractPoster(media,{mimeType:'video/mp4',duration:6});
  const base=await oldgen.render({name:'SERAPHINA VOSS',series:'THE BONEBOUND BRIDE',bio:'Premium motion visual integration test.',forced_tier:6},poster);
  const result=await animated.render({mediaBuffer:media,staticBuffer:base.buffer,mimeType:'video/mp4',duration:6,renderer:'oldgen',signature:'@PremiumOwner',seed:'motion-v2-test'});
  assert.strictEqual(result.duration,6);assert.strictEqual(result.width,700);assert.strictEqual(result.height,900);assert.ok(result.buffer.length>10000);assert.ok(animated.BORDERS.some(x=>x.key===result.border));
  await fs.promises.writeFile(preview,result.buffer);
  console.log(JSON.stringify({ok:true,bytes:result.buffer.length,border:result.border,preview}));
}finally{if(!process.env.KEEP_MOTION_TEST)await fs.promises.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
