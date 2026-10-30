'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('../acceptance/fixture');
test('RSS Sources actual APIs: imports, scoped recovery, provenance and concurrent ingestion',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await startFixture();const db=f.db,pool=db.getPool(),prefix='rss-'+Date.now();
 try{
  const tenant=(await pool.query("INSERT INTO tenants(slug,display_name,plan,status) VALUES($1,'RSS fixture','business','active') RETURNING id",[prefix])).rows[0].id;
  const user=(await pool.query("INSERT INTO users(tenant_id,username,password_hash,role,email,is_active) VALUES($1,$2,'offline','owner',$3,1) RETURNING id",[tenant,prefix,prefix+'@example.invalid'])).rows[0].id;
  const token=require('jsonwebtoken').sign({sub:user,tenantId:tenant,type:'platform-admin',role:'owner'},'offline-acceptance-jwt-not-a-production-credential',{expiresIn:'1h'});
  const request=async(path,body,method=body?'POST':'GET',auth=token)=>{const r=await fetch(f.base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};};
  const imports={format:'json',content:JSON.stringify({sources:[{name:'Feed One',url:'https://example.com/'+prefix+'/one?token=private-value',folder_path:'Research/AI'},{name:'Invalid',url:'javascript:alert(1)'},{name:'Feed Two',url:'https://example.org/'+prefix+'/two',folder_path:'Research/AI'}]})};
  let ids=[];
  await t.test('preview is non-mutating and redacted; partial import and retry are truthful',async()=>{
   const preview=await request('/api/sources/import-preview',imports);assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.items[1].status,'invalid');assert.ok(!JSON.stringify(preview.body).includes('private-value'));
   assert.equal((await request('/api/sources?paged=1')).body.total,0);
   const imported=await request('/api/sources/import',imports);assert.equal(imported.status,200);assert.equal(imported.body.added,2);assert.equal(imported.body.errors.length,1);ids=imported.body.results.filter(r=>r.id).map(r=>r.id);
   const retry=await request('/api/sources/import',imports);assert.equal(retry.body.added,0);assert.equal(retry.body.skipped,2);
   const listed=await request('/api/sources?paged=1&limit=1&q=Feed&folder=Research%2FAI');assert.equal(listed.body.total,2);assert.equal(listed.body.items.length,1);
  });
  await t.test('selection and export round-trip retain folders, token warning and rich settings',async()=>{
   const selection={mode:'ids',ids:[ids[0]]};
   const exported=await request('/api/sources/export',{format:'opml',selection});assert.equal(exported.status,200);assert.match(exported.body.warning,/private access tokens/);
   const parsed=await require('../../lib/rss-format').parseImport({format:'opml',content:exported.body.content});assert.equal(parsed.length,1);assert.equal(parsed[0].folder_path,'Research/AI');assert.ok(parsed[0].url.includes('private-value'));
   const changed=await request('/api/sources/bulk',{action:'folder',selection,value:'Technology/Signals'});assert.equal(changed.body.updated,1);
   const all=await request('/api/sources/bulk',{action:'pause',selection:{mode:'all_matching',filters:{folder:'Technology/Signals'}}});assert.equal(all.body.updated,1);
   assert.equal((await request('/api/sources?paged=1&status=paused')).body.total,1);
   await request('/api/sources/bulk',{action:'resume',selection});
   const foreign=(await pool.query("INSERT INTO sources(tenant_id,name,url) VALUES(1,$1,$2) RETURNING id",[prefix+' foreign','https://foreign.example/'+prefix])).rows[0].id;
   const denied=await request('/api/sources/bulk',{action:'remove',selection:{mode:'ids',ids:[ids[0],foreign]},confirm:'REMOVE SELECTED'});assert.equal(denied.status,404);
   assert.equal((await request('/api/sources?paged=1')).body.total,2);
   assert.equal((await request('/api/sources/bulk',{action:'pause',selection:{mode:'ids',ids:[ids[0]]}},'POST',null)).status,401);
   assert.equal((await request('/api/sources/'+ids[0]+'/toggle',{},'PUT')).status,400);
  });
  const {ingestItem}=require('../../lib/rss-ingest');let firstArticle;
  await t.test('ordinary refresh uses mocked feeds, stores readable safe text and never enriches with AI',async()=>{
   const safe=require('../../lib/rss-safe'),previous=safe.safeFetchText;
   safe.safeFetchText=async()=>`<rss version="2.0"><channel><title>Offline</title><link>https://example.com</link><description>Fixture</description><item><title>Readable source</title><guid>refresh-guid</guid><link>https://publisher.example/${prefix}/refresh</link><description><![CDATA[<p>Visible text</p><script>privateScript()</script><img src=x onerror=alert(1)>]]></description></item></channel></rss>`;
   try{
    const refreshed=await request('/api/fetch',{});assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));assert.equal(refreshed.body.inserted,1);assert.equal(refreshed.body.ai_used,false);assert.equal(f.state.calls,0);
    const article=(await pool.query('SELECT content FROM articles WHERE tenant_id=$1 AND source_url=$2',[tenant,'https://publisher.example/'+prefix+'/refresh'])).rows[0];assert.match(article.content,/Visible text/);assert.ok(!article.content.includes('<'));assert.ok(!article.content.includes('privateScript'));
   }finally{safe.safeFetchText=previous;}
  });
  await t.test('concurrent and cross-feed repeats are idempotent while preserving source occurrences',async()=>{
   const sources=(await pool.query('SELECT * FROM sources WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
   const item={title:'Same headline',link:'https://publisher.example/'+prefix+'/story?edition=1&utm_source=r',guid:'guid-1'};
   const results=await Promise.all(Array.from({length:8},()=>ingestItem(tenant,sources[0],item,'Uncategorized')));
   assert.equal(results.filter(r=>r.inserted).length,1);firstArticle=results[0].id;assert.ok(results.every(r=>r.id===firstArticle));
   assert.equal((await pool.query('SELECT source_url FROM articles WHERE id=$1',[firstArticle])).rows[0].source_url,item.link,'Original reader URL remains intact');
   const repeated=await ingestItem(tenant,sources[1],{...item,guid:'other-guid'},'Uncategorized');assert.equal(repeated.id,firstArticle);
   assert.equal(Number((await pool.query('SELECT COUNT(DISTINCT source_id) n FROM rss_occurrences WHERE tenant_id=$1 AND article_id=$2',[tenant,firstArticle])).rows[0].n),2);
   const distinct=await ingestItem(tenant,sources[1],{...item,link:'https://publisher.example/'+prefix+'/story?edition=2',guid:'guid-1'},'Uncategorized');assert.notEqual(distinct.id,firstArticle,'GUID is scoped to source and meaningful query values survive');
   const differentPublisher=await ingestItem(tenant,sources[0],{...item,link:'https://another-publisher.example/'+prefix+'/story',guid:'guid-2'},'Uncategorized');assert.notEqual(differentPublisher.id,firstArticle,'Same headline from another publisher is independent reporting');
   const moved=await ingestItem(tenant,sources[0],{...item,link:'https://publisher.example/'+prefix+'/moved?edition=1'},'Uncategorized');assert.equal(moved.id,firstArticle,'Stable feed GUID survives changed item URL');
   const disposable=await ingestItem(tenant,sources[0],{title:'Disposable',link:'https://publisher.example/'+prefix+'/disposable',guid:'owned-delete'},'Uncategorized');
   await pool.query('DELETE FROM articles WHERE tenant_id=$1 AND id=$2',[tenant,disposable.id]);
   const restored=await ingestItem(tenant,sources[0],{title:'Disposable',link:'https://publisher.example/'+prefix+'/disposable',guid:'owned-delete'},'Uncategorized');assert.ok(restored.inserted);assert.notEqual(restored.id,disposable.id);
  });
  await t.test('duplicate dry-run and reversible collapse never rewrite article references',async()=>{
   const alias=(await pool.query("INSERT INTO articles(tenant_id,title,source_url,content_type,is_published) SELECT tenant_id,'Legacy duplicate',source_url||'&utm_source=legacy','curated',0 FROM articles WHERE id=$1 RETURNING id",[firstArticle])).rows[0].id;
   const report=await request('/api/sources/duplicates');assert.equal(report.status,200);assert.ok(report.body.groups.some(g=>g.articles.some(a=>a.id===alias)));assert.equal(report.body.dry_run,true);
   assert.equal((await request('/api/sources/duplicates/link',{article_id:alias,canonical_article_id:firstArticle})).status,200);
   assert.equal((await pool.query('SELECT COUNT(*)::int n FROM articles WHERE id=ANY($1::int[])',[[firstArticle,alias]])).rows[0].n,2);
   assert.equal((await request('/api/sources/duplicates/unlink',{article_id:alias})).status,200);
   const foreign=f.foreignId;assert.equal((await request('/api/sources/duplicates/link',{article_id:alias,canonical_article_id:foreign})).status,404);
  });
  await t.test('clear-all is explicit, tenant scoped and recoverable without deleting imported articles',async()=>{
   const before=Number((await pool.query('SELECT COUNT(*) n FROM articles WHERE tenant_id=$1',[tenant])).rows[0].n);
   assert.equal((await request('/api/sources/clear',{confirmation:'wrong',exportAcknowledged:true})).status,400);
   const cleared=await request('/api/sources/clear',{confirmation:'CLEAR ALL SOURCES',exportAcknowledged:true});assert.equal(cleared.status,200);assert.equal(cleared.body.updated,2);
   assert.equal((await request('/api/sources?paged=1')).body.total,0);assert.equal((await request('/api/sources?paged=1&status=removed')).body.total,2);
   assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM articles WHERE tenant_id=$1',[tenant])).rows[0].n),before);
   assert.equal((await request('/api/sources/'+ids[0]+'/restore',{})).status,200);const restored=(await request('/api/sources?paged=1')).body.items[0];assert.equal(restored.is_active,0);
   assert.equal((await request('/api/sources/'+ids[0]+'?confirmed=true',null,'DELETE')).status,200);assert.equal((await request('/api/sources?paged=1&status=removed')).body.total,2);
   assert.equal(f.state.calls,0,'Reading, import, export and source actions must not call AI');
  });
  await require('../../lib/rss-schema').initRssSchema(pool); // Repeatable migration preserves all provenance.
 }finally{await f.close();}
});
