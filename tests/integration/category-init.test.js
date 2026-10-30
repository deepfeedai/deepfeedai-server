const assert=require('node:assert/strict');
const db=require('../../db');
const {test}=require('node:test');
let server;
test('category initialization supplies stable writer generation IDs', {skip: !process.env.DATABASE_URL}, async()=>{
 try {

 await db.init();
 const legacy=JSON.parse((await db.prepare("SELECT value FROM settings WHERE tenant_id=1 AND key='site_categories'").get()).value);
 const cats=await db.prepare('SELECT id,name,color,keywords FROM categories WHERE tenant_id=1 ORDER BY sort_order,id').all();
 assert.equal(cats.length,legacy.length);assert.equal(cats.length,8);
 for(const c of cats){assert.ok(Number.isInteger(c.id));const old=legacy.find(o=>o.name===c.name);assert.equal(c.color,old.color||'#94a3b8');assert.deepEqual(c.keywords,old.keywords||[]);}
 await db.init();
 assert.deepEqual(await db.prepare('SELECT id,name,color,keywords FROM categories WHERE tenant_id=1 ORDER BY sort_order,id').all(),cats);
 console.log('PASS fresh initialization preserves all eight categories and repeated initialization is idempotent');
 let called=0;
 const routerPath=require.resolve('../../lib/ai-router');
 require.cache[routerPath]={id:routerPath,filename:routerPath,loaded:true,exports:{complete:async opts=>{called++;assert.equal(opts.operation,'generate-writer-personas');return {text:JSON.stringify(cats.map((c,i)=>({name:'Offline'+i,categoryName:c.name}))),usage:{}};}}};
 const express=require('express');const app=express();app.use(express.json());app.use((req,res,next)=>{req.tenantId=1;req.user={permissions:['*']};next();});app.use('/writers',require('../../routes/admin-writers'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const ids=JSON.parse(JSON.stringify(cats.map(c=>parseInt(String(c.id)))));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/writers/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({categoryIds:ids,uncoveredOnly:false})});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.generated.length,8);assert.equal(called,1);assert.deepEqual(result.generated.map(x=>x.categoryId),ids);
 console.log('PASS actual generation route selects eight valid IDs using a local AI stub; zero provider calls');
 } finally {
  if(server) await new Promise(r=>server.close(r));
  await db.getPool().end();
 }
});
