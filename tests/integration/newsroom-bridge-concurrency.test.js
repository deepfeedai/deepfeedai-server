'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg'),db=require('../../db');
test('commission bridges share one transaction connection under pool pressure',{skip:!process.env.DATABASE_URL,timeout:15000},async()=>{
 const originalGetPool=db.getPool;let small;
 try{
  await db.init();const original=originalGetPool(),prefix='workflow-concurrent-'+Date.now();
  const writer=await db.prepare("INSERT INTO writers(tenant_id,name,slug,role) VALUES(1,'Concurrent fixture',$1,'writer') RETURNING id").get(prefix);
  const ids=[];for(let i=0;i<2;i++)ids.push((await db.prepare("INSERT INTO articles(tenant_id,title,summary,content_type,is_published) VALUES(1,$1,'Verified source','curated',0) RETURNING id").get(prefix+i)).id);
  const pitches=[];for(let i=0;i<3;i++)pitches.push((await db.prepare("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,source_article_ids,status) VALUES(1,$1,'original',$2,'Distinct rationale',$3::jsonb,'pending') RETURNING id").get(writer.id,prefix+i,JSON.stringify(ids))).id);
  small=new Pool({...original.options,max:2,connectionTimeoutMillis:2000,statement_timeout:3000});db.getPool=()=>small;
  const service=require('../../lib/newsroom-workflow');
  const results=await Promise.all(pitches.flatMap(id=>[service.commission('story_pitch',id,1,{sub:null}),service.commission('story_pitch',id,1,{sub:null})]));
  assert.equal(new Set(results.map(r=>r.assignment_id)).size,3);
  for(let i=0;i<results.length;i+=2)assert.equal(results[i].assignment_id,results[i+1].assignment_id);
  assert.equal(small.waitingCount,0);
  const rows=await small.query('SELECT angle_summary FROM article_pitches WHERE id=ANY($1::int[])',[results.map(r=>r.assignment_id)]);assert.ok(rows.rows.every(r=>r.angle_summary==='Distinct rationale'));
 }finally{db.getPool=originalGetPool;if(small)await small.end();await originalGetPool().end();}
});
