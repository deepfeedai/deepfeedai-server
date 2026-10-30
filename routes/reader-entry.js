'use strict';
const router=require('express').Router();
// Platform links here without copying tokens between origins. The Reader applies
// its normal login and tenant permissions at the configured editorial origin.
router.get('/',async(req,res,next)=>{
 try{
  const config=await require('../lib/app-config').getAppConfig(req.tenantId);
  let target;
  try{
   const base=new URL(config.base_url);
   if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid origin');
   target=new URL('/feed-inbox.html',base).href;
  }catch{return res.status(503).type('text/plain').send('Editorial portal URL is not configured.');}
  res.setHeader('Cache-Control','no-store');res.redirect(302,target);
 }catch(error){next(error);}
});
module.exports=router;
