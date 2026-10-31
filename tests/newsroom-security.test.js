'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('workflow DTO text remains literal and UI never treats it as HTML',()=>{
 const {project}=require('../lib/newsroom-workflow');
 const hostile='<SCRIPT>alert(1)</SCRIPT><img src=x onerror=alert(2)>';
 assert.equal(project('source',{id:1,title:hostile},{user:{permissions:['articles.read']}}).title,hostile);
 const controller=fs.readFileSync(path.join(__dirname,'../public/newsroom-workflow-page.js'),'utf8');
 assert.doesNotMatch(controller,/innerHTML|outerHTML|insertAdjacentHTML/);
 assert.match(controller,/textContent/);
});
test('production newsroom mutation mounts use the existing bounded admin limiter',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 for(const route of ['editor-assignments','pitches','newsroom-workflow','admin/pitches'])assert.ok(source.includes("app.use('/api/"+route+"', adminWriteLimiter,"),route);
 const code=source.match(/const adminWriteLimiter = rateLimit\(\{[\s\S]*?\n\}\);/)[0];
 const limiter=vm.runInNewContext(code+'\nadminWriteLimiter',{rateLimit:require('express-rate-limit'),rateLimitHandler:()=> (_req,res)=>res.status(429).json({error:'Slow down'})});
 const app=require('express')();app.use(limiter);app.all('/test',(_req,res)=>res.json({ok:true}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{const url='http://127.0.0.1:'+server.address().port+'/test';
  for(let i=0;i<60;i++)assert.equal((await fetch(url,{method:'POST'})).status,200);
  assert.equal((await fetch(url,{method:'POST'})).status,429);
  assert.equal((await fetch(url)).status,200,'Reading/recovery is not blocked by write quota');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
