'use strict';
const db=require('../db');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function text(v,max){return typeof v==='string'?v.trim().slice(0,max):'';}
async function sources(ids,tenantId){
 if(!Array.isArray(ids)||ids.length>20||ids.some(x=>!Number.isSafeInteger(x)||x<1))throw fail('Select valid source articles (maximum 20).');
 const unique=[...new Set(ids)];if(!unique.length)return [];
 const rows=await db.prepare("SELECT id FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[]) AND (content_type IS NULL OR content_type='curated') AND COALESCE(is_archived,0)=0 AND length(COALESCE(NULLIF(full_content,''),NULLIF(content,''),summary,''))>0").all(tenantId,unique);
 if(rows.length!==unique.length)throw fail('Sources must be available curated articles from this workspace with supporting text.');return unique;
}
async function create(input,tenantId,userId){
 const angle=text(input.angle_summary,2000),topic=text(input.topic||input.angle_summary,200);if(!angle||!topic)throw fail('A topic and angle are required.');
 if(!/^[a-zA-Z0-9_-]{16,100}$/.test(input.request_key||''))throw fail('A stable request key is required.');
 const writerId=Number(input.writer_id||input.pitched_by_writer_id)||null;
 if(writerId&&!await db.prepare("SELECT id FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'").get(writerId,tenantId))throw fail('Select an writer from this workspace.');
 const ids=await sources(input.source_article_ids||[],tenantId);
 const {normalisePitchType}=require('./pitch-types');
 return db.prepare(`INSERT INTO article_pitches(tenant_id,source_article_id,attached_article_ids,pitched_by_writer_id,requested_by_editor_id,angle_summary,pitch_type,status,is_editor_assignment,topic,request_key,skip_synthesis) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,true,$9,$10,true) ON CONFLICT(tenant_id,request_key) WHERE is_editor_assignment=true AND request_key IS NOT NULL DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`).get(tenantId,ids[0]||null,JSON.stringify(ids.slice(1)),writerId,userId,angle,normalisePitchType(input.pitch_type),ids.length>=2?'proposed':'needs_sources',topic,input.request_key);
}
async function attach(id,tenantId,ids,writerId){
 const valid=await sources(ids,tenantId);
 if(writerId&&!await db.prepare("SELECT id FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'").get(writerId,tenantId))throw fail('Select an writer from this workspace.');
 const row=await db.prepare(`UPDATE article_pitches SET source_article_id=$3,attached_article_ids=$4::jsonb,pitched_by_writer_id=COALESCE($5,pitched_by_writer_id),status=$6,decided_at=NULL,draft_error=NULL WHERE id=$1 AND tenant_id=$2 AND is_editor_assignment=true AND status IN ('needs_sources','proposed','approved','failed') AND spawned_article_id IS NULL RETURNING *`).get(id,tenantId,valid[0]||null,JSON.stringify(valid.slice(1)),writerId||null,valid.length>=2?'proposed':'needs_sources');if(!row)throw fail('Assignment cannot be edited in its current state.',409);return row;
}
async function approve(id,tenantId,userId){
 const row=await db.prepare('SELECT * FROM article_pitches WHERE id=$1 AND tenant_id=$2 AND is_editor_assignment=true').get(id,tenantId);if(!row)throw fail('Assignment not found.',404);
 const ids=await sources([row.source_article_id,...(row.attached_article_ids||[])].filter(Boolean),tenantId);if(ids.length<2||!row.pitched_by_writer_id)throw fail('Attach at least two sources and select a writer before approval.');
 const updated=await db.prepare("UPDATE article_pitches SET status='approved',decided_at=NOW(),decided_by_user_id=$3,skip_synthesis=true WHERE id=$1 AND tenant_id=$2 AND status IN ('proposed','approved') AND source_article_id IS NOT DISTINCT FROM $4 AND attached_article_ids=$5::jsonb AND pitched_by_writer_id=$6 RETURNING *").get(id,tenantId,userId,row.source_article_id,JSON.stringify(row.attached_article_ids||[]),row.pitched_by_writer_id);if(!updated)throw fail('Assignment cannot be approved in its current state.',409);return updated;
}
async function start(id,tenantId,{confirmPaid,retryAcknowledged}={},generate){
 if(confirmPaid!==true)throw fail('Explicit paid drafting confirmation is required.');
 const client=await db.getPool().connect();let locked=false;
 const release=async()=>{try{if(locked)await client.query('SELECT pg_advisory_unlock(7241,$1)',[id]);}finally{client.release();}};
 try{
  locked=(await client.query('SELECT pg_try_advisory_lock(7241,$1) AS locked',[id])).rows[0].locked;if(!locked)throw fail('Drafting is already running.',409);
  const p=await db.prepare('SELECT * FROM article_pitches WHERE id=$1 AND tenant_id=$2 AND is_editor_assignment=true').get(id,tenantId);if(!p)throw fail('Assignment not found.',404);
  const existing=await db.prepare("SELECT id FROM articles WHERE tenant_id=$1 AND synthesis_meta->>'editor_assignment_id'=$2 LIMIT 1").get(tenantId,String(id));
  if(p.spawned_article_id||existing){if(existing)await db.prepare("UPDATE article_pitches SET spawned_article_id=$3,status='review',draft_error=NULL WHERE id=$1 AND tenant_id=$2").run(id,tenantId,existing.id);throw fail('A draft already exists. Open it for review instead of generating again.',409);}
  if(!['approved','failed','drafting'].includes(p.status))throw fail('Approve the assignment first.',409);
  if(p.status!=='approved'&&retryAcknowledged!==true)throw fail('Check provider usage and acknowledge the possible charge before retrying.',409);
  if(p.status==='drafting'&&Date.now()-new Date(p.draft_started_at).getTime()<600000)throw fail('Draft result is still uncertain. Check again after ten minutes.',409);
  const ids=await sources([p.source_article_id,...(p.attached_article_ids||[])].filter(Boolean),tenantId);if(ids.length<2)throw fail('At least two supporting sources are required.');
  const writer=await db.prepare("SELECT * FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'").get(p.pitched_by_writer_id,tenantId);if(!writer)throw fail('An assigned writer is required.');
  const claimed=await db.prepare("UPDATE article_pitches SET status='drafting',draft_started_at=NOW(),draft_attempt=draft_attempt+1,draft_error=NULL WHERE id=$1 AND tenant_id=$2 AND status=$3 AND source_article_id IS NOT DISTINCT FROM $4 AND attached_article_ids=$5::jsonb AND pitched_by_writer_id=$6 RETURNING id").get(id,tenantId,p.status,p.source_article_id,JSON.stringify(p.attached_article_ids||[]),p.pitched_by_writer_id);
  if(!claimed)throw fail('Assignment changed. Reload and approve its current sources before drafting.',409);
  const run=async()=>{try{
   const rows=await db.prepare('SELECT * FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[])').all(tenantId,ids);
   const synth=generate||require('./synthesis').synthesizeCluster;
   const article=await synth({articles:rows,topic:p.topic+': '+p.angle_summary},writer,tenantId,{pitchType:p.pitch_type,editorAssignmentId:id,reviewOnly:true,allowAutoFollowup:false});
   if(!article)throw Error('No draft');
   await db.prepare("UPDATE article_pitches SET spawned_article_id=$3,status='review',draft_error=NULL WHERE id=$1 AND tenant_id=$2").run(id,tenantId,article.id);
  }catch{
   const saved=await db.prepare("SELECT id FROM articles WHERE tenant_id=$1 AND synthesis_meta->>'editor_assignment_id'=$2 LIMIT 1").get(tenantId,String(id));
   await db.prepare("UPDATE article_pitches SET status=$3,spawned_article_id=COALESCE($4,spawned_article_id),draft_error=$5 WHERE id=$1 AND tenant_id=$2").run(id,tenantId,saved?'review':'failed',saved?.id||null,saved?'Draft saved; review it before any retry.':'Drafting did not complete. Check sources, provider configuration and usage before explicitly retrying.');
  }finally{await release();}};
  return{run,status:'drafting'};
 }catch(e){await release();throw e;}
}
module.exports={create,attach,approve,start,sources};
