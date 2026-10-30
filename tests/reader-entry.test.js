'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('Platform Reader entry uses configured portal, never forwarded identity or URL credentials',async()=>{
 const file=require.resolve('../lib/app-config'),previous=require.cache[file];
 let base='https://editor.example/private?token=do-not-copy';
 require.cache[file]={id:file,filename:file,loaded:true,exports:{getAppConfig:async()=>({base_url:base})}};
 const app=require('express')();app.use((req,res,next)=>{req.tenantId=1;next()});app.use('/open',require('../routes/reader-entry'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port+'/open';
 try{
  const r=await fetch(url,{redirect:'manual',headers:{'X-Forwarded-Host':'attacker.invalid'}});
  assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://editor.example/feed-inbox.html');assert.equal(r.headers.get('cache-control'),'no-store');
  for(const invalid of [null,'javascript:alert(1)','https://user:password@editor.example']){
   base=invalid;const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,503);assert.equal(response.headers.get('location'),null);
  }
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(previous)require.cache[file]=previous;else delete require.cache[file];}
});
