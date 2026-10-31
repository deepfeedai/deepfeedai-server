const express=require('express'),router=express.Router(),db=require('../db');const {auth}=require('../middleware/auth'),{requirePermission}=require('../middleware/permissions');const assignments=require('../lib/editor-assignments');
const sourceRules=require('../lib/assignment-sources');
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next()});
router.use(auth);router.use(async(req,res,next)=>{if(!await require('../lib/feature-registry').isFeatureEnabled(req.tenantId,'article_pitches').catch(()=>false))return res.status(404).json({error:'Assignments are not enabled.'});next()});
const handle=fn=>async(req,res)=>{try{if(req.params.id&&!/^[1-9]\d{0,8}$/.test(req.params.id))return res.status(400).json({error:'Invalid assignment ID.'});await fn(req,res)}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Assignment operation failed. Please retry after checking its current state.'})}};
router.get('/',requirePermission('articles.read'),handle(async(req,res)=>{
 const statuses=['needs_sources','proposed','approved','drafting','failed','review','scheduled','published','rejected','draft','archived','draft_unavailable'];
 const {status,id}=req.query;
 const integer=(v,fallback,max)=>{if(v===undefined)return fallback;if(!/^\d+$/.test(String(v))||Number(v)>max)throw Object.assign(Error('Invalid pagination.'),{status:400});return Number(v);};
 const limit=integer(req.query.limit,100,200),offset=integer(req.query.offset,0,1000000);
 if(limit<1||(status&&!statuses.includes(status))||(id&&!/^[1-9]\d{0,8}$/.test(String(id))))return res.status(400).json({error:'Invalid assignment filter.'});
 const params=[req.tenantId],conditions=[];
 if(status){params.push(status);conditions.push('display_status=$'+params.length);if(status==='needs_sources')conditions.push('spawned_article_id IS NULL');}
 if(id){params.push(Number(id));conditions.push('id=$'+params.length);}
 const base="SELECT p.*,w.name AS writer_name,CASE WHEN a.id IS NOT NULL THEN CASE WHEN a.is_archived=1 THEN 'archived' WHEN a.is_published=1 THEN 'published' WHEN a.status IN ('draft','review','scheduled','rejected') THEN a.status ELSE 'draft' END WHEN p.spawned_article_id IS NOT NULL THEN 'draft_unavailable' ELSE p.status END AS display_status FROM article_pitches p LEFT JOIN writers w ON w.id=p.pitched_by_writer_id AND w.tenant_id=p.tenant_id LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.is_editor_assignment=true";
 const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
 const total=await db.getPool().query('SELECT count(*)::int AS total FROM ('+base+') assignments'+where,params);
 const rows=await db.getPool().query('SELECT * FROM ('+base+') assignments'+where+' ORDER BY created_at DESC,id DESC LIMIT $'+(params.length+1)+' OFFSET $'+(params.length+2),[...params,limit,offset]);
 res.setHeader('Cache-Control','no-store');res.json({assignments:await sourceRules.decorate(rows.rows,req.tenantId),total:total.rows[0].total,limit,offset});
}));
router.get('/:id/source-options',requirePermission('articles.read'),handle(async(req,res)=>res.json(await sourceRules.options(Number(req.params.id),req.tenantId,req.query))));
const mutation=action=>handle(async(req,res)=>{const row=await sourceRules.mutate(Number(req.params.id),req.tenantId,action,action==='remove'?{sourceId:Number(req.params.sourceId)}:req.body||{});res.json((await sourceRules.decorate([row],req.tenantId))[0]);});
router.post('/:id/sources',requirePermission('articles.update'),mutation('add'));
router.delete('/:id/sources/:sourceId',requirePermission('articles.update'),mutation('remove'));
router.put('/:id/writer',requirePermission('articles.update'),mutation('writer'));
router.get('/:id',requirePermission('articles.read'),handle(async(req,res)=>{
 const row=await db.prepare('SELECT p.*,a.status AS article_status,a.is_published AS article_published FROM article_pitches p LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.is_editor_assignment=true').get(req.params.id,req.tenantId);
 if(!row)return res.status(404).json({error:'Assignment not found.'});
 res.setHeader('Cache-Control','no-store');res.json((await sourceRules.decorate([row],req.tenantId))[0]);
}));
router.post('/',requirePermission('articles.update'),handle(async(req,res)=>res.status(201).json(await assignments.create(req.body,req.tenantId,req.user?.sub||null))));
router.put('/:id/sources',requirePermission('articles.update'),handle(async(req,res)=>res.json(await assignments.attach(Number(req.params.id),req.tenantId,req.body.source_article_ids,Number(req.body.writer_id)||null))));
router.post('/:id/approve',requirePermission('articles.update'),handle(async(req,res)=>res.json(await assignments.approve(Number(req.params.id),req.tenantId,req.user?.sub||null,req.body||{}))));
router.post('/:id/generate',requirePermission('articles.create'),handle(async(req,res)=>{const task=await assignments.start(Number(req.params.id),req.tenantId,req.body);setImmediate(()=>task.run().catch(()=>{}));res.status(202).json({status:task.status})}));
module.exports=router;
