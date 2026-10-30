const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
test('assignment routes enforce permissions and approval never starts generation',async()=>{
 const saved=new Map();function stub(name,exports){const p=require.resolve('../'+name);saved.set(p,require.cache[p]);require.cache[p]={id:p,filename:p,loaded:true,exports}}
 let permission='articles.read',approved=0,generated=0;
 stub('middleware/auth',{auth:(req,res,next)=>{req.tenantId=1;req.user={sub:1,permissions:[permission]};next()}});
 stub('lib/feature-registry',{isFeatureEnabled:async()=>true});
 stub('lib/editor-assignments',{approve:async()=>{approved++;return {status:'approved'}},start:async()=>{generated++;return {status:'drafting',run:async()=>{}}}});
 const routePath=require.resolve('../routes/editor-assignments');saved.set(routePath,require.cache[routePath]);delete require.cache[routePath];
 const app=express();app.use(express.json());app.use('/assignments',require(routePath));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/assignments/1/approve',{method:'POST'})).status,403);
  permission='articles.update';assert.equal((await fetch(base+'/assignments/1/approve',{method:'POST'})).status,200);assert.equal(approved,1);assert.equal(generated,0);
  assert.equal((await fetch(base+'/assignments/1/generate',{method:'POST'})).status,403);
  permission='articles.create';assert.equal((await fetch(base+'/assignments/invalid/generate',{method:'POST'})).status,400);assert.equal(generated,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));for(const[p,v]of saved){if(v)require.cache[p]=v;else delete require.cache[p]}}
});
