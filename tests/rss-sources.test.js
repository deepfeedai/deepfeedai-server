'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {normalizeUrl,displayUrl,isPublicAddress,safeFetchText}=require('../lib/rss-safe');
const {parseImport,normalizeSource,exportSources}=require('../lib/rss-format');
test('conservative identity strips tracking only when requested and keeps meaningful query values',()=>{
 assert.equal(normalizeUrl('HTTPS://Example.com:443/a?version=2&utm_source=r#x',{tracking:true}),'https://example.com/a?version=2');
 assert.notEqual(normalizeUrl('https://example.com/a?version=1',{tracking:true}),normalizeUrl('https://example.com/a?version=2',{tracking:true}));
 assert.notEqual(normalizeUrl('https://one.example/a'),normalizeUrl('https://two.example/a'));
 assert.equal(normalizeUrl('https://example.com/feed?token=private&utm_source=needed'),'https://example.com/feed?token=private&utm_source=needed');
 assert.ok(!displayUrl('https://example.com/feed?token=private').includes('private'));
 assert.ok(!displayUrl('https://example.com/private/secret-token/rss').includes('secret-token'));
 for(const u of ['file:///etc/passwd','http://user:password@example.com','http://127.1','http://[::1]','http://169.254.169.254','http://localhost'])assert.throws(()=>normalizeUrl(u));
 for(const ip of ['127.0.0.1','10.1.2.3','172.31.0.1','192.168.0.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false);
});
test('OPML safely round-trips hierarchy and escaped token URLs; JSON retains configuration',async()=>{
 const rows=[{name:'Research & safety',url:'https://example.com/rss?a=1&token=private',folder_path:'Science/AI',default_category:'Research',priority:2,is_active:0,auto_publish_max:12}];
 const out=exportSources(rows,'opml');assert.match(out.content,/&amp;/);assert.match(out.warning,/private access tokens/);
 const parsed=await parseImport({format:'opml',content:out.content});assert.equal(parsed[0].url,rows[0].url);assert.equal(parsed[0].folder_path,'Science/AI');assert.equal(parsed[0].name,rows[0].name);
 const richer=await parseImport({format:'json',content:exportSources(rows,'json').content});assert.equal(normalizeSource(richer[0]).auto_publish_max,12);assert.equal(normalizeSource(richer[0]).is_active,0);
 assert.match(exportSources([{...rows[0],name:'=1+1'}],'csv').content,/'=1\+1/);
});
test('hostile and malformed OPML cannot invoke entities or accept broken documents',async()=>{
 for(const content of ['<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml><body/></opml>','<opml><body><outline xmlUrl="https://example.com"/></opml>','<html/>'])await assert.rejects(parseImport({format:'opml',content}));
 await assert.rejects(parseImport({format:'opml',content:'<opml><body>'+Array(14).fill('<outline text="x">').join('')+'<outline xmlUrl="https://example.com"/>'+Array(14).fill('</outline>').join('')+'</body></opml>'}));
});
function fakeRequest(responses,seen=[]){return(url,options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=()=>req.emit('error',new Error('secret URL must not escape'));req.end=()=>queueMicrotask(()=>{seen.push(url.href);options.lookup(url.hostname,{},(err,address,family)=>{assert.equal(err,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});options.lookup(url.hostname,{all:true},(err,addresses)=>{assert.equal(err,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);});const spec=responses.shift();const res=Readable.from([Buffer.from(spec.body||'')]);res.statusCode=spec.status||200;res.headers=spec.headers||{};callback(res);});return req;};}
test('safe fetch pins validated DNS and revalidates redirects before downloading',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}],seen=[];
 assert.equal(await safeFetchText('https://example.com/feed?token=private',{lookup,request:fakeRequest([{status:302,headers:{location:'/other'}},{body:'<rss/>'}],seen)}),'<rss/>');assert.equal(seen.length,2);
 await assert.rejects(safeFetchText('https://example.com',{lookup,request:fakeRequest([{status:302,headers:{location:'http://127.0.0.1/private'}}])}),/redirect/);
 let called=false;await assert.rejects(safeFetchText('https://example.com',{lookup:async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}],request:()=>called=true}),/Private/);assert.equal(called,false);
 await assert.rejects(safeFetchText('https://example.com',{lookup,request:fakeRequest([{body:'12345'}]),maxBytes:4}),/size limit/);
});
test('source filters reuse parameter safely and do not interpolate token-bearing input',()=>{
 const {where}=require('../lib/source-management');const q=where(1,{q:"hello' OR true",folder:'AI',category:'Research'});
 assert.equal(q.sql,"tenant_id=$1 AND removed_at IS NULL AND (name ILIKE $2 OR split_part(url,chr(63),1) ILIKE $2) AND folder_path=$3 AND default_category=$4");assert.equal(q.params.length,4);
});
test('safe fetch bounds stalled DNS and total response time without exposing request addresses',async()=>{
 await assert.rejects(safeFetchText('https://example.com/private/token',{lookup:()=>new Promise(()=>{}),timeout:15}),/could not be resolved/);
 const request=()=>{const req=new EventEmitter();req.setTimeout=()=>req;req.end=()=>{};req.destroy=()=>req.emit('error',Error('https://example.com/private/token'));return req;};
 await assert.rejects(safeFetchText('https://example.com/private/token',{lookup:async()=>[{address:'93.184.216.34',family:4}],request,timeout:15}),error=>/timed out/.test(error.message)&&!error.message.includes('token'));
});
