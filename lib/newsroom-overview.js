'use strict';
const db=require('../db');
const VERSION=1;
function permitted(user,permission){const p=user?.permissions||[];return p.includes('*')||p.includes(permission)||p.includes(permission.split('.')[0]+'.*');}
function principal(user){if(!user?.sub||!['platform-admin','tenant-admin'].includes(user.type))throw Object.assign(Error('A current user identity is required.'),{status:403});return user.type+':'+user.sub;}
function context(tenant,user){if(!Number.isSafeInteger(tenant)||tenant<1)throw Object.assign(Error('Workspace context is required.'),{status:403});return principal(user);}
async function overview(tenant,user){
 const key=context(tenant,user),cards=[],items=[],activity=[];
 const count=async(table,condition,params=[])=>Number((await db.getPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND ${condition}`,[tenant,...params])).rows[0].n);
 const card=(id,label,n,href,description)=>cards.push({id,label,count:n,href,description});
 const item=(id,label,complete,href,description,scope='workspace')=>items.push({id,label,complete:Boolean(complete),href,description,scope});
 if(permitted(user,'sources.read')){
  const feeds=await count('sources','removed_at IS NULL');
  card('feed_errors','Feeds needing attention',await count('sources',"removed_at IS NULL AND NULLIF(TRIM(last_fetch_error),'') IS NOT NULL"),'sources.html?errors=1','Current subscriptions with a recorded fetch error, including paused feeds.');
  item('sources','Workspace has RSS subscriptions',feeds,'sources.html','Existing subscriptions are evidence, not proof that fetching succeeded.');
 }
 if(permitted(user,'articles.read')){
  const eligible='COALESCE(is_archived,0)=0 AND COALESCE(is_published,0)=0';
  const drafts=await count('articles',eligible+" AND content_type IN ('original','deep-dive') AND (status='draft' OR status IS NULL)");
  card('editorial_drafts','Editorial drafts',drafts,'articles.html?tab=drafts&content_type=editorial','Original and deep-dive drafts; imported inbox articles are excluded.');
  card('review','Articles in review',await count('articles',eligible+" AND status='review'"),'articles.html?tab=review','Unpublished, unarchived articles awaiting review.');
  card('scheduled','Scheduled publications',await count('articles',eligible+" AND status='scheduled'"),'articles.html?tab=scheduled','The full scheduled queue, including overdue items.');
  card('writer_pitches','Writer pitches awaiting decision',await count('story_pitches',"status IN ('pending','proposed')"),'pitches.html?tab=pitches&status=open','Writer story pitches; these are distinct from source-based commissions.');
  const pitchesEnabled=await require('./feature-registry').isFeatureEnabled(tenant,'article_pitches');
  if(pitchesEnabled){
   card('assignments_needs_sources','Assignments needing sources',await count('article_pitches',"is_editor_assignment=true AND status='needs_sources' AND spawned_article_id IS NULL"),'pitches.html?tab=commissions&assignment_status=needs_sources#editorAssignments','Attach evidence before approval; opening the queue does not generate a draft.');
   item('brief','Workspace has a pitch or assignment',await count('article_pitches','true'),'pitches.html?tab=commissions','A saved brief does not mean a draft was generated or approved.');
  }
  item('inbox','Workspace has source articles',await count('articles',"COALESCE(is_archived,0)=0 AND (content_type IS NULL OR content_type='curated')"),'feed-inbox.html','Imported evidence is available for reading and assignments.');
  const read=await db.getPool().query(`SELECT EXISTS(SELECT 1 FROM reader_item_states s JOIN articles a ON a.id=s.article_id AND a.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.principal=$2 AND s.is_read=true AND COALESCE(a.is_archived,0)=0 AND (a.content_type IS NULL OR a.content_type='curated')) AS done`,[tenant,key]);
  item('read','You have marked a source as read',read.rows[0].done,'feed-inbox.html','Based on your saved Reader state, not a page visit.','personal');
  item('draft','Workspace has an editorial draft',await count('articles',eligible+" AND content_type IN ('original','deep-dive') AND (status='draft' OR status IS NULL)"),'articles.html?tab=drafts&content_type=editorial','This does not prove paid generation; drafts may be written manually.');
  item('published','Workspace has published articles',await count('articles',"is_published=1 AND COALESCE(is_archived,0)=0"),'articles.html?tab=published','Current publication state, not a claim that you published it.');
  const rows=await db.getPool().query(`SELECT id,title,status,updated_at FROM articles WHERE tenant_id=$1 AND COALESCE(is_archived,0)=0 AND content_type IN ('original','deep-dive') ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 8`,[tenant]);
  for(const r of rows.rows)activity.push({id:r.id,title:String(r.title||'Untitled article').slice(0,250),status:r.status,at:r.updated_at,href:permitted(user,'articles.update')?'article-editor.html?id='+r.id:'articles.html?id='+r.id});
 }
 const prefs=await db.getPool().query('SELECT dismissed FROM navigation_preferences WHERE tenant_id=$1 AND principal=$2 AND checklist_version=$3',[tenant,key,VERSION]);
 return{cards,activity,onboarding:{version:VERSION,dismissed:prefs.rows[0]?.dismissed||false,items}};
}
async function dismiss(tenant,user,input){const key=context(tenant,user);if(typeof input?.dismissed!=='boolean'||input.version!==VERSION||Object.keys(input).some(k=>!['dismissed','version'].includes(k)))throw Object.assign(Error('Specify the current checklist version and dismissed true or false.'),{status:400});await db.getPool().query(`INSERT INTO navigation_preferences(tenant_id,principal,checklist_version,dismissed) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,principal,checklist_version) DO UPDATE SET dismissed=EXCLUDED.dismissed,updated_at=NOW()`,[tenant,key,VERSION,input.dismissed]);return{version:VERSION,dismissed:input.dismissed};}
module.exports={overview,dismiss,permitted,principal};
