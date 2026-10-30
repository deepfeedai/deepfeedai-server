'use strict';
const db=require('../db');
const error=(message,status=400)=>Object.assign(new Error(message),{status});
async function initPublicationSchema(pool){
 for(const column of ['publication_revision INTEGER NOT NULL DEFAULT 0',"post_publish_status TEXT NOT NULL DEFAULT 'not_requested'",'post_publish_error TEXT'])await pool.query('ALTER TABLE articles ADD COLUMN IF NOT EXISTS '+column);
 await pool.query(`CREATE TABLE IF NOT EXISTS article_publication_history(
  id BIGSERIAL PRIMARY KEY,tenant_id INTEGER NOT NULL,article_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,action TEXT NOT NULL,actor_id INTEGER,
  before_state JSONB,after_state JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query('CREATE INDEX IF NOT EXISTS article_publication_history_lookup ON article_publication_history(tenant_id,article_id,id)');
}
function snapshot(article){const result={};for(const key of ['title','slug','summary','full_content','content','content_blocks','category','source_article_ids','image_url','writer_id','status','is_published','is_archived','publication_revision'])result[key]=article[key]??null;return result;}
async function history(client,tenantId,articleId,action,userId,before,after){
 await client.query(`INSERT INTO article_publication_history(tenant_id,article_id,revision,action,actor_id,before_state,after_state)
 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,[tenantId,articleId,after.publication_revision,action,userId||null,JSON.stringify(snapshot(before)),JSON.stringify(snapshot(after))]);
}
async function validate(client,article,tenantId){
 if(!article.title?.trim())throw error('A title is required before publication');
 if(article.is_archived)throw error('Restore the article before publishing',409);
 if(!await client.query('SELECT id FROM categories WHERE tenant_id=$1 AND name=$2',[tenantId,article.category]).then(r=>r.rowCount))throw error('Select an existing category before publication');
 if(['original','deep-dive'].includes(article.content_type)){
  if(!String(article.full_content||article.content||'').trim())throw error('Draft content is required before publication');
  if(!await client.query("SELECT id FROM writers WHERE tenant_id=$1 AND id=$2 AND role='writer'",[tenantId,article.writer_id]).then(r=>r.rowCount))throw error('Assign a writer from this workspace before publication');
  let refs=article.source_article_ids;if(typeof refs==='string'){try{refs=JSON.parse(refs);}catch{refs=[];}}
  const ids=[...new Set((Array.isArray(refs)?refs:[]).map(r=>typeof r==='object'?r.id:r))];
  if(ids.length<2||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw error('At least two valid supporting sources are required before publication');
  const valid=await client.query("SELECT id FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[]) AND (content_type IS NULL OR content_type='curated') AND COALESCE(is_archived,0)=0",[tenantId,ids]);
  if(valid.rowCount!==ids.length)throw error('Supporting sources must remain available in this workspace');
 }else if(!String(article.summary||article.content||article.full_content||'').trim())throw error('Article text or a summary is required before publication');
}
async function change(id,tenantId,{published,approve=false,expectedRevision,force=false,userId}={}){
 if(typeof published!=='boolean')throw error('Specify published: true or false; publication is not a toggle');
 if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0))throw error('Invalid expected revision');
 const config=published?await require('./app-config').getAppConfig(tenantId):null;
 const client=await db.getPool().connect();let updated,changed=false;
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(78241,$1)',[tenantId]);
  const {rows:[article]}=await client.query('SELECT * FROM articles WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id,tenantId]);
  if(!article)throw error('Article not found',404);
  const alreadyDesired=published?article.is_published===1:article.is_published===0&&['draft','archived','rejected'].includes(article.status);
  if(alreadyDesired||(approve&&article.status==='scheduled')){await client.query('COMMIT');return article;}
  if(expectedRevision!==undefined&&article.publication_revision!==expectedRevision)throw error('Article changed since it was opened. Reload and review before publishing.',409);
  if(approve&&article.status!=='review')throw error('Only articles in review can be approved',409);
  let status=published?'published':'draft',publishAt=null;
  if(published){
   await validate(client,article,tenantId);
   const gate=await require('./publish-gate').evaluatePublish(tenantId,{force,appCfg:config,client});
   if(approve&&['schedule','cap_reached'].includes(gate.action)){status='scheduled';publishAt=gate.at||gate.scheduleAt;published=false;}
   else if(gate.action==='cap_reached')throw error('Daily publication limit reached. Review the schedule or explicitly request an override.',429);
  }
  const hooks=published?(process.env.AUTOMATION_ENABLED==='false'?'skipped':'pending'):'not_requested';
  const result=await client.query(`UPDATE articles SET is_published=$3,status=$4,is_archived=0,publish_at=$5,
    published_at=CASE WHEN $3=1 THEN NOW() ELSE published_at END,
    reviewed_by=CASE WHEN $6 THEN $7 ELSE reviewed_by END,reviewed_at=CASE WHEN $6 THEN NOW() ELSE reviewed_at END,
    publication_revision=publication_revision+1,post_publish_status=$8,post_publish_error=NULL,updated_at=NOW()
    WHERE id=$1 AND tenant_id=$2 RETURNING *`,[id,tenantId,published?1:0,status,publishAt,approve,userId||null,hooks]);
  updated=result.rows[0];await history(client,tenantId,id,published?'publish':status==='scheduled'?'schedule':'unpublish',userId,article,updated);
  await client.query('COMMIT');changed=true;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 if(changed&&updated.is_published&&updated.post_publish_status==='pending'){
  const dispatch=async()=>{try{await require('./post-publish').onArticlePublished(id,tenantId);await db.prepare("UPDATE articles SET post_publish_status='dispatched' WHERE id=$1 AND tenant_id=$2 AND publication_revision=$3").run(id,tenantId,updated.publication_revision);}catch{await db.prepare("UPDATE articles SET post_publish_status='failed',post_publish_error='Optional post-publication work failed; the article remains published.' WHERE id=$1 AND tenant_id=$2 AND publication_revision=$3").run(id,tenantId,updated.publication_revision);}};
  setImmediate(()=>dispatch().catch(()=>console.warn('[publication] Optional work status could not be persisted; check pending work.')));
 }
 return updated;
}
module.exports={initPublicationSchema,change,validate,history,snapshot};
