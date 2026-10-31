const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveNext, remember, consume } = require('../public/login-destination');
const origin = 'https://portal.example';
test('login preserves real local workflow filters but never redirects externally or to action endpoints', () => {
  assert.equal(resolveNext('/articles.html?tab=review&page=2#article-42', origin), '/articles.html?tab=review&page=2#article-42');
  assert.equal(resolveNext('/pitches.html?assignment_status=needs_sources#editorAssignments', origin), '/pitches.html?assignment_status=needs_sources#editorAssignments');
  for (const bad of ['https://evil.example','//evil.example','/\\evil.example','/api/articles/1/publish','/login.html','/unknown.html',null,'/articles.html\n']) assert.equal(resolveNext(bad, origin), '/overview.html');
  assert.equal(resolveNext('/articles.html?id=2&token=private&code=private', origin), '/articles.html?id=2');
});
test('login return survives callback then is consumed once, with safe storage failure fallback', () => {
  const data = new Map(), storage = {setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k),removeItem:k=>data.delete(k)};
  remember({origin,search:'?next=%2Ffeed-inbox.html%3Fview%3Dsaved'},storage);
  assert.equal(consume({origin,search:'?code=oauth-callback'},storage),'/feed-inbox.html?view=saved');
  assert.equal(consume({origin,search:''},storage),'/overview.html');
  const denied = {setItem(){throw Error('denied')},getItem(){throw Error('denied')},removeItem(){throw Error('denied')}};
  remember({origin,search:'?next=%2Fstories.html'},denied);
  assert.equal(consume({origin,search:''},denied),'/overview.html');
});
test('expired API authentication preserves the current safe destination for login', async () => {
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');
  const fn=source.match(/async function apiFetch\([\s\S]*?\n\}/)[0];
  let cleared=false;
  const context={API:'/api',getToken:()=>null,clearToken:()=>{cleared=true;},fetch:async()=>({status:401}),window:{location:{pathname:'/articles.html',search:'?tab=review',hash:'#item'}}};
  vm.createContext(context);vm.runInContext(fn,context);
  await assert.rejects(context.apiFetch('/articles'),/Unauthorized/);
  assert.equal(cleared,true);
  assert.equal(context.window.location.href,'/login.html?next=%2Farticles.html%3Ftab%3Dreview%23item');
});

test('edition sign-in returns preserve only allowlisted local page destinations', () => {
  assert.equal(resolveNext('/editions.html?id=12', origin), '/editions.html?id=12');
  assert.equal(resolveNext('/edition-print.html?id=12#preview', origin), '/edition-print.html?id=12#preview');
  assert.equal(resolveNext('/edition-print.html?id=12&token=private&secret=private', origin), '/edition-print.html?id=12');
  for (const bad of ['https://evil.example/edition-print.html?id=12','//evil.example/editions.html','/edition-print.html/../api/editions/12','/edition-print.html.evil','/api/editions/public/12']) assert.equal(resolveNext(bad, origin), '/overview.html');
  const data = new Map(), storage = {setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k),removeItem:k=>data.delete(k)};
  remember({origin,search:'?next=%2Fedition-print.html%3Fid%3D12'},storage);
  assert.equal(consume({origin,search:''},storage),'/edition-print.html?id=12');
  assert.equal(consume({origin,search:''},storage),'/overview.html');
});