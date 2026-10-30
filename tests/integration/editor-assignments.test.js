const {test}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../../db');
const service=require('../../lib/editor-assignments');
test('editor assignments: idempotent schema, source-free creation, approval, isolated drafting and recovery',{skip:!process.env.DATABASE_URL},async()=>{
 try {
  await db.init();
  const schema=require('../../lib/editor-assignment-schema');
  await schema.initAssignmentSchema(db.getPool());await schema.initAssignmentSchema(db.getPool());
  const key='assignment-test-'+Date.now();
  const writer=await db.prepare("INSERT INTO writers(tenant_id,name,slug,role) VALUES(1,'Assignment fixture',$1,'writer') RETURNING *").get(key);
  const input={topic:'Security research',angle_summary:'Explain verified mitigations',writer_id:writer.id,request_key:key};
  const copies=await Promise.all([service.create(input,1,null),service.create(input,1,null)]);
  assert.equal(copies[0].id,copies[1].id);assert.equal(copies[0].status,'needs_sources');
  const id=copies[0].id;
  await assert.rejects(()=>service.approve(id,1,null),/two sources/);
  await assert.rejects(()=>service.start(id,1,{}),/confirmation/);
  await assert.rejects(()=>service.attach(id,1,[2147483647],writer.id),/workspace/);
  await assert.rejects(()=>service.approve(id,2147483647,null),/not found/);
  const ids=[];for(let i=0;i<2;i++)ids.push((await db.prepare("INSERT INTO articles(tenant_id,title,summary,full_content,content_type,is_published) VALUES(1,$1,'Verified supporting text','','curated',0) RETURNING id").get(key+i)).id);
  await service.attach(id,1,ids,writer.id);assert.equal((await service.approve(id,1,null)).status,'approved');
  let calls=0;
  const task=await service.start(id,1,{confirmPaid:true},async(cluster,w,t,opts)=>{
   calls++;assert.equal(opts.reviewOnly,true);assert.equal(opts.allowAutoFollowup,false);assert.equal(cluster.articles.length,2);
   return db.prepare("INSERT INTO articles(tenant_id,title,content_type,is_published,status,synthesis_meta) VALUES(1,$1,'original',0,'review',$2::jsonb) RETURNING *").get(key,JSON.stringify({editor_assignment_id:String(id)}));
  });
  await assert.rejects(()=>service.start(id,1,{confirmPaid:true}),/already running/);
  await assert.rejects(()=>service.attach(id,1,ids,writer.id),/current state/);
  await task.run();assert.equal(calls,1);
  const saved=await db.prepare('SELECT * FROM article_pitches WHERE id=$1').get(id);assert.equal(saved.status,'review');assert.ok(saved.spawned_article_id);
  await assert.rejects(()=>service.start(id,1,{confirmPaid:true}),/already exists/);
  const failed=await service.create({...input,request_key:key+'-failed',source_article_ids:ids},1,null);await service.approve(failed.id,1,null);
  await (await service.start(failed.id,1,{confirmPaid:true},async()=>{throw Error('secret-provider-detail')})).run();
  const state=await db.prepare('SELECT * FROM article_pitches WHERE id=$1').get(failed.id);assert.equal(state.status,'failed');assert.ok(!state.draft_error.includes('secret-provider-detail'));
  await assert.rejects(()=>service.start(failed.id,1,{confirmPaid:true}),/acknowledge/);
  await (await service.start(failed.id,1,{confirmPaid:true,retryAcknowledged:true},async()=>{throw Error('offline failure')})).run();
  assert.equal((await db.prepare('SELECT draft_attempt FROM article_pitches WHERE id=$1').get(failed.id)).draft_attempt,2);
  assert.equal((await require('../../lib/synthesis').synthesizeFromPitch(id,1)).ok,false);
 }finally{await db.getPool().end();}
});
