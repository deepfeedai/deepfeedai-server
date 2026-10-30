'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createStore,safeUrl,plain}=require('../public/reader-model');
const source=fs.readFileSync(require.resolve('../public/feed-inbox-page.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
const facets={folders:[],sources:[],categories:[],counts:{all:61,unread:60,saved:1}};
test('Reader initializes the standard admin shell before loading its own panes and mobile navigation',async()=>{
 const calls=[],elements={};let ready,authorized=true;
 const c={onReady:fn=>ready=fn,requireAuth:()=>authorized,renderSidebar:()=>calls.push('sidebar'),store:null,apiFetch(){},render(){},allowed:()=>true,
  readerNav:{read:()=>({view:'saved',offset:'30',id:'7'}),restoreScroll:()=>calls.push('scroll')},readerNavReady:false,openArticle:async(id,markRead)=>calls.push(['open',id,markRead]),createStore(){assert.deepEqual(calls,['sidebar']);return{state:{filters:{},offset:0},load:async()=>calls.push('load')}},$:id=>elements[id]||(elements[id]=node()),document:{querySelectorAll:()=>[],addEventListener(){}},window:{},closeDialog(){},keyboard(){},folderDialog(){},manageFolder(){},moveDialog(){}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf(' function applyReaderNav('),source.indexOf(' let store,')),c);vm.runInContext(source.slice(source.indexOf(' onReady(async()=>{'),source.lastIndexOf('\n})();')),c);
 authorized=false;await ready();assert.deepEqual(calls,[]);authorized=true;await ready();assert.deepEqual(calls,['sidebar','load',['open',7,false],'scroll']);assert.equal(c.store.state.filters.view,'saved');assert.equal(c.store.state.offset,30);assert.equal(c.readerNavReady,true);
 const html=fs.readFileSync(require.resolve('../public/feed-inbox.html'),'utf8');assert.ok(html.indexOf('/admin-mobile-nav.js')>html.indexOf('/feed-inbox-page.js'),'Mobile enhancer must run after Reader creates the standard sidebar');
});
test('Reader queries server filters and page counts without loading the whole collection',async()=>{
 const calls=[];const store=createStore(async(url)=>{calls.push(url);return url.includes('/facets')?facets:{items:[{id:1}],total:61,hasMore:true};});
 await store.filter({q:'safety & evidence',view:'unread',source_id:'4',topic_tag:'same-event',date:'7d',sort:'oldest'});
 const url=new URL(calls[0],'https://test.invalid');assert.equal(url.searchParams.get('limit'),'30');assert.equal(url.searchParams.get('offset'),'0');assert.equal(url.searchParams.get('q'),'safety & evidence');assert.equal(url.searchParams.get('view'),'unread');assert.equal(url.searchParams.get('date'),'7d');assert.equal(url.searchParams.get('sort'),'oldest');assert.equal(url.searchParams.get('topic_tag'),'same-event');assert.equal(calls.length,2);
 await store.page(1);assert.match(calls[2],/offset=30/);assert.equal(store.state.total,61);
});
test('Reader ignores stale filter and detail responses',async()=>{
 const pending=[];const store=createStore(async url=>{if(url.endsWith('/facets'))return facets;const d=deferred();pending.push({url,...d});return d.promise;});
 const first=store.filter({q:'old'}),second=store.filter({q:'new'});pending[1].resolve({items:[{id:2}],total:1});await second;pending[0].resolve({items:[{id:1}],total:1});await first;assert.equal(store.state.items[0].id,2);
 const old=store.open(1),next=store.open(2);pending[3].resolve({id:2,title:'New'});await next;pending[2].resolve({id:1,title:'Old'});await old;assert.equal(store.state.detail.id,2);
});
test('page selection, all-matching selection and filter changes have explicit different scopes',async()=>{
 let payload;const store=createStore(async(url,opts)=>{if(opts){payload=JSON.parse(opts.body);return{updated:100};}return url.endsWith('/facets')?facets:{items:[{id:1},{id:2}],total:100,hasMore:true};});await store.load();store.selectPage(true);assert.deepEqual(store.selection(),{scope:'selected',ids:[1,2]});
 store.selectAll();await store.mutate({read:true});assert.equal(payload.scope,'all_matching');assert.equal(payload.confirmAllMatching,true);assert.equal(payload.filters.duplicates,'hide');assert.equal(payload.read,true);assert.equal(store.state.allMatching,false);
 store.selectAll();await store.filter({category:'Research'});assert.equal(store.state.allMatching,false);assert.equal(store.state.selected.size,0);
 store.selectAll();store.select(1,false);assert.deepEqual(store.selection(),{scope:'selected',ids:[2]});
});
test('single-item reading state preserves selected sources; duplicate submissions do not issue duplicate writes',async()=>{
 const request=deferred();let writes=0;const store=createStore(async(url,opts)=>{if(opts){writes++;return request.promise;}return url.endsWith('/facets')?facets:{items:[{id:1,read:false},{id:2,read:false}],total:2};});await store.load();store.select(2,true);await store.open(1);store.state.detail={id:1,read:false};
 const first=store.mutate({read:true},{scope:'selected',ids:[1]});assert.equal(await store.mutate({read:true},{scope:'selected',ids:[1]}),false);assert.equal(writes,1);request.resolve({updated:1});await first;assert.equal(store.state.detail.read,true);assert.deepEqual([...store.state.selected],[2]);assert.equal(store.state.busy,false);
});
test('failed state save preserves current state/selection and supports retry without provider calls',async()=>{
 let fail=true;const calls=[];const store=createStore(async(url,opts)=>{calls.push(url);if(opts){if(fail)throw Error('Offline');return{updated:1};}return url.endsWith('/facets')?facets:{items:[{id:1,saved:false}],total:1};});await store.load();store.state.detail={id:1,saved:false};store.select(1,true);assert.equal(await store.mutate({saved:true}),false);assert.equal(store.state.detail.saved,false);assert.equal(store.state.selected.size,1);assert.equal(store.state.busy,false);fail=false;assert.equal(await store.mutate({saved:true}),true);assert.equal(store.state.detail.saved,true);assert.ok(calls.every(x=>x.startsWith('/reader/')));assert.ok(!calls.some(x=>/enrich|generate|chat/.test(x)));
});
test('Reader URLs reject executable and protocol-relative inputs; hostile content stays plain text',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,hello','//evil.invalid/a','/\\evil.invalid/a','https://a.invalid/\nsecret'])assert.equal(safeUrl(url),'');
 assert.equal(safeUrl('/media/test.png'),'/media/test.png');assert.equal(safeUrl('https://publisher.example/story'),'https://publisher.example/story');assert.equal(plain('<script>alert(1)</script><p>Evidence</p>'),'Evidence');
});
function node(tag='div'){return {tag,children:[],events:{},style:{},classList:{toggle(){},remove(){},add(){}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},setAttribute(key,value){this[key]=value},addEventListener(name,fn){this.events[name]=fn},focus(){},remove(){},set innerHTML(value){throw Error('Untrusted HTML rendering is forbidden');}};}
test('actual reading-pane renderer uses text nodes for hostile feed content and safe source links',()=>{
 const elements={readerDetail:node()},ids=[];const context={hasPermission:()=>true,document:{createElement:node},$:id=>elements[id],safeUrl,plain,date:()=>'',store:{state:{detail:{id:4}}},closeArticle(){},openArticle(){},assignmentDialog:idsArg=>ids.push(idsArg),maxwellDialog(){},enrichDialog(){},separateGroup(){}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf(' const allowed='),source.indexOf(' const date=')),context);vm.runInContext(source.slice(source.indexOf(' function renderDetail('),source.indexOf(' function openDialog(')),context);
 context.renderDetail({id:4,title:'<img onerror=alert(1)>',source:'Publisher',summary:'<script>bad()</script>Safe excerpt',content_text:'<iframe>literal text</iframe>',image_url:'javascript:bad()',source_url:'javascript:bad()'});
 const walk=n=>[n,...(n.children||[]).flatMap(walk)];const nodes=walk(elements.readerDetail);assert.ok(nodes.some(n=>n.textContent==='<iframe>literal text</iframe>'));assert.ok(!nodes.some(n=>n.tag==='img'||n.tag==='a'));const use=nodes.find(n=>n.textContent==='Use as assignment source');use.events.click();assert.deepEqual(JSON.parse(JSON.stringify(ids)),[[4]]);
 context.renderDetail({id:4,title:'Linked source',duplicate_of:2,duplicate_available:false});const unavailable=walk(elements.readerDetail);assert.ok(unavailable.some(n=>String(n.textContent).includes('primary entry is unavailable')));assert.ok(!unavailable.some(n=>n.textContent==='Read primary entry'));assert.ok(unavailable.some(n=>n.textContent==='Keep as separate entry'));
});
test('actual dialog action prevents repeated submission and preserves inputs after failure',async()=>{
 const nodes={readerDialogClose:node(),readerDialogStatus:node()};const action=deferred();let calls=0;const c={$:id=>nodes[id],document:{createElement:node},dialogBusy:false,closeDialog(){}};vm.createContext(c);vm.runInContext(source.slice(source.indexOf(' const allowed='),source.indexOf(' const date=')),c);vm.runInContext(source.slice(source.indexOf(' function dialogActions('),source.indexOf(' function field(')),c);const parent=node();const submit=c.dialogActions(parent,'Save',()=>{calls++;return action.promise});const first=submit.events.click();await submit.events.click();assert.equal(calls,1);assert.equal(submit.disabled,true);action.reject(Error('Conflict. Your brief remains.'));await first;assert.equal(submit.disabled,false);assert.equal(c.dialogBusy,false);assert.match(nodes.readerDialogStatus.textContent,/Conflict/);assert.equal(parent.children.length,1);
});
test('keyboard navigation ignores form typing and supports read/save/back without paid operations',()=>{
 const nodes={readerDialog:{hidden:true},readerSearch:node()},actions=[];const c={$:id=>nodes[id],document:{activeElement:null},shell:()=>({classList:{remove(){}}}),store:{state:{items:[{id:1},{id:2}],detail:{id:1,saved:false,read:true}},mutate:patch=>actions.push(patch)},openArticle:id=>actions.push(id),closeArticle:()=>actions.push('back')};vm.createContext(c);vm.runInContext(source.slice(source.indexOf(' function keyboard('),source.indexOf('\n onReady(')),c);
 const event=(key,editing=false)=>({key,target:{matches:()=>editing},preventDefault(){}});c.keyboard(event('j'));c.keyboard(event('s'));c.keyboard(event('u',true));c.keyboard(event('Escape'));assert.deepEqual(JSON.parse(JSON.stringify(actions)),[2,{saved:true},'back']);
});
test('actual assignment dialog saves a stable non-AI brief and appends sources without replacing existing attachments',async()=>{
 const fields={},calls=[],elements={readerDialog:{hidden:false},readerDialogStatus:node(),readerNotice:node()};let action,fail=true;
 const c={document:{createElement:node},loadId:0,dialogBusy:false,crypto:{randomUUID:()=> 'stable-reader-request'},$:id=>elements[id],hasPermission:()=>true,openDialog:()=>node(),
  field(parent,label){const x=node();x.value='';x.reportValidity=()=>true;fields[label]=x;return x;},option(select,label,value){if(!select.value)select.value=String(value)},
  dialogActions(parent,label,fn){action=fn;return node()},closeDialog(){},notice(){},
  apiFetch:async(url,opts)=>{if(opts){calls.push({url,body:JSON.parse(opts.body)});if(fail)throw Error('Uncertain save');return{id:9};}if(url==='/categories')return[{name:'Research'}];if(url==='/admin/writers')return[{id:3,name:'Writer',role:'writer'}];return{assignments:[{id:9,topic:'Existing',status:'proposed'}]};}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf(' const allowed='),source.indexOf(' const date=')),c);vm.runInContext(source.slice(source.indexOf(' async function assignmentDialog('),source.indexOf(' function maxwellDialog(')),c);
 await c.assignmentDialog([1,2]);fields.Topic.value='Research topic';fields['Editorial angle'].value='Verified angle';fields.Category.value='Research';fields.Writer.value='3';
 await assert.rejects(action(),/Uncertain/);assert.equal(fields.Topic.value,'Research topic');fail=false;await action();assert.equal(calls[0].body.request_key,calls[1].body.request_key);assert.deepEqual(calls[1].body.source_article_ids,[1,2]);assert.equal(calls[1].url,'/editor-assignments');assert.equal(elements.readerNotice.children.at(-1).href,'/pitches.html?tab=commissions#editorAssignments');assert.equal(elements.readerNotice.children.at(-1).tag,'a');
 fields.Action.value='existing';fields.Assignment.value='9';await action();assert.equal(calls[2].url,'/reader/assignments/9/sources');assert.deepEqual(calls[2].body,{source_article_ids:[1,2]});assert.ok(!calls.some(x=>/generate|chat|enrich/.test(x.url)));
});
