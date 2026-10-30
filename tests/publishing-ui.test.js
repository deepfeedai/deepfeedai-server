'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=file=>fs.readFileSync(require.resolve('../public/'+file),'utf8');
function functionSource(src,start,end){return src.slice(src.indexOf(start),src.indexOf(end,src.indexOf(start)));}
test('article editor publication: cancel, dirty edits, repeated clicks, failure recovery and explicit state',async()=>{
 const code=functionSource(source('block-editor.js'),'  async function handleTogglePublish()','  async function handleArchive()');
 const btn={disabled:false},checkbox={checked:false};let confirm=false,resolve,calls=0,body,alert;
 const c={articleId:1,articleData:{is_published:0,publication_revision:4},isDirty:false,confirm:()=>confirm,document:{getElementById:id=>id==='actionTogglePublish'?btn:checkbox},showAlert:m=>alert=m,syncPublishToggleLabel(){},updateStatus(){},apiFetch:async(url,opts)=>{calls++;body=JSON.parse(opts.body);return new Promise(r=>resolve=r)}};
 vm.createContext(c);vm.runInContext(code,c);
 await c.handleTogglePublish();assert.equal(calls,0);confirm=true;c.isDirty=true;await c.handleTogglePublish();assert.equal(calls,0);assert.match(alert,/Save your edits/);
 c.isDirty=false;const pending=c.handleTogglePublish();await Promise.resolve();await c.handleTogglePublish();assert.equal(calls,1);assert.deepEqual(body,{published:true,expected_revision:4});resolve({is_published:1,publication_revision:5});await pending;assert.equal(btn.disabled,false);assert.equal(checkbox.checked,true);
 c.apiFetch=async()=>{throw Error('Offline failure')};await c.handleTogglePublish();assert.equal(btn.disabled,false);assert.equal(c.articleData.is_published,1);assert.match(alert,/Offline failure/);
});
test('failed article save retains modal edits and uploaded image; success closes only after persistence',async()=>{
 const src=source('articles-page.js'),code=functionSource(src,'  async function saveArticle()','  async function confirmDelete()');
 const elements={editId:{value:'1',dataset:{revision:'3'}},fTitle:{value:'Correction'},fSummary:{value:''},fCategory:{value:'Research'},fAuthor:{value:''},fSource:{value:''},fSourceUrl:{value:''},fImageUrl:{value:'/media/new.png'},fFeatured:{value:'0'},fWriter:{value:'2'},saveArticleBtn:{disabled:false}};
 let closes=0,fail=true,payload;
 const c={document:{getElementById:id=>elements[id]},allArticles:[{id:1}],closeModal:()=>closes++,apiFetch:async(url,opts)=>{payload=JSON.parse(opts.body);if(fail)throw Error('conflict');return{id:1,publication_revision:4}},rerenderRow(){},showAlert(){}};
 vm.createContext(c);vm.runInContext(code,c);await c.saveArticle();assert.equal(closes,0);assert.equal(elements.fImageUrl.value,'/media/new.png');assert.equal(elements.saveArticleBtn.disabled,false);assert.equal(payload.expected_revision,3);assert.equal(payload.writer_id,2);assert.equal(payload.is_published,undefined);
 fail=false;await c.saveArticle();assert.equal(closes,1);
});
test('interrupted draft retry requires separate acknowledgement without changing deployed button module',async()=>{
 let accepted=false,calls=0,body;
 const c={onReady(){},confirm:()=>accepted,window:{apiFetch:async(url,opts)=>{if(!opts)return{draft_attempt:1};calls++;body=JSON.parse(opts.body);return{status:'drafting'}}}};
 vm.createContext(c);vm.runInContext(source('assignment-brief.js'),c);
 await assert.rejects(c.window.apiFetch('/editor-assignments/7/generate',{body:JSON.stringify({confirmPaid:true})}),/cancelled/);assert.equal(calls,0);
 accepted=true;await c.window.apiFetch('/editor-assignments/7/generate',{body:JSON.stringify({confirmPaid:true})});assert.equal(calls,1);assert.equal(body.retryAcknowledged,true);
});
