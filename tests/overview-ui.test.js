'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const createPage = require('../public/overview-page');
const html = fs.readFileSync(path.join(__dirname, '../public/overview.html'), 'utf8');
const data = () => ({ cards: [{ id: 'review', label: 'Awaiting review', count: 0, href: '/articles.html?status=review', description: 'Review saved drafts' }], activity: [{ id: 1, title: '<script>unsafe</script>', status: 'pending_review', at: '2026-10-30T00:00:00Z', href: '/article-editor.html?id=1' }], onboarding: { version: 1, dismissed: false, items: [{ id: 'source', label: 'Gather sources', scope: 'workspace', complete: true, href: '/sources.html', description: 'Current feeds exist' }, { id: 'read', label: 'Read evidence', scope: 'personal', complete: false, href: '/feed-inbox.html' }] } });
function fixture(handler = async () => data(), options = {}) {
  const elements = new Map(); let focused;
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], { hidden: false, disabled: false, textContent: '', innerHTML: '', attrs: {}, handlers: {}, setAttribute(k,v) { this.attrs[k]=v; }, addEventListener(k,v) { this.handlers[k]=v; }, focus() { focused=match[1]; } });
  const calls = []; const app = createPage({ getElementById: id => { assert.ok(elements.has(id), id); return elements.get(id); } }, async (url, options) => { calls.push({url,options}); return handler(url,options); }, options);
  return { app, calls, document: { getElementById: id => elements.get(id) }, el: id => elements.get(id), focus: () => focused };
}
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
test('Overview renders truthful zero queues, bounded escaped activity and distinct evidence scopes without mutations', async () => {
  const f=fixture(); await f.app.init(); assert.equal(f.calls.length,1);assert.equal(f.calls[0].options,undefined);
  assert.match(f.el('overviewCards').innerHTML,/overview-card-count">0</); assert.match(f.el('overviewCards').innerHTML,/status=review/);
  assert.match(f.el('overviewActivity').innerHTML,/&lt;script&gt;/); assert.ok(!f.el('overviewActivity').innerHTML.includes('<script>'));
  assert.match(f.el('overviewChecklist').innerHTML,/Workspace evidence/); assert.match(f.el('overviewChecklist').innerHTML,/Your personal progress/);
  assert.equal(f.el('overviewProgress').textContent,'1 of 2 milestones evidenced');assert.equal(f.el('overviewContent').hidden,false);
});
test('Overview validates navigation destinations and never turns external or executable values into links', async () => {
  const malicious=data();malicious.cards.push({label:'bad',count:1,href:'javascript:alert(1)'});malicious.activity.push({title:'External',href:'//evil.invalid/a.html'});
  const f=fixture(async()=>malicious);await f.app.load();assert.ok(!f.el('overviewCards').innerHTML.includes('javascript:'));assert.ok(!f.el('overviewActivity').innerHTML.includes('evil.invalid'));
  for(const v of ['https://evil.invalid/articles.html','//evil.invalid/articles.html','/api/publish','/articles.html/../../api/fetch','/articles.html\\evil'])assert.equal(f.app.safeHref(v),null);
  assert.equal(f.app.safeHref('pitches.html?tab=assignments&status=needs_sources'),'/pitches.html?tab=assignments&status=needs_sources');
});
test('Repeated refresh shares one request; failed refresh hides stale counts and retry recovers', async () => {
  const pending=deferred();let n=0;const f=fixture(async()=>{n++;if(n===1)return pending.promise;if(n===2)throw Error('secret should not display');return data();});
  const first=f.app.load();const second=f.app.load();assert.equal(f.calls.length,1);assert.equal(f.el('overviewRefresh').disabled,true);pending.resolve(data());await Promise.all([first,second]);
  await f.app.load();assert.equal(f.el('overviewContent').hidden,true);assert.equal(f.el('overviewRetry').hidden,false);assert.ok(!f.el('overviewStatus').textContent.includes('secret'));
  await f.app.load();assert.equal(f.el('overviewContent').hidden,false);assert.equal(f.el('overviewRetry').hidden,true);
});
test('Checklist preference is explicit, duplicate-safe, persisted before display and restores focus',async()=>{
  const pending=deferred();const f=fixture(async(url,opts)=>opts?pending.promise:data());await f.app.load();
  const first=f.app.dismiss();await f.app.dismiss();assert.equal(f.calls.length,2);assert.equal(f.el('overviewGuideBody').hidden,false);
  assert.deepEqual(JSON.parse(f.calls[1].options.body),{dismissed:true,version:1});assert.equal(f.calls[1].options.method,'PUT');
  pending.resolve({dismissed:true,version:1});await first;assert.equal(f.el('overviewGuideBody').hidden,true);assert.equal(f.focus(),'overviewReopen');
});
test('Failed preference retains evidence and allows retry; reopen never marks steps complete',async()=>{
  let fail=true;const d=data();d.onboarding.dismissed=true;const f=fixture(async(url,opts)=>{if(!opts)return d;if(fail)throw Error('private');return{version:1,dismissed:false};});await f.app.load();
  await f.app.reopen();assert.equal(f.el('overviewGuideBody').hidden,true);assert.equal(f.el('overviewReopen').disabled,false);assert.match(f.el('overviewPreferenceStatus').textContent,/Try again/);
  fail=false;await f.app.reopen();assert.equal(f.el('overviewGuideBody').hidden,false);assert.equal(f.el('overviewProgress').textContent,'1 of 2 milestones evidenced');assert.equal(f.focus(),'overviewDismiss');
});
test('Empty permission-filtered response has honest empty states and caps activity rendering',async()=>{
  const f=fixture(async()=>({cards:[],activity:[],onboarding:{version:1,dismissed:false,items:[]}}));await f.app.load();assert.match(f.el('overviewCards').innerHTML,/No attention queues/);assert.match(f.el('overviewActivity').innerHTML,/No recent activity/);
  const d=data();d.activity=Array.from({length:30},()=>d.activity[0]);const bounded=fixture(async()=>d);await bounded.app.load();assert.equal((bounded.el('overviewActivity').innerHTML.match(/<li>/g)||[]).length,12);
});
test('Overview shell has native keyboard controls, live feedback, responsive columns and correct script order',()=>{
  assert.ok(html.indexOf('/admin.js')<html.indexOf('/overview-page.js'));assert.match(html,/aria-live="polite"/);assert.match(html,/<button[^>]+id="overviewReopen"/);
  const css=fs.readFileSync(path.join(__dirname,'../public/overview.css'),'utf8');assert.match(css,/focus-visible/);assert.match(css,/@media\(max-width:540px\)/);assert.match(css,/prefers-reduced-motion/);
});
test('Help can show a dismissed checklist for this visit without persisting a preference or completion',async()=>{
  const d=data();d.onboarding.dismissed=true;
  const f=fixture(async()=>d,{search:'?onboarding=show'});await f.app.load();
  assert.equal(f.el('overviewGuideBody').hidden,false);assert.equal(f.el('overviewVisitNotice').hidden,false);
  assert.equal(f.app.state.data.onboarding.dismissed,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options,undefined);
  assert.equal(f.el('overviewProgress').textContent,'1 of 2 milestones evidenced');
  const ordinary=fixture(async()=>d);await ordinary.app.load();assert.equal(ordinary.el('overviewGuideBody').hidden,true);assert.equal(ordinary.el('overviewVisitNotice').hidden,true);
});
test('Browser bootstrap uses actual admin apiFetch prefix exactly once for reads and preferences',async()=>{
  const vm=require('node:vm');const f=fixture();const requests=[];let ready;
  const admin=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
  const wrapper=admin.match(/async function apiFetch\(path, options = \{\}\) \{[\s\S]*?\n\}/)[0];
  const window={document:f.document,location:{search:''}};
  const context={window,document:f.document,URL,URLSearchParams,API:'/api',getToken:()=>null,clearToken:()=>{},requireAuth:()=>true,renderSidebar:()=>{},onReady:fn=>{ready=fn;},fetch:async(url,options)=>{
    requests.push({url,options});
    if(url==='/api/newsroom-overview')return{ok:true,status:200,json:async()=>data()};
    if(url==='/api/newsroom-overview/onboarding')return{ok:true,status:200,json:async()=>({version:1,dismissed:true})};
    return{ok:false,status:404,json:async()=>({error:'Unknown API path'})};
  }};
  vm.createContext(context);vm.runInContext(wrapper,context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/overview-page.js'),'utf8'),context);
  ready();await window.OverviewPage.load();assert.equal(f.el('overviewContent').hidden,false);
  await window.OverviewPage.dismiss();assert.equal(f.el('overviewGuideBody').hidden,true);
  assert.deepEqual(requests.map(r=>r.url),['/api/newsroom-overview','/api/newsroom-overview/onboarding']);
  assert.equal(requests[1].options.method,'PUT');
});
