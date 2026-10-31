'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const r=require('../lib/edition-references');
const sources=[{id:7,title:'First source',source:'Publisher One',source_url:'https://example.org/report?a=1&b=2'},{id:8,title:'Second source',source:'Publisher Two',source_url:'https://example.net/research'}];
test('reference snapshots preserve original numbering and metadata without inferred dates or lookups',()=>{
 const captured=r.captureReferences(sources,'Evidence [2][1].');
 assert.deepEqual(captured.references.map(x=>[x.number,x.article_id,x.title]),[[1,7,'First source'],[2,8,'Second source']]);
 assert.equal(captured.references[0].publisher,'Publisher One');assert.equal(captured.references[0].url,sources[0].source_url);
 assert.ok(captured.references.every(x=>!Object.hasOwn(x,'date')));assert.deepEqual(captured.reference_warnings,[]);
 sources[0].title='Changed later';assert.equal(captured.references[0].title,'First source');sources[0].title='First source';
});
test('missing or malformed source metadata remains explicit and never renumbers citations',()=>{
 const result=r.captureReferences([7,null,{id:8,title:'Known title',source_url:'javascript:alert(1)'}],'Text [1][2][3][4].');
 assert.deepEqual(result.references.map(x=>x.number),[1,2,3]);assert.equal(result.references[0].title,null);assert.match(result.references[0].warning,/not captured/);
 assert.equal(result.references[2].url,null);assert.match(result.references[2].warning,/safe source URL/);assert.equal(result.reference_warnings.length,3);
 assert.equal(r.captureReferences('{broken','Text [1]').references.length,0);
});
test('source URLs reject active schemes, credentials and secret-bearing query or fragments',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','https://user:pass@example.org/x','https://example.org/x?token=secret','https://example.org/?X-Amz-Signature=x','https://example.org/?api_key=x','https://example.org/?%74oken=x','https://example.org/#access_token=secret','https://example.org/#auth=secret','https://example.org/#code=secret','https://example.org/#/path?key=secret','https://example.org/#sig%3Dsecret','https://example.org/\\evil','https://example.org/\nheader'])assert.equal(r.safeReferenceUrl(url),null,url);
 assert.equal(r.safeReferenceUrl('https://example.org/report#methods'),'https://example.org/report#methods');
});
test('citation inventory leaves code examples and linked numeric text out of source matching',()=>{
 assert.deepEqual(r.citationNumbers('Claims [2][1][2]. `[9]` [3](https://example.org)\n```\n[8]\n```'),[1,2]);
 const result=r.captureReferences(Array.from({length:101},(_,i)=>({id:i+1,title:'Source '+i,source_url:'https://example.org/'+i})),'[101]');
 assert.equal(result.references.length,100);assert.ok(result.reference_warnings.some(w=>w.includes('[101]')));
});
const edition={id:1,tenant_id:1,mode:'published',status:'finalized'};
const article=()=>({id:9,tenant_id:1,title:'Article',full_content:'Evidence [1][2].',content:null,summary:'Summary',source_article_ids:sources,updated_at:new Date('2026-10-30T12:00:00.123Z'),publication_epoch:'2026-10-30 12:00:00.123456+00',is_published:1,is_archived:0,content_type:'original'});
const item=()=>({article_id:9,snapshot:{title:'Article',content:'Evidence [1][2].',source_updated_at:'2026-10-30T12:00:00.123Z',publication_epoch:'2026-10-30 12:00:00.123456+00'}});
test('backfill requires matching source text, captured version, publication epoch and reference order',()=>{
 assert.equal(r.inspectMatch(edition,item(),article()).eligible,true);
 for(const patch of [{title:'Different'},{full_content:'Changed body'},{updated_at:new Date('2026-10-30T12:00:01Z')},{publication_epoch:'2026-10-30 13:00:00+00'},{tenant_id:2},{is_published:0},{is_archived:1},{source_article_ids:[7,8]}])assert.equal(r.inspectMatch(edition,item(),{...article(),...patch}).eligible,false,JSON.stringify(patch));
 const already=item();already.snapshot.references=[];assert.equal(r.inspectMatch(edition,already,article()).reason,'already-captured');
});
test('metadata preservation fingerprint excludes only approved reference fields',()=>{
 const original={title:'Same',content:'Exact text',image_notice:null};const updated={...original,...r.captureReferences(sources,'[1]')};
 assert.equal(r.digest(r.preservedSnapshot(original)),r.digest(r.preservedSnapshot(updated)));
 assert.notEqual(r.digest(r.preservedSnapshot(original)),r.digest(r.preservedSnapshot({...updated,content:'Different'})));
});
