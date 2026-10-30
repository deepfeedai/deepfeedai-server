const {test}=require('node:test');
const assert=require('node:assert/strict');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0sAAAAASUVORK5CYII=';
const {imageError,publicImageError,decodePng}=require('../lib/image-errors');
function mocked(modules, target) {
  const saved=new Map();
  for(const [name,exports] of Object.entries(modules)){const p=require.resolve('../'+name);saved.set(p,require.cache[p]);require.cache[p]={id:p,filename:p,loaded:true,exports};}
  const p=require.resolve('../'+target);saved.set(p,require.cache[p]);delete require.cache[p];
  const result=require(p);
  return {result,restore(){for(const [p,old] of saved){if(old)require.cache[p]=old;else delete require.cache[p];}}};
}
test('GPT Image uses native parameters, decoded PNG, explicit quality and reported usage',async()=>{
  const old=global.fetch;let body;
  global.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);return{ok:true,json:async()=>({data:[{b64_json:png}],usage:{input_tokens:10,output_tokens:20}})}};
  try{const result=await require('../lib/providers/openai-image').generate({apiKey:'test-only',model:'gpt-image-2',prompt:'offline',quality:'medium'});assert.equal(result.b64,png);assert.equal(body.size,'1536x1024');assert.equal(body.output_format,'png');assert.equal(body.quality,'medium');assert.equal(body.response_format,undefined);assert.equal(result.usage.output_tokens,20);}finally{global.fetch=old;}
});
test('invalid/retired models fail before fetch; error bodies never escape',async()=>{
 const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;return{ok:false,status:401,text:async()=> 'secret-key private prompt'}};
 try{const p=require('../lib/providers/openai-image');await assert.rejects(p.generate({apiKey:'test',model:'dall-e-3',prompt:'x'}),{code:'IMAGE_CONFIG'});assert.equal(calls,0);await assert.rejects(p.generate({apiKey:'test',prompt:'x'}),e=>e.code==='IMAGE_PROVIDER'&&!e.message.includes('secret'));}finally{global.fetch=old;}
});
test('timeout is explicit and never automatically retryable',async()=>{
 const old=global.fetch;global.fetch=async(_u,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 try{await assert.rejects(require('../lib/providers/openai-image').generate({apiKey:'test',prompt:'x',timeoutMs:5}),e=>e.code==='IMAGE_TIMEOUT'&&e.retryable===false);}finally{global.fetch=old;}
});
test('PNG decoding rejects malformed data and public errors omit raw secrets',()=>{
 assert.ok(decodePng(png).length>24);for(const bad of ['', 'hello', Buffer.from('<html>').toString('base64')])assert.throws(()=>decodePng(bad),{code:'IMAGE_INVALID'});
 assert.deepEqual(publicImageError(new Error('secret')), {code:'IMAGE_FAILED',error:'Image generation or saving failed. The previous image was retained.'});
});
for(const table of ['articles','writers']) for(const outcome of ['success','db-error','conflict','upload-error'])test(`${table} replacement ${outcome} preserves ordering and prior asset`,async()=>{
 const events=[];const folder=table==='articles'?'images':'avatars';const oldUrl=`/media/tenants/1/${folder}/old.png`;
 const m=mocked({db:{prepare:()=>({get:async()=>{events.push('db');if(outcome==='db-error')throw Error('offline DB');return outcome==='conflict'?null:{id:1};}})},'lib/storage':{upload:async()=>{events.push('upload');if(outcome==='upload-error')throw Error('offline storage');return 'new-url'},remove:async key=>{events.push(key.endsWith('old.png')?'delete-old':'delete-new')}}},'lib/image-persistence');
 try{const run=()=>m.result.replaceImage({table,id:1,tenantId:1,oldUrl,b64:png});if(outcome==='success'){assert.equal(await run(),'new-url');assert.deepEqual(events,['upload','db','delete-old']);}else{await assert.rejects(run());assert.ok(!events.includes('delete-old'));if(outcome==='conflict')assert.deepEqual(events,['upload','db','delete-new']);if(outcome==='db-error')assert.deepEqual(events,['upload','db']);}}finally{m.restore();}
});
test('image policy denies feature and quota before provider preflight',async()=>{
 let enabled=false,allowed=true,calls=0;
 const m=mocked({'lib/feature-registry':{isFeatureEnabled:async()=>enabled},'lib/plan-limits':{checkPlanLimit:async()=>({allowed})},'lib/ai-router':{validateImageConfig:async()=>calls++}},'lib/image-policy');
 try{await assert.rejects(m.result.assertImageAllowed(1,'writer-avatar'),{code:'IMAGE_FEATURE'});enabled=true;allowed=false;await assert.rejects(m.result.assertImageAllowed(1,'writer-avatar'),{code:'IMAGE_STORAGE'});assert.equal(calls,0);allowed=true;await m.result.assertImageAllowed(1,'writer-avatar');assert.equal(calls,1);}finally{m.restore();}
});
test('permission middleware denies unauthorized media callers',()=>{
 const {requirePermission}=require('../middleware/permissions');let status,allowed=false;
 requirePermission('media.create')({user:{permissions:['articles.read']}},{status(n){status=n;return this},json(){}},()=>allowed=true);assert.equal(status,403);assert.equal(allowed,false);
 requirePermission('media.create')({user:{permissions:['media.*']}},{},()=>allowed=true);assert.equal(allowed,true);
});
test('inline mixed failures retain old images and persist only successful replacements',async()=>{
 let updates=0,calls=0;const removed=[];let saved;
 const previous=[{position:1,position_type:'paragraph',url:'/media/tenants/1/images/old1.png',status:'ready'},{position:3,position_type:'paragraph',url:'/media/tenants/1/images/old3.png',status:'ready'}];
 const article={id:1,tenant_id:1,title:'Offline',content_type:'original',full_content:'a\n\nb\n\nc\n\nd\n\ne',inline_images:previous};
 const m=mocked({db:{prepare:q=>({get:async(...args)=>{if(q.startsWith('SELECT * FROM articles'))return article;if(q.startsWith('UPDATE articles')){updates++;saved=JSON.parse(args[0]);return{id:1}}return null;}})},'lib/ai-router':{complete:async()=>null,generateImage:async()=>{if(++calls===2)throw imageError('IMAGE_PROVIDER');return{b64:png}}},'lib/image-policy':{assertImageAllowed:async()=>{}},'lib/site-config':{getSiteConfig:async()=>({})},'lib/storage':{upload:async()=>'/media/tenants/1/images/new.png',remove:async key=>removed.push(key)}},'lib/media-helpers');
 try{const r=await m.result.generateInlineImages(1,1,{replace:true});assert.equal(r.generated,1);assert.equal(r.failed,1);assert.equal(updates,1);assert.equal(saved[1].url,previous[1].url);assert.deepEqual(removed,['images/old1.png']);}finally{m.restore();}
});
test('image routing respects separate overrides and rejects retired/unknown choices without fetch',async()=>{
 let config={default:{provider:'dalle',model:'dall-e-3'}};
 const old=global.fetch;global.fetch=async()=>{throw Error('No external calls permitted');};
 const m=mocked({db:{prepare:q=>({get:async()=>q.includes('image_provider_config')?{value:JSON.stringify(config)}:null})}},'lib/ai-router');
 try{
  await assert.rejects(m.result.validateImageConfig('writer-avatar',1),{code:'RETIRED_IMAGE_MODEL'});
  config={default:{provider:'openai-image',model:'gpt-image-2'},operations:{'writer-avatar':{provider:'imagen',model:'imagen-4.0-generate-001'}}};m.result.bustProviderConfigCache(1);
  assert.equal((await m.result.validateImageConfig('writer-avatar',1)).provider,'imagen');assert.equal((await m.result.validateImageConfig('thumbnail-render',1)).model,'gpt-image-2');
  config={default:{provider:'unknown'}};m.result.bustProviderConfigCache(1);await assert.rejects(m.result.validateImageConfig('thumbnail-render',1),{code:'IMAGE_CONFIG'});
 }finally{m.restore();global.fetch=old;}
});
test('queue executor propagates failures and distinguishes no-op from generation',async()=>{
 let failure=true;
 const m=mocked({'lib/media-helpers':{generateAndStoreImage:async()=>{if(failure)throw imageError('IMAGE_PROVIDER',true);return null;}}},'lib/jobs/executor');
 try{await assert.rejects(m.result.executeJob({job_type:'generate_image',tenant_id:1,payload:{articleId:1}}),{code:'IMAGE_PROVIDER'});failure=false;const r=await m.result.executeJob({job_type:'generate_image',tenant_id:1,payload:{articleId:1}});assert.equal(r.thumbnail,false);assert.equal(r.skipped,'missing_archived_or_existing_image');}finally{m.restore();}
});
test('mixed and skipped UI outcomes show counts without echoing unsafe error payloads',()=>{
 const {summarize}=require('../public/image-outcomes');
 const r=summarize([{id:1,status:'ready'},{id:2,status:'failed',error:'<script>secret</script>'},{position:3,status:'skipped'}]);
 assert.equal(r.generated,1);assert.equal(r.failed,1);assert.equal(r.skipped,1);assert.ok(r.text.includes('Article 2'));assert.ok(r.text.includes('Position 4'));assert.ok(!r.text.includes('secret'));assert.equal(r.hasIssues,true);
 assert.equal(summarize([{status:'ready'}]).hasIssues,false);
});
test('public image permission checks tenant role instead of mere account existence',async()=>{
 let row={role:'viewer',permissions:['articles.read']};
 const m=mocked({db:{prepare:()=>({get:async()=>row})}},'lib/image-policy');
 try{assert.equal(await m.result.canGenerateForUser('offline@example.invalid',1),false);row={role:'editor',permissions:['media.create']};assert.equal(await m.result.canGenerateForUser('offline@example.invalid',1),true);row=null;assert.equal(await m.result.canGenerateForUser('offline@example.invalid',1),false);}finally{m.restore();}
});
test('worker honors nonretryable image timeouts and reports actual pending retry state',async()=>{
 let retryable=false,received;
 const m=mocked({db:{getPool:()=>({query:async()=>({rows:[{id:1,tenant_id:1,job_type:'generate_image',attempts:0,max_attempts:3}]})})},'lib/jobs/executor':{executeJob:async()=>{throw imageError(retryable?'IMAGE_PROVIDER':'IMAGE_TIMEOUT',retryable)}},'lib/jobs/queue':{failJob:async opts=>{received=opts;return{status:opts.retryable?'pending':'failed'}}}},'lib/jobs/worker');
 try{assert.equal((await m.result.pollAndExecute()).status,'failed');assert.equal(received.retryable,false);retryable=true;assert.equal((await m.result.pollAndExecute()).status,'pending');assert.equal(received.retryable,true);}finally{m.restore();}
});
