'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../../db');
function stub(name,exports){const p=require.resolve('../../lib/'+name);require.cache[p]={id:p,filename:p,loaded:true,exports};}
let calls=0;
stub('notifications',{notify:async()=>{}});
stub('newsroom-events',{recordEvent:async()=>{}});
stub('budget',{canSpend:async()=>({allowed:true})});
stub('ai-router',{complete:async()=>{calls++;return {text:JSON.stringify({name:'A Specific Updated Story Name',summary:'Offline summary'})};}});
const service=require('../../lib/story-timelines');
const ai=require('../../lib/story-ai');

test('Stories: publication, atomic associations, stable links and durable explicit AI',{skip:!process.env.DATABASE_URL},async t=>{
 try {
  await db.init();await ai.initStoryAiSchema(db.getPool());await ai.initStoryAiSchema(db.getPool());
  const key='stories-'+Date.now();
  const other=await db.prepare("INSERT INTO tenants(slug,display_name,plan,status) VALUES($1,'Offline fixture','starter','active') RETURNING id").get(key);
  const article=async(tenant,published,image=null)=>db.prepare("INSERT INTO articles(tenant_id,title,summary,status,is_published,content_type,image_url,published_at) VALUES($1,$2,'Private fixture metadata',$3,$4,'original',$5,NOW()) RETURNING id").get(tenant,key,published?'published':'review',published,image);
  const a=await article(1,1,'/media/fixture.png'),b=await article(1,1),draft=await article(1,0),foreign=await article(other.id,1);
  let story;
  await t.test('atomic create rejects all invalid and foreign associations',async()=>{
   for(const id of [draft.id,foreign.id,2147483646]) await assert.rejects(()=>service.createStory(1,{name:key,articleIds:[a.id,id]}),/published/);
   assert.equal((await db.prepare('SELECT count(*)::int n FROM story_timelines WHERE name=$1').get(key)).n,0);
   story=await service.createStory(1,{name:key,summary:'Editor summary',articleIds:[a.id,a.id,b.id]});
   assert.equal(story.article_count,2);assert.equal((await service.getStory(1,story.slug)).summary,'Editor summary');
  });
  await t.test('parallel attachments deduplicate and reject invalid targets',async()=>{
   await Promise.all([service.addArticleToStory(story.id,a.id,1),service.addArticleToStory(story.id,a.id,1)]);
   assert.equal((await service.getStoryById(1,story.id)).article_count,2);
   for(const id of [draft.id,foreign.id,2147483646])await assert.rejects(()=>service.addArticleToStory(story.id,id,1),/published/);
   await assert.rejects(()=>service.addArticleToStory(story.id,a.id,other.id),/not found/);
  });
  await t.test('legacy bad links never leak metadata or inflate counts and cover clears',async()=>{
   await db.prepare('INSERT INTO story_timeline_articles(story_id,article_id,tenant_id) VALUES($1,$2,1),($1,$3,1)').run(story.id,draft.id,foreign.id);
   let result=await service.getStory(1,story.slug);
   assert.deepEqual(result.articles.map(x=>x.id).sort((x,y)=>x-y),[a.id,b.id]);assert.equal(result.article_count,2);assert.equal(result.summary,null);
   await service.removeArticleFromStory(story.id,a.id,1);
   result=await service.getStoryById(1,story.id);assert.equal(result.cover_article_id,null);assert.equal(result.image_url,null);assert.equal(result.article_count,1);
   await db.prepare('UPDATE articles SET is_published=0 WHERE id=$1').run(b.id);
   result=await service.getStory(1,story.slug);assert.equal(result.article_count,0);assert.equal(result.articles.length,0);
   await db.prepare('UPDATE articles SET is_published=1 WHERE id=$1').run(b.id);
   await service.removeArticleFromStory(story.id,draft.id,1);await service.removeArticleFromStory(story.id,foreign.id,1);
  });
  await t.test('reads and ordinary mutations never generate; rename keeps original URL',async()=>{
   assert.equal(calls,0);await service.listStories(1);await service.updateStory(1,story.id,{summary:'Reviewed summary'});
   assert.equal(calls,0);assert.equal((await service.getStory(1,story.slug)).summary,'Reviewed summary');
   await service.generateStoryNameAndSummary(story.id,1);assert.equal(calls,1);
   assert.equal((await service.getStory(1,story.slug)).name,'A Specific Updated Story Name');
   assert.equal((await service.getStory(1,story.slug)).summary,'Offline summary');
  });
  await t.test('explicit confirmation, deduplication, failure privacy and acknowledged retry',async()=>{
   await assert.rejects(()=>ai.start(1,story.id,{}),/Confirm/);
   await assert.rejects(()=>ai.start(other.id,story.id,{confirmPaid:true,requestKey:key+'-cross'}),/not found/);
   const options={confirmPaid:true,requestKey:key+'-request'};let invoked=0;
   const task=await ai.start(1,story.id,options,async()=>{invoked++;return {state:'ready'};});
   assert.equal((await ai.latest(1,story.id)).state,'running');
   await assert.rejects(()=>ai.start(1,story.id,options),/already running/);
   const another=await service.createStory(1,{name:key+'-concurrent-ai'});
   await assert.rejects(()=>ai.start(1,another.id,{...options,requestKey:key+'-parallel'}),/Another story/);
   await task.run();await task.run();assert.equal(invoked,1);
   assert.equal((await ai.start(1,story.id,options)).run,null);
   assert.equal((await ai.latest(1,story.id)).state,'ready');
   await db.prepare("UPDATE story_ai_runs SET finished_at=NOW()-INTERVAL '2 minutes' WHERE story_id=$1").run(story.id);
   const failed=await ai.start(1,story.id,{...options,requestKey:key+'-failure'},async()=>{throw Error('secret-provider-token');});await failed.run();
   assert.equal((await ai.latest(1,story.id)).state,'failed');assert.ok(!(await ai.latest(1,story.id)).message.includes('secret-provider-token'));
   await assert.rejects(()=>ai.start(1,story.id,{...options,requestKey:key+'-retry'}),/Acknowledge/);
   const retry=await ai.start(1,story.id,{...options,requestKey:key+'-retry',retryAcknowledged:true},async()=>({state:'skipped',message:'Budget limit reached'}));await retry.run();
   assert.equal((await ai.latest(1,story.id)).state,'skipped');
  });
  await t.test('pagination returns stable nonoverlapping pages',async()=>{
   const created=await Promise.all(Array.from({length:12},(_,i)=>service.createStory(1,{name:key+'-parallel-create'})));
   assert.equal(new Set(created.map(s=>s.slug)).size,12);
   const first=await service.listStories(1,{limit:2}),next=await service.listStories(1,{limit:2,offset:2});
   assert.equal(first.hasMore,true);assert.equal(first.stories.length,2);assert.ok(next.stories.every(s=>!first.stories.some(a=>a.id===s.id)));
  });
  await t.test('interrupted jobs become actionable failures without automatic generation',async()=>{
   await db.prepare("INSERT INTO story_ai_runs(tenant_id,story_id,request_key,state) VALUES(1,$1,$2,'running')").run(story.id,key+'-interrupted');
   const before=calls;assert.equal((await ai.latest(1,story.id)).state,'failed');assert.equal(calls,before);
   await assert.rejects(()=>ai.start(1,story.id,{confirmPaid:true,requestKey:key+'-restart'}),/Acknowledge/);
  });
  await t.test('public list, catch-up, article widget and saved brief agree without AI calls',async()=>{
   const express=require('express');const app=express();app.use((req,res,next)=>{req.tenantId=1;next();});app.use('/news',require('../../routes/stories'));
   const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
   const before=calls;
   try{
    for(const suffix of ['/stories?limit=50','/stories/catchup?limit=20','/stories?forArticle='+b.id]){
     const response=await fetch(base+'/news'+suffix);assert.equal(response.status,200);const body=await response.json();
     const found=body.stories.find(s=>s.id===story.id);assert.ok(found,suffix);assert.equal(found.articleCount ?? found.article_count,1);
    }
    assert.equal((await (await fetch(base+'/news/stories?forArticle='+draft.id)).json()).stories.length,0);
    const brief=await fetch(base+'/news/stories/'+story.slug+'/summarize');assert.equal(brief.status,200);assert.equal((await brief.json()).brief,'Offline summary');
    await db.prepare('UPDATE articles SET is_published=0 WHERE id=$1').run(b.id);
    assert.equal((await fetch(base+'/news/stories/'+story.slug+'/summarize')).status,404);
    assert.equal(calls,before);
   }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  });
 }finally{await new Promise(r=>setTimeout(r,40));await db.getPool().end();}
});
