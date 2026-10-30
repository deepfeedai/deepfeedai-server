'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
test('Newspaper edition real API lifecycle and privacy',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const media=await fs.mkdtemp(path.join(os.tmpdir(),'edition-fixture-')),oldMedia=process.env.STORAGE_LOCAL_DIR;process.env.STORAGE_LOCAL_DIR=media;
 const f=await require('../acceptance/fixture').startFixture({beforeStatic:app=>app.use('/api/editions',require('../../routes/editions'))});
 try{
  const pool=f.db.getPool(),prefix='edition-'+Date.now(),schema=require('../../lib/edition-schema');await schema.initEditionSchema(pool);await schema.initEditionSchema(pool);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await fs.mkdir(path.join(media,'tenants','1','images'),{recursive:true});await fs.writeFile(path.join(media,'tenants','1','images','edition.png'),png);
  const articles=[];for(let i=0;i<4;i++)articles.push((await pool.query("INSERT INTO articles(tenant_id,title,full_content,summary,content_type,is_published,is_archived,writer_id,image_url) VALUES(1,$1,$2,'Article summary','original',$3,0,$4,'/media/tenants/1/images/edition.png') RETURNING *",[prefix+' '+i,'Snapshot text '+i,i===3?0:1,f.writerId])).rows[0]);
  const request=async(url='',{method='GET',body,token=f.token}={})=>{const r=await fetch(f.base+'/api/editions'+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
  const value=(ids=[articles[1].id,articles[0].id])=>({name:prefix,issue_date:'2026-10-30',mode:'published',article_ids:ids,lead_article_id:ids[0]??null,settings:{paper:'Letter',ink_saving:false,images:true},request_id:crypto.randomUUID()});
  let edition;
  await t.test('auth, eligibility, search and pagination exclude foreign and third-party content',async()=>{
   assert.equal((await request('',{token:null})).status,401);assert.equal((await request('/articles?mode=proof',{token:null})).status,401);
   const found=await request('/articles?q='+prefix+'&limit=2');assert.equal(found.status,200);assert.equal(found.body.total,3);assert.equal(found.body.articles.length,2);
   const next=await request('/articles?q='+prefix+'&limit=2&offset=2');assert.equal(next.body.articles.length,1);assert.ok(!next.body.articles.some(a=>found.body.articles.some(b=>a.id===b.id)));
   assert.equal((await request('/articles?q='+prefix+'&mode=proof')).body.total,4);
   for(const ids of [[f.foreignId],[f.sourceIds[0]],[articles[3].id]])assert.equal((await request('',{method:'POST',body:value(ids)})).status,400);
   assert.equal((await request('',{method:'POST',body:value(),token:f.viewerToken})).status,403);
   assert.equal(f.state.calls,0);
  });
  await t.test('concurrent duplicate creates collapse, order and private-by-default are durable',async()=>{
   const input=value();const results=await Promise.all([request('',{method:'POST',body:input}),request('',{method:'POST',body:input})]);assert.ok(results.every(r=>r.status===201));
   assert.equal(results[0].body.edition.id,results[1].body.edition.id);edition=results[0].body.edition;assert.equal(edition.visibility,'private');assert.deepEqual(edition.articles.map(a=>a.article_id),input.article_ids);
   assert.match(results[0].cache,/no-store/);assert.equal((await request('/public/'+edition.id,{token:null})).status,404);
   assert.equal((await request('',{method:'POST',body:{...input,name:'different'}})).status,409);
   assert.equal((await request('/'+edition.id+'/assets/'+articles[1].id,{token:null})).status,401);
  });
  await t.test('save retains snapshot, explicit refresh updates it, conflicts preserve winner',async()=>{
   await pool.query("UPDATE articles SET full_content='Updated article body',updated_at=NOW() WHERE id=$1",[articles[1].id]);
   const input={...value(),name:'Renamed',article_ids:edition.articles.map(a=>a.article_id),lead_article_id:edition.lead_article_id,revision:edition.revision};
   let saved=await request('/'+edition.id,{method:'PUT',body:input});assert.equal(saved.status,200);edition=saved.body.edition;assert.equal(edition.articles[0].content,'Snapshot text 1');
   const stale=await request('/'+edition.id,{method:'PUT',body:input});assert.equal(stale.status,409);
   const refreshed=await request('/'+edition.id+'/refresh',{method:'POST',body:{revision:edition.revision}});assert.equal(refreshed.status,200);edition=refreshed.body.edition;assert.equal(edition.articles[0].content,'Updated article body');
   const sameRevision=edition.revision;const writes=await Promise.all(['A','B'].map(name=>request('/'+edition.id,{method:'PUT',body:{...input,name,revision:sameRevision}})));assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);edition=writes.find(r=>r.status===200).body.edition;
  });
  await t.test('finalization is idempotent, immutable and never publishes sources',async()=>{
   const rev=edition.revision;const final=await Promise.all([request('/'+edition.id+'/finalize',{method:'POST',body:{revision:rev}}),request('/'+edition.id+'/finalize',{method:'POST',body:{revision:rev}})]);assert.ok(final.every(r=>r.status===200));edition=final[0].body.edition;assert.equal(edition.status,'finalized');
   assert.equal((await request('/'+edition.id+'/refresh',{method:'POST',body:{revision:edition.revision}})).status,409);
   assert.equal((await request('/'+edition.id,{method:'PUT',body:{...value(),revision:edition.revision}})).status,409);
   assert.equal((await pool.query('SELECT is_published FROM articles WHERE id=$1',[articles[3].id])).rows[0].is_published,0);
   await fs.writeFile(path.join(media,'tenants','1','images','edition.png'),'source replaced');
   const image=await fetch(f.base+edition.articles[0].image_path,{headers:{Authorization:'Bearer '+f.token}});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  });
  await t.test('only explicit authorized sharing opens reader view; withdrawal hides entire issue and its images',async()=>{
   assert.equal((await request('/'+edition.id+'/visibility',{method:'POST',body:{revision:edition.revision,visibility:'public'},token:f.viewerToken})).status,403);
   const shared=await request('/'+edition.id+'/visibility',{method:'POST',body:{revision:edition.revision,visibility:'public'}});assert.equal(shared.status,200);edition=shared.body.edition;
   let publicRead=await request('/public/'+edition.id,{token:null});assert.equal(publicRead.status,200);assert.equal(publicRead.body.edition.articles[0].content,'Updated article body');
   await pool.query("UPDATE articles SET full_content='Later correction' WHERE id=$1",[articles[1].id]);assert.equal((await request('/public/'+edition.id,{token:null})).body.edition.articles[0].content,'Updated article body');
   await pool.query('UPDATE articles SET is_published=0 WHERE id=$1',[articles[0].id]);
   assert.equal((await request('/public/'+edition.id,{token:null})).status,404);
   assert.equal((await fetch(f.base+publicRead.body.edition.articles[0].image_path)).status,404);
   const archived=await request('/'+edition.id);assert.equal(archived.status,200);assert.ok(archived.body.edition.articles.find(a=>a.article_id===articles[0].id).withdrawn);
   await pool.query("UPDATE articles SET is_published=1,published_at=NOW()+INTERVAL '1 second',full_content='Republished without withdrawn details' WHERE id=$1",[articles[0].id]);
   assert.equal((await request('/public/'+edition.id,{token:null})).status,404);
   await pool.query('DELETE FROM articles WHERE id=$1',[articles[0].id]);assert.equal((await request('/public/'+edition.id,{token:null})).status,404);assert.equal((await request('/'+edition.id)).body.edition.articles.length,2);
  });
  await t.test('proof draft snapshots can never transition to a public edition',async()=>{
   const input={...value([articles[3].id]),mode:'proof'};let proof=(await request('',{method:'POST',body:input})).body.edition;
   assert.equal(proof.articles[0].withdrawn,false);
   await pool.query("UPDATE articles SET full_content='Clean published text',is_published=1 WHERE id=$1",[articles[3].id]);
   assert.equal((await request('/'+proof.id,{method:'PUT',body:{...input,mode:'published',revision:proof.revision}})).status,400);
   proof=(await request('/'+proof.id+'/finalize',{method:'POST',body:{revision:proof.revision}})).body.edition;
   assert.equal(proof.articles[0].content,'Snapshot text 3');
   assert.equal((await request('/'+proof.id+'/visibility',{method:'POST',body:{revision:proof.revision,visibility:'public'}})).status,400);
   assert.equal((await request('/public/'+proof.id,{token:null})).status,404);assert.equal((await fetch(f.base+'/api/editions/public/'+proof.id+'/assets/'+articles[3].id)).status,404);
   const foreign=await require('../../lib/editions').create(f.otherTenantId,f.userId,{...input,article_ids:[f.foreignId],lead_article_id:f.foreignId,request_id:crypto.randomUUID()});
   assert.equal((await request('/'+foreign.id)).status,404);assert.equal((await request('/'+foreign.id+'/assets/'+f.foreignId)).status,404);
   assert.equal(f.state.calls,0);
  });
 }finally{await f.close();if(oldMedia===undefined)delete process.env.STORAGE_LOCAL_DIR;else process.env.STORAGE_LOCAL_DIR=oldMedia;await fs.rm(media,{recursive:true,force:true});}
});
