'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
test('contributor real routes preserve snapshots, references, tenant privacy and withdrawal boundaries',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const media=await fs.mkdtemp(path.join(os.tmpdir(),'contributors-')),oldMedia=process.env.STORAGE_LOCAL_DIR;process.env.STORAGE_LOCAL_DIR=media;
 const f=await require('../acceptance/fixture').startFixture({beforeStatic:app=>app.use('/api/editions',require('../../routes/editions'))});
 try{
  const pool=f.db.getPool(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await require('../../lib/edition-schema').initEditionSchema(pool);await require('../../lib/edition-schema').initEditionSchema(pool);
  await fs.mkdir(path.join(media,'tenants','1'),{recursive:true});await fs.writeFile(path.join(media,'tenants','1','portrait.png'),png);
  await pool.query("UPDATE writers SET name='Captured persona',bio='Configured profile',beat='Science',system_prompt='Fixture persona',avatar_url='/media/tenants/1/portrait.png',is_auto=false WHERE id=$1",[f.writerId]);
  const style=(await pool.query("INSERT INTO writing_styles(tenant_id,name,slug,prompt) VALUES(1,'Clear explainer','edition-card-test','PRIVATE STYLE PROMPT') RETURNING id")).rows[0].id;
  await pool.query("UPDATE writers SET style_id=$2,tone='Concise',style_guide='PRIVATE GUIDE' WHERE id=$1",[f.writerId,style]);
  const refs=[{id:f.sourceIds[0],title:'Captured source',source:'Publisher',source_url:'https://example.org/evidence'}];
  const ids=[];for(let i=0;i<2;i++)ids.push((await pool.query("INSERT INTO articles(tenant_id,title,full_content,content_type,is_published,writer_id,source_article_ids) VALUES(1,'Contributor fixture','Saved evidence [1]','original',1,$1,$2::jsonb) RETURNING id",[f.writerId,JSON.stringify(refs)])).rows[0].id);
  const req=async(url='',method='GET',body,token=f.token)=>{const r=await fetch(f.base+'/api/editions'+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const input={name:'Contributors',issue_date:'2026-10-31',mode:'published',article_ids:ids,lead_article_id:ids[0],settings:{paper:'A4',images:true,ink_saving:false,contributors:true,portraits:true},request_id:crypto.randomUUID()};
  let edition;
  await t.test('capture explicit fields and protected immutable portrait; repeated schema retains captures',async()=>{
   const r=await req('','POST',input);assert.equal(r.status,201);edition=r.body.edition;
   assert.equal(edition.contributors.length,1);assert.equal(edition.contributors[0].article_count,2);assert.equal(edition.articles[0].contributor.kind,'ai_persona');assert.equal(edition.articles[0].contributor.bio,'Configured profile');assert.equal(edition.articles[0].references[0].title,'Captured source');
   assert.equal((await fetch(f.base+edition.articles[0].portrait_path)).status,401);
   await require('../../lib/edition-schema').initEditionSchema(pool);
   const image=await fetch(f.base+edition.articles[0].portrait_path,{headers:{Authorization:'Bearer '+f.token}});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
   assert.equal(JSON.stringify(edition).includes('Fixture persona'),false);
   assert.equal(edition.articles[0].contributor.writing_style,'Clear explainer · Concise');
   assert.equal(JSON.stringify(edition).includes('PRIVATE'),false);
  });
  await t.test('ordinary save retains profiles and bytes; explicit working refresh updates capture',async()=>{
   await pool.query("UPDATE writers SET bio='Changed profile',tone='Conversational' WHERE id=$1",[f.writerId]);
   edition=(await req('/'+edition.id,'PUT',{...input,revision:edition.revision})).body.edition;
   assert.equal(edition.articles[0].contributor.bio,'Configured profile');
   assert.equal(edition.articles[0].contributor.writing_style,'Clear explainer · Concise');
   edition=(await req('/'+edition.id+'/refresh','POST',{revision:edition.revision})).body.edition;
   assert.equal(edition.articles[0].contributor.bio,'Changed profile');assert.equal(edition.articles[0].references[0].title,'Captured source');
   assert.equal(edition.articles[0].contributor.writing_style,'Clear explainer · Conversational');
   edition=(await req('/'+edition.id+'/finalize','POST',{revision:edition.revision})).body.edition;
   await pool.query("UPDATE writers SET bio='Later profile',tone='Later tone',avatar_url=NULL WHERE id=$1",[f.writerId]);await fs.writeFile(path.join(media,'tenants','1','portrait.png'),'removed portrait');
   const saved=(await req('/'+edition.id)).body.edition;assert.equal(saved.articles[0].contributor.bio,'Changed profile');
   assert.equal(saved.articles[0].contributor.writing_style,'Clear explainer · Conversational');
   const image=await fetch(f.base+saved.articles[0].portrait_path,{headers:{Authorization:'Bearer '+f.token}});assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  });
  await t.test('public portraits inherit issue eligibility and cannot bypass withdrawal',async()=>{
   edition=(await req('/'+edition.id+'/visibility','POST',{revision:edition.revision,visibility:'public'})).body.edition;
   const publicIssue=(await req('/public/'+edition.id,'GET',undefined,null)).body.edition;
   assert.equal((await fetch(f.base+publicIssue.articles[0].portrait_path)).status,200);
   await pool.query('UPDATE articles SET is_published=0 WHERE id=$1',[ids[0]]);
   assert.equal((await fetch(f.base+publicIssue.articles[1].portrait_path)).status,404);
   assert.equal((await req('/public/'+edition.id,'GET',undefined,null)).status,404);
  });
  await t.test('unassigned author and foreign profile cannot leak contributor data',async()=>{
   const foreignWriter=(await pool.query("INSERT INTO writers(tenant_id,name,bio,system_prompt) VALUES($1,'Foreign secret persona','Private tenant biography','Fixture') RETURNING id",[f.otherTenantId])).rows[0].id;
   for(const writerId of [null,foreignWriter]){
    const id=(await pool.query("INSERT INTO articles(tenant_id,title,full_content,content_type,is_published,author,writer_id) VALUES(1,'Unknown author','Body','original',1,'Guest author',$1) RETURNING id",[writerId])).rows[0].id;
    const r=await req('','POST',{...input,article_ids:[id],lead_article_id:id,request_id:crypto.randomUUID()});assert.equal(r.status,201);assert.equal(r.body.edition.articles[0].contributor,null);assert.equal(r.body.edition.articles[0].byline,'Guest author');assert.equal(r.body.edition.articles[0].portrait_path,null);assert.deepEqual(r.body.edition.contributors,[]);
   }
   assert.equal(f.state.calls,0);
  });
  await t.test('legacy finalized snapshots stay byte-for-byte unchanged without live profile fallback',async()=>{
   const legacy=(await req('','POST',{...input,mode:'proof',request_id:crypto.randomUUID()})).body.edition;
   await pool.query("UPDATE newspaper_edition_articles SET snapshot=snapshot-'contributor',portrait_data=NULL,portrait_mime=NULL WHERE edition_id=(SELECT id FROM newspaper_editions WHERE public_id=$1)",[legacy.id]);
   const finalized=(await req('/'+legacy.id+'/finalize','POST',{revision:legacy.revision})).body.edition;
   const before=(await pool.query('SELECT snapshot::text FROM newspaper_edition_articles WHERE edition_id=(SELECT id FROM newspaper_editions WHERE public_id=$1) ORDER BY position',[legacy.id])).rows;
   await require('../../lib/edition-schema').initEditionSchema(pool);
   const result=(await req('/'+legacy.id)).body.edition;
   assert.equal(result.revision,finalized.revision);assert.deepEqual(result.contributors,[]);assert.equal(result.articles[0].contributor,undefined);assert.equal(result.articles[0].portrait_path,null);
   assert.deepEqual((await pool.query('SELECT snapshot::text FROM newspaper_edition_articles WHERE edition_id=(SELECT id FROM newspaper_editions WHERE public_id=$1) ORDER BY position',[legacy.id])).rows,before);
  });
  await t.test('hero and portrait captures share a bounded edition budget; rejection is atomic',async()=>{
   // The valid tiny PNG header is padded within the same per-file bound. No decoding or AI occurs.
   const large=Buffer.alloc(5*1024*1024);png.copy(large);await fs.writeFile(path.join(media,'tenants','1','large.png'),large);
   await pool.query("UPDATE writers SET avatar_url='/media/tenants/1/large.png' WHERE id=$1",[f.writerId]);
   const largeIds=[];for(let i=0;i<3;i++)largeIds.push((await pool.query("INSERT INTO articles(tenant_id,title,full_content,content_type,is_published,writer_id,image_url) VALUES(1,'Bounded capture','Body','original',1,$1,'/media/tenants/1/large.png') RETURNING id",[f.writerId])).rows[0].id);
   const key=crypto.randomUUID(),r=await req('','POST',{...input,request_id:key,article_ids:largeIds,lead_article_id:largeIds[0]});assert.equal(r.status,400);assert.match(r.body.error,/25 MB/);
   assert.equal((await pool.query('SELECT id FROM newspaper_editions WHERE request_id=$1',[key])).rowCount,0);assert.equal(f.state.calls,0);
  });
  await t.test('whitespace-only configuration and scheduling alone never label an AI persona',async()=>{
   await pool.query('UPDATE writers SET system_prompt=$2,is_auto=true,avatar_url=NULL WHERE id=$1',[f.writerId,' \n\t ']);
   const r=await req('','POST',{...input,mode:'proof',request_id:crypto.randomUUID()});assert.equal(r.status,201);assert.ok(r.body.edition.articles.every(a=>a.contributor.kind==='unclassified'));
  });
  await t.test('foreign and non-system shared styles are excluded, legitimate system display names are allowed',async()=>{
   for(const config of [{tenant:f.otherTenantId,system:false,expected:'Later tone'},{tenant:0,system:false,expected:'Later tone'},{tenant:0,system:true,expected:'Shared style · Later tone'}]){
    const sid=(await pool.query('INSERT INTO writing_styles(tenant_id,name,slug,prompt,is_system) VALUES($1,$2,$3,$4,$5) RETURNING id',[config.tenant,'Shared style',crypto.randomUUID(),'PRIVATE PROMPT',config.system])).rows[0].id;
    await pool.query('UPDATE writers SET style_id=$2 WHERE id=$1',[f.writerId,sid]);
    const result=await req('','POST',{...input,mode:'proof',request_id:crypto.randomUUID()});assert.equal(result.status,201);
    assert.equal(result.body.edition.articles[0].contributor.writing_style,config.expected);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE PROMPT'),false);
   }
   assert.equal(f.state.calls,0);
  });
 }finally{await f.close();if(oldMedia===undefined)delete process.env.STORAGE_LOCAL_DIR;else process.env.STORAGE_LOCAL_DIR=oldMedia;await fs.rm(media,{recursive:true,force:true});}
});
