'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('edition 1 metadata backfill is guarded, partial-safe and preserves immutable fields',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await require('../acceptance/fixture').startFixture();let client;
 try{
  client=await f.db.getPool().connect();
  // Session-local shadow tables make the fixed-ID operator repair testable without
  // touching any other fixture's editions, source articles or production database.
  await client.query(`CREATE TEMP TABLE newspaper_editions(id int PRIMARY KEY,tenant_id int,mode text,status text,visibility text,revision int,name text,settings jsonb,lead_article_id int,finalized_at timestamptz,updated_at timestamptz)`);
  await client.query(`CREATE TEMP TABLE newspaper_edition_articles(edition_id int,article_id int,position int,snapshot jsonb,image_data bytea,image_mime text)`);
  await client.query(`CREATE TEMP TABLE articles(id int,tenant_id int,title text,full_content text,content text,summary text,source_article_ids jsonb,updated_at timestamptz,published_at timestamptz,is_published int,is_archived int,content_type text)`);
  const ref=[{id:10,title:'Verified reference',source:'Publisher',source_url:'https://example.org/reference'}];
  for(const id of [1,2])await client.query("INSERT INTO articles VALUES($1,1,'Article','Saved body [1]',NULL,'Summary',$2::jsonb,NOW(),NOW(),1,0,'original')",[id,JSON.stringify(ref)]);
  await client.query("INSERT INTO newspaper_editions VALUES(1,1,'published','finalized','public',6,'Edition',$1::jsonb,1,NOW(),NOW())",[JSON.stringify({paper:'Letter',images:true,ink_saving:false})]);
  const rows=(await client.query('SELECT *,published_at::text publication_epoch FROM articles ORDER BY id')).rows;
  for(const row of rows)await client.query('INSERT INTO newspaper_edition_articles VALUES(1,$1,$2,$3::jsonb,$4,\'image/png\')',[row.id,row.id-1,JSON.stringify({title:row.title,content:row.id===2?'Older unmatched text [1]':row.full_content,source_updated_at:row.updated_at,publication_epoch:row.publication_epoch,was_published:true}),Buffer.from([1,2,3,row.id])]);
  const wrapped={connect:async()=>({query:client.query.bind(client),release(){}})},service=require('../../lib/edition-references');
  const beforeEdition=(await client.query('SELECT * FROM newspaper_editions')).rows[0],beforeRows=(await client.query('SELECT * FROM newspaper_edition_articles ORDER BY position')).rows;
  let plan=await service.backfillEditionOne(wrapped);assert.equal(plan.applied,false);assert.equal(plan.edition_revision,6);assert.equal(plan.items[0].eligible,true);assert.equal(plan.items[1].eligible,false);
  await t.test('changed reference metadata invalidates reviewed dry-run without writes',async()=>{
   await client.query("UPDATE articles SET source_article_ids=$1::jsonb WHERE id=1",[JSON.stringify([{...ref[0],title:'Changed before approval'}])]);
   await assert.rejects(service.backfillEditionOne(wrapped,{apply:true,expectedPlan:plan}),/plan changed/);
   assert.equal((await client.query('SELECT revision FROM newspaper_editions')).rows[0].revision,6);
   assert.equal((await client.query("SELECT snapshot ? 'references' captured FROM newspaper_edition_articles WHERE article_id=1")).rows[0].captured,false);
  });
  await t.test('reviewed exact plan adds only references, leaves blocked item and source state intact',async()=>{
   plan=await service.backfillEditionOne(wrapped);const result=await service.backfillEditionOne(wrapped,{apply:true,expectedPlan:plan});
   assert.deepEqual(result.changed_article_ids,[1]);assert.equal(result.new_revision,7);assert.equal(result.preservation_verified,true);
   const afterEdition=(await client.query('SELECT * FROM newspaper_editions')).rows[0],afterRows=(await client.query('SELECT * FROM newspaper_edition_articles ORDER BY position')).rows;
   for(const k of Object.keys(beforeEdition).filter(k=>!['revision','updated_at'].includes(k)))assert.deepEqual(afterEdition[k],beforeEdition[k],k);
   for(let i=0;i<beforeRows.length;i++){const old=beforeRows[i],now=afterRows[i];assert.deepEqual({...now,snapshot:service.preservedSnapshot(now.snapshot)},{...old,snapshot:service.preservedSnapshot(old.snapshot)});}
   assert.equal(afterRows[0].snapshot.references[0].title,'Changed before approval');assert.equal(afterRows[1].snapshot.references,undefined);
   assert.equal((await client.query('SELECT is_published FROM articles WHERE id=1')).rows[0].is_published,1);
  });
  await t.test('old plan cannot replay and fresh no-change plan is idempotent',async()=>{
   await assert.rejects(service.backfillEditionOne(wrapped,{apply:true,expectedPlan:plan}),/plan changed/);
   const repeat=await service.backfillEditionOne(wrapped);const result=await service.backfillEditionOne(wrapped,{apply:true,expectedPlan:repeat});assert.deepEqual(result.changed_article_ids,[]);assert.equal(result.new_revision,7);
  });
 }finally{if(client)client.release();await f.close();}
});
