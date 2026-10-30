'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('../acceptance/fixture');
test('Reader actual APIs: per-user state, tenant isolation, matching selection, safe detail and explicit enrichment',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await startFixture();
 try{
  const pool=f.db.getPool(),reader=require('../../lib/reader'),jwt=require('jsonwebtoken');
  await require('../../lib/rss-schema').initRssSchema(pool);await require('../../lib/reader-schema').initReaderSchema(pool);await require('../../lib/reader-schema').initReaderSchema(pool);
  const prefix='reader-'+Date.now();
  const second=await f.db.prepare("INSERT INTO users(username,password_hash,tenant_id,role,email,is_active) VALUES($1,'offline-only',1,'viewer',$2,1) RETURNING id").get(prefix,prefix+'@example.invalid');
  const token2=jwt.sign({sub:second.id,tenantId:1,type:'platform-admin',role:'viewer'},'offline-acceptance-jwt-not-a-production-credential',{expiresIn:'1h'});
  const foreign=await f.db.prepare("UPDATE articles SET content_type='curated' WHERE id=$1 RETURNING tenant_id").get(f.foreignId);
  const third=await f.db.prepare("INSERT INTO users(username,password_hash,tenant_id,role,email,is_active) VALUES($1,'offline-only',$2,'owner',$3,1) RETURNING id").get(prefix+'-third',foreign.tenant_id,prefix+'-third@example.invalid');
  const token3=jwt.sign({sub:third.id,tenantId:foreign.tenant_id,type:'platform-admin',role:'owner'},'offline-acceptance-jwt-not-a-production-credential',{expiresIn:'1h'});
  const source=await f.db.prepare("INSERT INTO sources(tenant_id,name,url,removed_at) VALUES(1,$1,$2,NOW()) RETURNING id").get(prefix,'https://example.invalid/'+prefix);
  const group=await f.db.prepare("INSERT INTO feed_groups(tenant_id,name,color) VALUES(1,$1,'#123456') RETURNING id").get(prefix);
  const ids=[];
  for(let i=0;i<4;i++)ids.push((await f.db.prepare("INSERT INTO articles(tenant_id,title,summary,full_content,category,source,source_id,group_id,content_type,is_published,image_url,source_url) VALUES(1,$1,$2,$3,'Research',$4,$5,$6,'curated',0,'javascript:alert(1)','https://example.invalid/source') RETURNING id").get(prefix+' '+i,'Evidence '+i,'<script>secret script</script><p>Readable &amp; safe</p>',prefix,source.id,group.id)).id);
  await f.db.prepare('INSERT INTO rss_duplicate_links(tenant_id,article_id,canonical_article_id) VALUES(1,$1,$2)').run(ids[3],ids[0]);
  const request=async(path,{body,method=body?'PUT':'GET',token=f.token}={})=>{const r=await fetch(f.base+'/api/reader'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  await t.test('real filters paginate and count visible items without AI',async()=>{
   let r=await request('/items?q='+prefix+'&limit=2');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,3);assert.equal(r.body.items.length,2);assert.equal(r.body.hasMore,true);
   const next=await request('/items?q='+prefix+'&limit=2&offset=2');assert.equal(next.body.items.length,1);assert.equal(next.body.hasMore,false);
   assert.equal((await request('/items?q='+prefix+'&duplicates=show')).body.total,4);
   assert.equal((await request('/items?source_id='+source.id+'&folder_id='+group.id+'&category=Research')).body.total,3);
   assert.equal((await request('/items?q='+prefix+'%25')).body.total,0,'Search percent is literal, not wildcard');
   assert.equal((await request('/items?limit=100000')).status,400);
   const facets=(await request('/facets')).body;assert.equal(facets.sources.find(s=>s.id===source.id).removed,true);assert.equal(facets.folders.find(g=>g.id===group.id).count,3);
   const otherFeed=await f.db.prepare("INSERT INTO sources(tenant_id,name,url) VALUES(1,$1,$2) RETURNING id").get(prefix+' mirror','https://example.invalid/'+prefix+'-mirror');
   await f.db.prepare('UPDATE articles SET source_id=$2 WHERE id=$1').run(ids[3],otherFeed.id);
   await f.db.prepare('INSERT INTO rss_occurrences(tenant_id,source_id,occurrence_key,article_id) VALUES(1,$1,$2,$3)').run(otherFeed.id,prefix+'-occurrence',ids[1]);
   const shared=await request('/items?source_id='+otherFeed.id);assert.equal(shared.body.total,2);
   assert.deepEqual(new Set(shared.body.items.map(a=>a.id)),new Set([ids[0],ids[1]]),'Collapsed aliases and repeated-feed occurrences retain source visibility');
   assert.equal((await request('/facets')).body.sources.find(s=>s.id===otherFeed.id).count,2);
   assert.equal(f.state.calls,0);
  });
  await t.test('state belongs to distinct actual users; selected and all-matching are explicit',async()=>{
   assert.equal((await request('/state',{body:{scope:'selected',ids:[ids[0]],read:true,saved:true}})).body.updated,1);
   assert.equal((await request('/items/'+ids[0])).body.read,true);assert.equal((await request('/items/'+ids[0],{token:token2})).body.read,false);
   assert.equal((await request('/items/'+ids[0],{token:token2})).body.saved,false);
   assert.equal((await request('/state',{body:{scope:'all_matching',filters:{q:prefix},read:true}})).status,400);
   const r=await request('/state',{body:{scope:'all_matching',filters:{q:prefix},read:true,confirmAllMatching:true}});assert.equal(r.body.updated,3);
   assert.equal((await request('/items?q='+prefix+'&view=unread')).body.total,0);
   assert.equal((await request('/items?q='+prefix+'&view=unread',{token:token2})).body.total,3);
   assert.equal((await request('/items?q='+prefix+'&view=saved')).body.total,1);
   assert.equal((await request('/items/'+ids[3])).body.read,false,'Hidden duplicates not implicitly modified');
   await request('/state',{body:{scope:'selected',ids:[ids[0]],read:false}});assert.equal((await request('/items/'+ids[0])).body.saved,true,'Read updates preserve saved state');
   const empty=await request('/state',{body:{scope:'all_matching',filters:{q:'no-reader-match'},saved:true,confirmAllMatching:true}});assert.equal(empty.body.updated,0);
  });
  await t.test('unauthenticated and other-tenant selections cannot read or change items',async()=>{
   assert.equal((await request('/items',{token:null})).status,401);
   assert.equal((await request('/items/'+f.foreignId)).status,404);
   assert.equal((await request('/items/'+ids[0],{token:token3})).status,404);
   const r=await request('/state',{body:{scope:'selected',ids:[ids[0],f.foreignId],saved:false}});assert.equal(r.status,404);assert.equal((await request('/items/'+ids[0])).body.saved,true);
   assert.equal((await request('/state',{token:token3,body:{scope:'all_matching',filters:{q:prefix},read:true,confirmAllMatching:true}})).body.updated,0);
   assert.equal((await request('/items/'+ids[0]+'/enrich',{token:token2,method:'POST',body:{confirmPaid:true}})).status,403);
  });
  await t.test('detail emits plain text, safe URLs and preserves removed-feed articles',async()=>{
   const r=await request('/items/'+ids[0]);assert.equal(r.status,200);assert.equal(r.body.content_text,'Readable & safe');assert.equal(r.body.image_url,null);assert.ok(!JSON.stringify(r.body).includes('secret script'));
   assert.equal((await request('/items/'+ids[0]+'/enrich',{method:'POST',body:{}})).status,400);assert.equal(f.state.calls,0);
  });
  await t.test('aliases remain visible when their primary is archived, missing or no longer curated',async()=>{
   for(const mode of ['archived','missing','original']){
    if(mode==='archived')await f.db.prepare('UPDATE articles SET is_archived=1 WHERE id=$1').run(ids[0]);
    if(mode==='original')await f.db.prepare("UPDATE articles SET content_type='original' WHERE id=$1").run(ids[0]);
    if(mode==='missing')await f.db.prepare('UPDATE rss_duplicate_links SET canonical_article_id=2147483647 WHERE tenant_id=1 AND article_id=$1').run(ids[3]);
    const page=await request('/items?q='+prefix);assert.ok(page.body.items.some(a=>a.id===ids[3]));
    const alias=(await request('/items/'+ids[3])).body;assert.equal(alias.duplicate_available,false);assert.ok(alias.duplicate_of);
    if(mode!=='missing')assert.equal(page.body.total,3);
    await f.db.prepare("UPDATE articles SET is_archived=0,content_type='curated' WHERE id=$1").run(ids[0]);
    await f.db.prepare('UPDATE rss_duplicate_links SET canonical_article_id=$2 WHERE tenant_id=1 AND article_id=$1').run(ids[3],ids[0]);
   }
   assert.equal((await request('/items?q='+prefix)).body.total,3);
  });
  await t.test('date/sort, folder moves and reversible coverage groups preserve article identity',async()=>{
   await f.db.prepare("UPDATE articles SET published_at=NOW()-INTERVAL '60 days' WHERE id=$1").run(ids[2]);
   assert.equal((await request('/items?q='+prefix+'&date=24h')).body.total,2);
   assert.equal((await request('/items?q='+prefix+'&sort=oldest')).body.items[0].id,ids[2]);
   assert.equal((await request('/move',{body:{scope:'all_matching',filters:{q:prefix},folder_id:null}})).status,400);
   assert.equal((await request('/move',{body:{scope:'all_matching',filters:{q:prefix},folder_id:null,confirmAllMatching:true}})).body.updated,3);
   assert.equal((await request('/items?q='+prefix+'&folder_id=none')).body.total,3);
   assert.equal((await request('/move',{body:{scope:'selected',ids:[ids[0]],folder_id:2147483647}})).status,404);
   assert.equal((await request('/move',{body:{scope:'selected',ids:[ids[0]],folder_id:group.id}})).body.updated,1);
   await f.db.prepare('UPDATE articles SET topic_tag=$1 WHERE id=ANY($2::int[])').run(prefix,ids);
   assert.equal((await request('/items?topic_tag='+prefix)).body.total,3);
   assert.equal((await request('/items/'+ids[0]+'/group',{body:{excluded:true}})).status,200);
   assert.equal((await request('/items?topic_tag='+prefix)).body.total,2);
   assert.equal((await request('/items/'+ids[0])).body.group_excluded,true);
   assert.equal((await f.db.prepare('SELECT topic_tag FROM articles WHERE id=$1').get(ids[0])).topic_tag,prefix);
   await request('/items/'+ids[0]+'/group',{body:{excluded:false}});assert.equal((await request('/items?topic_tag='+prefix)).body.total,3);
   assert.equal((await request('/items/'+f.foreignId+'/group',{body:{excluded:true}})).status,404);
  });
  await t.test('assignment append is concurrent-safe, non-paid and preserves existing source IDs',async()=>{
   const assignment=await require('../../lib/editor-assignments').create({topic:'Reader research',angle_summary:'Explain verified sources',writer_id:f.writerId,source_article_ids:[ids[0],ids[1]],request_key:prefix+'-assignment'},1,null);
   await require('../../lib/editor-assignments').approve(assignment.id,1,null);
   const outcomes=await Promise.all([ids[2],ids[3]].map(id=>request('/assignments/'+assignment.id+'/sources',{method:'POST',body:{source_article_ids:[id]}})));
   assert.ok(outcomes.every(r=>r.status===200));
   const saved=await f.db.prepare('SELECT * FROM article_pitches WHERE id=$1').get(assignment.id);assert.equal(saved.status,'proposed');
   assert.deepEqual(new Set([saved.source_article_id,...saved.attached_article_ids]),new Set(ids));
   assert.equal((await request('/assignments/'+assignment.id+'/sources',{method:'POST',body:{source_article_ids:[f.foreignId]}})).status,400);
   assert.equal((await request('/assignments/'+assignment.id+'/sources',{token:token3,method:'POST',body:{source_article_ids:[f.foreignId]}})).status,404);
   assert.equal(f.state.calls,0);
  });
  await t.test('enrichment is explicit, deduplicates concurrent calls and requires acknowledgement after failure',async()=>{
   const synthesis=require('../../lib/synthesis'),previous=synthesis.enrichArticle;let release,calls=0;
   try{
   synthesis.enrichArticle=async()=>{calls++;await new Promise(r=>release=r);throw Error('private-provider-detail');};
   const running=request('/items/'+ids[0]+'/enrich',{method:'POST',body:{confirmPaid:true}});
   for(let n=0;n<100&&!release;n++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
   assert.equal((await request('/items/'+ids[0]+'/enrich',{method:'POST',body:{confirmPaid:true}})).status,409);
   assert.equal((await request('/items/'+ids[0])).body.enrichment.status,'running');release();assert.equal((await running).body.status,'failed');
   assert.ok(!(await request('/items/'+ids[0])).body.enrichment.error.includes('private-provider-detail'));
   assert.equal((await request('/items/'+ids[0]+'/enrich',{method:'POST',body:{confirmPaid:true}})).status,409);
   synthesis.enrichArticle=async()=>{calls++;await f.db.prepare("UPDATE articles SET enriched_summary='Mocked safe summary' WHERE id=$1").run(ids[0]);return 'Mocked safe summary';};
   const retry=await request('/items/'+ids[0]+'/enrich',{method:'POST',body:{confirmPaid:true,retryAcknowledged:true}});assert.equal(retry.body.status,'ready');assert.equal(calls,2);
   assert.equal((await request('/items/'+ids[0]+'/enrich',{method:'POST',body:{confirmPaid:true}})).body.status,'skipped');assert.equal(calls,2);
   }finally{synthesis.enrichArticle=previous;}
  });
  await t.test('actual enrichment route and pipeline reject private DNS before AI or network access',async()=>{
   const safe=require('../../lib/reader-fetch'),original=safe.scrapeText;let connections=0;
   try{
    safe.scrapeText=(url,tenant)=>original(url,tenant,{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{connections++;throw Error('Private network must not be contacted');}});
    const before=f.state.calls,r=await request('/items/'+ids[1]+'/enrich',{method:'POST',body:{confirmPaid:true}});
    assert.equal(r.status,200);assert.equal(r.body.status,'failed');assert.equal(connections,0);assert.equal(f.state.calls,before);
    const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
    const transport=(redirect=false)=>(url,options,callback)=>{
     connections++;const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=()=>{};
     req.end=()=>process.nextTick(()=>{const res=Readable.from([Buffer.from('<article>'+('Verified source evidence. '.repeat(30))+'</article>')]);res.statusCode=redirect?302:200;res.headers=redirect?{location:'http://private.example/secret'}:{};callback(res);});return req;
    };
    safe.scrapeText=(url,tenant)=>original(url,tenant,{lookup:async host=>[{address:host==='private.example'?'127.0.0.1':'93.184.216.34',family:4}],request:transport(true)});
    assert.equal((await request('/items/'+ids[2]+'/enrich',{method:'POST',body:{confirmPaid:true}})).body.status,'failed');assert.equal(connections,1);assert.equal(f.state.calls,before);
    safe.scrapeText=(url,tenant)=>original(url,tenant,{lookup:async()=>[{address:'93.184.216.34',family:4}],request:transport()});
    const success=await request('/items/'+ids[1]+'/enrich',{method:'POST',body:{confirmPaid:true,retryAcknowledged:true}});
    assert.equal(success.body.status,'ready');assert.equal(f.state.calls,before+1);assert.equal((await request('/items/'+ids[1])).body.enriched_summary,'Offline verified source summary');
   }finally{safe.scrapeText=original;}
  });
 }finally{await f.close();}
});
