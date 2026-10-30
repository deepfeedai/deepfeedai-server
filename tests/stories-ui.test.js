'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
test('Stories UI: cancel, repeated clicks, durable status, close/reopen and failures',async()=>{
 const elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,style:{},classList:{add(){},remove(){}},addEventListener(){},prepend(child){elements.set(child.id,child);}});return elements.get(id);};
 let paid=false,posts=0,resolvePost,interval,alert;
 const story={id:7,name:'Offline story',slug:'offline',status:'active',summary:'Summary',articles:[],intensity:[],aiJob:null};
 const context={window:{},document:{getElementById:el,createElement:()=>({setAttribute(){}})},onReady:()=>{},confirm:()=>paid,
  crypto:{randomUUID:()=> 'offline-stable-request-key'},setInterval:fn=>(interval=fn,1),clearInterval:()=>{interval=null;},setTimeout:()=>{},clearTimeout:()=>{},
  esc:s=>String(s).replaceAll('<','&lt;'),showAlert:m=>alert=m,
  apiFetch:async(url,opts)=>{if(opts?.method==='POST'){posts++;await new Promise(r=>resolvePost=r);story.aiJob={state:'running',message:'Generating'};return {job:story.aiJob};}
   if(url.includes('?'))return {stories:[],hasMore:false};return {story:{...story}};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/stories-page'),'utf8'),context);
 await context.window.openDrawer(7);await context.window.regenerateStory();assert.equal(posts,0);
 paid=true;const pending=context.window.regenerateStory();await tick();await context.window.regenerateStory();assert.equal(posts,1);assert.equal(el('regenBtn').disabled,true);
 resolvePost();await pending;await interval();assert.equal(el('storyAiStatus').textContent,'AI running: Generating');
 context.window.closeDrawer();assert.equal(interval,null);await context.window.openDrawer(7);assert.ok(interval);assert.equal(el('regenBtn').disabled,true);
 el('dSummary').value='Unsaved editor text';
 story.aiJob={state:'failed',message:'Provider unavailable'};await interval();assert.equal(el('regenBtn').disabled,false);assert.match(el('storyAiStatus').textContent,/failed/);
 paid=false;await context.window.regenerateStory();assert.equal(posts,1);assert.match(alert,/unsaved edits were kept/);assert.equal(el('dSummary').value,'Unsaved editor text');
});

test('Stories UI loads all pages without losing earlier results',async()=>{
 let boot,reads=0;const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',addEventListener(){}});return elements.get(id);};
 const context={window:{},document:{getElementById:el},onReady:fn=>boot=fn,requireAuth:()=>true,renderSidebar(){},
  apiFetch:async url=>{reads++;return {stories:[{id:reads,name:'Story '+reads,status:'active',createdAt:'2026-01-01'}],hasMore:reads===1};},esc:String};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/stories-page'),'utf8'),context);boot();await tick();await tick();
 assert.equal(reads,2);assert.match(el('sList').innerHTML,/Story 1/);assert.match(el('sList').innerHTML,/Story 2/);
});
