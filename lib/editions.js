'use strict';

const fs = require('node:fs/promises');
const {constants}=require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeEntities } = require('./utils');
const { captureReferences } = require('./edition-references');
const {captureContributor,contributorsFor}=require('./edition-contributors');
const MAX_ARTICLES = 20, MAX_IMAGE = 5 * 1024 * 1024, MAX_EDITION_IMAGES = 25 * 1024 * 1024;
const authored = alias => `${alias}.content_type IN ('original','deep-dive') AND COALESCE(${alias}.is_archived,0)=0`;
const published = alias => `${authored(alias)} AND ${alias}.is_published=1`;
const invalid = (message, status=400) => Object.assign(new Error(message), {status,statusCode:status});
const pool = () => require('../db').getPool();
function positive(value, label='ID') { if(!Number.isSafeInteger(Number(value)) || Number(value)<1) throw invalid(`Invalid ${label}`); return Number(value); }
function page(query={}) {
  const limit=query.limit===undefined?20:Number(query.limit),offset=query.offset===undefined?0:Number(query.offset);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(offset)||offset<0||offset>100000) throw invalid('Invalid pagination');
  return {limit,offset};
}
function validate(input) {
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>120) throw invalid('Edition name must contain 1–120 characters');
  const date=String(input.issue_date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) throw invalid('Choose a valid issue date');
  if(!['published','proof'].includes(input.mode)) throw invalid('Choose published articles or a private proof');
  if(!Array.isArray(input.article_ids)||input.article_ids.length>MAX_ARTICLES||input.article_ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(input.article_ids).size!==input.article_ids.length) throw invalid(`Choose up to ${MAX_ARTICLES} distinct articles`);
  const lead=input.lead_article_id??null;
  if(lead!==null&&!input.article_ids.includes(lead)) throw invalid('The lead story must be selected');
  const s=input.settings||{};
  if(!['Letter','A4'].includes(s.paper)||typeof s.ink_saving!=='boolean'||typeof s.images!=='boolean') throw invalid('Choose paper, color and image settings');
  for(const key of ['contributors','portraits'])if(s[key]!==undefined&&typeof s[key]!=='boolean')throw invalid('Invalid contributor display settings');
  return {name,issue_date:date,mode:input.mode,article_ids:input.article_ids,lead_article_id:lead,settings:{paper:s.paper,ink_saving:s.ink_saving,images:s.images,contributors:s.contributors===true,portraits:s.portraits===true}};
}
function text(value) {
  return decodeEntities(String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<\/(?:p|div|h[1-6]|li)>/gi,'\n\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'')).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,'').trim();
}
function rasterMime(data) {
  const bounded=(width,height)=>width>0&&height>0&&width<=12000&&height<=12000&&width*height<=40000000;
  if(data.length>=33&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR') return bounded(data.readUInt32BE(16),data.readUInt32BE(20))?'image/png':null;
  if(data.length>=4&&data[0]===255&&data[1]===216&&data[2]===255) {
    let i=2;
    while(i+4<data.length){
      if(data[i]!==255)return null;while(data[i]===255)i++;const marker=data[i++];
      if(marker===0xD9||marker===0xDA)return null;
      if(marker===0x01||(marker>=0xD0&&marker<=0xD7))continue;
      if(i+2>data.length)return null;const length=data.readUInt16BE(i);
      if(length<2||i+length>data.length)return null;
      if([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker))return length>=8&&bounded(data.readUInt16BE(i+5),data.readUInt16BE(i+3))?'image/jpeg':null;
      i+=length;
    }
  }
  if(data.length>=30&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP') {
    const format=data.toString('ascii',12,16);let width=0,height=0;
    if(format==='VP8X'){width=1+data.readUIntLE(24,3);height=1+data.readUIntLE(27,3);}
    else if(format==='VP8 '&&data[23]===0x9d&&data[24]===0x01&&data[25]===0x2a){width=data.readUInt16LE(26)&0x3fff;height=data.readUInt16LE(28)&0x3fff;}
    else if(format==='VP8L'&&data[20]===0x2f){const bits=data.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
    if(bounded(width,height))return 'image/webp';
  }
  return null;
}
async function localImage(url, tenantId) {
  if(!url) return {image_notice:'No image selected'};
  // No network fetching and no authority inferred from absolute URLs or forwarding headers.
  const prefix=`/media/tenants/${tenantId}/`;
  if(typeof url!=='string'||!url.startsWith(prefix)||/[?#\\\x00-\x1F]/.test(url)) return {image_notice:'Image omitted: only local workspace raster images can be preserved in this edition'};
  let relative; try { relative=decodeURIComponent(url.slice(prefix.length)); } catch { return {image_notice:'Image omitted: invalid local path'}; }
  if(!relative||relative.split('/').some(s=>!s||s==='.'||s==='..')||/[\\\x00-\x1F]/.test(relative)) return {image_notice:'Image omitted: invalid local path'};
  try {
    const storageRoot=await fs.realpath(process.env.STORAGE_LOCAL_DIR||path.join(__dirname,'..','public','media'));
    const root=await fs.realpath(path.join(storageRoot,'tenants',String(tenantId)));
    if(root!==path.join(storageRoot,'tenants',String(tenantId))) throw Error('workspace directory must not redirect to another tenant');
    const target=await fs.realpath(path.join(root,relative));
    if(!target.startsWith(root+path.sep)) throw Error('outside workspace');
    const file=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try {
      const stat=await file.stat();
      if(!stat.isFile()||stat.size>MAX_IMAGE) return {image_notice:'Image omitted: unavailable or larger than 5 MB'};
      // Read one byte beyond bound to detect concurrent growth without unbounded allocation.
      const bytes=Buffer.alloc(MAX_IMAGE+1);let bytesRead=0;
      while(bytesRead<bytes.length){const chunk=await file.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!chunk.bytesRead)break;bytesRead+=chunk.bytesRead;}
      if(bytesRead>MAX_IMAGE) return {image_notice:'Image omitted: larger than 5 MB'};
      const data=bytes.subarray(0,bytesRead),mime=rasterMime(data);
      if(!mime) return {image_notice:'Image omitted: unsupported raster format'};
      return {image_data:data,image_mime:mime,image_notice:null};
    } finally {await file.close();}
  } catch { return {image_notice:'Image omitted: local file unavailable'}; }
}
async function transaction(fn) {
  const client=await pool().connect();
  try { await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result; }
  catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
}
async function sourceRows(client,tenantId,ids,mode,lock=false) {
  if(!ids.length)return [];
  const result=await client.query(`SELECT a.*,a.published_at::text AS publication_epoch,w.id AS profile_id,w.name AS writer_name,w.bio AS writer_bio,w.beat AS writer_beat,w.role AS writer_role,w.avatar_url AS writer_avatar_url,COALESCE(w.system_prompt ~ '[^[:space:]]',false) AS writer_has_prompt FROM articles a LEFT JOIN writers w ON w.id=a.writer_id AND w.tenant_id=a.tenant_id
    WHERE a.tenant_id=$1 AND a.id=ANY($2::int[]) AND ${mode==='published'?published('a'):authored('a')}
    ORDER BY a.id ${lock?'FOR SHARE OF a':''}`,[tenantId,ids]);
  if(result.rows.length!==ids.length)throw invalid('Every selected article must be an available authored article in this workspace; published editions require published articles');
  return result.rows;
}
function editionKey(id,legacy=false,isPublic=false){
  if(typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return {column:'public_id',value:id};
  if(legacy&&/^[1-9][0-9]*$/.test(String(id))&&Number.isSafeInteger(Number(id)))return {column:'id',value:Number(id)};
  throw invalid(isPublic?'Edition not found':'Invalid edition identifier',isPublic?404:400);
}
async function lockEdition(client,tenantId,id) {
  const key=editionKey(id);const {rows}=await client.query(`SELECT * FROM newspaper_editions WHERE tenant_id=$1 AND ${key.column}=$2 FOR UPDATE`,[tenantId,key.value]);
  if(!rows[0])throw invalid('Edition not found',404);return rows[0];
}
function assertActive(row){if(row.archived_at)throw invalid('Restore this archived edition before changing it.',409);}
function checkRevision(row,revision) { if(!Number.isSafeInteger(revision)||revision!==row.revision)throw invalid('This edition changed. Reload before saving your changes.',409); }
async function assertPublicationEpochs(client,row) {
  const invalidRows=await client.query(`SELECT e.article_id FROM newspaper_edition_articles e
    LEFT JOIN articles a ON a.id=e.article_id AND a.tenant_id=$2 WHERE e.edition_id=$1
    AND NOT COALESCE((${published('a')} AND a.published_at IS NOT DISTINCT FROM (e.snapshot->>'publication_epoch')::timestamptz),false) LIMIT 1`,[row.id,row.tenant_id]);
  if(invalidRows.rowCount)throw invalid(row.status==='working'?'An article was withdrawn or republished. Refresh the edition before finalizing.':'This issue contains withdrawn or republished coverage. Create a new edition to share current coverage.');
}
async function replaceSnapshots(client,row,input,refresh=false) {
  const sources=await sourceRows(client,row.tenant_id,input.article_ids,input.mode,true);
  const old=(await client.query('SELECT article_id,snapshot,image_data,image_mime,portrait_data,portrait_mime FROM newspaper_edition_articles WHERE edition_id=$1',[row.id])).rows;
  const existing=new Map(old.map(a=>[a.article_id,a]));const next=[];let total=0;
  for(const id of input.article_ids) {
    let item=existing.get(id);
    if(!item||refresh){
      const a=sources.find(s=>s.id===id),body=text(a.full_content)||text(a.content),content=body||text(a.summary),text_kind=body?'full':'excerpt';
      if(!content)throw invalid('Selected articles need readable article text');
      if(content.length>200000)throw invalid('An article is too long for this edition (maximum 200,000 characters)');
      const image=await localImage(a.image_url,row.tenant_id);
      const portrait=a.profile_id?await localImage(a.writer_avatar_url,row.tenant_id):{};
      const contributor=captureContributor(a,text,portrait);
      item={article_id:id,snapshot:{title:text(a.title),byline:text(a.writer_name||a.author||'Editorial team'),category:text(a.category),content,text_kind,summary:text(a.summary),source_updated_at:a.updated_at,source_published_at:a.published_at,publication_epoch:a.publication_epoch,was_published:a.is_published===1,image_notice:image.image_notice,contributor,...captureReferences(a.source_article_ids,content)},...image,portrait_data:portrait.image_data||null,portrait_mime:portrait.image_mime||null};
    }
    total+=(item.image_data?.length||0)+(item.portrait_data?.length||0);
    if(total>MAX_EDITION_IMAGES)throw invalid('Edition images exceed 25 MB. Choose fewer illustrated articles.');
    next.push(item);
  }
  await client.query('DELETE FROM newspaper_edition_articles WHERE edition_id=$1',[row.id]);
  for(let i=0;i<next.length;i++){
    const a=next[i];await client.query('INSERT INTO newspaper_edition_articles(edition_id,article_id,position,snapshot,image_data,image_mime,portrait_data,portrait_mime) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',[row.id,a.article_id,i,JSON.stringify(a.snapshot),a.image_data||null,a.image_mime||null,a.portrait_data||null,a.portrait_mime||null]);
  }
}
function rowDto(row) {
  const date=row.issue_date instanceof Date?row.issue_date.toISOString().slice(0,10):String(row.issue_date).slice(0,10);
  return {id:row.public_id,name:row.name,issue_date:date,mode:row.mode,status:row.status,visibility:row.visibility,revision:row.revision,lead_article_id:row.lead_article_id,settings:row.settings,created_at:row.created_at,updated_at:row.updated_at,finalized_at:row.finalized_at,archived_at:row.archived_at||null,retracted_at:row.retracted_at||null};
}
async function detail(client,tenantId,id,isPublic=false) {
  const key=editionKey(id,!isPublic,isPublic);const row=(await client.query(`SELECT * FROM newspaper_editions WHERE tenant_id=$1 AND ${key.column}=$2`,[tenantId,key.value])).rows[0];
  if(!row||isPublic&&(row.archived_at||row.visibility!=='public'||row.status!=='finalized'||row.mode!=='published'))throw invalid('Edition not found',404);
  const items=(await client.query(`SELECT e.article_id,e.snapshot,e.image_data IS NOT NULL AS has_image,e.portrait_data IS NOT NULL AS has_portrait,
    COALESCE((${published('a')} AND a.published_at IS NOT DISTINCT FROM (e.snapshot->>'publication_epoch')::timestamptz),false) AS currently_published,COALESCE((${authored('a')}),false) AS currently_available FROM newspaper_edition_articles e
    LEFT JOIN articles a ON a.id=e.article_id AND a.tenant_id=$2 WHERE e.edition_id=$1 ORDER BY e.position`,[row.id,tenantId])).rows;
  if(isPublic&&(!items.length||items.some(a=>!a.currently_published)))throw invalid('This edition is unavailable because its source coverage changed or was withdrawn.',404);
  const articles=items.map(a=>({article_id:a.article_id,...a.snapshot,withdrawn:!a.currently_available||a.snapshot.was_published&&!a.currently_published,image_path:a.has_image?`/api/editions/${isPublic?'public/':''}${row.public_id}/assets/${a.article_id}`:null,portrait_path:a.has_portrait?`/api/editions/${isPublic?'public/':''}${row.public_id}/portraits/${a.article_id}`:null}));
  return {...rowDto(row),articles,contributors:contributorsFor(articles)};
}
async function list(tenantId,query={}) {
  const {limit,offset}=page(query),client=pool(),view=query.view||'active';
  if(!['active','archived','all'].includes(view))throw invalid('Invalid edition view');
  const filter=view==='active'?' AND archived_at IS NULL':view==='archived'?' AND archived_at IS NOT NULL':'';
  const result=await client.query(`SELECT e.*, (SELECT COUNT(*)::int FROM newspaper_edition_articles a WHERE a.edition_id=e.id) article_count FROM newspaper_editions e WHERE tenant_id=$1${filter} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[tenantId,limit,offset]);
  const count=(await client.query(`SELECT COUNT(*)::int AS total FROM newspaper_editions WHERE tenant_id=$1${filter}`,[tenantId])).rows[0];
  return {editions:result.rows.map(r=>({...rowDto(r),article_count:r.article_count})),total:count.total,limit,offset};
}
async function search(tenantId,query={}) {
  const {limit,offset}=page(query),mode=query.mode||'published';
  if(!['published','proof'].includes(mode))throw invalid('Invalid edition mode');
  const q=String(query.q||'').trim();if(q.length>200)throw invalid('Search is too long');
  const where=`a.tenant_id=$1 AND ${mode==='published'?published('a'):authored('a')} AND (a.title ILIKE $2 OR COALESCE(a.category,'') ILIKE $2 OR COALESCE(w.name,a.author,'') ILIKE $2)`;
  const values=[tenantId,'%'+q.replace(/[\\%_]/g,'\\$&')+'%'];
  const rows=(await pool().query(`SELECT a.id,a.title,a.summary,a.category,COALESCE(w.name,a.author,'Editorial team') byline,a.is_published,a.updated_at,a.published_at FROM articles a LEFT JOIN writers w ON w.id=a.writer_id AND w.tenant_id=a.tenant_id WHERE ${where} ORDER BY a.updated_at DESC,a.id DESC LIMIT $3 OFFSET $4`,[...values,limit,offset])).rows;
  const count=(await pool().query(`SELECT COUNT(*)::int total FROM articles a LEFT JOIN writers w ON w.id=a.writer_id AND w.tenant_id=a.tenant_id WHERE ${where}`,values)).rows[0];
  return {articles:rows,total:count.total,limit,offset};
}
async function create(tenantId,userId,input) {
  const value=validate(input),key=String(input.request_id||'');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw invalid('A unique request ID is required');
  const hash=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return transaction(async client=>{
    // Transaction advisory key also serializes concurrent retries before the row exists.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`edition:${tenantId}:${userId}:${key}`]);
    const old=(await client.query('SELECT * FROM newspaper_editions WHERE tenant_id=$1 AND created_by=$2 AND request_id=$3',[tenantId,String(userId),key])).rows[0];
    if(old){if(old.request_hash!==hash)throw invalid('This request ID was already used for different edition details',409);return detail(client,tenantId,old.id);}
    const row=(await client.query(`INSERT INTO newspaper_editions(tenant_id,created_by,request_id,request_hash,name,issue_date,mode,lead_article_id,settings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[tenantId,String(userId),key,hash,value.name,value.issue_date,value.mode,value.lead_article_id,JSON.stringify(value.settings)])).rows[0];
    await replaceSnapshots(client,row,value);return detail(client,tenantId,row.id);
  });
}
async function update(tenantId,id,input) {
  const value=validate(input);
  return transaction(async client=>{const row=await lockEdition(client,tenantId,id);checkRevision(row,input.revision);assertActive(row);if(row.status!=='working')throw invalid('Finalized editions cannot be edited. Create a new edition.',409);
    if(row.mode!==value.mode)throw invalid('Edition mode cannot change after creation. Create a new edition to switch mode.');
    await replaceSnapshots(client,row,value);
    await client.query('UPDATE newspaper_editions SET name=$3,issue_date=$4,mode=$5,lead_article_id=$6,settings=$7::jsonb,revision=revision+1,updated_at=NOW() WHERE tenant_id=$1 AND id=$2',[tenantId,row.id,value.name,value.issue_date,value.mode,value.lead_article_id,JSON.stringify(value.settings)]);
    return detail(client,tenantId,row.id);
  });
}
async function refresh(tenantId,id,revision) {
  return transaction(async client=>{const row=await lockEdition(client,tenantId,id);checkRevision(row,revision);assertActive(row);if(row.status!=='working')throw invalid('Finalized snapshots cannot be refreshed',409);
    const ids=(await client.query('SELECT article_id FROM newspaper_edition_articles WHERE edition_id=$1 ORDER BY position',[row.id])).rows.map(a=>a.article_id);
    await replaceSnapshots(client,row,{...row,article_ids:ids},true);
    await client.query('UPDATE newspaper_editions SET revision=revision+1,updated_at=NOW() WHERE id=$1',[row.id]);return detail(client,tenantId,row.id);
  });
}
async function finalize(tenantId,id,revision) {
  return transaction(async client=>{const row=await lockEdition(client,tenantId,id);
    assertActive(row);if(row.status==='finalized'){if(revision!==row.revision&&revision!==row.revision-1)checkRevision(row,revision);return detail(client,tenantId,row.id);}
    checkRevision(row,revision);const ids=(await client.query('SELECT article_id FROM newspaper_edition_articles WHERE edition_id=$1 ORDER BY position',[row.id])).rows.map(a=>a.article_id);
    if(!ids.length||!ids.includes(row.lead_article_id))throw invalid('Select at least one article and a lead story before finalizing');
    await sourceRows(client,tenantId,ids,row.mode,true);
    if(row.mode==='published')await assertPublicationEpochs(client,row);
    await client.query("UPDATE newspaper_editions SET status='finalized',finalized_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1",[row.id]);return detail(client,tenantId,row.id);
  });
}
async function visibility(tenantId,id,revision,value,actorId,reason) {
  if(!['public','private'].includes(value))throw invalid('Invalid visibility');
  if(value==='private')return lifecycle(tenantId,id,actorId,'retract',{revision,reason},{canPublish:true});
  return transaction(async client=>{const row=await lockEdition(client,tenantId,id);
    assertActive(row);if(row.visibility===value){checkRevision(row,revision);return detail(client,tenantId,row.id);}
    checkRevision(row,revision);if(value==='public'){
      if(row.mode!=='published'||row.status!=='finalized')throw invalid('Only finalized published-content editions can be shared');
      const ids=(await client.query('SELECT article_id FROM newspaper_edition_articles WHERE edition_id=$1',[row.id])).rows.map(a=>a.article_id);
      if(!ids.length)throw invalid('Cannot share an empty edition');await sourceRows(client,tenantId,ids,'published',true);
      await assertPublicationEpochs(client,row);
    }
    await client.query('UPDATE newspaper_editions SET visibility=$2,retracted_at=CASE WHEN $2=$3 THEN NOW() ELSE NULL END,revision=revision+1,updated_at=NOW() WHERE id=$1',[row.id,value,'private']);
    await audit(client,row,actorId||'system',value==='private'?'retract':'share',value==='private'?reasonText(reason||'Visibility changed to private'):'',{});return detail(client,tenantId,row.id);
  });
}
function reasonText(value){const reason=typeof value==='string'?value.trim():'';if(!reason||reason.length>1000)throw invalid('Provide a reason of 1–1000 characters');return reason;}
async function audit(client,row,actor,action,reason,metadata){
  await client.query('INSERT INTO newspaper_edition_audit(tenant_id,edition_id,actor_id,action,reason,before_revision,after_revision,metadata,edition_public_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[row.tenant_id,row.id,String(actor),action,reason,row.revision,row.revision+1,JSON.stringify(metadata),row.public_id]);
}
async function history(tenantId,id){
  const key=editionKey(id,true);
  return (await pool().query(`SELECT actor_id,action,reason,before_revision,after_revision,metadata,created_at FROM newspaper_edition_audit WHERE tenant_id=$1 AND ${key.column==='id'?'edition_id':'edition_public_id'}=$2 ORDER BY id DESC LIMIT 100`,[tenantId,key.value])).rows;
}
async function lifecycle(tenantId,id,actor,action,input={},permissions={}){
  if(!['retract','archive','restore','rename','delete'].includes(action))throw invalid('Invalid edition action');
  const reason=['retract','archive','delete'].includes(action)?reasonText(input.reason):'';
  const name=action==='rename'&&typeof input.name==='string'?input.name.trim():null;
  if(action==='rename'&&(!name||name.length>120))throw invalid('Edition name must contain 1–120 characters');
  return transaction(async client=>{
    const row=await lockEdition(client,tenantId,id);
    if(['archive','retract'].includes(action)&&!permissions.canPublish)throw invalid('Publishing permission is required for this action',403);
    if(action==='rename'&&row.visibility==='public'&&!permissions.canPublish)throw invalid('Publishing permission is required to rename a public edition',403);
    // A repeated request can only replay the immediately preceding identical action.
    if(input.revision===row.revision-1){
      const prior=(await client.query('SELECT action,actor_id,reason,metadata FROM newspaper_edition_audit WHERE tenant_id=$1 AND edition_id=$2 AND before_revision=$3 AND after_revision=$4 ORDER BY id DESC LIMIT 1',[tenantId,row.id,input.revision,row.revision])).rows[0];
      if(prior&&prior.action===action&&prior.actor_id===String(actor)&&prior.reason===reason&&(action!=='rename'||prior.metadata.new_name===name))return detail(client,tenantId,row.id);
    }
    checkRevision(row,input.revision);
    if(action==='delete'){
      if(!row.archived_at)throw invalid('Archive this edition before permanently deleting it.',409);
      if(input.confirmation!==row.name)throw invalid('Type the exact edition title to confirm permanent deletion');
      await audit(client,row,actor,action,reason,{name:row.name});
      await client.query('DELETE FROM newspaper_editions WHERE tenant_id=$1 AND id=$2',[tenantId,row.id]);
      return {deleted:true,id:row.public_id};
    }
    if(action==='restore'){
      if(!row.archived_at)return detail(client,tenantId,row.id);
      await client.query("UPDATE newspaper_editions SET archived_at=NULL,visibility='private',revision=revision+1,updated_at=NOW() WHERE id=$1",[row.id]);
    }else if(action==='archive'){
      if(row.archived_at)return detail(client,tenantId,row.id);
      await client.query("UPDATE newspaper_editions SET archived_at=NOW(),retracted_at=CASE WHEN visibility='public' THEN NOW() ELSE retracted_at END,visibility='private',revision=revision+1,updated_at=NOW() WHERE id=$1",[row.id]);
    }else if(action==='retract'){
      assertActive(row);
      await client.query("UPDATE newspaper_editions SET visibility='private',retracted_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1",[row.id]);
    }else{
      assertActive(row);if(row.name===name)return detail(client,tenantId,row.id);
      await client.query('UPDATE newspaper_editions SET name=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',[row.id,name]);
    }
    await audit(client,row,actor,action,reason,action==='rename'?{old_name:row.name,new_name:name}:{name:row.name,previous_visibility:row.visibility});
    return detail(client,tenantId,row.id);
  });
}
async function asset(tenantId,id,articleId,isPublic=false,portrait=false) {
  // Eligibility and image are selected in the same read transaction snapshot.
  return transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const edition=await detail(client,tenantId,id,isPublic);if(!edition.articles.some(a=>a.article_id===positive(articleId)))throw invalid('Image not found',404);
    const row=(await client.query(`SELECT ${portrait?'portrait_data AS image_data,portrait_mime AS image_mime':'image_data,image_mime'} FROM newspaper_edition_articles WHERE edition_id=(SELECT id FROM newspaper_editions WHERE tenant_id=$1 AND public_id=$2) AND article_id=$3`,[tenantId,edition.id,positive(articleId)])).rows[0];
    if(!row?.image_data)throw invalid('Image not found',404);return {data:row.image_data,mime:row.image_mime};
  });
}
module.exports={MAX_ARTICLES,MAX_IMAGE,MAX_EDITION_IMAGES,validate,text,rasterMime,localImage,list,search,create,update,refresh,finalize,visibility,lifecycle,history,asset,get:(tenantId,id,isPublic=false)=>detail(pool(),tenantId,id,isPublic)};
