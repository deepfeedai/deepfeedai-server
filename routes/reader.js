'use strict';
const router=require('express').Router(),reader=require('../lib/reader');
const {auth}=require('../middleware/auth'),{requirePermission}=require('../middleware/permissions');
router.use(auth);router.use(requirePermission('articles.read'));
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const handle=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Reader operation failed. Refresh and try again.'});}};
router.get('/items',handle(async(req,res)=>res.json(await reader.list(req.tenantId,reader.principal(req.user),req.query))));
router.get('/facets',handle(async(req,res)=>res.json(await reader.facets(req.tenantId,reader.principal(req.user)))));
router.get('/items/:id',handle(async(req,res)=>res.json(await reader.detail(req.tenantId,reader.principal(req.user),Number(req.params.id)))));
router.put('/state',handle(async(req,res)=>res.json(await reader.state(req.tenantId,reader.principal(req.user),req.body))));
router.put('/move',requirePermission('articles.update'),handle(async(req,res)=>res.json(await reader.move(req.tenantId,reader.principal(req.user),req.body))));
router.put('/items/:id/group',requirePermission('articles.update'),handle(async(req,res)=>res.json(await reader.group(req.tenantId,Number(req.params.id),req.body))));
router.post('/assignments/:id/sources',requirePermission('articles.update'),handle(async(req,res)=>{
 if(!await require('../lib/feature-registry').isFeatureEnabled(req.tenantId,'article_pitches'))return res.status(404).json({error:'Assignments are not enabled.'});
 res.json(await reader.appendSources(req.tenantId,Number(req.params.id),req.body));
}));
router.post('/items/:id/enrich',requirePermission('articles.update'),handle(async(req,res)=>res.json(await reader.enrich(req.tenantId,reader.principal(req.user),Number(req.params.id),req.body))));
module.exports=router;
