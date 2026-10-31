'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),db=require('../../db');
test('workflow schema is additive and repeated initialization preserves writer pitches',{skip:!process.env.DATABASE_URL},async()=>{
 try{
  await db.init();const schema=require('../../lib/newsroom-workflow-schema');
  const client=await db.getPool().connect();
  try{
   await client.query('BEGIN');
   await client.query('CREATE TEMP TABLE story_pitches(id INTEGER,tenant_id INTEGER,headline TEXT) ON COMMIT DROP');
   await client.query("INSERT INTO story_pitches VALUES(1,1,'Legacy saved pitch')");
   await schema.initNewsroomWorkflowSchema(client);await schema.initNewsroomWorkflowSchema(client);
   assert.deepEqual((await client.query('SELECT * FROM story_pitches')).rows,[{id:1,tenant_id:1,headline:'Legacy saved pitch',spawned_article_id:null}]);
   await client.query('ROLLBACK');
  }finally{client.release();}
  const writer=await db.prepare("INSERT INTO writers(tenant_id,name,slug,role) VALUES(1,'Workflow schema fixture',$1,'writer') RETURNING id").get('workflow-schema-'+Date.now());
  const pitch=await db.prepare("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,status) VALUES(1,$1,'original','Preserved headline','Preserved reasoning','pending') RETURNING *").get(writer.id);
  await schema.initNewsroomWorkflowSchema(db.getPool());await schema.initNewsroomWorkflowSchema(db.getPool());
  const after=await db.prepare('SELECT * FROM story_pitches WHERE id=$1').get(pitch.id);assert.deepEqual(after,pitch);assert.equal(after.spawned_article_id,null);
  await db.prepare('UPDATE story_pitches SET spawned_article_id=123 WHERE id=$1').run(pitch.id);await schema.initNewsroomWorkflowSchema(db.getPool());
  assert.equal((await db.prepare('SELECT spawned_article_id FROM story_pitches WHERE id=$1').get(pitch.id)).spawned_article_id,123);
 }finally{await db.getPool().end();}
});
