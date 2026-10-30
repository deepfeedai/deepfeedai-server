'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const editions=require('../lib/editions');
const input=()=>({name:'Morning edition',issue_date:'2026-10-30',mode:'published',article_ids:[1,2],lead_article_id:2,settings:{paper:'A4',ink_saving:true,images:true}});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('edition validation preserves order and enforces bounded truthful settings',()=>{
 assert.deepEqual(editions.validate(input()).article_ids,[1,2]);
 for(const change of [{article_ids:[1,1]},{article_ids:[-1]},{article_ids:Array.from({length:21},(_,i)=>i+1)},{lead_article_id:4},{mode:'public'},{issue_date:'2026-02-30'},{name:' '},{settings:{paper:'A3',ink_saving:false,images:true}},{settings:{paper:'A4',ink_saving:'false',images:true}}])assert.throws(()=>editions.validate({...input(),...change}));
 assert.equal(editions.validate({...input(),article_ids:[],lead_article_id:null}).article_ids.length,0);
});
test('snapshot plain text strips active HTML and control characters without executing content',()=>{
 assert.equal(editions.text('<p>News &amp; science</p><script>secret()</script><p>Second</p>'),'News & science\n\nSecond');
 assert.equal(editions.text('safe\u0000text'),'safetext');
});
test('raster byte signatures and dimensions reject SVG, corrupt and decompression-heavy files',()=>{
 assert.equal(editions.rasterMime(png),'image/png');
 assert.equal(editions.rasterMime(Buffer.from('<svg onload="bad()"/>')),null);
 assert.equal(editions.rasterMime(Buffer.from([255,216,255,217])),null);
 const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);assert.equal(editions.rasterMime(huge),null);
});
test('snapshot image reader enforces tenant roots, traversal, size and immutable bytes without fetching URLs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'edition-images-')),previous=process.env.STORAGE_LOCAL_DIR;
 process.env.STORAGE_LOCAL_DIR=root;
 try{
  await fs.mkdir(path.join(root,'tenants','1','images'),{recursive:true});await fs.writeFile(path.join(root,'tenants','1','images','safe.png'),png);
  const image=await editions.localImage('/media/tenants/1/images/safe.png',1);assert.equal(image.image_mime,'image/png');assert.deepEqual(image.image_data,png);
  await fs.writeFile(path.join(root,'tenants','1','images','safe.png'),'changed');assert.deepEqual(image.image_data,png);
  for(const url of ['https://example.invalid/image.png','/media/tenants/2/images/safe.png','/media/tenants/1/../2/image.png','/media/tenants/1/%2e%2e/2/image.png','/media/tenants/1/images/safe.png?key=private','/media/tenants/1/images/missing.png'])assert.ok((await editions.localImage(url,1)).image_notice);
  await fs.writeFile(path.join(root,'tenants','1','images','oversize.png'),Buffer.alloc(editions.MAX_IMAGE+1));assert.match((await editions.localImage('/media/tenants/1/images/oversize.png',1)).image_notice,/5 MB/);
  if(process.platform!=='win32'){
   await fs.mkdir(path.join(root,'tenants','2'),{recursive:true});await fs.writeFile(path.join(root,'tenants','2','secret.png'),png);
   await fs.symlink(path.join(root,'tenants','2','secret.png'),path.join(root,'tenants','1','images','link.png'));
   assert.ok((await editions.localImage('/media/tenants/1/images/link.png',1)).image_notice);
  }
 }finally{if(previous===undefined)delete process.env.STORAGE_LOCAL_DIR;else process.env.STORAGE_LOCAL_DIR=previous;await fs.rm(root,{recursive:true,force:true});}
});
