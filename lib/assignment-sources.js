'use strict';
const db=require('../db');
const MINIMUM=2,MAXIMUM=20;
const ELIGIBLE="(content_type IS NULL OR content_type='curated') AND COALESCE(is_archived,0)=0 AND length(TRIM(COALESCE(NULLIF(full_content,''),NULLIF(content,''),summary,'')))>0";
function fail(message,status=400){return Object.assign(Error(message),{status});}
function ids(row){return [...new Set([row.source_article_id,...(row.attached_article_ids||[])].filter(Boolean))];}
function clean(value){return String(value||'').replace(/<[^>]*>/g,'').slice(0,600);}
function card(row){let url=null;try{const u=new URL(row.source_url);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)url=u.href;}catch{}return{id:row.id,title:clean(row.title),publisher:clean(row.source),topic:clean(row.topic_tag),summary:clean(row.summary),created_at:row.created_at,url,eligible:row.eligible};}
async function decorate(rows,tenant){const all=[...new Set(rows.flatMap(ids))];const found=all.length?(await db.getPool().query(`SELECT id,title,source,topic_tag,summary,created_at,source_url,(${ELIGIBLE}) AS eligible FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[])`,[tenant,all])).rows:[];const map=new Map(found.map(r=>[r.id,card(r)]));return rows.map(r=>({...r,attached_sources:ids(r).map(id=>map.get(id)||{id,title:'Source unavailable',eligible:false,unavailable:true}),requirements:{minimum:MINIMUM,maximum:MAXIMUM}}));}
function validateIds(value){if(!Array.isArray(value)||value.length>MAXIMUM||value.some(n=>!Number.isSafeInteger(n)||n<1))throw fail('Select valid source IDs (maximum '+MAXIMUM+').');return [...new Set(value)];}
async function mutate(id,tenant,action,input){const client=await db.getPool().connect();try{
 await client.query('BEGIN');const row=(await client.query('SELECT * FROM article_pitches WHERE id=$1 AND tenant_id=$2 AND is_editor_assignment=true FOR UPDATE',[id,tenant])).rows[0];if(!row)throw fail('Assignment not found.',404);
 if(row.spawned_article_id||!['needs_sources','proposed','approved','failed'].includes(row.status))throw fail('Assignment cannot be edited in its current state.',409);
 const before=ids(row);let after=before,writer=row.pitched_by_writer_id;
 if(action==='add'){const added=validateIds(input.source_article_ids);if(!added.length)throw fail('Select at least one source.');after=[...new Set([...before,...added])];}
 if(action==='replace')after=validateIds(input.source_article_ids);
 if(action==='remove'){if(!Number.isSafeInteger(input.sourceId)||input.sourceId<1)throw fail('Invalid source ID.');after=before.filter(n=>n!==input.sourceId);}
 if(after.length>MAXIMUM)throw fail('An assignment can contain at most '+MAXIMUM+' sources.');
 if(action==='writer'||(action==='replace'&&input.writer_id!=null)){
  writer=input.writer_id;if(writer!==null&&(!Number.isSafeInteger(writer)||writer<1))throw fail('Select a valid writer.');
  if(writer!==null&&!(await client.query("SELECT id FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'",[writer,tenant])).rowCount)throw fail('Select a writer from this workspace.');
 }
 // Removal and writer edits remain possible when a previously attached source has become unavailable.
 if(['add','replace'].includes(action)&&after.length){const valid=await client.query(`SELECT id FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[]) AND ${ELIGIBLE} FOR SHARE`,[tenant,after]);if(valid.rowCount!==after.length)throw fail('Sources must be available curated articles from this workspace with supporting text.');}
 const changed=writer!==row.pitched_by_writer_id||JSON.stringify(after)!==JSON.stringify(before);let result=row;
 if(changed)result=(await client.query(`UPDATE article_pitches SET source_article_id=$3,attached_article_ids=$4::jsonb,pitched_by_writer_id=$5,status=$6,decided_at=NULL,decided_by_user_id=NULL,draft_error=NULL WHERE id=$1 AND tenant_id=$2 RETURNING *`,[id,tenant,after[0]||null,JSON.stringify(after.slice(1)),writer,after.length>=MINIMUM?'proposed':'needs_sources'])).rows[0];
 await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function options(id,tenant,query={}){
 const assignment=(await db.getPool().query('SELECT * FROM article_pitches WHERE id=$1 AND tenant_id=$2 AND is_editor_assignment=true',[id,tenant])).rows[0];if(!assignment)throw fail('Assignment not found.',404);
 const number=(v,fallback,max)=>{if(v===undefined)return fallback;if(!/^\d+$/.test(String(v))||Number(v)>max)throw fail('Invalid pagination.');return Number(v);};
 const limit=number(query.limit,25,50),offset=number(query.offset,0,1000000);if(!limit)throw fail('Invalid limit.');
 for(const k of ['q','publisher','topic'])if(query[k]!==undefined&&(typeof query[k]!=='string'||query[k].length>200))throw fail('Invalid source filter.');
 const date=query.date||'all',sort=query.sort||'newest';if(!['all','24h','7d','30d'].includes(date)||!['newest','relevance'].includes(sort))throw fail('Invalid date or sort.');
 const params=[tenant],where=['tenant_id=$1',ELIGIBLE];const add=(clause,value)=>{params.push(value);where.push(clause.replaceAll('?',()=>'$'+params.length));};
 const q=(query.q||'').trim(),escaped=q.replace(/[\\%_]/g,'\\$&');if(q)add("(title ILIKE ? OR source ILIKE ? OR summary ILIKE ?)",'%'+escaped+'%');
 if(query.publisher)add('source=?',query.publisher);if(query.topic)add('topic_tag=?',query.topic);
 if(date!=='all')add('created_at >= NOW() - ?::interval',{'24h':'24 hours','7d':'7 days','30d':'30 days'}[date]);
 const condition=where.join(' AND '),total=(await db.getPool().query('SELECT count(*)::int total FROM articles WHERE '+condition,params)).rows[0].total;
 let order='created_at DESC NULLS LAST,id DESC';if(sort==='relevance'&&q){params.push('%'+escaped+'%');order='CASE WHEN title ILIKE $'+params.length+' THEN 0 WHEN source ILIKE $'+params.length+' THEN 1 ELSE 2 END,'+order;}
 const rows=(await db.getPool().query(`SELECT id,title,source,topic_tag,summary,created_at,source_url,true AS eligible FROM articles WHERE ${condition} ORDER BY ${order} LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset])).rows;
 const facets=await db.getPool().query(`SELECT DISTINCT source,topic_tag FROM articles WHERE tenant_id=$1 AND ${ELIGIBLE} ORDER BY source,topic_tag LIMIT 500`,[tenant]);
 return{items:rows.map(card),total,limit,offset,attached_ids:ids(assignment),requirements:{minimum:MINIMUM,maximum:MAXIMUM},facets:{publishers:[...new Set(facets.rows.map(r=>r.source).filter(Boolean))],topics:[...new Set(facets.rows.map(r=>r.topic_tag).filter(Boolean))]}};
}
module.exports={MINIMUM,MAXIMUM,ELIGIBLE,ids,decorate,mutate,options,validateIds};
