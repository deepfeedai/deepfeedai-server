'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const createPage=require('../public/sources-page');
const html=fs.readFileSync(path.join(__dirname,'../public/sources.html'),'utf8');
function fixture(handler=async()=>({items:[],total:0,folders:[],categories:[]})){
 const elements=new Map();let doc;
 class Element{
  constructor(id,tag,attrs){this.id=id;this.tagName=tag.toUpperCase();this.value='';this.textContent='';this.innerHTML='';this.hidden=/\bhidden\b/.test(attrs);this.disabled=/\bdisabled\b/.test(attrs);this.checked=false;this.open=false;this.dataset={};this.handlers={};this.attrs={};}
  addEventListener(name,fn){this.handlers[name]=fn;}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}
  showModal(){this.open=true;doc.activeElement=this;}close(){this.open=false;}focus(){doc.activeElement=this;}
  closest(selector){return selector==='dialog'?this.dialog:null;}
  querySelectorAll(){return [...elements.values()].filter(e=>e.dialog===this&&['BUTTON','INPUT','SELECT','TEXTAREA'].includes(e.tagName));}
 }
 for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g))elements.set(match[3],new Element(match[3],match[1],match[2]));
 for(const match of html.matchAll(/<dialog\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)){const dialog=elements.get(match[1]);for(const id of match[2].matchAll(/id="([^"]+)"/g))elements.get(id[1]).dialog=dialog;}
 doc={getElementById:id=>{if(!elements.has(id))throw Error('Missing element '+id);return elements.get(id);},querySelectorAll:selector=>selector==='.sources-dialog'?[...elements.values()].filter(e=>e.tagName==='DIALOG'):[],activeElement:null};
 elements.get('sourcesStatus').value='current';elements.get('sourcesBulkAction').value='pause';elements.get('sourcesImportFormat').value='urls';elements.get('sourcesExportScope').value='current';elements.get('sourcesExportFormat').value='opml';
 const calls=[],downloads=[];const api=async(url,options)=>{const body=options?.body?JSON.parse(options.body):null;calls.push({url,body,method:options?.method});return handler(url,body,options);};
 const app=createPage(doc,api,{download:(...args)=>downloads.push(args),suggestions:{'ai-tech':[{name:'Example',url:'https://example.invalid/feed'}]}});
 return{app,el:id=>elements.get(id),calls,downloads,doc};
}
const list={items:[{id:1,name:'<script>alert(1)</script>',url:'https://alice:secret@example.invalid/private/path-token/feed?token=private-token#fragment',is_active:1,priority:2,auto_publish_max:50,folder_path:'Tech',default_category:'Research'},{id:2,name:'Second',url:'https://second.invalid/feed',is_active:0}],total:70,folders:['Tech'],categories:['Research']};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
test('Sources pagination and explicit page/all-matching selection never render private URL components',async()=>{
 const f=fixture(async()=>list);await f.app.load();
 assert.match(f.calls[0].url,/paged=1&page=1&limit=25/);assert.equal(f.app.state.items.length,2);
 assert.match(f.el('sourcesBody').innerHTML,/&lt;script&gt;/);assert.ok(!f.el('sourcesBody').innerHTML.includes('private-token'));assert.ok(!f.el('sourcesBody').innerHTML.includes('alice:secret'));assert.ok(!f.el('sourcesBody').innerHTML.includes('path-token'));
 f.app.selectPage(true);assert.deepEqual(f.app.selection(),{mode:'ids',ids:[1,2]});
 f.app.selectMatching();assert.equal(f.app.selection().mode,'all_matching');assert.equal(f.app.selection().filters.status,'current');assert.match(f.el('sourcesSelectionText').textContent,/70 matching/);
 f.el('sourcesSearch').value='Research';await f.app.filterChanged();assert.deepEqual(f.app.selection(),{mode:'ids',ids:[]});assert.match(f.calls.at(-1).url,/q=Research/);
 f.app.selectPage(true);await f.app.movePage(1);assert.equal(f.app.state.page,2);assert.equal(f.app.selection().ids.length,0);
});
test('Sources ignore stale list responses and recover a failed page without retaining actionable stale selection',async()=>{
 const slow=deferred();let request=0;const f=fixture(async()=>++request===1?slow.promise:{...list,items:[list.items[1]],total:1});
 const first=f.app.load();f.app.state.filters.q='new';await f.app.load();slow.resolve(list);await first;assert.equal(f.app.state.items.length,1);assert.equal(f.app.state.items[0].id,2);
 const broken=fixture(async()=>{throw Error('Failed https://private.invalid/feed?token=private-token');});await broken.app.load();assert.equal(broken.el('sourcesRetry').hidden,false);assert.equal(broken.el('sourcesSelectPage').disabled,true);assert.ok(!broken.el('sourcesNotice').textContent.includes('private-token'));
});
test('Import preview is duplicate-safe, escaped, cancellable after completion, and invalidated by edits',async()=>{
 const pending=deferred();const f=fixture(async()=>pending.promise);f.app.open('sourcesImportDialog');f.el('sourcesImportContent').value='https://example.invalid/feed';
 const preview=f.app.previewImport();await f.app.previewImport();assert.equal(f.calls.length,1);assert.equal(f.app.close('sourcesImportDialog'),false);
 pending.resolve({items:[{index:0,name:'<img onerror=bad>',display_url:'https://example.invalid/feed?token=private-token',status:'ready'},{index:1,status:'duplicate'},{index:2,status:'invalid',error:'Invalid https://x.invalid/?key=private-token'}]});await preview;
 assert.equal(f.el('sourcesCommitImport').disabled,false);assert.match(f.el('sourcesImportResults').innerHTML,/&lt;img/);assert.ok(!f.el('sourcesImportResults').innerHTML.includes('private-token'));
 f.el('sourcesImportContent').value+='\nhttps://other.invalid';f.app.invalidateImport();assert.equal(f.el('sourcesCommitImport').disabled,true);assert.equal(f.app.state.preview,null);
 assert.equal(f.app.close('sourcesImportDialog'),true);assert.equal(f.el('sourcesImportContent').value,'');
});
test('Partial import reports each failed item and prevents repeated commits; uncertain failures require a fresh preview',async()=>{
 const pending=deferred();let imports=0;const f=fixture(async(url)=>url.includes('import-preview')?{items:[{index:0,name:'Good',status:'ready'},{index:1,name:'Bad',status:'invalid'}]}:url==='/sources/import'?(imports++,pending.promise):list);
 f.app.open('sourcesImportDialog');f.el('sourcesImportContent').value='https://good.invalid/feed\nbad';await f.app.previewImport();
 const one=f.app.commitImport();await f.app.commitImport();assert.equal(imports,1);
 pending.resolve({added:1,skipped:0,results:[{index:0,status:'added',id:5},{index:1,status:'invalid'}],errors:[{index:1,error:'Invalid address'}]});await one;
 assert.match(f.el('sourcesImportMessage').textContent,/1 added · 0 skipped · 1 failed/);assert.match(f.el('sourcesImportResults').innerHTML,/Invalid address/);assert.equal(f.el('sourcesCommitImport').disabled,true);
 const uncertain=fixture(async(url)=>url.includes('preview')?{items:[{index:0,status:'ready'}]}:Promise.reject(Error('Network lost')));uncertain.el('sourcesImportContent').value='https://a.invalid';await uncertain.app.previewImport();await uncertain.app.commitImport();assert.match(uncertain.el('sourcesImportMessage').textContent,/Preview again before retrying/);assert.equal(uncertain.app.state.importSnapshot,null);
});
test('Removal cancel does nothing; clear-all requires exact phrase and export acknowledgement and suppresses repeated submission',async()=>{
 const pending=deferred();const f=fixture(async(url)=>url==='/sources/clear'?pending.promise:list);
 f.app.openRemoval(false,{mode:'ids',ids:[1]});f.app.close('sourcesRemoveDialog');assert.equal(f.calls.length,0);
 f.app.openRemoval(true);await f.app.confirmRemoval();assert.equal(f.calls.length,0);
 f.el('sourcesClearPhrase').value='CLEAR ALL SOURCES';f.app.updateRemoveButton();assert.equal(f.el('sourcesConfirmRemove').disabled,true);
 f.el('sourcesExportAcknowledged').checked=true;f.app.updateRemoveButton();const run=f.app.confirmRemoval();await f.app.confirmRemoval();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{confirmation:'CLEAR ALL SOURCES',exportAcknowledged:true});
 assert.equal(f.app.close('sourcesRemoveDialog'),false);pending.resolve({updated:70});await run;assert.equal(f.el('sourcesRemoveDialog').open,false);assert.match(f.el('sourcesNotice').textContent,/articles are preserved/);
});
test('Bulk scope is preserved and restore explicitly leaves subscriptions paused',async()=>{
 const f=fixture(async(url)=>url==='/sources/bulk'?{updated:2}:list);await f.app.load();f.app.selectMatching();f.el('sourcesBulkAction').value='folder';f.el('sourcesBulkValue').value='Research / Papers';await f.app.applyBulk();
 const bulk=f.calls.find(c=>c.url==='/sources/bulk');assert.equal(bulk.body.selection.mode,'all_matching');assert.equal(bulk.body.value,'Research / Papers');
 await f.app.applyBulk('restore',{mode:'ids',ids:[1]});assert.match(f.el('sourcesNotice').textContent,/restored as paused/);
});
test('Editing retains fields on failure and never replaces original URL with a masked value',async()=>{
 let sent;const f=fixture(async(url,body)=>{if(url==='/sources/1'){sent=body;throw Error('Save unavailable');}return list;});await f.app.load();f.app.editSource(1);
 assert.equal(f.el('sourcesEditUrl').value,'');assert.ok(!f.el('sourcesEditCurrentUrl').textContent.includes('private-token'));
 f.el('sourcesEditName').value='Edited name';await f.app.saveEdit();assert.equal(Object.hasOwn(sent,'url'),false);assert.equal(sent.name,'Edited name');assert.equal(f.el('sourcesEditDialog').open,true);assert.equal(f.el('sourcesEditName').value,'Edited name');assert.equal(f.el('sourcesSaveEdit').disabled,false);
});
test('Export uses explicit scope, downloads original selected configuration, and warns about private tokens',async()=>{
 const f=fixture(async()=>({content:'<opml>token=private-token</opml>',mime:'text/x-opml',filename:'sources.opml'}));
 assert.match(html,/Exports contain complete feed URLs, including any private tokens/);
 assert.equal(await f.app.exportSources('opml',{mode:'ids',ids:[]}),false);assert.equal(f.calls.length,0);
 await f.app.exportSources('opml',{mode:'ids',ids:[2]});assert.equal(f.calls[0].body.selection.ids[0],2);assert.equal(f.downloads[0][0],'<opml>token=private-token</opml>');assert.ok(!f.el('sourcesExportMessage').textContent.includes('private-token'));
 f.el('sourcesExportScope').value='matching';f.app.state.filters.folder='Research';assert.equal(f.app.exportSelection().filters.folder,'Research');
 f.el('sourcesExportScope').value='current';assert.deepEqual(f.app.exportSelection(),{mode:'all_matching',filters:{status:'current'}});
});
test('Late file reads cannot repopulate a cancelled import, and oversized files are rejected locally',async()=>{
 const f=fixture();const delayed=deferred();f.app.open('sourcesImportDialog');const read=f.app.importFile({size:20,name:'feeds.opml',text:()=>delayed.promise});f.app.close('sourcesImportDialog');delayed.resolve('<opml/>');await read;assert.equal(f.el('sourcesImportContent').value,'');
 f.app.open('sourcesImportDialog');await f.app.importFile({size:500001,name:'large.opml',text:()=>{throw Error('Must not read')}});assert.match(f.el('sourcesImportMessage').textContent,/smaller than 500 KB/);assert.equal(f.calls.length,0);
});
test('Repeated-entry report is read-only until explicit selection; partial collapse preserves originals and supports undo',async()=>{
 const report={dry_run:true,scanned:5000,truncated:true,groups:[{reason:'same_normalized_url',canonical_article_id:1,articles:[{id:1,title:'Primary',source:'A'},{id:2,title:'Repeat',source:'A'},{id:3,title:'Failed repeat',source:'A'}]}],links:[]};
 const f=fixture(async(url,body)=>{if(url==='/sources/duplicates')return report;if(url==='/sources/duplicates/link'&&body.article_id===3)throw Error('Relationship changed. Refresh.');return{};});
 await f.app.loadDuplicates();assert.equal(f.calls.length,1);assert.match(f.el('sourcesDuplicatesMessage').textContent,/not a full-library audit/);assert.match(f.el('sourcesDuplicatesResults').innerHTML,/Same normalized URL/);
 await f.app.collapseDuplicates(0,1,[]);assert.equal(f.calls.length,1);
 await f.app.collapseDuplicates(0,1,[1,2,3,999]);const links=f.calls.filter(call=>call.url.endsWith('/link'));assert.equal(links.length,2);assert.deepEqual(links.map(call=>call.body.article_id),[2,3]);assert.match(f.el('sourcesDuplicatesMessage').textContent,/1 repeat\(s\) collapsed; 1 failed/);
 await f.app.undoDuplicate(2);assert.deepEqual(f.calls.find(call=>call.url.endsWith('/unlink')).body,{article_id:2});assert.match(f.el('sourcesDuplicatesMessage').textContent,/No article content changed/);
 assert.ok(f.calls.every(call=>call.method!=='DELETE'));
});
test('Dialog Escape cancellation clears private input and restores keyboard focus without a request',async()=>{
 const f=fixture(async(url)=>url==='/categories'?[]:list);await f.app.init();f.el('sourcesAdd').focus();f.app.open('sourcesImportDialog');f.el('sourcesImportContent').value='https://private.invalid/path-token/feed';
 let prevented=false;f.el('sourcesImportDialog').handlers.cancel({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(f.el('sourcesImportDialog').open,false);assert.equal(f.el('sourcesImportContent').value,'');assert.equal(f.doc.activeElement.id,'sourcesAdd');assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});
test('Narrow Sources layout explicitly restores identity/folder columns hidden by legacy admin rules',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../public/sources.css'),'utf8');
 const mobile=css.slice(css.indexOf('/* Sources now has a different column order'));
 assert.match(mobile,/@media \(max-width:768px\)/);
 assert.match(mobile,/\.sources-workspace table\.sources-table\{[^}]*min-width:0/);
 assert.match(mobile,/\.sources-workspace table\.sources-table td\{display:block/);
 assert.match(mobile,/td:nth-child\(2\)\{grid-column:2 \/ -1;grid-row:1/);
 assert.match(mobile,/td:nth-child\(3\)\{grid-column:2 \/ -1;grid-row:2/);
 assert.match(mobile,/td:nth-child\(1\)\{grid-column:1/);
 assert.match(mobile,/td:nth-child\(6\)\{grid-column:2 \/ -1;grid-row:4/);
 assert.match(mobile,/\.sources-row-actions\{justify-content:flex-start;flex-wrap:wrap/);
});

test('Mobile Sources hides only the redundant Reader shortcut, retaining navigation controls',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/sources.html'),'utf8');
 const css=fs.readFileSync(path.join(__dirname,'../public/sources.css'),'utf8');
 assert.match(html,/<a class="btn btn-ghost btn-sm sources-reader-shortcut" href="\/feed-inbox.html"/);
 assert.match(html,/<button class="hamburger" id="hamburger" aria-label="Open navigation"/);
 assert.match(css,/@media \(max-width:768px\) \{\s*\.topbar \.sources-reader-shortcut\{display:none\}/);
});
