'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('edition opaque identifiers preserve authorization and canonical legacy policy',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const media=await fs.mkdtemp(path.join(os.tmpdir(),'edition-identifiers-')),previous=process.env.STORAGE_LOCAL_DIR;
 process.env.STORAGE_LOCAL_DIR=media;
 const f=await require('../acceptance/fixture').startFixture({beforeStatic:app=>app.use('/api/editions',require('../../routes/editions'))});
 try{
  const pool=f.db.getPool(),schema=require('../../lib/edition-schema');await schema.initEditionSchema(pool);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await fs.mkdir(path.join(media,'tenants','1'),{recursive:true});await fs.writeFile(path.join(media,'tenants','1','identifier.png'),png);
  await pool.query("UPDATE writers SET avatar_url='/media/tenants/1/identifier.png',system_prompt='Offline persona' WHERE id=$1",[f.writerId]);
  const article=(await pool.query("INSERT INTO articles(tenant_id,title,full_content,content_type,is_published,writer_id,image_url) VALUES(1,'Opaque fixture','Saved body','original',1,$1,'/media/tenants/1/identifier.png') RETURNING id",[f.writerId])).rows[0].id;
  const request=async(route='',method='GET',body,token=f.token)=>{
   const r=await fetch(f.base+'/api/editions'+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
   return {status:r.status,body:await r.json()};
  };
  const input={name:'Opaque issue',issue_date:'2026-10-31',mode:'published',article_ids:[article],lead_article_id:article,settings:{paper:'Letter',images:true,ink_saving:false,contributors:true,portraits:true},request_id:crypto.randomUUID()};
  let edition=(await request('','POST',input)).body.edition;
  const numeric=(await pool.query('SELECT id FROM newspaper_editions WHERE public_id=$1',[edition.id])).rows[0].id;
  await t.test('new IDs are distinct UUIDv4 and canonical DTO/assets never expose sequential edition ID',async()=>{
   assert.match(edition.id,uuid);assert.equal(typeof edition.id,'string');assert.equal(edition.public_id,undefined);assert.equal(edition.internal_id,undefined);
   const other=(await request('','POST',{...input,request_id:crypto.randomUUID()})).body.edition;assert.match(other.id,uuid);assert.notEqual(other.id,edition.id);
   assert.equal(edition.articles[0].image_path,`/api/editions/${edition.id}/assets/${article}`);
   assert.equal(edition.articles[0].portrait_path,`/api/editions/${edition.id}/portraits/${article}`);
   const list=await request();assert.ok(list.body.editions.every(e=>uuid.test(e.id)));
  });
  await t.test('repeat migration keeps UUIDs, revisions and exact snapshots; legacy null backfill is stable',async()=>{
   const before=(await pool.query('SELECT revision,public_id FROM newspaper_editions WHERE id=$1',[numeric])).rows[0];
   const snapshots=(await pool.query('SELECT snapshot::text,encode(image_data,\'hex\') image,encode(portrait_data,\'hex\') portrait FROM newspaper_edition_articles WHERE edition_id=$1',[numeric])).rows;
   await schema.initEditionSchema(pool);await schema.initEditionSchema(pool);
   assert.deepEqual((await pool.query('SELECT revision,public_id FROM newspaper_editions WHERE id=$1',[numeric])).rows[0],before);
   // Model a pre-migration row only in this explicitly disposable fixture database.
   const legacy=(await pool.query("INSERT INTO newspaper_editions(tenant_id,created_by,request_id,request_hash,name,issue_date,mode,settings) VALUES(1,'fixture',$1,'fixture','Legacy','2026-10-31','proof','{}') RETURNING id",[crypto.randomUUID()])).rows[0].id;
   await pool.query('ALTER TABLE newspaper_editions ALTER COLUMN public_id DROP NOT NULL');
   await pool.query('UPDATE newspaper_editions SET public_id=NULL WHERE id=$1',[legacy]);
   await schema.initEditionSchema(pool);const migrated=(await pool.query('SELECT public_id,revision FROM newspaper_editions WHERE id=$1',[legacy])).rows[0];assert.match(migrated.public_id,uuid);assert.equal(migrated.revision,1);
   await schema.initEditionSchema(pool);assert.deepEqual((await pool.query('SELECT public_id,revision FROM newspaper_editions WHERE id=$1',[legacy])).rows[0],migrated);
   assert.deepEqual((await pool.query('SELECT snapshot::text,encode(image_data,\'hex\') image,encode(portrait_data,\'hex\') portrait FROM newspaper_edition_articles WHERE edition_id=$1',[numeric])).rows,snapshots);
  });
  await t.test('private legacy reads require authentication, return canonical UUID, and numeric writes fail',async()=>{
   assert.equal((await request('/'+numeric,'GET',undefined,null)).status,401);
   assert.equal((await request('/'+numeric)).body.edition.id,edition.id);
   for(const kind of ['assets','portraits']){
    assert.equal((await fetch(`${f.base}/api/editions/${numeric}/${kind}/${article}`)).status,401);
    const r=await fetch(`${f.base}/api/editions/${numeric}/${kind}/${article}`,{headers:{Authorization:'Bearer '+f.token}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
   }
   assert.equal((await request('/'+numeric+'/finalize','POST',{revision:edition.revision})).status,400);
   const foreign=await require('../../lib/editions').create(f.otherTenantId,f.userId,{...input,mode:'proof',article_ids:[f.foreignId],lead_article_id:f.foreignId,request_id:crypto.randomUUID()});
   const foreignNumeric=(await pool.query('SELECT id FROM newspaper_editions WHERE public_id=$1',[foreign.id])).rows[0].id;
   assert.equal((await request('/'+foreign.id)).status,404);assert.equal((await request('/'+foreignNumeric)).status,404);
  });
  await t.test('public routes refuse numeric and malformed IDs while eligible UUID snapshots and raster assets work',async()=>{
   edition=(await request('/'+edition.id+'/finalize','POST',{revision:edition.revision})).body.edition;
   edition=(await request('/'+edition.id+'/visibility','POST',{revision:edition.revision,visibility:'public'})).body.edition;
   assert.equal((await request('/public/'+edition.id,'GET',undefined,null)).status,200);
   for(const bad of [String(numeric),'0','00000000-0000-0000-0000-000000000000','not-an-id']){
    assert.equal((await request('/public/'+bad,'GET',undefined,null)).status,404);
    for(const kind of ['assets','portraits'])assert.equal((await fetch(`${f.base}/api/editions/public/${bad}/${kind}/${article}`)).status,404);
   }
   for(const kind of ['assets','portraits']){const r=await fetch(`${f.base}/api/editions/public/${edition.id}/${kind}/${article}`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);}
   const proof=(await request('','POST',{...input,mode:'proof',request_id:crypto.randomUUID()})).body.edition;
   assert.equal((await request('/public/'+proof.id,'GET',undefined,null)).status,404);
   assert.equal((await fetch(`${f.base}/api/editions/public/${proof.id}/portraits/${article}`)).status,404);
   assert.equal(f.state.calls,0);
  });
 }finally{await f.close();if(previous===undefined)delete process.env.STORAGE_LOCAL_DIR;else process.env.STORAGE_LOCAL_DIR=previous;await fs.rm(media,{recursive:true,force:true});}
});
