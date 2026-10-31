'use strict';
const router=require('express').Router(),service=require('../lib/newsroom-workflow');
const {auth}=require('../middleware/auth'),{requirePermission}=require('../middleware/permissions');
router.use(auth);router.use(requirePermission('articles.read'));router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const handle=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Workflow could not be loaded. Reload its current state before retrying.'});}};
router.get('/',handle(req=>service.list(req.tenantId,req.user,req.query)));
router.get('/:kind/:id',handle(req=>service.detail(req.params.kind,req.params.id,req.tenantId,req.user)));
router.post('/:kind/:id/commission',requirePermission('articles.update'),handle(async req=>{if(!await require('../lib/feature-registry').isFeatureEnabled(req.tenantId,'article_pitches'))throw Object.assign(Error('Commissions are not enabled.'),{status:404});return service.commission(req.params.kind,req.params.id,req.tenantId,req.user,req.body||{});}));
module.exports=router;
