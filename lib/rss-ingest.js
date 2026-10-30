'use strict';
const crypto=require('node:crypto');
const db=require('../db');const {normalizeUrl,fail}=require('./rss-safe');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const text=value=>require('./utils').decodeEntities(String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[^]*?-->/g,'').replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')).trim();
async function ingestItem(tenant,source,item,category){
 const originalUrl=normalizeUrl(item.link||item.guid),url=normalizeUrl(originalUrl,{tracking:true});const guid=typeof item.guid==='string'?item.guid.slice(0,4000):null;
 const keys=['url:'+hash(url)];if(guid)keys.push('guid:'+source.id+':'+hash(guid));
 const client=await db.getPool().connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(78243,$1)',[tenant]);
  const subscription=(await client.query('SELECT id FROM sources WHERE tenant_id=$1 AND id=$2 AND removed_at IS NULL AND is_active=1 FOR UPDATE',[tenant,source.id])).rows[0];
  if(!subscription)throw fail('Source is paused or removed',409);
  // Legacy article deletion/purge must not leave identities suppressing ingestion forever.
  await client.query('DELETE FROM rss_identities i WHERE i.tenant_id=$1 AND i.identity_key=ANY($2::text[]) AND NOT EXISTS(SELECT 1 FROM articles a WHERE a.tenant_id=i.tenant_id AND a.id=i.article_id)',[tenant,keys]);
  const known=(await client.query('SELECT DISTINCT article_id FROM rss_identities WHERE tenant_id=$1 AND identity_key=ANY($2::text[])',[tenant,keys])).rows;
  // Migration-era URL matches must be considered even when a GUID is known.
  // Otherwise a changed GUID target can steal a legacy article's URL identity.
  const legacy=(await client.query("SELECT id FROM articles WHERE tenant_id=$1 AND source_url=ANY($2::text[]) AND (content_type IS NULL OR content_type='curated') ORDER BY id",[tenant,[url,originalUrl,item.link||item.guid]])).rows;
  const candidates=new Set([...known.map(row=>row.article_id),...legacy.map(row=>row.id)]);
  if(candidates.size>1){await client.query('ROLLBACK');return{inserted:false,conflict:true};}
  let id=[...candidates][0];
  let inserted=false;
  if(!id){
   const {toSlug,decodeEntities}=require('./utils');const title=decodeEntities(text(item.title)).slice(0,1000);if(!title)throw fail('Missing item title');
   let published=new Date(item.pubDate||item.isoDate||Date.now());if(!Number.isFinite(published.getTime()))published=new Date();
   let image=null;try{const candidate=item.enclosure?.url||item['media:content']?.['$']?.url||item.image?.url;if(candidate)image=normalizeUrl(candidate);}catch{}
   id=(await client.query(`INSERT INTO articles(tenant_id,title,slug,summary,category,source,source_id,source_url,image_url,author,is_published,is_featured,published_at,status,content_type,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,$11,'source','curated',$12) RETURNING id`,[tenant,title,toSlug(title),text(item.contentSnippet||item.content).slice(0,4000)||null,category||'Uncategorized',source.name,source.id,originalUrl,image,text(item.creator||item.author).slice(0,300)||null,published,text(item['content:encoded']||item.content||item.contentSnippet).slice(0,100000)||null])).rows[0].id;inserted=true;
  }
  for(const key of keys)await client.query('INSERT INTO rss_identities(tenant_id,identity_key,article_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenant,key,id]);
  const occurrence=hash((guid||'')+'\n'+originalUrl);
  await client.query(`INSERT INTO rss_occurrences(tenant_id,source_id,occurrence_key,article_id,normalized_url,original_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,source_id,occurrence_key) DO UPDATE SET last_seen_at=NOW(),article_id=EXCLUDED.article_id`,[tenant,source.id,occurrence,id,url,originalUrl]);
  await client.query('COMMIT');return{id,inserted};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function duplicates(tenant){
 const rows=(await db.getPool().query("SELECT id,title,source_url,source FROM articles WHERE tenant_id=$1 AND (content_type IS NULL OR content_type='curated') AND source_url IS NOT NULL ORDER BY id LIMIT 5001",[tenant])).rows;
 const groups=new Map();for(const row of rows.slice(0,5000)){try{const key=normalizeUrl(row.source_url,{tracking:true});if(!groups.has(key))groups.set(key,[]);groups.get(key).push({id:row.id,title:row.title,source:row.source});}catch{}}
 const links=(await db.getPool().query('SELECT article_id,canonical_article_id FROM rss_duplicate_links WHERE tenant_id=$1',[tenant])).rows;
 return{dry_run:true,scanned:Math.min(rows.length,5000),truncated:rows.length>5000,groups:[...groups.values()].filter(g=>g.length>1).map(articles=>({reason:'same_normalized_url',canonical_article_id:articles[0].id,articles})),links};
}
async function linkDuplicate(tenant,{article_id,canonical_article_id},user){
 if(![article_id,canonical_article_id].every(Number.isSafeInteger)||article_id===canonical_article_id)throw fail('Choose two different article IDs');
 return require('./source-management').transaction(tenant,async client=>{
  const rows=(await client.query("SELECT id,source_url FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[]) AND (content_type IS NULL OR content_type='curated') FOR UPDATE",[tenant,[article_id,canonical_article_id]])).rows;
  if(rows.length!==2)throw fail('Source articles are unavailable',404);
  if(normalizeUrl(rows[0].source_url,{tracking:true})!==normalizeUrl(rows[1].source_url,{tracking:true}))throw fail('These are not exact URL duplicates. Keep different reporting as separate sources.');
  if((await client.query('SELECT 1 FROM rss_duplicate_links WHERE tenant_id=$1 AND (article_id=$2 OR canonical_article_id=$3)',[tenant,canonical_article_id,article_id])).rowCount)throw fail('Undo the existing relationship first',409);
  await client.query('INSERT INTO rss_duplicate_links(tenant_id,article_id,canonical_article_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,article_id) DO UPDATE SET canonical_article_id=$3,created_by=$4',[tenant,article_id,canonical_article_id,user||null]);
  return{article_id,canonical_article_id,collapsed:true};
 });
}
async function unlinkDuplicate(tenant,id){if(!Number.isSafeInteger(id))throw fail('Invalid article ID');await db.getPool().query('DELETE FROM rss_duplicate_links WHERE tenant_id=$1 AND article_id=$2',[tenant,id]);return{article_id:id,collapsed:false};}
module.exports={ingestItem,duplicates,linkDuplicate,unlinkDuplicate};
