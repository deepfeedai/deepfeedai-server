'use strict';
const db=require('../db');
const {normalizeUrl,displayUrl,fail}=require('./rss-safe');
const {parseImport,normalizeSource,exportSources,cleanFolder,WARNING}=require('./rss-format');
function where(tenant,filters={},params=[tenant]){
 const clauses=['tenant_id=$1'];const add=(sql,value)=>{params.push(value);clauses.push(sql.replaceAll('?',()=>'$'+params.length));};
 const status=filters.status||'current';
 if(status==='removed')clauses.push('removed_at IS NOT NULL');else if(status!=='all')clauses.push('removed_at IS NULL');
 if(status==='active')clauses.push('is_active=1');if(status==='paused')clauses.push('is_active=0');
 if(!['current','all','removed','active','paused'].includes(status))throw fail('Invalid source status');
 if(filters.errors!==undefined&&!['','0','1',false,true].includes(filters.errors))throw fail('Invalid error filter');
 if(filters.errors==='1'||filters.errors===true)clauses.push("NULLIF(TRIM(last_fetch_error),'') IS NOT NULL");
 if(filters.q)add("(name ILIKE ? OR split_part(url,chr(63),1) ILIKE ?)",'%'+String(filters.q).slice(0,200)+'%');
 // Both placeholders in the search intentionally reuse the same parameter.
 if(filters.folder!==undefined&&filters.folder!=='')add('folder_path=?',String(filters.folder));
 if(filters.category)add('default_category=?',String(filters.category));
 return {sql:clauses.join(' AND '),params};
}
async function select(client,tenant,selection){
 if(!selection||!['ids','all_matching'].includes(selection.mode))throw fail('Choose explicit IDs or all matching sources');
 if(selection.mode==='ids'){
  const ids=[...new Set(selection.ids||[])];if(!ids.length||ids.length>1000||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw fail('Select 1–1000 valid source IDs');
  const rows=(await client.query('SELECT * FROM sources WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE',[tenant,ids])).rows;
  if(rows.length!==ids.length)throw fail('One or more selected sources are unavailable',404);return rows;
 }
 const q=where(tenant,selection.filters);const rows=(await client.query('SELECT * FROM sources WHERE '+q.sql+' ORDER BY id FOR UPDATE',q.params)).rows;
 if(rows.length>5000)throw fail('Selection exceeds 5000 sources; narrow the filters');return rows;
}
async function transaction(tenant,fn){const client=await db.getPool().connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(78243,$1)',[tenant]);const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function validCategory(client,tenant,category){if(category&&!((await client.query('SELECT 1 FROM categories WHERE tenant_id=$1 AND name=$2',[tenant,category])).rowCount))throw fail('Choose an existing category');}
async function list(tenant,filters={}){
 const q=where(tenant,filters),page=Math.max(1,Math.min(100000,Number(filters.page)||1)),limit=Math.max(1,Math.min(200,Number(filters.limit)||50));
 const pool=db.getPool();const rows=await pool.query('SELECT * FROM sources WHERE '+q.sql+' ORDER BY priority,id LIMIT $'+(q.params.length+1)+' OFFSET $'+(q.params.length+2),[...q.params,limit,(page-1)*limit]);
 const count=await pool.query('SELECT COUNT(*)::int total FROM sources WHERE '+q.sql,q.params);
 const folders=await pool.query("SELECT DISTINCT folder_path FROM sources WHERE tenant_id=$1 AND removed_at IS NULL AND folder_path<>'' ORDER BY folder_path",[tenant]);
 const categories=await pool.query('SELECT name FROM categories WHERE tenant_id=$1 ORDER BY name',[tenant]);
 return{items:rows.rows.map(row=>({...row,display_url:displayUrl(row.url)})),total:count.rows[0].total,page,limit,folders:folders.rows.map(x=>x.folder_path),categories:categories.rows.map(x=>x.name)};
}
async function importSources(tenant,body,{preview=false}={}){
 const items=await parseImport(body);if(!items.length||items.length>500)throw fail('Import 1–500 sources');
 const plan=await require('./plan-limits').getPlanInfo(tenant);const max=plan?.limits?.max_sources;
 return transaction(tenant,async client=>{
  const current=(await client.query('SELECT id,url,removed_at FROM sources WHERE tenant_id=$1',[tenant])).rows;
  const seen=new Map();for(const row of current){try{seen.set(normalizeUrl(row.url),row);}catch{}}
  let count=current.filter(row=>!row.removed_at).length,added=0,skipped=0;const results=[],errors=[];
  for(let index=0;index<items.length;index++){
   try{
    const item=normalizeSource(items[index]);await validCategory(client,tenant,item.default_category);
    const existing=seen.get(item.normalized_url);let status=existing?(existing.removed_at?'removed':'duplicate'):'ready';
    if(!existing&&max!=null&&Number(max)>=0&&count>=Number(max))throw fail('Source plan limit reached');
    const result={index,name:item.name,display_url:item.display_url,folder_path:item.folder_path,default_category:item.default_category,status};
    if(existing){skipped++;result.id=existing.id;}
    else{count++;seen.set(item.normalized_url,{id:null});if(!preview){await client.query('SAVEPOINT source_item');try{const r=await client.query(`INSERT INTO sources(tenant_id,name,url,normalized_url,folder_path,default_category,priority,is_active,auto_publish,auto_publish_max) VALUES($1,$2,$3,$3,$4,$5,$6,$7,0,$8) RETURNING id`,[tenant,item.name,item.url,item.folder_path,item.default_category,item.priority,item.is_active,item.auto_publish_max]);result.id=r.rows[0].id;result.status='added';added++;seen.set(item.normalized_url,{id:result.id});await client.query('RELEASE SAVEPOINT source_item');}catch{await client.query('ROLLBACK TO SAVEPOINT source_item');count--;seen.delete(item.normalized_url);throw fail('Source could not be added');}}}
    results.push(result);
   }catch(e){const error=e.status?e.message:'Source could not be processed';errors.push({index,error});results.push({index,status:'invalid',error});}
  }
  return{items:results,results,total:items.length,added,skipped,errors,warning:WARNING};
 });
}
async function bulk(tenant,{action,selection,value,confirm}={}){
 if(!['pause','resume','remove','restore','category','folder'].includes(action))throw fail('Invalid bulk action');
 if(action==='remove'&&confirm!=='REMOVE SELECTED')throw fail('Confirm removal with REMOVE SELECTED');
 return transaction(tenant,async client=>{
  const rows=await select(client,tenant,selection);const ids=rows.map(r=>r.id);
  if(action==='category')await validCategory(client,tenant,value||null);
  if(action==='restore'){
   const limit=await require('./plan-limits').getPlanInfo(tenant);const max=limit?.limits?.max_sources;
   const current=Number((await client.query('SELECT COUNT(*) n FROM sources WHERE tenant_id=$1 AND removed_at IS NULL',[tenant])).rows[0].n);
   if(max!=null&&Number(max)>=0&&current+rows.filter(r=>r.removed_at).length>Number(max))throw fail('Restoring these sources exceeds the plan limit');
  }
  const updates={pause:['is_active=0',[]],resume:['is_active=1',[]],remove:['removed_at=COALESCE(removed_at,NOW()),is_active=0',[]],restore:['removed_at=NULL,is_active=0',[]],category:['default_category=$3',[value||null]],folder:['folder_path=$3',[cleanFolder(value)]]};
  const [set,values]=updates[action];const q=await client.query('UPDATE sources SET '+set+' WHERE tenant_id=$1 AND id=ANY($2::int[])'+(action==='restore'?' AND removed_at IS NOT NULL':' AND removed_at IS NULL')+' RETURNING id',[tenant,ids,...values]);
  return{updated:q.rowCount,ids:q.rows.map(r=>r.id),action};
 });
}
async function exportSelected(tenant,{format='opml',selection={mode:'all_matching',filters:{status:'current'}}}={}){return transaction(tenant,async client=>exportSources(await select(client,tenant,selection),format));}
async function update(tenant,id,body){return transaction(tenant,async client=>{
 const old=(await select(client,tenant,{mode:'ids',ids:[id]}))[0];if(old.removed_at)throw fail('Restore the source before editing',409);
 const item=normalizeSource({...old,...body});await validCategory(client,tenant,item.default_category);
 const others=(await client.query('SELECT id,url FROM sources WHERE tenant_id=$1 AND id<>$2',[tenant,id])).rows;
 if(others.some(row=>{try{return normalizeUrl(row.url)===item.url;}catch{return false;}}))throw fail('That subscription already exists, possibly in Removed',409);
 return(await client.query('UPDATE sources SET name=$3,url=$4,normalized_url=$4,folder_path=$5,default_category=$6,priority=$7,is_active=$8,auto_publish_max=$9 WHERE tenant_id=$1 AND id=$2 RETURNING *',[tenant,id,item.name,item.url,item.folder_path,item.default_category,item.priority,item.is_active,item.auto_publish_max])).rows[0];
});}
module.exports={list,importSources,bulk,exportSelected,update,transaction,select,where};
