const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
test('assignment UI separates approval and paid generation, suppresses repeated clicks, preserves edits and reports failures',async()=>{
 let handler,confirmPaid=false,pending,fail=false,posts=0,alert,open=false;
 const record={id:7,topic:'<script>unsafe</script>',angle_summary:'Angle',status:'approved',attached_article_ids:[2],source_article_id:1};
 const host={innerHTML:'',querySelector:()=>open?{}:null,offsetParent:{}};
 const card={dataset:{assignment:'7'},querySelector:()=>null};
 const btn={dataset:{assignmentAction:'generate'},closest:()=>card};
 const context={document:{getElementById:()=>host,addEventListener:(event,fn)=>handler=fn},window:{},setInterval:()=>{},confirm:()=>confirmPaid,showAlert:m=>alert=m,apiFetch:async(url,opts)=>{
  if(opts){posts++;await new Promise(r=>pending=r);if(fail)throw Error('Safe failure');record.status='drafting';return {status:'drafting'}}
  if(url==='/editor-assignments')return {assignments:[record]};if(url.startsWith('/articles'))return {articles:[]};return [];
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/editor-assignments'),'utf8'),context);await tick();
 assert.ok(host.innerHTML.includes('&lt;script&gt;'));assert.ok(host.innerHTML.includes('Generate draft (paid)'));
 const event={target:{closest:()=>btn}};await handler(event);assert.equal(posts,0);
 confirmPaid=true;const first=handler(event);await tick();await handler(event);assert.equal(posts,1);assert.equal(btn.disabled,true);pending();await first;assert.equal(btn.disabled,false);assert.ok(host.innerHTML.includes('Drafting.'));
 open=true;const before=host.innerHTML;record.status='failed';await context.window.loadEditorAssignments();assert.equal(host.innerHTML,before);open=false;await context.window.loadEditorAssignments();
 fail=true;const retry=handler(event);await tick();pending();await retry;assert.equal(alert,'Safe failure');assert.equal(btn.disabled,false);
});
test('chat save cards use stable keys, validate missing angles and explicit no-generation labels',()=>{
 const src=fs.readFileSync(require.resolve('../public/newsroom-chat-page'),'utf8');
 assert.ok(src.includes('proposal.request_key=proposal.request_key||crypto.randomUUID()'));
 assert.ok(src.includes('card.dataset.requestKey||(card.dataset.requestKey=crypto.randomUUID())'));
 assert.ok(src.includes('card.dataset.pending'));
 assert.ok(src.includes('Save assignment (no generation)'));
 assert.ok(src.includes("String(action.payload?.angle_summary||'').trim()"));
});

function assignmentFixture({permissions=['articles.read','articles.update','articles.create','writers.read'],handler}={}){
 let listener,open=false,picker,notice;const calls=[];
 const record={id:9,topic:'Research',angle_summary:'Angle',status:'proposed',pitched_by_writer_id:3,writer_name:'Writer',attached_sources:[{id:11,title:'<img onerror=alert(1)>',publisher:'Publisher',created_at:'2026-10-30',url:'javascript:alert(1)',eligible:true},{id:12,title:'Missing',unavailable:true}],requirements:{minimum:2,maximum:20}};
 const details={get open(){return open},set open(v){open=v}},select={value:'3'};
 const host={innerHTML:'',querySelector:()=>open?details:null,offsetParent:{}};
 const controls=[select,{disabled:false},{disabled:true}],attrs={};
 const card={dataset:{assignment:'9'},querySelector:s=>s==='details'?details:s==='.assignment-writer'?select:null,querySelectorAll:()=>controls,setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k]};
 const context={URL,document:{getElementById:()=>host,addEventListener:(event,fn)=>listener=fn},window:{CommissionSourcePicker:{open:opts=>{picker=opts}}},setInterval:()=>{},confirm:()=>true,hasPermission:p=>permissions.includes(p),showAlert:m=>notice=m,apiFetch:async(url,opts)=>{calls.push({url,opts});if(handler){const custom=await handler(url,opts,record);if(custom!==undefined)return custom;}if(opts){if(url.endsWith('/writer'))record.pitched_by_writer_id=JSON.parse(opts.body).writer_id;if(opts.method==='DELETE')record.attached_sources=record.attached_sources.filter(s=>s.id!==Number(url.split('/').at(-1)));return record;}if(url==='/editor-assignments')return{assignments:[record]};if(url==='/admin/writers')return[{id:3,name:'Writer',role:'writer'},{id:4,name:'New writer',role:'writer'}];throw Error('Unexpected '+url);}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/editor-assignments'),'utf8'),context);
 function click(action,sourceId){const button={dataset:{assignmentAction:action,sourceId},textContent:action,disabled:false,closest:()=>card};controls.push(button);return listener({target:{closest:()=>button}});}
 return{context,host,record,calls,details,select,controls,attrs,click,picker:()=>picker,notice:()=>notice};
}
test('assignment cards show safe attached evidence and backend requirements without downloading the article catalog',async()=>{
 const f=assignmentFixture();await tick();assert.match(f.host.innerHTML,/Requires 2 supporting sources; maximum 20/);assert.match(f.host.innerHTML,/&lt;img/);assert.ok(!f.host.innerHTML.includes('href="javascript:'));assert.match(f.host.innerHTML,/no longer eligible/);assert.match(f.host.innerHTML,/Add sources/);assert.ok(!f.host.innerHTML.includes('multiple'));assert.ok(!f.calls.some(c=>c.url.startsWith('/articles')));
 const html=fs.readFileSync(require.resolve('../public/pitches.html'),'utf8');assert.ok(html.indexOf('/commission-source-picker.js')<html.indexOf('/editor-assignments.js'));assert.match(html,/commission-source-picker.css/);
});
test('writer edits are independent; source operations wait for save/cancel and cancel discards draft',async()=>{
 const f=assignmentFixture();await tick();f.details.open=true;f.select.value='4';await f.click('add-sources');assert.equal(f.picker(),undefined);assert.match(f.notice(),/Save or cancel/);await f.click('remove-source','11');assert.equal(f.calls.filter(c=>c.opts).length,0);
 await f.click('cancel');assert.equal(f.select.value,'3');assert.equal(f.details.open,false);assert.equal(f.calls.filter(c=>c.opts).length,0);
 f.details.open=true;f.select.value='4';await f.click('writer');const write=f.calls.find(c=>c.opts);assert.equal(write.url,'/editor-assignments/9/writer');assert.equal(write.opts.method,'PUT');assert.deepEqual(JSON.parse(write.opts.body),{writer_id:4});assert.equal(f.record.attached_sources.length,2);
});
test('picker addition refreshes current cards and explicit removal changes only the attached source',async()=>{
 const f=assignmentFixture();await tick();await f.click('add-sources');const picker=f.picker();assert.equal(picker.assignmentId,9);assert.equal(picker.api,f.context.apiFetch);assert.ok(picker.returnFocus);assert.equal(f.calls.filter(c=>c.opts).length,0);
 f.record.attached_sources.push({id:13,title:'New evidence',eligible:true,url:'https://publisher.example/article'});await picker.onAdded();assert.match(f.host.innerHTML,/New evidence/);assert.match(f.host.innerHTML,/noopener noreferrer/);
 await f.click('remove-source','13');const remove=f.calls.find(c=>c.opts?.method==='DELETE');assert.equal(remove.url,'/editor-assignments/9/sources/13');assert.ok(!f.host.innerHTML.includes('New evidence'));assert.equal(f.record.pitched_by_writer_id,3);
});
test('read-only roles see attached evidence but no source mutations; source editors need not read writers',async()=>{
 const read=assignmentFixture({permissions:['articles.read']});await tick();assert.match(read.host.innerHTML,/Publisher/);assert.ok(!read.host.innerHTML.includes('data-assignment-action="add-sources"'));await read.click('remove-source','11');assert.equal(read.calls.filter(c=>c.opts).length,0);assert.ok(!read.calls.some(c=>c.url==='/admin/writers'));
 const edit=assignmentFixture({permissions:['articles.read','articles.update']});await tick();assert.match(edit.host.innerHTML,/data-assignment-action="add-sources"/);assert.ok(!edit.host.innerHTML.includes('assignment-writer'));await edit.click('add-sources');assert.ok(edit.picker());
});
test('failed writer save preserves draft and busy guard prevents duplicate writes',async()=>{
 let release;const f=assignmentFixture({handler:async(url,opts)=>{if(opts){await new Promise(r=>release=r);throw Error('Writer update failed');}}});await tick();f.details.open=true;f.select.value='4';const first=f.click('writer');await tick();await f.click('writer');assert.equal(f.calls.filter(c=>c.opts).length,1);release();await first;assert.equal(f.select.value,'4');assert.equal(f.details.open,true);assert.equal(f.notice(),'Writer update failed');
});
test('assignment refresh ignores older responses and never overwrites an open writer draft',async()=>{
 let release,n=0;const f=assignmentFixture({handler:async(url,opts,record)=>{if(!opts&&url==='/editor-assignments'){n++;if(n===1)return new Promise(r=>release=r);return{assignments:[{...record,topic:'Latest topic'}]};}}});await tick();await f.context.window.loadEditorAssignments();assert.match(f.host.innerHTML,/Latest topic/);release({assignments:[{...f.record,topic:'Stale topic'}]});await tick();assert.ok(!f.host.innerHTML.includes('Stale topic'));f.details.open=true;f.select.value='4';const before=f.calls.length;await f.context.window.loadEditorAssignments();assert.equal(f.calls.length,before);assert.equal(f.select.value,'4');
});
test('consolidated assignment styling and busy state cover all controls and restore prior state after failure',async()=>{
 let release;const f=assignmentFixture({handler:async(url,opts)=>{if(opts){await new Promise(r=>release=r);throw Error('Safe failure');}}});await tick();
 assert.match(f.host.innerHTML,/review-card assignment-card/);assert.match(f.host.innerHTML,/assignment-fields/);assert.match(f.host.innerHTML,/assignment-actions assignment-workflow-actions/);assert.match(f.host.innerHTML,/btn-primary[^>]+data-assignment-action="writer"/);
 f.details.open=true;const saving=f.click('writer');await tick();assert.equal(f.attrs['aria-busy'],'true');assert.ok(f.controls.every(c=>c.disabled));assert.equal(f.controls.at(-1).textContent,'Saving...');release();await saving;
 assert.equal(f.attrs['aria-busy'],undefined);assert.equal(f.controls[0].disabled,false);assert.equal(f.controls[1].disabled,false);assert.equal(f.controls[2].disabled,true);assert.equal(f.controls.at(-1).textContent,'writer');assert.equal(f.details.open,true);
 const css=fs.readFileSync(require.resolve('../public/editor-assignments.css'),'utf8');assert.match(css,/assignment-actions/);assert.match(css,/max-width: 600px/);assert.ok(!css.includes('assignment-sources'));assert.match(fs.readFileSync(require.resolve('../public/pitches.html'),'utf8'),/editor-assignments.css/);
});
