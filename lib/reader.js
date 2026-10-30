'use strict';
const db=require('../db');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function principal(user) {
  if(!user?.sub||!['platform-admin','tenant-admin'].includes(user.type))throw fail('Reader identity is required.',401);
  return user.type+':'+String(user.sub);
}
function integer(value,name,{min=1,max=2147483647,optional=false}={}) {
  if(optional&&(value===undefined||value===null||value===''))return null;
  if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))throw fail('Invalid '+name+'.');
  const n=typeof value==='number'?value:Number(value);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw fail('Invalid '+name+'.');return n;
}
function text(value,max,name) {if(value===undefined||value===null)return '';if(typeof value!=='string'||value.length>max)throw fail('Invalid '+name+'.');return value.trim();}
function filters(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid Reader filters.');
  const view=input.view||'all';if(!['all','unread','saved'].includes(view))throw fail('Invalid Reader view.');
  const folder=input.folder_id===undefined||input.folder_id===''?'all':String(input.folder_id);
  if(!['all','none'].includes(folder))integer(folder,'folder');
  const duplicates=input.show_duplicates==='1'?'show':input.duplicates||'hide';
  if(!['hide','show'].includes(duplicates))throw fail('Invalid duplicate view.');
  const date=input.date||'all',sort=input.sort||'newest';
  if(!['all','24h','7d','30d'].includes(date))throw fail('Invalid date filter.');
  if(!['newest','oldest'].includes(sort))throw fail('Invalid sort order.');
  return {q:text(input.q,200,'search'),folder_id:folder,source_id:integer(input.source_id,'source',{optional:true}),source:text(input.source,200,'source'),category:text(input.category,100,'category'),topic_tag:text(input.topic_tag,200,'coverage group'),view,duplicates,date,sort};
}
const eligibility="a.tenant_id=$1 AND (a.content_type IS NULL OR a.content_type='curated') AND COALESCE(a.is_archived,0)=0";
const joins=" LEFT JOIN reader_item_states rs ON rs.tenant_id=a.tenant_id AND rs.article_id=a.id AND rs.principal=$2 LEFT JOIN rss_duplicate_links dl ON dl.tenant_id=a.tenant_id AND dl.article_id=a.id LEFT JOIN articles primary_article ON primary_article.id=dl.canonical_article_id AND primary_article.tenant_id=dl.tenant_id AND (primary_article.content_type IS NULL OR primary_article.content_type='curated') AND COALESCE(primary_article.is_archived,0)=0 LEFT JOIN reader_topic_exclusions tx ON tx.tenant_id=a.tenant_id AND tx.article_id=a.id AND tx.topic_tag=a.topic_tag ";
const activeDuplicate="EXISTS(SELECT 1 FROM rss_duplicate_links d JOIN articles c ON c.id=d.canonical_article_id AND c.tenant_id=d.tenant_id AND (c.content_type IS NULL OR c.content_type='curated') AND COALESCE(c.is_archived,0)=0 WHERE d.tenant_id=a.tenant_id AND d.article_id=a.id)";
function sourceMembership(source) {return `(a.source_id=${source} OR EXISTS(SELECT 1 FROM rss_occurrences ro WHERE ro.tenant_id=a.tenant_id AND ro.article_id=a.id AND ro.source_id=${source}) OR EXISTS(SELECT 1 FROM rss_duplicate_links rd JOIN articles alias ON alias.id=rd.article_id AND alias.tenant_id=rd.tenant_id WHERE rd.tenant_id=a.tenant_id AND rd.canonical_article_id=a.id AND (alias.source_id=${source} OR EXISTS(SELECT 1 FROM rss_occurrences ro WHERE ro.tenant_id=alias.tenant_id AND ro.article_id=alias.id AND ro.source_id=${source}))))`;}
function queryParts(tenantId,who,input={},includeView=true) {
  const f=filters(input),params=[tenantId,who],parts=[eligibility];
  const add=(sql,value)=>{params.push(value);parts.push(sql.replaceAll('?', '$'+params.length));};
  if(f.q)add("(a.title ILIKE ? ESCAPE '\\' OR a.summary ILIKE ? ESCAPE '\\')",'%'+f.q.replace(/[\\%_]/g,'\\$&')+'%');
  if(f.folder_id==='none')parts.push('a.group_id IS NULL');else if(f.folder_id!=='all')add('a.group_id=?',Number(f.folder_id));
  if(f.source_id)add(sourceMembership('?'),f.source_id);else if(f.source)add('a.source=?',f.source);
  if(f.category)add('a.category=?',f.category);
  if(f.topic_tag){add('a.topic_tag=?',f.topic_tag);parts.push('tx.article_id IS NULL');}
  if(f.date!=='all')add('COALESCE(a.published_at,a.created_at)>=NOW()-?::interval',{'24h':'24 hours','7d':'7 days','30d':'30 days'}[f.date]);
  if(f.duplicates==='hide')parts.push('primary_article.id IS NULL');
  if(includeView&&f.view==='unread')parts.push('COALESCE(rs.is_read,false)=false');
  if(includeView&&f.view==='saved')parts.push('rs.is_saved=true');
  return {params,where:parts.join(' AND '),filters:f};
}
function plain(value) {return require('./utils').decodeEntities(String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<[^>]*>/g,'')).replace(/\u0000/g,'');}
function safeUrl(value,{local=false}={}) {
  if(typeof value!=='string')return null;if(local&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\'))return value;
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
function serialize(row,detail=false) {
  const result={id:row.id,title:plain(row.title),summary:plain(row.summary),category:row.category,source:plain(row.source),source_id:row.source_id,
    source_url:safeUrl(row.source_url),image_url:safeUrl(row.image_url,{local:true}),published_at:row.published_at,created_at:row.created_at,
    group_id:row.group_id,topic_tag:row.topic_tag||null,group_excluded:!!row.group_excluded,read:!!row.is_read,saved:!!row.is_saved,duplicate_of:row.canonical_article_id||null,duplicate_available:!!row.duplicate_available};
  if(detail){result.content_text=plain(row.full_content||row.content||row.summary);result.enriched_summary=plain(row.enriched_summary);
    result.enrichment={status:row.enrichment_status||(row.enriched_summary?'ready':'not_requested'),error:row.enrichment_error||null};}
  return result;
}
const fields='a.id,a.title,a.summary,a.category,a.source,a.source_id,a.source_url,a.image_url,a.published_at,a.created_at,a.group_id,a.topic_tag,(tx.article_id IS NOT NULL) AS group_excluded,rs.is_read,rs.is_saved,dl.canonical_article_id,(primary_article.id IS NOT NULL) AS duplicate_available';
async function list(tenantId,who,input={}) {
  const limit=integer(input.limit??50,'page size',{max:100}),offset=integer(input.offset??0,'offset',{min:0,max:1000000});
  const q=queryParts(tenantId,who,input),base=queryParts(tenantId,who,input,false);
  const pool=db.getPool();
  const order=q.filters.sort==='oldest'?'ASC':'DESC';
  const [items,count,counts]=await Promise.all([
    pool.query(`SELECT ${fields} FROM articles a ${joins} WHERE ${q.where} ORDER BY COALESCE(a.published_at,a.created_at) ${order},a.id ${order} LIMIT $${q.params.length+1} OFFSET $${q.params.length+2}`,[...q.params,limit,offset]),
    pool.query(`SELECT count(*)::int AS total FROM articles a ${joins} WHERE ${q.where}`,q.params),
    pool.query(`SELECT count(*) FILTER(WHERE COALESCE(rs.is_read,false)=false)::int AS unread_count,count(*) FILTER(WHERE rs.is_saved=true)::int AS saved_count FROM articles a ${joins} WHERE ${base.where}`,base.params)
  ]);
  const total=count.rows[0].total;return {items:items.rows.map(r=>serialize(r)),total,...counts.rows[0],limit,offset,hasMore:offset+items.rows.length<total};
}
async function detail(tenantId,who,id) {
  integer(id,'article');const result=await db.getPool().query(`SELECT ${fields},a.full_content,a.content,a.enriched_summary,er.status AS enrichment_status,er.error AS enrichment_error FROM articles a ${joins} LEFT JOIN reader_enrichment_runs er ON er.tenant_id=a.tenant_id AND er.article_id=a.id WHERE ${eligibility} AND a.id=$3`,[tenantId,who,id]);
  if(!result.rows[0])throw fail('Reader item not found.',404);return serialize(result.rows[0],true);
}
async function facets(tenantId,who) {
  const pool=db.getPool();const [counts,folders,sources,categories,topics]=await Promise.all([
    pool.query(`SELECT count(*)::int AS all,count(*) FILTER(WHERE COALESCE(rs.is_read,false)=false)::int AS unread,count(*) FILTER(WHERE rs.is_saved=true)::int AS saved FROM articles a ${joins} WHERE ${eligibility} AND primary_article.id IS NULL`,[tenantId,who]),
    pool.query(`SELECT g.id,g.name,g.color,count(a.id)::int AS count FROM feed_groups g LEFT JOIN articles a ON a.group_id=g.id AND a.tenant_id=g.tenant_id AND (a.content_type IS NULL OR a.content_type='curated') AND COALESCE(a.is_archived,0)=0 AND NOT ${activeDuplicate} WHERE g.tenant_id=$1 GROUP BY g.id ORDER BY g.name`,[tenantId]),
    pool.query(`SELECT s.id,s.name,(s.removed_at IS NOT NULL) AS removed,count(a.id)::int AS count FROM sources s LEFT JOIN articles a ON ${sourceMembership('s.id')} AND a.tenant_id=s.tenant_id AND (a.content_type IS NULL OR a.content_type='curated') AND COALESCE(a.is_archived,0)=0 AND NOT ${activeDuplicate} WHERE s.tenant_id=$1 GROUP BY s.id ORDER BY s.name`,[tenantId]),
    pool.query(`SELECT a.category AS name,count(*)::int AS count FROM articles a WHERE ${eligibility} AND NOT ${activeDuplicate} GROUP BY a.category ORDER BY a.category`,[tenantId]),
    pool.query(`SELECT a.topic_tag AS tag,count(*)::int AS count FROM articles a WHERE ${eligibility} AND a.topic_tag IS NOT NULL AND NOT ${activeDuplicate} AND NOT EXISTS(SELECT 1 FROM reader_topic_exclusions x WHERE x.tenant_id=a.tenant_id AND x.article_id=a.id AND x.topic_tag=a.topic_tag) GROUP BY a.topic_tag HAVING count(*)>=2 ORDER BY count(*) DESC,a.topic_tag LIMIT 50`,[tenantId])
  ]);return {counts:counts.rows[0],folders:folders.rows,sources:sources.rows,categories:categories.rows,topics:topics.rows};
}
async function state(tenantId,who,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid Reader state.');
  const hasRead=typeof input.read==='boolean',hasSaved=typeof input.saved==='boolean';
  if(!hasRead&&!hasSaved)throw fail('Specify read or saved as a boolean.');
  if(input.read!==undefined&&!hasRead||input.saved!==undefined&&!hasSaved)throw fail('Invalid Reader state.');
  const client=await db.getPool().connect();try{
    await client.query('BEGIN');const ids=await selectedIds(client,tenantId,who,input);
    if(ids.length)await client.query(`INSERT INTO reader_item_states(tenant_id,principal,article_id,is_read,is_saved) SELECT $1,$2,id,$4,$5 FROM unnest($3::int[]) AS id
      ON CONFLICT(tenant_id,principal,article_id) DO UPDATE SET is_read=CASE WHEN $6 THEN EXCLUDED.is_read ELSE reader_item_states.is_read END,is_saved=CASE WHEN $7 THEN EXCLUDED.is_saved ELSE reader_item_states.is_saved END,updated_at=NOW()`,[tenantId,who,ids,input.read===true,input.saved===true,hasRead,hasSaved]);
    await client.query('COMMIT');return {updated:ids.length};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function selectedIds(client,tenantId,who,input){
    let ids;if(input.scope==='selected'){
      if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>1000)throw fail('Select between 1 and 1000 items.');
      ids=[...new Set(input.ids.map(id=>integer(id,'article')))];
      const valid=await client.query(`SELECT a.id FROM articles a WHERE ${eligibility} AND a.id=ANY($2::int[])`,[tenantId,ids]);
      if(valid.rowCount!==ids.length)throw fail('Some selected items are unavailable in this publication.',404);
    }else if(input.scope==='all_matching'){
      if(input.confirmAllMatching!==true)throw fail('Confirm the all-matching selection.');
      const q=queryParts(tenantId,who,input.filters||{});
      const rows=await client.query(`SELECT a.id FROM articles a ${joins} WHERE ${q.where} ORDER BY a.id LIMIT 10001`,q.params);
      if(rows.rowCount>10000)throw fail('Narrow your filters to at most 10000 matching items.');ids=rows.rows.map(r=>r.id);
    }else throw fail('Choose selected items or all matching items.');
    return ids;
}
async function move(tenantId,who,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||input.folder_id===undefined)throw fail('Select a destination folder.');
  const folderId=input.folder_id===null?null:integer(input.folder_id,'folder');
  const client=await db.getPool().connect();try{
    await client.query('BEGIN');
    if(folderId&&!((await client.query('SELECT id FROM feed_groups WHERE tenant_id=$1 AND id=$2',[tenantId,folderId])).rowCount))throw fail('Folder not found in this publication.',404);
    const ids=await selectedIds(client,tenantId,who,input);
    const changed=await client.query(`UPDATE articles a SET group_id=$3 WHERE ${eligibility} AND id=ANY($2::int[]) RETURNING id`,[tenantId,ids,folderId]);
    await client.query('COMMIT');return {updated:changed.rowCount};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function appendSources(tenantId,id,input={}) {
  integer(id,'assignment');if(!input||!Array.isArray(input.source_article_ids)||!input.source_article_ids.length||input.source_article_ids.length>20)throw fail('Select between 1 and 20 source articles.');
  const added=[...new Set(input.source_article_ids.map(n=>integer(n,'article')))];
  const client=await db.getPool().connect();try{
    await client.query('BEGIN');const {rows:[row]}=await client.query('SELECT * FROM article_pitches WHERE tenant_id=$1 AND id=$2 AND is_editor_assignment=true FOR UPDATE',[tenantId,id]);
    if(!row)throw fail('Assignment not found.',404);
    if(row.spawned_article_id||!['needs_sources','proposed','approved','failed'].includes(row.status))throw fail('Assignment cannot accept sources in its current state.',409);
    const before=[row.source_article_id,...(row.attached_article_ids||[])].filter(Boolean),ids=[...new Set([...before,...added])];
    if(ids.length>20)throw fail('An assignment can contain at most 20 sources.');
    const valid=await client.query(`SELECT a.id FROM articles a WHERE ${eligibility} AND a.id=ANY($2::int[]) AND length(COALESCE(NULLIF(a.full_content,''),NULLIF(a.content,''),a.summary,''))>0`,[tenantId,ids]);
    if(valid.rowCount!==ids.length)throw fail('Sources must be available in this publication with supporting text.');
    let result=row;
    if(ids.length!==before.length)result=(await client.query("UPDATE article_pitches SET source_article_id=$3,attached_article_ids=$4::jsonb,status=$5,decided_at=NULL,decided_by_user_id=NULL,draft_error=NULL WHERE tenant_id=$1 AND id=$2 RETURNING *",[tenantId,id,ids[0],JSON.stringify(ids.slice(1)),ids.length>=2?'proposed':'needs_sources'])).rows[0];
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function group(tenantId,id,input={}) {
  integer(id,'article');if(typeof input?.excluded!=='boolean')throw fail('Specify whether to exclude this item from its coverage group.');
  const client=await db.getPool().connect();try{
    await client.query('BEGIN');const {rows:[row]}=await client.query(`SELECT a.topic_tag FROM articles a WHERE ${eligibility} AND a.id=$2 FOR UPDATE`,[tenantId,id]);
    if(!row)throw fail('Reader item not found.',404);if(!row.topic_tag)throw fail('This item has no coverage group.');
    if(input.excluded)await client.query('INSERT INTO reader_topic_exclusions(tenant_id,article_id,topic_tag) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenantId,id,row.topic_tag]);
    else await client.query('DELETE FROM reader_topic_exclusions WHERE tenant_id=$1 AND article_id=$2 AND topic_tag=$3',[tenantId,id,row.topic_tag]);
    await client.query('COMMIT');return {excluded:input.excluded,topic_tag:row.topic_tag};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function enrich(tenantId,who,id,input={},worker) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid enrichment request.');
  integer(id,'article');if(input.confirmPaid!==true)throw fail('Confirm paid AI enrichment before continuing.');
  const client=new (require('pg').Client)(db.getPool().options),lock='reader-enrich:'+tenantId+':'+id;let locked=false;await client.connect();
  try{
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',[lock])).rows[0].locked;
    if(!locked)throw fail('Enrichment is already running. Refresh its status rather than starting another request.',409);
    const article=await detail(tenantId,who,id);if(article.enriched_summary)return {status:'skipped',message:'This item already has an AI summary.'};
    const prior=await client.query('SELECT status FROM reader_enrichment_runs WHERE tenant_id=$1 AND article_id=$2',[tenantId,id]);
    if(prior.rowCount&&input.retryAcknowledged!==true)throw fail('A previous attempt may have used provider credits. Acknowledge this before retrying.',409);
    await client.query("INSERT INTO reader_enrichment_runs(tenant_id,article_id,status,error) VALUES($1,$2,'running',NULL) ON CONFLICT(tenant_id,article_id) DO UPDATE SET status='running',error=NULL,attempted_at=NOW(),finished_at=NULL",[tenantId,id]);
    let value;try{value=await (worker||require('./synthesis').enrichArticle)(id,tenantId,{scrapeText:require('./reader-fetch').scrapeText,redactErrors:true});}catch{}
    const status=value?'ready':'failed',message=value?null:'Enrichment did not complete. Check the source and provider settings; retry may incur charges.';
    await client.query('UPDATE reader_enrichment_runs SET status=$3,error=$4,finished_at=NOW() WHERE tenant_id=$1 AND article_id=$2',[tenantId,id,status,message]);
    return {status,message};
  }finally{try{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)',[lock]);}finally{await client.end();}}
}
module.exports={principal,filters,plain,safeUrl,serialize,list,detail,facets,state,move,appendSources,group,enrich};
