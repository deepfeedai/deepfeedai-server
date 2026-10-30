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
