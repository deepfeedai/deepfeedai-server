'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const create = require('../public/editions-page');
const html = fs.readFileSync(path.join(__dirname, '../public/editions.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/editions-page.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/editions.css'), 'utf8');
const article = id => ({ id, article_id: id, title: 'Article ' + id, summary: 'Summary ' + id, byline: 'Writer', is_published: true });
const edition = (props = {}) => ({ id: 4, name: 'Weekend', issue_date: '2026-10-30', mode: 'published', status: 'working', visibility: 'private', revision: 1, settings: { paper: 'Letter', ink_saving: false, images: true }, articles: [article(10)], lead_article_id: 10, ...props });
function fixture(handler, options = {}) {
  const els = new Map(); let focused = null;
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) { const id = m[1]; els.set(id, { hidden: false, disabled: false, checked: false, value: '', innerHTML: '', textContent: '', attrs: {}, handlers: {}, open: false, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.handlers[k] = v; }, showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused = id; } }); }
  const calls = [], navigations = [];
  const doc = { getElementById: id => { assert.ok(els.has(id), id); return els.get(id); }, activeElement: { focus() { focused = 'return'; } } };
  const app = create(doc, async (url, opts) => { calls.push({ url, opts }); if (handler) return handler(url, opts); if (url.startsWith('/editions?')) return { editions: [edition()], total: 1 }; if (url.startsWith('/editions/articles?')) return { articles: [article(10), article(11)], total: 2 }; return { edition: edition() }; }, { uuid: () => '7c77cebb-5ca2-4bb1-a1bb-5cd438fa9dd6', navigate: id => navigations.push(id), ...options });
  return { app, el: id => els.get(id), calls, navigations, focus: () => focused };
}
function fields(f) { f.el('editionName').value = 'Weekend'; f.el('editionDate').value = '2026-10-30'; f.el('editionPaper').value = 'A4'; f.el('editionImages').checked = true; }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('layout controls preserve defaults and save independent paper, content and source choices', async () => {
 const f=fixture(); await f.app.init(); await f.app.openEdition(4);
 assert.equal(f.el('editionFormat').value,'newspaper'); assert.equal(f.el('editionContent').value,'full'); assert.equal(f.el('editionSources').checked,true);
 f.el('editionFormat').value='large-print'; f.el('editionFormat').handlers.change();
 f.el('editionPaper').value='A4'; f.el('editionContent').value='excerpt'; f.el('editionSources').checked=false;
 assert.equal(f.app.state.dirty,true); assert.equal(f.el('editionPreview').attrs['aria-disabled'],'true');
 await f.app.save(); const settings=JSON.parse(f.calls.find(c=>c.opts).opts.body).settings;
 assert.equal(settings.format,'large-print'); assert.equal(settings.paper,'A4'); assert.equal(settings.content_mode,'excerpt'); assert.equal(settings.sources,false);
 assert.equal(f.app.state.edition.articles[0].title,'Article 10');
});

test('Morning Brief explicitly selects excerpts and discard restores saved layout', async () => {
 const f=fixture(); await f.app.init(); await f.app.openEdition(4);
 f.el('editionFormat').value='morning-brief'; f.el('editionFormat').handlers.change();
 assert.equal(f.el('editionContent').value,'excerpt'); assert.equal(f.el('editionContent').disabled,true); assert.match(f.el('editionFormatHelp').textContent,/no fixed page count/);
 const discard=f.el('editionCancel').handlers.click(); f.app.finishConfirm(true); await discard;
 assert.equal(f.el('editionFormat').value,'newspaper'); assert.equal(f.el('editionContent').value,'full'); assert.equal(f.el('editionContent').disabled,false);
 assert.equal(f.calls.filter(c=>c.opts).length,0);
});

test('saved layout options reload and finalized controls cannot mutate the issue', async () => {
 const settings={paper:'A4',ink_saving:true,images:false,format:'magazine',content_mode:'excerpt',sources:false};
 const f=fixture(async()=>({edition:edition({status:'finalized',settings})})); await f.app.init(); await f.app.openEdition(4);
 assert.equal(f.el('editionFormat').value,'magazine'); assert.equal(f.el('editionContent').value,'excerpt'); assert.equal(f.el('editionSources').checked,false); assert.equal(f.el('editionFields').disabled,true);
 f.el('editionFormat').value='morning-brief'; f.el('editionFormat').handlers.change(); await f.app.save();
 assert.equal(f.calls.filter(c=>c.opts).length,0); assert.deepEqual(f.app.state.edition.settings,settings);
});
test('Edition bootstrap reads only; new edition defaults private with no paid or publication request', async () => {
  const f = fixture(); await f.app.init(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].opts, undefined);
  await f.app.newEdition(); assert.equal(f.app.state.edition.visibility, 'private'); assert.equal(f.app.state.edition.mode, 'published'); assert.equal(f.calls.length, 1); assert.equal(f.el('editionPreview').hidden, true);
});
test('Picker retains selection through paginated search, cancel mutates nothing and reopen resets', async () => {
  const f = fixture(); await f.app.openEdition(4); await f.app.openPicker(); f.app.togglePick(11, true);
  f.app.state.query = 'another'; f.app.state.searchOffset = 20; await f.app.searchArticles(); assert.equal(f.app.state.picked.size, 1); assert.match(f.calls.at(-1).url, /q=another.*offset=20/);
  f.app.closePicker(); assert.deepEqual(f.app.state.edition.articles.map(a => a.article_id), [10]); assert.equal(f.app.state.dirty, false); assert.equal(f.focus(), 'return');
  await f.app.openPicker(); assert.equal(f.app.state.picked.size, 0); assert.match(f.el('editionResults').innerHTML, /Already added/); assert.match(f.el('editionResults').innerHTML, /Published/);
});
test('Picker applies unique additions locally and lead/order/remove never edit source articles', async () => {
  const f = fixture(); await f.app.openEdition(4); await f.app.openPicker(); f.app.togglePick(11, true); f.app.applyPicker(); f.app.applyPicker();
  assert.deepEqual(f.app.state.edition.articles.map(a => a.article_id), [10, 11]); assert.equal(f.app.state.dirty, true); assert.ok(f.calls.every(c => !c.opts));
  f.app.selectedAction('lead', 11); assert.deepEqual(f.app.state.edition.articles.map(a => a.article_id), [11, 10]); assert.equal(f.app.state.edition.lead_article_id, 11);
  f.app.selectedAction('down', 11); assert.equal(f.app.state.edition.lead_article_id, 10); f.app.selectedAction('remove', 10); assert.equal(f.app.state.edition.lead_article_id, 11);
});
test('Create saves with stable request ID across ambiguous failure; duplicate clicks share one mutation', async () => {
  const pending = deferred(); let mutations = 0;
  const f = fixture(async (url, opts) => { if (!opts) return { editions: [], total: 0 }; mutations++; if (mutations === 1) return pending.promise; return { edition: edition() }; });
  await f.app.newEdition(); fields(f); f.app.state.edition.articles = [article(10)]; f.app.state.edition.lead_article_id = 10; f.app.markDirty();
  const first = f.app.save(); await f.app.save(); assert.equal(mutations, 1); const key = JSON.parse(f.calls[0].opts.body).request_id; pending.reject(Error('unknown secret')); await first;
  assert.match(f.el('editionNotice').textContent, /Could not confirm/); assert.ok(!f.el('editionNotice').textContent.includes('unknown secret')); assert.equal(f.el('editionName').value, 'Weekend');
  await f.app.save(); assert.equal(JSON.parse(f.calls[1].opts.body).request_id, key); assert.equal(f.app.state.edition.id, 4); assert.equal(f.app.state.dirty, false);
});
test('Existing save carries revision, settings and exact selected order, and enables preview only after save', async () => {
  const f = fixture(); await f.app.openEdition(4); fields(f); f.app.state.edition.articles.push(article(11)); f.app.selectedAction('lead', 11);
  assert.equal(f.el('editionPreview').attrs['aria-disabled'], 'true'); await f.app.save(); const mutation = f.calls.find(c => c.opts); const b = JSON.parse(mutation.opts.body);
  assert.equal(mutation.opts.method, 'PUT'); assert.equal(b.revision, 1); assert.deepEqual(b.article_ids, [11, 10]); assert.equal(b.lead_article_id, 11); assert.equal(b.settings.paper, 'A4'); assert.equal(b.mode, 'published'); assert.equal(f.el('editionPreview').href, '/edition-print.html?id=4');
});
test('Finalize confirmation cancel does nothing; accept is explicit and blocks repeated actions', async () => {
  const pending = deferred(); const f = fixture(async (url, opts) => opts ? pending.promise : url.includes('?') ? { editions: [], total: 0 } : { edition: edition() });
  await f.app.openEdition(4); const cancelled = f.app.action('finalize'); f.app.finishConfirm(false); await cancelled; assert.ok(f.calls.every(c => !c.opts));
  const active = f.app.action('finalize'); f.app.finishConfirm(true); await Promise.resolve(); await f.app.action('finalize'); assert.equal(f.calls.filter(c => c.opts).length, 1); assert.match(f.calls.at(-1).url, /finalize$/);
  pending.resolve({ edition: edition({ status: 'finalized', revision: 2 }) }); await active; assert.equal(f.el('editionFields').disabled, true); assert.equal(f.el('editionSave').hidden, true); assert.equal(f.el('editionVisibility').hidden, false);
});
test('Private proof cannot show sharing; readonly user gets no create/edit controls', async () => {
  const f = fixture(async () => ({ edition: edition({ mode: 'proof', status: 'finalized' }) })); await f.app.openEdition(4); assert.equal(f.el('editionVisibility').hidden, true); assert.match(f.el('editionPolicy').textContent, /DRAFT/);
  const r = fixture(undefined, { canCreate: () => false, canUpdate: () => false, canPublish: () => false }); await r.app.init(); await r.app.openEdition(4); assert.equal(r.el('editionNew').disabled, true); assert.equal(r.el('editionFields').disabled, true); assert.equal(r.el('editionSave').hidden, true); assert.equal(r.el('editionFinalize').hidden, true); assert.equal(r.el('editionVisibility').hidden, true);
});
test('Mode change cancels safely or clears only unsaved selection; existing mode is fixed', async () => {
  const f = fixture(); await f.app.newEdition(); f.app.state.edition.articles = [article(10)]; f.el('editionMode').value = 'proof';
  const cancel = f.app.changeMode(); f.app.finishConfirm(false); await cancel; assert.equal(f.app.state.edition.mode, 'published'); assert.equal(f.app.state.edition.articles.length, 1);
  f.el('editionMode').value = 'proof'; const change = f.app.changeMode(); f.app.finishConfirm(true); await change; assert.equal(f.app.state.edition.mode, 'proof'); assert.equal(f.app.state.edition.articles.length, 0);
});
test('Snapshot refresh is disabled for unsaved changes and never implicit on open or print', async () => {
  const f = fixture(); await f.app.openEdition(4); f.app.markDirty(); await f.app.action('refresh'); assert.ok(f.calls.every(c => !c.opts)); assert.equal(f.el('editionRefresh').disabled, true); assert.equal(f.el('editionConfirm').open, false);
});
test('Server-controlled titles and summaries render escaped; selection cap prevents oversized issues', async () => {
  const f = fixture(async url => url.includes('/articles?') ? { articles: [{ ...article(99), title: '<script>x</script>', summary: '<img src=x onerror=x>' }], total: 1 } : { edition: edition() });
  await f.app.openEdition(4); await f.app.openPicker(); assert.match(f.el('editionResults').innerHTML, /&lt;script&gt;/); assert.ok(!f.el('editionResults').innerHTML.includes('<img'));
  f.app.state.edition.articles = Array.from({ length: 20 }, (_, i) => article(i + 1)); f.app.togglePick(99, true); assert.equal(f.app.state.picked.size, 0); assert.match(f.el('editionPickerStatus').textContent, /up to 20/);
});
test('Search failure clears stale results while preserving selection and retry state', async () => {
  let bad = false; const f = fixture(async url => { if (url.includes('/articles?')) { if (bad) throw Error('secret'); return { articles: [article(11)], total: 1 }; } return { edition: edition() }; });
  await f.app.openEdition(4); await f.app.openPicker(); f.app.togglePick(11, true); bad = true; await f.app.searchArticles(); assert.equal(f.app.state.results.length, 0); assert.equal(f.app.state.picked.size, 1); assert.match(f.el('editionPickerStatus').textContent, /Search again to retry/); assert.equal(f.app.state.searchBusy, false);
});
test('Edition editor has native dialog focus/Escape, responsive layout, no automatic print or generation', () => {
  assert.match(html, /<dialog id="editionPicker"/); assert.match(html, /aria-live="polite"/); assert.match(css, /@media\(max-width:720px\)/); assert.match(css, /focus-visible/); assert.match(css, /max-height:calc\(100dvh/); assert.match(source, /addEventListener\('cancel'/); assert.ok(!source.includes('window.print')); assert.ok(!source.includes('/generate'));
});
test('Contributor settings preserve legacy defaults, cancel and finalized immutability', async () => {
 const f = fixture(); await f.app.init(); await f.app.openEdition(4);
 assert.equal(f.el('editionContributors').checked, false); assert.equal(f.el('editionPortraits').checked, false);
 f.el('editionContributors').checked = true; f.el('editionPortraits').checked = true;
 f.el('editionContributors').handlers.input(); assert.equal(f.app.state.dirty, true);
 const cancel = f.el('editionCancel').handlers.click(); f.app.finishConfirm(true); await cancel;
 assert.equal(f.el('editionContributors').checked, false); assert.equal(f.calls.filter(c => c.opts).length, 0);
 f.el('editionContributors').checked = true; f.el('editionPortraits').checked = true; f.app.markDirty(); await f.app.save();
 assert.deepEqual(JSON.parse(f.calls.find(c => c.opts).opts.body).settings, { paper: 'Letter', ink_saving: false, images: true, contributors: true, portraits: true });
 const final = fixture(async () => ({ edition: edition({ status: 'finalized' }) })); await final.app.init(); await final.app.openEdition(4);
 final.el('editionContributors').checked = true; final.app.markDirty(); await final.app.save();
 assert.equal(final.el('editionFields').disabled, true); assert.equal(final.calls.filter(c => c.opts).length, 0);
});

const canonical = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('Canonical IDs and accepted selection drive highlight despite late open responses', async () => {
 const first = deferred(), second = deferred();
 const f = fixture(async url => url.endsWith('/history') ? { history: [] } : url.endsWith('/4') ? first.promise : second.promise);
 f.app.state.list = [edition({ id: canonical }), edition({ id: secondId })];
 const one = f.app.openEdition(4); await Promise.resolve(); const two = f.app.openEdition(secondId); await Promise.resolve();
 second.resolve({ edition: edition({ id: secondId, name: 'Second' }) }); await two;
 first.resolve({ edition: edition({ id: canonical, name: 'First' }) }); await one;
 assert.equal(f.app.state.edition.id, secondId); assert.equal(f.navigations.at(-1), secondId);
 assert.match(f.el('editionList').innerHTML, new RegExp('data-open="' + secondId + '" aria-current="true"'));
 assert.equal(f.app.state.busy, false);
});
test('Authenticated legacy open canonicalizes returned ID without numeric mutation routes', async () => {
 const navigations = []; const f = fixture(async (url, opts) => url.endsWith('/history') ? { history: [] } : { edition: edition({ id: canonical }) }, { navigate: (id, replace) => navigations.push([id, replace]) });
 await f.app.openEdition(4); assert.deepEqual(navigations[0], [canonical, true]); f.app.markDirty(); await f.app.save();
 assert.equal(f.calls.find(c => c.opts).url, '/editions/' + canonical);
});
test('Retraction and archive require reasons; cancel is inert; restore remains explicit', async () => {
 let current = edition({ id: canonical, status: 'finalized', visibility: 'public' });
 const f = fixture(async (url, opts) => { if (url.endsWith('/history')) return { history: [] }; if (opts) { const b = JSON.parse(opts.body); assert.equal(b.revision, current.revision); current = { ...current, revision: current.revision + 1, visibility: 'private', ...(url.endsWith('/archive') ? { archived_at: 'today' } : url.endsWith('/restore') ? { archived_at: null } : { retracted_at: 'today' }) }; } return { edition: current }; });
 await f.app.init(); await f.app.openEdition(canonical);
 const cancelled = f.app.lifecycle('retract'); f.app.finishConfirm(false); await cancelled; assert.equal(f.calls.filter(c => c.opts).length, 0);
 const retract = f.app.lifecycle('retract'); f.app.finishConfirm(true); assert.equal(f.el('editionConfirm').open, true); f.el('editionConfirmReason').value = 'Correction needed'; f.app.finishConfirm(true); await retract;
 assert.equal(JSON.parse(f.calls.find(c => c.opts).opts.body).reason, 'Correction needed'); assert.equal(f.el('editionVisibility').hidden, false); assert.match(f.el('editionVisibility').textContent, /again/);
 const archive = f.app.lifecycle('archive'); f.el('editionConfirmReason').value = 'Archive issue'; f.app.finishConfirm(true); await archive;
 assert.equal(f.el('editionRestore').hidden, false);
 const restore = f.app.lifecycle('restore'); f.app.finishConfirm(true); await restore; assert.equal(f.app.state.edition.visibility, 'private'); assert.equal(f.el('editionVisibility').hidden, false); assert.ok(!f.calls.some(c => c.url.endsWith('/visibility')));
});
test('Rename changes only name and revision; archived deletion needs exact title and permission', async () => {
 let current = edition({ id: canonical, status: 'finalized' }); const bodies = [];
 const f = fixture(async (url, opts) => { if (url.endsWith('/history')) return { history: [] }; if (opts) { bodies.push(JSON.parse(opts.body)); if (opts.method === 'DELETE') return { deleted: true, id: canonical }; current = { ...current, name: bodies.at(-1).name, revision: 2 }; } return { edition: current }; }, { canDelete: () => true });
 await f.app.openEdition(canonical); const rename = f.app.lifecycle('rename'); f.el('editionConfirmValue').value = 'New title'; f.app.finishConfirm(true); await rename;
 assert.deepEqual(bodies[0], { revision: 1, name: 'New title' }); assert.equal(f.app.state.edition.articles[0].article_id, 10);
 await f.app.lifecycle('delete'); assert.equal(bodies.length, 1);
 f.app.state.edition.archived_at = 'today'; const deletion = f.app.lifecycle('delete'); f.el('editionConfirmReason').value = 'Remove issue'; f.el('editionConfirmValue').value = 'wrong'; f.app.finishConfirm(true); assert.equal(f.el('editionConfirm').open, true);
 f.el('editionConfirmValue').value = 'New title'; f.app.finishConfirm(true); await deletion; assert.equal(f.app.state.edition, null); assert.equal(bodies[1].confirmation, 'New title');
});
test('Public visibility removal collects a reason and privileged lifecycle actions stay hidden', async () => {
 const f = fixture(async () => ({ edition: edition({ id: canonical, status: 'finalized', visibility: 'public' }) })); await f.app.openEdition(canonical);
 const hiding = f.app.action('visibility'); f.app.finishConfirm(true); assert.equal(f.el('editionConfirm').open, true); f.app.finishConfirm(false); await hiding; assert.ok(f.calls.every(c => !c.opts));
 const denied = fixture(async () => ({ edition: edition({ id: canonical, status: 'finalized', visibility: 'public' }) }), { canPublish: () => false, canUpdate: () => true }); await denied.app.openEdition(canonical);
 assert.equal(denied.el('editionArchive').hidden, true); assert.equal(denied.el('editionRename').hidden, true); await denied.app.lifecycle('archive'); await denied.app.lifecycle('rename'); assert.ok(denied.calls.every(c => !c.opts));
});
test('Back/forward and list filter preserve authoritative selection without late load resurrection', async () => {
 let pop; const slow = deferred();
 const f = fixture(async url => url.endsWith('/history') ? { history: [] } : url.includes('?') ? { editions: [edition({ id: canonical })], total: 1 } : url.endsWith(secondId) ? slow.promise : { edition: edition({ id: canonical }) }, { onPopState: handler => { pop = handler; } });
 await f.app.init(); await f.app.openEdition(canonical); f.el('editionListView').value = 'archived'; f.el('editionListView').handlers.change(); await Promise.resolve();
 assert.ok(f.calls.some(c => c.url.includes('view=archived')));
 const opening = f.app.openEdition(secondId); await Promise.resolve(); await pop(''); slow.resolve({ edition: edition({ id: secondId }) }); await opening;
 assert.equal(f.app.state.edition, null); assert.doesNotMatch(f.el('editionList').innerHTML, /aria-current="true"/);
 await pop('?id=' + canonical); assert.equal(f.app.state.edition.id, canonical); assert.match(f.el('editionList').innerHTML, /aria-current="true"/);
 f.app.markDirty(); await pop(''); assert.equal(f.app.state.edition.id, canonical); assert.match(f.el('editionNotice').textContent, /Finish or discard/);
});
test('Copy share link is user initiated with selectable fallback and hidden for private issues', async () => {
 const copied = []; const f = fixture(async () => ({ edition: edition({ id: canonical, status: 'finalized', visibility: 'public' }) }), { publicOrigin: 'https://news.example.test', copyText: async text => copied.push(text) });
 await f.app.init(); await f.app.openEdition(canonical); assert.equal(copied.length, 0); assert.equal(f.el('editionCopyLink').disabled, false); await f.app.copyShareLink(); assert.deepEqual(copied, ['https://news.example.test/edition-print.html?id=' + canonical + '&public=1']);
 const failed = fixture(async () => ({ edition: edition({ id: canonical, status: 'finalized', visibility: 'public' }) }), { copyText: async () => { throw Error('denied'); } }); await failed.app.openEdition(canonical); await failed.app.copyShareLink(); assert.equal(failed.focus(), 'editionShareUrl'); assert.match(failed.el('editionNotice').textContent, /Select and copy/);
 const hidden = fixture(); await hidden.app.openEdition(4); assert.equal(hidden.el('editionCopyLink').hidden, true); await hidden.app.copyShareLink();
});

test('Retraction is only offered for a currently public finalized reader issue', async () => {
 for (const props of [{ mode: 'proof', visibility: 'private', status: 'finalized' }, { mode: 'published', visibility: 'private', status: 'finalized' }, { mode: 'published', visibility: 'public', status: 'working' }, { mode: 'published', visibility: 'public', status: 'finalized', archived_at: 'today' }]) {
  const f = fixture(async () => ({ edition: edition({ id: canonical, ...props }) })); await f.app.openEdition(canonical);
  assert.equal(f.el('editionRetract').hidden, true); await f.app.lifecycle('retract'); assert.equal(f.el('editionConfirm').open, false); assert.ok(f.calls.every(c => !c.opts));
 }
 const visible = fixture(async () => ({ edition: edition({ id: canonical, mode: 'published', visibility: 'public', status: 'finalized' }) })); await visible.app.openEdition(canonical); assert.equal(visible.el('editionRetract').hidden, false);
});
