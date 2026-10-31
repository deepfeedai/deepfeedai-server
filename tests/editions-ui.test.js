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
  const f = fixture(); await f.app.openEdition(4); f.app.markDirty(); await f.app.action('refresh'); assert.equal(f.calls.length, 1); assert.equal(f.el('editionRefresh').disabled, true); assert.equal(f.el('editionConfirm').open, false);
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
