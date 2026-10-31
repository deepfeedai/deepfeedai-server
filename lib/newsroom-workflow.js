'use strict';
// Workflow is a projection of authoritative records, never a second content store.
const db = require('../db');
const sourceRules = require('./assignment-sources');
const { permitted } = require('./newsroom-overview');
const STAGES = ['discover','pitch','commission','draft','review','scheduled','published','archived'];
const KINDS = ['source','story_pitch','pitch','assignment','article'];
const fail = (message,status=400) => Object.assign(Error(message),{status});
// DTO text is not HTML. Renderers must use textContent, never HTML insertion.
const clean = value => String(value || '').slice(0,2000);
const safeId = value => { if(!/^[1-9]\d{0,8}$/.test(String(value)))throw fail('Invalid workflow item.');return Number(value); };
function publicUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function fingerprint(row){return require('crypto').createHash('sha256').update(JSON.stringify([row.status,row.source_article_id,row.attached_article_ids,row.source_article_ids,row.pitched_by_writer_id,row.writer_id,row.spawned_article_id,row.draft_attempt,row.topic,row.angle_summary,row.reasoning,row.headline])).digest('hex');}
function assertCurrent(row,expected){if(expected!==undefined&&(typeof expected!=='string'||expected!==fingerprint(row)))throw fail('This item changed since it was opened. Reload and review the current brief, sources and writer.',409);}
function costProjection(usage){
 const requests=Number(usage?.requests||0),priced=Number(usage?.priced_requests||0);
 if(!requests||!priced)return{available:false,estimated_usd:null,requests,note:requests?'Usage is recorded, but no cost estimates are available. Check provider billing.':'No uniquely attributable usage is recorded for this item. This is not a claim of zero cost.'};
 return{available:true,estimated_usd:Number(usage.estimated_usd),requests,priced_requests:priced,note:(priced<requests?'Partial estimate: '+priced+' of '+requests+' requests have recorded costs. ':'Recorded estimates associated with this article slug. ')+'Provider billing is authoritative.'};
}
function editorialStage(kind,row,article) {
 const a=article||(kind==='article'||kind==='source'?row:null);
 if(a) return a.is_archived?'archived':kind==='source'?'discover':a.is_published?'published':['draft','review','scheduled'].includes(a.status)?a.status:'draft';
 if(row.spawned_article_id)return 'commission';
 if(['rejected','dismissed','killed'].includes(row.status))return 'archived';
 return kind==='assignment'||row.status==='approved'?'commission':'pitch';
}
function assignmentPrerequisites(row,sources,writer) {
 const blockers=[];
 if(sources.filter(s=>s.eligible).length<sourceRules.MINIMUM)blockers.push({code:'sources',message:`Attach at least ${sourceRules.MINIMUM} available supporting sources.`});
 if(sources.some(s=>!s.eligible))blockers.push({code:'unavailable_source',message:'Remove or replace unavailable supporting sources.'});
 if(!writer||writer.role!=='writer')blockers.push({code:'writer',message:'Choose an available writer from this workspace.'});
 return blockers;
}
function project(kind,row,{article=null,sources=[],writer=null,user={},commissionEnabled=true}={}) {
 const stage=editorialStage(kind,row,article),assignment=kind==='assignment';
 const generation={state:assignment?(row.status==='drafting'?'running':row.status==='failed'?'failed':row.spawned_article_id?'succeeded':'not_started'):'not_tracked',attempt:assignment?row.draft_attempt||0:0,started_at:assignment?row.draft_started_at||null:null,error:assignment&&row.draft_error?clean(row.draft_error):null,retry_requires_acknowledgement:assignment&&(row.status==='failed'||row.status==='drafting'||row.draft_attempt>0)};
 if(generation.state==='running'&&row.draft_started_at&&Date.now()-new Date(row.draft_started_at).getTime()>=600000)generation.state='uncertain';
 const blockers=assignment&&!article?assignmentPrerequisites(row,sources,writer):[];
 if(row.spawned_article_id&&!article)blockers.push({code:'draft_unavailable',message:'The linked draft is unavailable. Do not generate another draft; review its history.'});
 const actions=[];
 const add=(id,label,permission,options={})=>{
  const allowed=permitted(user,permission),enabled=allowed&&options.enabled!==false;
  const action={id,label,enabled,reason:allowed?(options.reason||null):'Your role does not permit this action.',consequence:options.consequence||'Opens the existing workspace without generating or publishing.',paid:false,...options,enabled};
  if(!allowed)action.reason='Your role does not permit this action.';
  actions.push(action);return action;
 };
 const href='newsroom-workflow.html?kind='+kind+'&id='+row.id;
 if(kind==='source')add('create_commission','Create a commission','articles.update',{href:'pitches.html?tab=commissions&source_ids='+row.id,enabled:commissionEnabled,reason:commissionEnabled?null:'Commissions are not enabled.',consequence:'Start a brief using this source. Saving does not generate text.'});
 if(['pitch','story_pitch'].includes(kind)&&!article&&!row.spawned_article_id&&!['rejected','dismissed','killed'].includes(row.status))add('commission','Open a commission','articles.update',{method:'POST',endpoint:`/api/newsroom-workflow/${kind}/${row.id}/commission`,body:{expected_state:fingerprint(row)},enabled:commissionEnabled,reason:commissionEnabled?null:'Commissions are not enabled.',consequence:'Creates or opens a linked research brief. Approval and paid drafting remain separate.'});
 if(assignment&&!article&&!row.spawned_article_id){
  add('sources','Manage sources and writer','articles.update',{href:`pitches.html?tab=commissions&assignment=${row.id}#editorAssignments`,enabled:['needs_sources','proposed','approved','failed'].includes(row.status),reason:row.status==='drafting'?'Wait for the current attempt; source changes are locked.':null});
  if(['needs_sources','proposed','approved'].includes(row.status))add('approve','Approve commission','articles.update',{method:'POST',endpoint:`/api/editor-assignments/${row.id}/approve`,body:{expected_state:fingerprint(row)},enabled:!blockers.length&&row.status!=='approved',reason:row.status==='approved'?'Already approved.':blockers.map(b=>b.message).join(' ')||null,consequence:'Records approval only. No AI request or publication.'});
  if(['approved','failed','drafting'].includes(row.status))add('generate',generation.retry_requires_acknowledgement?'Retry paid draft':'Generate draft (paid)','articles.create',{method:'POST',endpoint:`/api/editor-assignments/${row.id}/generate`,body:{confirmPaid:true,expected_state:fingerprint(row),...(generation.retry_requires_acknowledgement?{retryAcknowledged:true}:{})},paid:true,enabled:!blockers.length&&generation.state!=='running',reason:generation.state==='running'?'Generation is running. Refresh status; do not resubmit.':blockers.map(b=>b.message).join(' ')||null,consequence:generation.retry_requires_acknowledgement?'The previous request may have incurred charges. Check provider usage before explicitly retrying.':'Calls your configured provider and may incur charges. Saves an unpublished draft for review.'});
 }
 const a=article||(kind==='article'?row:null);
 if(a){
  add('edit',stage==='published'?'Review published article':stage==='scheduled'?'Edit scheduled article':stage==='archived'?'Open archived article':'Review and edit draft','articles.update',{href:'article-editor.html?id='+a.id});
  if(stage==='draft')add('submit_review','Submit for review','articles.update',{method:'PUT',endpoint:`/api/articles/${a.id}/submit-review`,body:{expected_revision:a.publication_revision},consequence:'Moves the saved draft into review. Does not publish.'});
  if(stage==='review')add('publish','Approve publication','articles.update',{method:'PUT',endpoint:`/api/articles/${a.id}/approve`,body:{expected_revision:a.publication_revision},consequence:'Publishes publicly or places the article in the configured schedule. Review sources, text and media first.'});
  if(stage==='scheduled')add('schedule','Review schedule','articles.update',{href:'articles.html?tab=scheduled'});
  if(stage==='published')add('unpublish','Unpublish article','articles.update',{method:'PUT',endpoint:`/api/articles/${a.id}/publish`,body:{published:false,expected_revision:a.publication_revision},consequence:'Withdraws this article from public readers and dependent public editions. Downloaded copies cannot be recalled.'});
 }
 const preferred=stage==='discover'?'create_commission':stage==='pitch'?'commission':stage==='review'?'edit':stage==='published'?'edit':stage==='scheduled'?'schedule':assignment?(blockers.length?'sources':row.status==='approved'||row.status==='failed'?'generate':'approve'):'edit';
 return {key:kind+':'+row.id,kind,id:row.id,title:clean(row.topic||row.headline||row.title||row.angle_summary||'Untitled'),stage,editorial_status:a?a.status:assignment&&['drafting','failed'].includes(row.status)?'approved':row.status,generation,blockers,primary_action:actions.find(a=>a.id===preferred&&a.enabled)||actions.find(a=>a.enabled)||null,actions,updated_at:row.updated_at||row.created_at||null,href};
}
const ARTICLE_STAGE="CASE WHEN a.is_archived=1 THEN 'archived' WHEN a.is_published=1 THEN 'published' WHEN a.status IN ('draft','review','scheduled') THEN a.status ELSE 'draft' END";
const UNION=`
 SELECT 'source' kind,a.id,to_jsonb(a) record,NULL::jsonb draft,'discover' stage,COALESCE(a.updated_at,a.created_at) at FROM articles a WHERE a.tenant_id=$1 AND (a.content_type IS NULL OR a.content_type='curated') AND COALESCE(a.is_archived,0)=0
 UNION ALL SELECT 'article',a.id,to_jsonb(a),NULL::jsonb,${ARTICLE_STAGE},COALESCE(a.updated_at,a.created_at) FROM articles a WHERE a.tenant_id=$1 AND a.content_type IN ('original','deep-dive') AND NOT EXISTS(SELECT 1 FROM article_pitches p WHERE $4 AND p.tenant_id=a.tenant_id AND p.spawned_article_id=a.id) AND NOT EXISTS(SELECT 1 FROM story_pitches p WHERE p.tenant_id=a.tenant_id AND p.spawned_article_id=a.id)
 UNION ALL SELECT CASE WHEN p.is_editor_assignment THEN 'assignment' ELSE 'pitch' END,p.id,to_jsonb(p),CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,CASE WHEN a.id IS NOT NULL THEN ${ARTICLE_STAGE} WHEN p.status IN ('rejected','dismissed','killed') THEN 'archived' WHEN p.is_editor_assignment OR p.status='approved' THEN 'commission' ELSE 'pitch' END,p.created_at FROM article_pitches p LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND (p.is_editor_assignment OR NOT EXISTS(SELECT 1 FROM article_pitches linked WHERE $4 AND linked.tenant_id=p.tenant_id AND linked.is_editor_assignment=true AND linked.request_key='workflow-pitch-'||p.id||'-commission'))
 UNION ALL SELECT 'story_pitch',p.id,to_jsonb(p),CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,CASE WHEN a.id IS NOT NULL THEN ${ARTICLE_STAGE} WHEN p.status IN ('rejected','dismissed') THEN 'archived' WHEN p.status='approved' THEN 'commission' ELSE 'pitch' END,p.created_at FROM story_pitches p LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM article_pitches linked WHERE $4 AND linked.tenant_id=p.tenant_id AND linked.is_editor_assignment=true AND linked.request_key='workflow-story_pitch-'||p.id||'-commission')`;
async function context(kind,row,tenant) {
 const ids=kind==='assignment'||kind==='pitch'?sourceRules.ids(row):Array.isArray(row.source_article_ids)?row.source_article_ids.map(x=>typeof x==='object'?x.id:x):[];
 const safe=ids.filter(Number.isSafeInteger);
 const found=safe.length?(await db.getPool().query(`SELECT id,title,source,summary,source_url,created_at,(${sourceRules.ELIGIBLE}) eligible FROM articles WHERE tenant_id=$1 AND id=ANY($2::int[])`,[tenant,safe])).rows:[];
 const sources=safe.map(id=>{const s=found.find(s=>s.id===id);return s?{id,title:clean(s.title),publisher:clean(s.source),summary:clean(s.summary),eligible:s.eligible,created_at:s.created_at,url:publicUrl(s.source_url)}:{id,title:'Source unavailable',eligible:false};});
 const writerId=row.pitched_by_writer_id||row.writer_id;
 const writer=writerId?await db.prepare('SELECT id,name,role FROM writers WHERE id=$1 AND tenant_id=$2').get(writerId,tenant):null;
 return {sources,writer};
}
async function list(tenant,user,query={}){
 const limit=query.limit===undefined?25:Number(query.limit),offset=query.offset===undefined?0:Number(query.offset),stage=query.stage||'all',q=typeof query.q==='string'?query.q.trim():'';
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!['all',...STAGES].includes(stage)||q.length>200)throw fail('Invalid workflow filter.');
 const enabled=await require('./feature-registry').isFeatureEnabled(tenant,'article_pitches');
 const params=[tenant,stage,'%'+q.replace(/[\\%_]/g,match=>'\\'+match)+'%',enabled];
 const where=" WHERE ($4 OR kind NOT IN ('assignment','pitch')) AND ($2='all' OR stage=$2) AND concat_ws(' ',record->>'title',record->>'topic',record->>'headline',record->>'angle_summary') ILIKE $3";
 const total=(await db.getPool().query('SELECT count(*)::int n FROM ('+UNION+') work'+where,params)).rows[0].n;
 const rows=(await db.getPool().query('SELECT * FROM ('+UNION+') work'+where+' ORDER BY at DESC NULLS LAST,kind,id DESC LIMIT $5 OFFSET $6',[...params,limit,offset])).rows;
 const items=[];for(const r of rows){const item=project(r.kind,r.record,{...await context(r.kind,r.record,tenant),article:r.draft,user,commissionEnabled:enabled});await publicationBlockers(item,r.draft||(r.kind==='article'?r.record:null),tenant);items.push(item);}
 return{items,total,limit,offset,stages:STAGES};
}
async function record(kind,id,tenant){
 if(!KINDS.includes(kind))throw fail('Unknown workflow item.',404);id=safeId(id);
 const table=['source','article'].includes(kind)?'articles':kind==='story_pitch'?'story_pitches':'article_pitches';
 const row=await db.prepare(`SELECT * FROM ${table} WHERE id=$1 AND tenant_id=$2`).get(id,tenant);
 if(!row||(kind==='assignment'&&!row.is_editor_assignment)||(kind==='pitch'&&row.is_editor_assignment)||(kind==='source'&&!['curated',null].includes(row.content_type))||(kind==='article'&&!['original','deep-dive'].includes(row.content_type)))throw fail('Workflow item not found.',404);return row;
}
async function detail(kind,id,tenant,user){
 if(['assignment','pitch'].includes(kind)&&!await require('./feature-registry').isFeatureEnabled(tenant,'article_pitches'))throw fail('Commissions are not enabled.',404);
 const row=await record(kind,id,tenant),ctx=await context(kind,row,tenant);
 const article=row.spawned_article_id?await db.prepare('SELECT * FROM articles WHERE id=$1 AND tenant_id=$2').get(row.spawned_article_id,tenant):kind==='article'?row:null;
 const commissionEnabled=await require('./feature-registry').isFeatureEnabled(tenant,'article_pitches');
 const item=project(kind,row,{...ctx,article,user,commissionEnabled});
 if(['pitch','story_pitch'].includes(kind)){
  const linked=await db.prepare("SELECT id FROM article_pitches WHERE tenant_id=$1 AND is_editor_assignment=true AND request_key=$2").get(tenant,'workflow-'+kind+'-'+id+'-commission');
  if(linked){item.linked_assignment_id=linked.id;const action={id:'open_commission',label:'Open existing commission',href:'newsroom-workflow.html?kind=assignment&id='+linked.id,enabled:commissionEnabled,reason:commissionEnabled?null:'Commissions are not enabled.',paid:false,consequence:'Opens the existing brief. No generation or publication.'};item.actions=item.actions.filter(a=>a.id!=='commission');item.actions.unshift(action);item.primary_action=action;}
 }
 await publicationBlockers(item,article,tenant);
 const history=[];
 if(row.created_at)history.push({action:'Created',at:row.created_at});
 if(row.decided_at)history.push({action:'Decision recorded',at:row.decided_at});
 if(row.draft_started_at)history.push({action:'Draft attempt '+(row.draft_attempt||1)+' started',at:row.draft_started_at});
 if(article){const events=await db.prepare('SELECT action,created_at FROM article_publication_history WHERE tenant_id=$1 AND article_id=$2 ORDER BY id DESC LIMIT 40').all(tenant,article.id);history.push(...events.map(e=>({action:e.action,at:e.created_at})));}
 let costs=costProjection(null);
 if(article?.slug&&permitted(user,'settings.read')){const usage=await db.prepare('SELECT count(*)::int requests,count(estimated_cost)::int priced_requests,sum(estimated_cost) estimated_usd FROM ai_usage WHERE tenant_id=$1 AND article_slug=$2').get(tenant,article.slug);costs=costProjection(usage);}
 const handoffs=[];
 if(article?.is_published&&!article.is_archived){if(permitted(user,'articles.read'))handoffs.push({id:'edition',label:permitted(user,'articles.create')?'Curate a newspaper edition':'Browse newspaper editions',href:'editions.html',enabled:true,paid:false,consequence:'Select published authored articles. This does not create or share an edition automatically.'});if(permitted(user,'newsletter.send'))handoffs.push({id:'newsletter',label:'Open newsletter curation',href:'newsletter.html',enabled:true,paid:false,consequence:'Opens the existing newsletter workspace. Sending and AI suggestions remain separate actions.'});}
 return{item,...ctx,brief:{topic:clean(row.topic||row.headline||row.title),angle_summary:clean(row.angle_summary||row.reasoning||row.angle)},draft:article?{id:article.id,title:clean(article.title),status:article.status,href:(permitted(user,'articles.update')?'article-editor.html?id=':'articles.html?id=')+article.id}:null,history,costs,handoffs};
}
async function publicationBlockers(item,article,tenant){if(article&&!article.is_published){try{await require('./publication').validate(db.getPool(),article,tenant);}catch(e){if(!e.status)throw e;item.blockers.push({code:'publication',message:e.message});for(const a of item.actions)if(a.id==='publish'){a.enabled=false;a.reason=e.message;}}}}
async function commission(kind,id,tenant,user,input={}){
 if(!['pitch','story_pitch'].includes(kind))throw fail('Only a pitch can become a commission.');
 id=safeId(id);const client=await db.getPool().connect();try{await client.query('BEGIN');const table=kind==='pitch'?'article_pitches':'story_pitches';const row=(await client.query(`SELECT * FROM ${table} WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[id,tenant])).rows[0];if(!row||(kind==='pitch'&&row.is_editor_assignment))throw fail('Pitch not found.',404);assertCurrent(row,input.expected_state);if(row.spawned_article_id)throw fail('This pitch already has a draft. Open it instead.',409);if(['rejected','dismissed','killed'].includes(row.status))throw fail('This pitch is closed.',409);
 const linked=(await client.query("SELECT id FROM article_pitches WHERE tenant_id=$1 AND is_editor_assignment=true AND request_key=$2",[tenant,'workflow-'+kind+'-'+id+'-commission'])).rows[0];if(linked){await client.query('COMMIT');return{assignment_id:linked.id,href:'newsroom-workflow.html?kind=assignment&id='+linked.id};}
 const ids=kind==='pitch'?sourceRules.ids(row):(Array.isArray(row.source_article_ids)?row.source_article_ids:[]);
 const saved=await require('./editor-assignments').create({topic:row.topic||row.headline||row.angle_summary,angle_summary:row.angle_summary||row.reasoning||row.angle||row.headline,writer_id:row.pitched_by_writer_id||row.writer_id,source_article_ids:ids,pitch_type:row.pitch_type,request_key:'workflow-'+kind+'-'+id+'-commission'},tenant,user?.sub||null,client);
 await client.query('COMMIT');return{assignment_id:saved.id,href:'newsroom-workflow.html?kind=assignment&id='+saved.id};}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={STAGES,KINDS,project,assignmentPrerequisites,fingerprint,assertCurrent,costProjection,list,detail,commission};
