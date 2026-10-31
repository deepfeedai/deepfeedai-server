'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
test('edition lifecycle real routes retain audit and protect publication and snapshots',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const media=await fs.mkdtemp(path.join(os.tmpdir(),'edition-lifecycle-')),previousMedia=process.env.STORAGE_LOCAL_DIR;process.env.STORAGE_LOCAL_DIR=media;
 const f=await require('../acceptance/fixture').startFixture({beforeStatic:app=>app.use('/api/editions',require('../../routes/editions'))});
 try{
 const pool=f.db.getPool(),req=async(url='',method='GET',body,token=f.token)=>{const r=await fetch(f.base+'/api/editions'+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 const article=(await pool.query("INSERT INTO articles(tenant_id,title,full_content,content_type,is_published,writer_id) VALUES(1,'Lifecycle source','Retained source content','original',1,$1) RETURNING id",[f.writerId])).rows[0].id;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 await fs.mkdir(path.join(media,'tenants','1'),{recursive:true});await fs.writeFile(path.join(media,'tenants','1','original.png'),png);
 await pool.query("UPDATE articles SET image_url='/media/tenants/1/original.png' WHERE id=$1",[article]);
 await pool.query("UPDATE writers SET avatar_url='/media/tenants/1/original.png',system_prompt='Offline lifecycle persona' WHERE id=$1",[f.writerId]);
 const input={name:'Lifecycle issue',issue_date:'2026-10-31',mode:'published',article_ids:[article],lead_article_id:article,settings:{paper:'Letter',images:false,ink_saving:true},request_id:crypto.randomUUID()};
 let e=(await req('','POST',input)).body.edition;
 const second=(await req('','POST',{...input,name:'Another issue using the same assets',request_id:crypto.randomUUID()})).body.edition;
 const secondSnapshots=async()=> (await pool.query("SELECT snapshot::text,encode(image_data,'hex') image,encode(portrait_data,'hex') portrait,position FROM newspaper_edition_articles WHERE edition_id=(SELECT id FROM newspaper_editions WHERE public_id=$1) ORDER BY position",[second.id])).rows;
 const secondBefore=await secondSnapshots();assert.equal(secondBefore[0].image,png.toString('hex'));assert.equal(secondBefore[0].portrait,png.toString('hex'));
 const rawId=(await pool.query('SELECT id FROM newspaper_editions WHERE public_id=$1',[e.id])).rows[0].id;
 const role='edition-update-'+Date.now();await pool.query('INSERT INTO roles(tenant_id,name,permissions) VALUES(1,$1,$2)',[role,JSON.stringify(['articles.read','articles.update'])]);
 const jwt=require('jsonwebtoken'),secret=(await require('../../lib/secrets').getSecrets()).jwtSecret;
 const updateToken=jwt.sign({...jwt.decode(f.token),role},secret);
 e=(await req('/'+e.id+'/finalize','POST',{revision:e.revision})).body.edition;
 e=(await req('/'+e.id+'/visibility','POST',{revision:e.revision,visibility:'public'})).body.edition;
 const snapshots=async()=> (await pool.query('SELECT snapshot::text,encode(image_data,\'hex\') image,encode(portrait_data,\'hex\') portrait,position FROM newspaper_edition_articles WHERE edition_id=$1 ORDER BY position',[rawId])).rows;
 const before=await snapshots();
 await t.test('private reader issues and proofs cannot acquire false retraction state or audit',async()=>{
  const proof=(await req('','POST',{...input,mode:'proof',request_id:crypto.randomUUID()})).body.edition;
  for(const issue of [second,proof]){
   const historyBefore=(await req('/'+issue.id+'/history')).body.history;
   for(const endpoint of ['retract','visibility']){
    const result=await req('/'+issue.id+'/'+endpoint,'POST',{revision:issue.revision,reason:'Not actually public',visibility:'private'});assert.equal(result.status,409);
   }
   const retained=(await req('/'+issue.id)).body.edition;assert.equal(retained.retracted_at,null);assert.equal(retained.revision,issue.revision);
   assert.deepEqual((await req('/'+issue.id+'/history')).body.history,historyBefore);
  }
 });
 await t.test('update-only actor cannot retract, archive or rename public issue',async()=>{
  for(const action of ['archive','retract','rename'])assert.equal((await req('/'+e.id+'/'+action,'POST',{revision:e.revision,reason:'Test',name:'Unauthorized'},updateToken)).status,403);
  assert.equal((await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:e.name,reason:'Test'},updateToken)).status,403);
  assert.equal((await req('/'+e.id)).body.edition.visibility,'public');
 });
 await t.test('retraction requires reason on both new and legacy endpoint; duplicate retry creates one audit',async()=>{
  assert.equal((await req('/'+e.id+'/visibility','POST',{revision:e.revision,visibility:'private'})).status,400);
  const body={revision:e.revision,reason:'Editorial correction'};
  const both=await Promise.all([req('/'+e.id+'/retract','POST',body),req('/'+e.id+'/retract','POST',body)]);assert.ok(both.every(r=>r.status===200));e=both[0].body.edition;
  assert.equal(e.visibility,'private');assert.ok(e.retracted_at);
  assert.equal((await fetch(f.base+'/api/editions/public/'+e.id)).status,404);
  assert.equal((await req('/'+e.id+'/history')).body.history.filter(a=>a.action==='retract').length,1);
 });
 await t.test('explicit finalized rename preserves captured contents and guards concurrent changes',async()=>{
  const revision=e.revision;const results=await Promise.all(['New masthead','Other title'].map(name=>req('/'+e.id+'/rename','POST',{revision,name},updateToken)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);e=results.find(r=>r.status===200).body.edition;
  assert.deepEqual(await snapshots(),before);assert.deepEqual(e.settings,{...input.settings,contributors:false,portraits:false});
  assert.equal((await req('/'+e.id+'/history')).body.history.filter(a=>a.action==='rename').length,1);
 });
 await t.test('archive excludes active list and public access; restore remains private',async()=>{
  const archived=await req('/'+e.id+'/archive','POST',{revision:e.revision,reason:'No longer current'});assert.equal(archived.status,200);e=archived.body.edition;assert.ok(e.archived_at);
  assert.ok(!(await req('')).body.editions.some(x=>x.id===e.id));assert.ok((await req('?view=archived')).body.editions.some(x=>x.id===e.id));
  assert.equal((await req('/'+e.id+'/visibility','POST',{revision:e.revision,visibility:'public'})).status,409);
  assert.equal((await req('/'+e.id+'/rename','POST',{revision:e.revision,name:'Blocked'})).status,409);
  e=(await req('/'+e.id+'/restore','POST',{revision:e.revision},updateToken)).body.edition;assert.equal(e.archived_at,null);assert.equal(e.visibility,'private');assert.deepEqual(await snapshots(),before);
 });
 await t.test('permanent delete requires archive/title/revision and retains audit and original article',async()=>{
  assert.equal((await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:e.name,reason:'Remove issue'})).status,409);
  e=(await req('/'+e.id+'/archive','POST',{revision:e.revision,reason:'Retire issue'})).body.edition;
  assert.equal((await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:'wrong title',reason:'Remove issue'})).status,400);
  assert.equal((await req('/'+e.id,'DELETE',{revision:e.revision-1,confirmation:e.name,reason:'Remove issue'})).status,409);
  // Deliberately fail cascade cleanup in the guarded disposable fixture DB only.
  // A server failure must roll back the audit insert and edition deletion together.
  const auditBefore=(await req('/'+e.id+'/history')).body.history,snapshotsBefore=await snapshots();
  await pool.query(`CREATE FUNCTION edition_fixture_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.edition_id=${rawId} THEN RAISE EXCEPTION 'Offline cleanup failure'; END IF; RETURN OLD; END $$`);
  try{
   await pool.query('CREATE TRIGGER edition_fixture_cleanup_failure BEFORE DELETE ON newspaper_edition_articles FOR EACH ROW EXECUTE FUNCTION edition_fixture_cleanup_failure()');
   const failed=await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:e.name,reason:'Remove issue'});assert.equal(failed.status,500);
   const retained=(await req('/'+e.id)).body.edition;assert.equal(retained.revision,e.revision);assert.equal(retained.archived_at,e.archived_at);assert.equal(retained.name,e.name);
   assert.deepEqual(await snapshots(),snapshotsBefore);assert.deepEqual((await req('/'+e.id+'/history')).body.history,auditBefore);assert.deepEqual(await secondSnapshots(),secondBefore);
  }finally{
   await pool.query('DROP TRIGGER IF EXISTS edition_fixture_cleanup_failure ON newspaper_edition_articles');
   await pool.query('DROP FUNCTION IF EXISTS edition_fixture_cleanup_failure()');
  }
  const removed=await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:e.name,reason:'Remove issue'});assert.equal(removed.status,200);assert.equal(removed.body.deleted,true);
  assert.equal((await req('/'+e.id)).status,404);assert.equal((await snapshots()).length,0);
  assert.equal((await pool.query('SELECT full_content FROM articles WHERE id=$1',[article])).rows[0].full_content,'Retained source content');
  assert.deepEqual(await fs.readFile(path.join(media,'tenants','1','original.png')),png);
  assert.deepEqual(await secondSnapshots(),secondBefore);
  for(const assetPath of [second.articles[0].image_path,second.articles[0].portrait_path]){
   const asset=await fetch(f.base+assetPath,{headers:{Authorization:'Bearer '+f.token}});assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),png);
  }
  const h=(await req('/'+e.id+'/history')).body.history;assert.equal(h[0].action,'delete');assert.equal(h[0].actor_id,String(f.userId));assert.equal(h[0].metadata.name,e.name);
  const foreignToken=jwt.sign({...jwt.decode(f.token),tenantId:f.otherTenantId},secret);
  const foreignHistory=await req('/'+e.id+'/history','GET',undefined,foreignToken);assert.equal(foreignHistory.status,200);assert.deepEqual(foreignHistory.body.history,[]);
  assert.equal((await req('/'+e.id,'DELETE',{revision:e.revision,confirmation:e.name,reason:'Remove issue'})).status,404);
  assert.equal(f.state.calls,0);
 });
 }finally{await f.close();if(previousMedia===undefined)delete process.env.STORAGE_LOCAL_DIR;else process.env.STORAGE_LOCAL_DIR=previousMedia;await fs.rm(media,{recursive:true,force:true});}
});
