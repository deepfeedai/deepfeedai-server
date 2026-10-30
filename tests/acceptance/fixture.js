'use strict';
// Test-only entry point. Never mount these controls in server.js.
const path=require('node:path');
async function startFixture({port=0,readerRoot=process.env.READER_ROOT}={}) {
 if(process.env.PUBLISHING_ACCEPTANCE!=='1'||process.env.AUTOMATION_ENABLED!=='false'||!String(process.env.DATABASE_URL).match(/\/publishing_acceptance(?:\?|$)/)) {
  throw Error('Publishing acceptance requires its explicitly named disposable database and disabled automation');
 }
 process.env.STORAGE_BACKEND='local';
 const db=require('../../db'),express=require('express'),jwt=require('jsonwebtoken');
 const cached=new Map();const stub=(name,exports)=>{const file=require.resolve('../../'+name);cached.set(file,require.cache[file]);require.cache[file]={id:file,filename:file,loaded:true,exports};};
 const state={calls:0,delay:0,fail:false,imageFail:true};
 const key='offline-acceptance-jwt-not-a-production-credential';
 stub('lib/secrets',{getSecrets:async()=>({jwtSecret:key,userJwtSecret:key,cronSecret:'offline-only'}),getJwtSecret:async()=>key});
 stub('lib/ai-router',{
  complete:async options=>{state.calls++;if(state.delay)await new Promise(r=>setTimeout(r,state.delay));if(state.fail)throw Error('Offline provider failure');
   if(options.operation==='scrape-summarize')return {text:'Offline verified source summary',usage:{}};
   if(options.operation!=='synthesis')throw Error('Unexpected AI operation: '+options.operation);
   return {text:'TITLE: Offline publishing acceptance '+state.calls+'\nEXCERPT: Verified test summary\nPULL_QUOTE: A tested publishing workflow\nTOPIC_TAG: offline-publishing\n'+Array(230).fill('Evidence-backed analysis [1][2].').join(' '),usage:{}};
  },generateImage:async()=>{throw Error('Offline image replacement failure');},generateVoice:async()=>{throw Error('Voice is outside this test');},purgeStaleEntries(){}
 });
 stub('lib/writer-memory',{getRelevantMemories:async()=>[],extractAndStoreMemories:async()=>{}});
 stub('lib/presence',{setPresence:async()=>{}});
 stub('lib/notifications',{notify:async()=>{}});
 await db.init();
 await db.prepare("INSERT INTO tenant_feature_overrides(tenant_id,feature_key,value,reason) VALUES(1,'article_pitches','true','Disposable acceptance fixture') ON CONFLICT(tenant_id,feature_key) DO UPDATE SET value='true'").run();
 const prefix='acceptance-'+Date.now();
 const user=await db.prepare("INSERT INTO users(username,password_hash,tenant_id,role,email,is_active) VALUES($1,'not-a-login-password',1,'owner',$2,1) RETURNING id").get(prefix,prefix+'@example.invalid');
 const token=jwt.sign({sub:user.id,tenantId:1,type:'platform-admin',role:'owner',email:prefix+'@example.invalid'},key,{expiresIn:'1h'});
 const viewerToken=jwt.sign({sub:user.id,tenantId:1,type:'platform-admin',role:'viewer',email:prefix+'@example.invalid'},key,{expiresIn:'1h'});
 const writer=await db.prepare("INSERT INTO writers(tenant_id,name,slug,role) VALUES(1,'Offline Writer',$1,'writer') RETURNING id").get(prefix);
 const sources=[];for(let i=0;i<2;i++)sources.push((await db.prepare("INSERT INTO articles(tenant_id,title,summary,full_content,content_type,category,source,source_url,is_published) VALUES(1,$1,'Verified evidence','Detailed source evidence','curated','Research','Offline source',$2,0) RETURNING id").get('Offline source '+i,'https://example.invalid/evidence-'+i)).id);
 const other=await db.prepare("INSERT INTO tenants(slug,display_name,plan,status) VALUES($1,'Other fixture','pro','active') RETURNING id").get(prefix+'-other');
 const foreign=await db.prepare("INSERT INTO articles(tenant_id,title,slug,summary,content_type,is_published) VALUES($1,'Foreign draft',$2,'Private fixture','original',0) RETURNING id").get(other.id,prefix+'-private');
 const app=express();app.use(express.json({limit:'2mb'}));app.use('/api',require('../../middleware/tenant').tenantContext);
 app.use('/api/reader/open',require('../../routes/reader-entry'));
 app.use('/api/newsroom-overview',require('../../routes/newsroom-overview'));
 app.use('/api/admin/pitches',require('../../routes/admin-pitches'));
 app.use('/api/reader',require('../../routes/reader'));
 app.use('/api/sources',require('../../routes/sources'));
 app.use('/api/feed-groups',require('../../routes/feed-groups'));
 app.use('/api/fetch',require('../../routes/fetch').router);
 app.use('/api/editor-assignments',require('../../routes/editor-assignments'));
 app.use('/api/articles',require('../../routes/articles'));
 app.use('/api/article',require('../../routes/article'));
 app.use('/api/news',require('../../routes/news'));app.use('/api/news',require('../../routes/stories'));
 app.use('/api/story-timelines',require('../../routes/admin-stories'));
 app.use('/api/media',require('../../routes/media'));
 app.use('/api/categories',require('../../routes/categories'));
 app.use('/api/admin/writers',require('../../middleware/auth').auth,require('../../routes/admin-writers'));
 app.use((err,req,res,next)=>{res.status(err.status||500).json({error:err.message});});
 app.get('/__fixture/login',(req,res)=>res.type('html').send('<script>localStorage.setItem("dfa_admin_url",location.origin);localStorage.setItem("dfa_site_url",location.origin);localStorage.setItem("deepfeedai_token",'+JSON.stringify(token)+');localStorage.setItem("deepfeedai_user",JSON.stringify({role:"owner",permissions:["*"]}));location.href="/pitches.html";</script>'));
 if(readerRoot){app.get('/article/:slug',(req,res)=>res.sendFile(path.join(readerRoot,'article.html')));app.get('/',(req,res)=>res.sendFile(path.join(readerRoot,'index.html')));app.use(express.static(readerRoot));}
 app.use(express.static(path.resolve(__dirname,'../../public')));
 const server=app.listen(port,'0.0.0.0');await new Promise(r=>server.once('listening',r));
 return {app,server,db,state,token,viewerToken,userId:user.id,otherTenantId:other.id,writerId:writer.id,sourceIds:sources,foreignId:foreign.id,foreignSlug:prefix+'-private',base:'http://127.0.0.1:'+server.address().port,
  close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));for(const[file,previous]of cached){if(previous)require.cache[file]=previous;else delete require.cache[file];}await db.getPool().end();}};
}
module.exports={startFixture};
if(require.main===module)startFixture({port:Number(process.env.PORT)||4180}).then(()=>console.log('Offline publishing fixture ready')).catch(error=>{console.error(error.message);process.exit(1);});
