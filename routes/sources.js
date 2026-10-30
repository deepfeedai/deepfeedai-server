'use strict';
const router=require('express').Router();
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const {auth}=require('../middleware/auth'),{requirePermission}=require('../middleware/permissions'),{asyncHandler}=require('../lib/utils');
const {logAudit}=require('../middleware/audit');
const service=require('../lib/source-management'),dedup=require('../lib/rss-ingest');
const {safeFetchText,fail}=require('../lib/rss-safe');
const parser=new(require('rss-parser'))();
const permission=name=>requirePermission('sources.'+name);
router.get('/',auth,permission('read'),asyncHandler(async(req,res)=>{
 const data=await service.list(req.tenantId,req.query);
 if(req.query.paged==='1')return res.json(data);
 const rows=await require('../db').getPool().query('SELECT * FROM sources WHERE tenant_id=$1 AND removed_at IS NULL ORDER BY priority,id',[req.tenantId]);res.json(rows.rows);
}));
router.post('/preview-feed',auth,permission('create'),asyncHandler(async(req,res)=>{
 try{const text=await safeFetchText(req.body?.url);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw fail('Feed entities are unsupported',422);const feed=await parser.parseString(text);res.json({title:String(feed.title||'').slice(0,300),description:String(feed.description||'').slice(0,1000),itemCount:feed.items?.length||0});}
 catch(e){res.status(e.status||422).json({error:e.status?e.message:'Could not parse RSS feed',statusHint:'invalid_or_unreachable'});}
}));
router.post('/import-preview',auth,permission('create'),asyncHandler(async(req,res)=>res.json(await service.importSources(req.tenantId,req.body,{preview:true}))));
router.post('/import',auth,permission('create'),asyncHandler(async(req,res)=>{const result=await service.importSources(req.tenantId,req.body);logAudit(req,'source.import','source',null,{added:result.added,skipped:result.skipped});res.json(result);}));
router.post('/bulk-add',auth,permission('create'),asyncHandler(async(req,res)=>res.json(await service.importSources(req.tenantId,{sources:req.body?.sources}))));
router.post('/import-opml',auth,permission('create'),asyncHandler(async(req,res)=>res.json(await service.importSources(req.tenantId,{format:'opml',content:req.body?.content}))));
router.post('/export',auth,permission('read'),asyncHandler(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await service.exportSelected(req.tenantId,req.body));}));
router.post('/bulk',auth,(req,res,next)=>permission(req.body?.action==='remove'?'delete':'update')(req,res,next),asyncHandler(async(req,res)=>{const result=await service.bulk(req.tenantId,req.body);logAudit(req,'source.bulk_'+result.action,'source',null,{count:result.updated});res.json(result);}));
router.post('/clear',auth,permission('delete'),asyncHandler(async(req,res)=>{
 if(req.body?.confirmation!=='CLEAR ALL SOURCES'||req.body?.exportAcknowledged!==true)throw fail('Type CLEAR ALL SOURCES and acknowledge the export offer');
 const result=await service.bulk(req.tenantId,{action:'remove',selection:{mode:'all_matching',filters:{status:'current'}},confirm:'REMOVE SELECTED'});logAudit(req,'source.clear','source',null,{count:result.updated});res.json({...result,message:'Subscriptions removed. Imported articles are preserved. Restore from Removed.'});
}));
router.get('/duplicates',auth,requirePermission('articles.read'),asyncHandler(async(req,res)=>res.json(await dedup.duplicates(req.tenantId))));
router.post('/duplicates/link',auth,requirePermission('articles.update'),asyncHandler(async(req,res)=>res.json(await dedup.linkDuplicate(req.tenantId,req.body,req.user?.sub))));
router.post('/duplicates/unlink',auth,requirePermission('articles.update'),asyncHandler(async(req,res)=>res.json(await dedup.unlinkDuplicate(req.tenantId,req.body?.article_id))));
router.post('/',auth,permission('create'),asyncHandler(async(req,res)=>{
 const result=await service.importSources(req.tenantId,{sources:[req.body]});const row=result.results[0];
 if(row.status==='invalid')throw fail(row.error);if(row.status!=='added')throw fail('Subscription already exists, possibly in Removed',409);
 const source=(await require('../db').getPool().query('SELECT * FROM sources WHERE tenant_id=$1 AND id=$2',[req.tenantId,row.id])).rows[0];logAudit(req,'source.create','source',row.id);res.status(201).json(source);
}));
router.put('/:id',auth,permission('update'),asyncHandler(async(req,res)=>{const source=await service.update(req.tenantId,Number(req.params.id),req.body);logAudit(req,'source.update','source',source.id);res.json(source);}));
router.post('/:id/restore',auth,permission('update'),asyncHandler(async(req,res)=>res.json(await service.bulk(req.tenantId,{action:'restore',selection:{mode:'ids',ids:[Number(req.params.id)]}}))));
router.delete('/:id',auth,permission('delete'),asyncHandler(async(req,res)=>{
 if(req.query.confirmed!=='true')return res.json({requires_confirmation:true,message:'Removal preserves imported articles and can be restored.'});
 res.json(await service.bulk(req.tenantId,{action:'remove',selection:{mode:'ids',ids:[Number(req.params.id)]},confirm:'REMOVE SELECTED'}));
}));
router.put('/:id/toggle',auth,permission('update'),asyncHandler(async(req,res)=>{
 if(typeof req.body?.is_active!=='boolean')throw fail('Specify is_active true or false; source state is not a toggle');
 res.json(await service.bulk(req.tenantId,{action:req.body.is_active?'resume':'pause',selection:{mode:'ids',ids:[Number(req.params.id)]}}));
}));
module.exports=router;
