'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {scrapeText,extractText}=require('../lib/reader-fetch');
function response(body,{status=200,location}={}){return (url,options,callback)=>{
 const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=()=>{};
 request.end=()=>process.nextTick(()=>{const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers={location};callback(res);});return request;
};}
test('Reader enrichment pins public DNS and extracts plain article text without scripts or boilerplate',async()=>{
 let pinned,accept;const text=await scrapeText('https://example.invalid/article',1,{
  lookup:async()=>[{address:'93.184.216.34',family:4}],
  request:(url,options,callback)=>{accept=options.headers.Accept;options.lookup('example.invalid',{},(err,address)=>pinned=address);return response('<nav>Navigation</nav><article><script>secret</script><h1>Evidence</h1><p>'+('Safe &amp; verified. '.repeat(20))+'</p></article>')(url,options,callback);}
 });
 assert.equal(pinned,'93.184.216.34');assert.equal(accept,'text/html,application/xhtml+xml');assert.ok(text.startsWith('Evidence Safe & verified.'));assert.ok(!text.includes('secret'));assert.ok(!text.includes('Navigation'));
 assert.equal(extractText('<script>bad()</script><p>too short</p>'),null);
});
test('Reader enrichment blocks private DNS and redirected private DNS before connecting',async()=>{
 let calls=0;
 await assert.rejects(()=>scrapeText('https://private.example/article',1,{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{calls++;throw Error('Must not connect');}}),/Private/);assert.equal(calls,0);
 await assert.rejects(()=>scrapeText('https://public.example/article',1,{
  lookup:async host=>[{address:host==='private.example'?'10.0.0.1':'93.184.216.34',family:4}],
  request:(url,options,callback)=>{calls++;return response('',{status:302,location:'http://private.example/secret'})(url,options,callback);}
 }),/Private/);assert.equal(calls,1);
});
