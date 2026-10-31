'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),db=require('../../db');
test('actual signed publication handler respects review, schedule and cap',{skip:!process.env.DATABASE_URL},async t=>{
 const config=require('../../lib/app-config'),original=config.getAppConfig,oldAutomation=process.env.AUTOMATION_ENABLED;
 let settings={publish_mode:'scheduled',daily_publish_cap:0,newsroom_timezone:'UTC',drop_windows:['23:59']};
 config.getAppConfig=async()=>settings;process.env.AUTOMATION_ENABLED='false';
 try{
  await db.init();const prefix='token-workflow-'+Date.now();
  const category=await db.prepare('SELECT name FROM categories WHERE tenant_id=1 LIMIT 1').get();assert.ok(category);
  const insert=async status=>db.prepare("INSERT INTO articles(tenant_id,title,summary,content_type,category,status,is_published) VALUES(1,$1,'Verified text','curated',$2,$3,0) RETURNING *").get(prefix,category.name,status);
  const handler=require('../../lib/actions/handlers').getHandler('article.publish');
  const token=a=>({target_id:a.id,tenant_id:1,user_id:null,payload:{expected_revision:a.publication_revision}});
  await t.test('review approval schedules; repeated scheduled token never publishes early',async()=>{
   const a=await insert('review'),r=await handler(token(a));assert.equal(r.data.status,'scheduled');
   const before=await db.prepare('SELECT * FROM articles WHERE id=$1').get(a.id);assert.equal(before.is_published,0);assert.ok(before.publish_at);
   const again=await handler(token(a));assert.equal(again.data.status,'scheduled');
   const after=await db.prepare('SELECT * FROM articles WHERE id=$1').get(a.id);assert.equal(after.publication_revision,before.publication_revision);assert.equal(after.is_published,0);assert.equal(String(after.publish_at),String(before.publish_at));
  });
  await t.test('stale draft token requires review instead of publishing',async()=>{
   const a=await insert('draft');await assert.rejects(()=>handler(token(a)),e=>e.status===409);
   assert.equal((await db.prepare('SELECT is_published FROM articles WHERE id=$1').get(a.id)).is_published,0);
  });
  await t.test('daily cap produces honest future schedule',async()=>{
   settings={...settings,publish_mode:'immediate',daily_publish_cap:1};
   await db.prepare("INSERT INTO articles(tenant_id,title,summary,content_type,category,status,is_published,published_at) VALUES(1,$1,'Cap fixture','original',$2,'published',1,NOW())").run(prefix+'-cap',category.name);
   const a=await insert('review'),r=await handler(token(a));assert.equal(r.data.status,'scheduled');
   const after=await db.prepare('SELECT is_published,publish_at FROM articles WHERE id=$1').get(a.id);assert.equal(after.is_published,0);assert.ok(new Date(after.publish_at)>new Date());
  });
 }finally{config.getAppConfig=original;if(oldAutomation===undefined)delete process.env.AUTOMATION_ENABLED;else process.env.AUTOMATION_ENABLED=oldAutomation;await db.getPool().end();}
});
