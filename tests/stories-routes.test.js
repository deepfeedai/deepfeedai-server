'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
test('Stories routes enforce editorial permission and public summary reads never call AI',async()=>{
 const saved=new Map();function stub(name,exports){const p=require.resolve('../'+name);saved.set(p,require.cache[p]);require.cache[p]={id:p,filename:p,loaded:true,exports};}
 let permission='articles.read',authenticated=false,starts=0,summary='Saved public summary';
 stub('middleware/auth',{auth:(req,res,next)=>{if(!authenticated)return res.sendStatus(401);req.user={sub:1,permissions:[permission]};next();}});
 stub('lib/story-timelines',{getStory:async()=>({id:1,summary,updated_at:'2026-01-01'}),listStories:async()=>({stories:[],totalCount:0})});
 stub('lib/story-ai',{start:async()=>{starts++;return {job:{state:'running'},run:async()=>{}};}});
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.tenantId=1;next();});
 for(const [path,route]of [['/admin','admin-stories'],['/news','stories']]){const p=require.resolve('../routes/'+route);saved.set(p,require.cache[p]);delete require.cache[p];app.use(path,require(p));}
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(url+'/admin/1/regenerate',{method:'POST'})).status,401);
  authenticated=true;assert.equal((await fetch(url+'/admin/1/regenerate',{method:'POST'})).status,403);assert.equal(starts,0);
  const read=await fetch(url+'/news/stories/example/summarize');assert.equal(read.status,200);assert.equal((await read.json()).brief,summary);assert.equal(starts,0);
  summary=null;assert.equal((await fetch(url+'/news/stories/example/summarize')).status,404);assert.equal(starts,0);
  permission='articles.update';assert.equal((await fetch(url+'/admin/1/regenerate',{method:'POST'})).status,202);assert.equal(starts,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));for(const[p,v]of saved){if(v)require.cache[p]=v;else delete require.cache[p];}}
});
