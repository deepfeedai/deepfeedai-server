'use strict';
const router=require('express').Router(),service=require('../lib/newsroom-overview');
router.use(require('../middleware/auth').auth);
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const handle=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Overview could not be loaded. Please retry.'});}};
router.get('/',handle(req=>service.overview(req.tenantId,req.user)));
router.put('/onboarding',handle(req=>service.dismiss(req.tenantId,req.user,req.body)));
module.exports=router;
