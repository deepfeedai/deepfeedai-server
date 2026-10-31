'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync('public/'+p,'utf8');

test('Reader saves selected evidence and links to the exact new or existing commission',async()=>{
 const code=read('feed-inbox-page.js'),start=code.indexOf("  const submit=dialogActions(body,'Save without generation'"),end=code.indexOf("  mode.addEventListener",start);
 for(const modeValue of ['new','existing']){
  let save;const links=[],calls=[];const field=value=>({value,reportValidity:()=>true});
  const c={body:{},mode:field(modeValue),topic:field('Topic'),angle:field('Angle'),category:field('Tools'),writer:field('3'),assignment:field('24'),ids:[7,8],key:'fixed-key',dialogBusy:true,
   dialogActions(_body,_label,fn){save=fn;return{};},apiFetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return{id:42};},notice(){},el:()=>({}),$:()=>({append:n=>links.push(n)}),closeDialog(){}};
  vm.createContext(c);vm.runInContext(code.slice(start,end),c);await save();
  assert.equal(calls.length,1);assert.deepEqual(Array.from(calls[0][1].source_article_ids),[7,8]);
  assert.equal(links[0].href,'/newsroom-workflow.html?kind=assignment&id='+(modeValue==='new'?42:24));
  assert.equal(calls.some(([url])=>/generate|approve|publish/.test(url)),false);
 }
});

test('Reader save failure preserves the dialog and offers no false success handoff',async()=>{
 const code=read('feed-inbox-page.js'),start=code.indexOf("  const submit=dialogActions(body,'Save without generation'"),end=code.indexOf('  mode.addEventListener',start);let save,closed=false,notified=false;
 const field=value=>({value,reportValidity:()=>true});const c={body:{},mode:field('existing'),assignment:field('24'),ids:[7],dialogBusy:true,dialogActions(_b,_l,fn){save=fn;return{};},apiFetch:async()=>{throw Error('Conflict');},notice(){notified=true;},closeDialog(){closed=true;}};
 vm.createContext(c);vm.runInContext(code.slice(start,end),c);await assert.rejects(save,/Conflict/);assert.equal(closed,false);assert.equal(notified,false);
});

test('source-to-brief query accepts only bounded safe integer IDs and preserves deduplicated order',()=>{
 const code=read('assignment-brief.js'),start=code.indexOf('  const rawSources='),end=code.indexOf('  if(sourceIds.length)',start);
 function parse(query){return vm.runInNewContext(code.slice(start,end)+'({sourceIds,sourceSelectionValid})',{URLSearchParams,location:{search:query}});}
 assert.deepEqual(Array.from(parse('?source_ids=7,8,7').sourceIds),[7,8]);assert.equal(parse('').sourceSelectionValid,true);
 for(const value of ['1,0','1,-2','1,x','9007199254740992','1%22onclick%3Dx',Array.from({length:21},(_,i)=>i+1).join(',')])assert.equal(parse('?source_ids='+value).sourceSelectionValid,false,value);
 assert.match(code,/source_article_ids:sourceIds/);assert.match(code,/!sourceSelectionValid\|\|!form.reportValidity/);
});

test('legacy pitch approval and retry navigation never promise or initiate paid drafting',async()=>{
 const code=read('pitches-page.js');assert.doesNotMatch(code,/Approve & Write|Re-queue synthesis|Synthesis re-queued/);
 let calls=0;const c={window:{},location:{},Number,apiFetch:()=>{calls++;}};vm.createContext(c);
 const start=code.indexOf('  window.retryCommissionSynthesis ='),end=code.indexOf('\n  };',start)+5;
 vm.runInContext(code.slice(start,end),c);await c.window.retryCommissionSynthesis(31);assert.equal(c.location.href,'/newsroom-workflow.html?kind=pitch&id=31');assert.equal(calls,0);
 c.location.href='';await c.window.retryCommissionSynthesis('javascript:alert(1)');assert.equal(c.location.href,'');
 for(const kind of ['story_pitch','pitch'])assert.match(code,new RegExp("workflowLink\\('"+kind+"',p.id\\)"));
 assert.match(read('editor-assignments.js'),/newsroom-workflow.html\?kind=assignment&id=/);
});

test('connected workflow deep link survives login without admitting external redirects or secrets',()=>{
 const {resolveNext}=require('../public/login-destination');
 assert.equal(resolveNext('/newsroom-workflow.html?kind=assignment&id=42','https://portal.example'),'/newsroom-workflow.html?kind=assignment&id=42');
 assert.equal(resolveNext('/newsroom-workflow.html?kind=assignment&id=42&token=secret','https://portal.example'),'/newsroom-workflow.html?kind=assignment&id=42');
 assert.equal(resolveNext('//evil.example/newsroom-workflow.html','https://portal.example'),'/overview.html');
});

test('article editor exposes its typed workflow link without bypassing unsaved-change navigation protection',()=>{
 const html=read('article-editor.html'),script=html.match(/<script>\s*(\/\/ Read \?return=[\s\S]*?)<\/script>/i)[1];
 const {resolveNext}=require('../public/login-destination');
 for(const [query,expected]of [['?id=42&return=%2Fnewsroom-workflow.html%3Fkind%3Dassignment%26id%3D7','/newsroom-workflow.html?kind=assignment&id=7'],['?id=42&return=https%3A%2F%2Fevil.example','/overview.html']]){
  let ready;const back={},workflow={hidden:true};const c={window:{LoginDestination:{resolveNext}},URLSearchParams,location:{search:query,origin:'https://portal.example'},document:{addEventListener(_event,fn){ready=fn;},getElementById:id=>id==='editorBackBtn'?back:workflow}};
  vm.createContext(c);vm.runInContext(script,c);ready();assert.equal(back.href,expected);assert.equal(workflow.href,'/newsroom-workflow.html?kind=article&id=42');assert.equal(workflow.hidden,false);
 }
 assert.match(read('block-editor.js'),/beforeunload/);assert.doesNotMatch(script,/preventDefault|isDirty\s*=/);
});
