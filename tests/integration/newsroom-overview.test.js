'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('Overview real routes: queues, evidence, identity, filters and read-only behavior',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await require('../acceptance/fixture').startFixture();
 try{
  const pool=f.db.getPool(),schema=require('../../lib/navigation-schema');await schema.initNavigationSchema(pool);await schema.initNavigationSchema(pool);
  // Safe when root has already mounted it; the earlier mounted router responds first.
  f.app.use('/api/newsroom-overview',require('../../routes/newsroom-overview'));
  const key='offline-acceptance-jwt-not-a-production-credential',jwt=require('jsonwebtoken');
  const prefix='nav-'+Date.now();
  const second=await f.db.prepare("INSERT INTO users(username,password_hash,tenant_id,role,email,is_active) VALUES($1,'offline-only',1,'viewer',$2,1) RETURNING id").get(prefix,prefix+'@example.invalid');
  const secondToken=jwt.sign({sub:second.id,type:'platform-admin',role:'viewer',tenantId:1},key);
  const request=async(path='',{method='GET',body,token=f.token}={})=>{const r=await fetch(f.base+'/api/newsroom-overview'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
  await t.test('permission projections are omitted and reads do not create preferences or call AI',async()=>{
   const before=(await pool.query('SELECT count(*)::int n FROM navigation_preferences')).rows[0].n,calls=f.state.calls;
   assert.equal((await request('',{token:null})).status,401);
   const r=await request();assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.ok(r.body.cards.length);assert.ok(r.body.activity.length<=8);
   const restricted=await require('../../lib/newsroom-overview').overview(1,{sub:second.id,type:'platform-admin',permissions:[]});assert.deepEqual(restricted.cards,[]);assert.deepEqual(restricted.activity,[]);assert.deepEqual(restricted.onboarding.items,[]);
   assert.equal((await pool.query('SELECT count(*)::int n FROM navigation_preferences')).rows[0].n,before);assert.equal(f.state.calls,calls);
  });
  await t.test('dismissal is per principal and tenant and cannot forge completion',async()=>{
   assert.equal((await request('/onboarding',{method:'PUT',body:{version:1,dismissed:true,complete:true}})).status,400);
   assert.equal((await request('/onboarding',{method:'PUT',body:{version:2,dismissed:true}})).status,400);
   assert.equal((await request('/onboarding',{method:'PUT',body:{version:1,dismissed:true}})).status,200);
   assert.equal((await request()).body.onboarding.dismissed,true);assert.equal((await request('',{token:secondToken})).body.onboarding.dismissed,false);
   const service=require('../../lib/newsroom-overview');
   assert.equal((await service.overview(f.otherTenantId,{sub:f.userId,type:'platform-admin',permissions:[]})).onboarding.dismissed,false);
   assert.equal((await service.overview(1,{sub:f.userId,type:'tenant-admin',permissions:[]})).onboarding.dismissed,false);
   assert.equal((await request('/onboarding',{method:'PUT',body:{version:1,dismissed:false}})).body.dismissed,false);
  });
  await t.test('counts distinguish actual queues, removed sources and imported evidence',async()=>{
   const before=(await request()).body.cards;const n=id=>before.find(c=>c.id===id)?.count||0;
   for(const [status,type,published,archived] of [['draft','original',0,0],['draft','curated',0,0],['review','original',0,0],['scheduled','original',0,0],['review','original',0,1],['draft','original',1,0]])await pool.query('INSERT INTO articles(tenant_id,title,content_type,status,is_published,is_archived) VALUES(1,$1,$2,$3,$4,$5)',[prefix,type,status,published,archived]);
   await pool.query("INSERT INTO sources(tenant_id,name,url,last_fetch_error,is_active) VALUES(1,$1,$2,'Failed',0)",[prefix,'https://example.invalid/'+prefix]);
   await pool.query("INSERT INTO sources(tenant_id,name,url,last_fetch_error,removed_at) VALUES(1,$1,$2,'Failed',NOW())",[prefix+'removed','https://example.invalid/'+prefix+'removed']);
   const after=(await request()).body;for(const id of ['editorial_drafts','review','scheduled','feed_errors'])assert.equal(after.cards.find(c=>c.id===id).count,n(id)+1,id);
   assert.equal(after.onboarding.items.find(x=>x.id==='draft').scope,'workspace');assert.equal(after.onboarding.items.find(x=>x.id==='read').scope,'personal');
   const sources=await fetch(f.base+'/api/sources?paged=1&errors=1&q='+prefix,{headers:{Authorization:'Bearer '+f.token}}).then(r=>r.json());assert.equal(sources.total,1);
   const pitchBefore=after.cards.find(c=>c.id==='writer_pitches').count;
   for(const status of ['pending','proposed','approved'])await pool.query("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,status) VALUES(1,$1,'original',$2,'offline fixture',$3)",[f.writerId,prefix,status]);
   assert.equal((await request()).body.cards.find(c=>c.id==='writer_pitches').count,pitchBefore+2);
  });
  await t.test('assignment filtering is bounded and matches Overview beyond default page',async()=>{
   const before=(await request()).body.cards.find(c=>c.id==='assignments_needs_sources').count;
   const row=(await pool.query("INSERT INTO article_pitches(tenant_id,angle_summary,topic,status,is_editor_assignment) VALUES(1,'offline brief',$1,'needs_sources',true) RETURNING id",[prefix])).rows[0];
   const headers={Authorization:'Bearer '+f.token};
   const r=await fetch(f.base+'/api/editor-assignments?status=needs_sources&id='+row.id+'&limit=1&offset=0',{headers}).then(r=>r.json());assert.equal(r.total,1);assert.equal(r.assignments[0].id,row.id);assert.equal(r.limit,1);assert.equal(r.offset,0);
   assert.equal((await request()).body.cards.find(c=>c.id==='assignments_needs_sources').count,before+1);
   assert.equal((await fetch(f.base+'/api/editor-assignments?status=made_up',{headers})).status,400);
   assert.equal((await fetch(f.base+'/api/editor-assignments?limit=-1',{headers})).status,400);
   const foreign=(await pool.query("INSERT INTO article_pitches(tenant_id,angle_summary,topic,status,is_editor_assignment) VALUES($1,'foreign brief',$2,'needs_sources',true) RETURNING id",[f.otherTenantId,prefix])).rows[0];
   const empty=await fetch(f.base+'/api/editor-assignments?id='+foreign.id+'&status=needs_sources',{headers}).then(r=>r.json());assert.equal(empty.total,0);
  });
  await t.test('disabled assignment feature hides its counts and evidence',async()=>{
   const features=require('../../lib/feature-registry');
   try{
    await pool.query("UPDATE tenant_feature_overrides SET value='false' WHERE tenant_id=1 AND feature_key='article_pitches'");features.bustFeatureCache(1);
    const r=(await request()).body;assert.ok(!r.cards.some(x=>x.id==='assignments_needs_sources'));assert.ok(!r.onboarding.items.some(x=>x.id==='brief'));assert.ok(r.cards.some(x=>x.id==='writer_pitches'));
   }finally{await pool.query("UPDATE tenant_feature_overrides SET value='true' WHERE tenant_id=1 AND feature_key='article_pitches'");features.bustFeatureCache(1);}
  });
  await t.test('draft evidence matches its destination and read-only activity avoids editing links',async()=>{
   const service=require('../../lib/newsroom-overview'),user={sub:second.id,type:'platform-admin',permissions:['articles.read']};
   await pool.query("UPDATE articles SET status='review' WHERE tenant_id=$1",[f.otherTenantId]);
   let result=await service.overview(f.otherTenantId,user);assert.equal(result.onboarding.items.find(x=>x.id==='draft').complete,false);
   assert.ok(result.activity.every(x=>x.href.startsWith('articles.html?id=')));
   await pool.query('UPDATE articles SET status=NULL WHERE id=$1',[f.foreignId]);
   result=await service.overview(f.otherTenantId,user);assert.equal(result.onboarding.items.find(x=>x.id==='draft').complete,true);assert.equal(result.cards.find(x=>x.id==='editorial_drafts').count,1);
  });
  await t.test('assignment display state follows persisted draft lifecycle including unavailable articles',async()=>{
   const article=(await pool.query("INSERT INTO articles(tenant_id,title,status,content_type,is_published,is_archived) VALUES(1,$1,'draft','original',0,0) RETURNING id",[prefix])).rows[0];
   const assignment=(await pool.query("INSERT INTO article_pitches(tenant_id,angle_summary,status,is_editor_assignment,spawned_article_id) VALUES(1,'offline lifecycle','review',true,$1) RETURNING id",[article.id])).rows[0];
   const headers={Authorization:'Bearer '+f.token};
   const get=async status=>fetch(f.base+'/api/editor-assignments?id='+assignment.id+'&status='+status,{headers}).then(r=>r.json());
   assert.equal((await get('draft')).total,1);assert.equal((await get('review')).total,0);
   await pool.query('UPDATE articles SET is_archived=1 WHERE id=$1',[article.id]);assert.equal((await get('archived')).total,1);
   await pool.query('DELETE FROM articles WHERE id=$1',[article.id]);assert.equal((await get('draft_unavailable')).total,1);assert.equal((await get('review')).total,0);
  });
  await t.test('writer pitch queue remains reachable beyond the default first fifty',async()=>{
   for(let i=0;i<55;i++)await pool.query("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,status) VALUES(1,$1,'original',$2,'offline pagination','pending')",[f.writerId,prefix+'page'+i]);
   const headers={Authorization:'Bearer '+f.token},base=f.base+'/api/admin/pitches?status=open&writer_id='+f.writerId+'&limit=50&offset=';
   const first=await fetch(base+'0',{headers}).then(r=>r.json()),second=await fetch(base+'50',{headers}).then(r=>r.json());
   assert.equal(first.total,57);assert.equal(first.pitches.length,50);assert.equal(first.hasMore,true);
   assert.equal(second.total,57);assert.equal(second.pitches.length,7);assert.equal(second.hasMore,false);
   assert.equal(new Set([...first.pitches,...second.pitches].map(p=>p.id)).size,57);
  });
 }finally{await f.close();}
});
