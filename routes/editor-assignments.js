const express=require('express'),router=express.Router(),db=require('../db');const {auth}=require('../middleware/auth'),{requirePermission}=require('../middleware/permissions');const assignments=require('../lib/editor-assignments');
router.use(auth);router.use(async(req,res,next)=>{if(!await require('../lib/feature-registry').isFeatureEnabled(req.tenantId,'article_pitches').catch(()=>false))return res.status(404).json({error:'Assignments are not enabled.'});next()});
const handle=fn=>async(req,res)=>{try{if(req.params.id&&!/^[1-9]\d{0,8}$/.test(req.params.id))return res.status(400).json({error:'Invalid assignment ID.'});await fn(req,res)}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Assignment operation failed. Please retry after checking its current state.'})}};
router.get('/',requirePermission('articles.read'),handle(async(req,res)=>{const rows=await db.prepare(`SELECT p.*,w.name AS writer_name,CASE WHEN a.id IS NOT NULL THEN CASE WHEN a.is_published=1 THEN 'published' WHEN a.status='scheduled' THEN 'scheduled' ELSE 'review' END ELSE p.status END AS display_status FROM article_pitches p LEFT JOIN writers w ON w.id=p.pitched_by_writer_id AND w.tenant_id=p.tenant_id LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.is_editor_assignment=true ORDER BY p.created_at DESC LIMIT 100`).all(req.tenantId);res.json({assignments:rows})}));
router.get('/:id',requirePermission('articles.read'),handle(async(req,res)=>{
 const row=await db.prepare('SELECT p.*,a.status AS article_status,a.is_published AS article_published FROM article_pitches p LEFT JOIN articles a ON a.id=p.spawned_article_id AND a.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.is_editor_assignment=true').get(req.params.id,req.tenantId);
 if(!row)return res.status(404).json({error:'Assignment not found.'});
 res.setHeader('Cache-Control','no-store');res.json(row);
}));
router.post('/',requirePermission('articles.update'),handle(async(req,res)=>res.status(201).json(await assignments.create(req.body,req.tenantId,req.user?.sub||null))));
router.put('/:id/sources',requirePermission('articles.update'),handle(async(req,res)=>res.json(await assignments.attach(Number(req.params.id),req.tenantId,req.body.source_article_ids,Number(req.body.writer_id)||null))));
router.post('/:id/approve',requirePermission('articles.update'),handle(async(req,res)=>res.json(await assignments.approve(Number(req.params.id),req.tenantId,req.user?.sub||null))));
router.post('/:id/generate',requirePermission('articles.create'),handle(async(req,res)=>{const task=await assignments.start(Number(req.params.id),req.tenantId,req.body);setImmediate(()=>task.run().catch(()=>{}));res.status(202).json({status:task.status})}));
module.exports=router;
