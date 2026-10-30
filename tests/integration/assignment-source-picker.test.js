'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('Assignment source picker real APIs and atomic attachment editing',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await require('../acceptance/fixture').startFixture();try{
 const pool=f.db.getPool(),prefix='picker-'+Date.now(),rules=require('../../lib/assignment-sources');
 const assignment=await require('../../lib/editor-assignments').create({topic:prefix,angle_summary:'Offline evidence',request_key:prefix+'-unique-request',writer_id:f.writerId},1,f.userId);
 const request=async(path='',{method='GET',body,token=f.token}={})=>{const r=await fetch(f.base+'/api/editor-assignments/'+assignment.id+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};};
 const ids=[];for(let i=0;i<26;i++)ids.push((await pool.query("INSERT INTO articles(tenant_id,title,source,summary,content_type,topic_tag,is_archived,created_at) VALUES(1,$1,$2,'Readable evidence','curated',$3,0,NOW()) RETURNING id",[prefix+' article '+i,prefix+' publisher',prefix+' topic'])).rows[0].id);
 await t.test('eligible search, pagination, filters and metadata are tenant safe and non-AI',async()=>{
  const a=await request('/source-options?q='+prefix+'&limit=10');assert.equal(a.status,200);assert.equal(a.body.total,26);assert.equal(a.body.items.length,10);assert.deepEqual(a.body.requirements,{minimum:2,maximum:20});
  const b=await request('/source-options?q='+prefix+'&limit=10&offset=10');assert.ok(!b.body.items.some(x=>a.body.items.some(y=>x.id===y.id)));
  assert.equal((await request('/source-options?publisher='+encodeURIComponent(prefix+' publisher')+'&topic='+encodeURIComponent(prefix+' topic')+'&date=24h&sort=relevance&q='+prefix)).body.total,26);
  assert.equal((await request('/source-options?limit=51')).status,400);assert.equal((await request('/source-options?date=bad')).status,400);assert.equal((await request('/source-options',{token:null})).status,401);
  await pool.query('UPDATE articles SET is_archived=1 WHERE id=$1',[ids[25]]);await pool.query("UPDATE articles SET summary='',full_content='',content='' WHERE id=$1",[ids[24]]);
  assert.equal((await request('/source-options?q='+prefix)).body.total,24);assert.equal(f.state.calls,0);
 });
 await t.test('concurrent adds preserve both sources and repeated adds preserve approval',async()=>{
  const results=await Promise.all(ids.slice(0,2).map(id=>request('/sources',{method:'POST',body:{source_article_ids:[id]}})));assert.ok(results.every(x=>x.status===200));
  let detail=(await request()).body;assert.deepEqual(new Set(rules.ids(detail)),new Set(ids.slice(0,2)));assert.equal(detail.attached_sources.length,2);assert.equal(detail.status,'proposed');
  assert.equal((await request('/approve',{method:'POST',body:{}})).status,200);
  detail=(await request('/sources',{method:'POST',body:{source_article_ids:[ids[0]]}})).body;assert.equal(detail.status,'approved');assert.ok(detail.decided_at);
 });
 await t.test('writer update and add are independent, explicit remove is idempotent',async()=>{
  const results=await Promise.all([request('/writer',{method:'PUT',body:{writer_id:null}}),request('/sources',{method:'POST',body:{source_article_ids:[ids[2]]}})]);assert.ok(results.every(x=>x.status===200));
  let detail=(await request()).body;assert.equal(detail.pitched_by_writer_id,null);assert.equal(rules.ids(detail).length,3);
  assert.equal((await request('/writer',{method:'PUT',body:{writer_id:f.writerId}})).status,200);
  assert.equal((await request('/sources/'+ids[0],{method:'DELETE'})).status,200);assert.equal((await request('/sources/'+ids[0],{method:'DELETE'})).status,200);
  detail=(await request()).body;assert.equal(detail.pitched_by_writer_id,f.writerId);assert.deepEqual(new Set(rules.ids(detail)),new Set(ids.slice(1,3)));
 });
 await t.test('invalid/foreign/ineligible/capacity/permission failures do not corrupt attachments',async()=>{
  const before=rules.ids((await request()).body);
  for(const bad of [[f.foreignId],[ids[25]],[ids[24]],[-1],Array.from({length:21},(_,i)=>ids[i])])assert.equal((await request('/sources',{method:'POST',body:{source_article_ids:bad}})).status,400);
  assert.equal((await request('/sources',{method:'POST',body:{source_article_ids:[ids[4]]},token:f.viewerToken})).status,403);
  assert.equal((await request('/writer',{method:'PUT',body:{writer_id:99999999}})).status,400);assert.deepEqual(rules.ids((await request()).body),before);
  await pool.query("UPDATE article_pitches SET status='drafting' WHERE id=$1",[assignment.id]);assert.equal((await request('/sources/'+ids[1],{method:'DELETE'})).status,409);
  await pool.query("UPDATE article_pitches SET status='proposed' WHERE id=$1",[assignment.id]);
  const foreign=(await pool.query("INSERT INTO article_pitches(tenant_id,angle_summary,status,is_editor_assignment) VALUES($1,'Foreign','needs_sources',true) RETURNING id",[f.otherTenantId])).rows[0];
  assert.equal((await fetch(f.base+'/api/editor-assignments/'+foreign.id+'/source-options',{headers:{Authorization:'Bearer '+f.token}})).status,404);
 });
 await t.test('legacy replacement remains explicit, unavailable source cards do not leak foreign content',async()=>{
  assert.equal((await request('/sources',{method:'PUT',body:{source_article_ids:[ids[4]],writer_id:f.writerId}})).status,200);assert.deepEqual(rules.ids((await request()).body),[ids[4]]);
  await pool.query('UPDATE article_pitches SET attached_article_ids=$2::jsonb WHERE id=$1',[assignment.id,JSON.stringify([f.foreignId])]);
  const cards=(await request()).body.attached_sources;assert.equal(cards.find(c=>c.id===f.foreignId).title,'Source unavailable');assert.equal(cards.find(c=>c.id===f.foreignId).unavailable,true);
  assert.equal((await request('/sources/'+f.foreignId,{method:'DELETE'})).status,200);assert.equal(f.state.calls,0);
 });
 }finally{await f.close();}
});
