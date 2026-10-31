'use strict';
// Isolated real-browser editor QA. All API traffic is intercepted with disposable fixtures.
// PLAYWRIGHT_MODULE and CHROME_PATH may point to preinstalled local tooling.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../public');
const output = process.env.EDITION_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'editions-editor-'));
const articles = Array.from({ length: 22 }, (_, i) => ({ id: i + 1, title: 'A considered newsroom article ' + (i + 1), summary: 'Clear context and practical reporting for the issue. This text is a disposable browser fixture.', byline: 'Fixture Writer', category: 'Research', is_published: true }));
const eid = '11111111-1111-4111-8111-111111111111';
const seed = () => ({ id: eid, name: 'The Weekend Edition', issue_date: '2026-10-30', mode: 'published', status: 'working', visibility: 'private', revision: 1, settings: { paper: 'Letter', ink_saving: false, images: true }, articles: [articles[0]].map(a => ({ ...a, article_id: a.id })), lead_article_id: 1 });
async function run() {
  const server = http.createServer((req, res) => { const pathname = new URL(req.url, 'http://fixture').pathname; const file = path.resolve(root, '.' + pathname); if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); } const ext = path.extname(file); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[ext] || 'application/octet-stream'); res.end(fs.readFileSync(file)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const results = [];
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript(() => { localStorage.setItem('deepfeedai_token', 'fixture.' + btoa(JSON.stringify({ type: 'tenant-admin', role: 'owner', permissions: ['*'], exp: 9999999999 })) + '.fixture'); });
      let edition = seed(), saves = 0, failure = false; const errors = [];
      const page = await context.newPage(); page.on('pageerror', err => errors.push(err.message));
      await page.route('**/api/**', async route => {
        const req = route.request(), u = new URL(req.url()), method = req.method(); let result = {};
        if (u.pathname === '/api/editions') { if (method === 'GET') { const visible = u.searchParams.get('view') === 'all' || (u.searchParams.get('view') === 'archived' ? !!edition.archived_at : !edition.archived_at); result = { editions: visible ? [edition] : [], total: visible ? 1 : 0 }; } else { const body = req.postDataJSON(); saves++; edition = { ...edition, ...body, articles: body.article_ids.map(id => ({ ...articles[id - 1], article_id: id })), revision: edition.revision + 1 }; result = { edition }; } }
        else if (u.pathname === '/api/editions/articles') { const q = (u.searchParams.get('q') || '').toLowerCase(); const rows = articles.filter(a => a.title.toLowerCase().includes(q)); const offset = Number(u.searchParams.get('offset')); result = { articles: rows.slice(offset, offset + 20), total: rows.length }; }
        else if ((u.pathname === '/api/editions/1' || u.pathname === '/api/editions/' + eid)) { if (method === 'GET') result = { edition }; else { saves++; if (failure) return route.fulfill({ status: 409, json: { error: 'Edition changed; reload first' } }); const body = req.postDataJSON(); edition = { ...edition, ...body, articles: body.article_ids.map(id => ({ ...articles[id - 1], article_id: id })), revision: edition.revision + 1 }; result = { edition }; } }
        else if (u.pathname.endsWith('/finalize')) { edition = { ...edition, status: 'finalized', revision: edition.revision + 1 }; result = { edition }; }
        else if (u.pathname.endsWith('/visibility')) { edition = { ...edition, visibility: req.postDataJSON().visibility, revision: edition.revision + 1 }; result = { edition }; }
        else if (u.pathname.endsWith('/history')) result = { history: [] };
        else if (/\/(rename|retract|archive|restore)$/.test(u.pathname)) { const action = u.pathname.split('/').pop(), body = req.postDataJSON(); edition = { ...edition, revision: edition.revision + 1, ...(action === 'rename' ? { name: body.name } : action === 'retract' ? { retracted_at: '2026-10-31', visibility: 'private' } : action === 'archive' ? { archived_at: '2026-10-31', visibility: 'private' } : { archived_at: null, visibility: 'private' }) }; result = { edition }; }
        else if (u.pathname === '/api/site-config') result = { name: 'Fixture Newsroom' };
        else if (u.pathname === '/api/features') result = { features: {} };
        else if (u.pathname === '/api/categories') result = [];
        await route.fulfill({ status: 200, json: result });
      });
      await page.goto('http://127.0.0.1:' + server.address().port + '/editions.html?id=1');
      await page.locator('#editionName').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.getElementById('editionName').value === 'The Weekend Edition');
      assert.equal(new URL(page.url()).searchParams.get('id'), eid); assert.equal(await page.locator('[data-open="' + eid + '"]').getAttribute('aria-current'), 'true');
      await page.locator('#editionAdd').click(); await page.locator('[data-pick="2"]').check(); await page.locator('#editionSearchNext').click(); await page.locator('[data-pick="21"]').check(); assert.match(await page.locator('#editionPickedCount').innerText(), /^2 selected/);
      await page.locator('#editionSearch').fill('article 2'); await page.locator('#editionSearchForm button').click(); await page.locator('#editionPickerApply').click(); assert.equal(await page.locator('#editionSelection .edition-story-card').count(), 3);
      await page.locator('#editionSelection [data-action="lead"][data-id="21"]').click(); assert.equal(await page.locator('#editionSelection h4').first().innerText(), articles[20].title);
      await page.locator('#editionAdd').click(); await page.locator('[data-pick="3"]').check(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#editionSelection .edition-story-card').count(), 3); assert.equal(await page.locator('#editionAdd').evaluate(el => document.activeElement === el), true);
      await page.locator('#editionContributors').check(); await page.locator('#editionPortraits').check();
      assert.equal(await page.locator('#editionFormat').inputValue(), 'newspaper');
      await page.locator('#editionFormat').selectOption('morning-brief');
      assert.equal(await page.locator('#editionContent').inputValue(), 'excerpt');
      assert.equal(await page.locator('#editionContent').isDisabled(), true);
      await page.locator('#editionFormat').selectOption('large-print');
      assert.equal(await page.locator('#editionContent').isDisabled(), false);
      await page.locator('#editionContent').selectOption('full');
      await page.locator('#editionSources').uncheck();
      await page.locator('#editionPaper').selectOption('A4');
      await page.locator('#editionFormat').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.locator('#editionContent').evaluate(el => document.activeElement === el), true);
      await page.locator('#editionName').fill('Fixture edited issue'); failure = true; await page.locator('#editionSave').click(); await page.waitForFunction(() => document.getElementById('editionNotice').textContent.includes('Could not confirm')); assert.equal(await page.locator('#editionName').inputValue(), 'Fixture edited issue'); failure = false;
      await page.locator('#editionSave').dblclick(); await page.waitForFunction(() => document.getElementById('editionNotice').textContent.includes('Edition saved')); assert.equal(saves, 2, 'double click must issue only one successful save'); assert.equal(edition.settings.contributors, true); assert.equal(edition.settings.portraits, true);
      await page.locator('#editionFinalize').click(); await page.locator('#editionConfirmCancel').click(); assert.equal(edition.status, 'working');
      assert.equal(edition.settings.format, 'large-print'); assert.equal(edition.settings.content_mode || 'full', 'full'); assert.equal(edition.settings.sources, false); assert.equal(edition.settings.paper, 'A4');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(overflow, false, 'horizontal overflow at ' + width);
      await page.screenshot({ path: path.join(output, 'editions-editor-' + width + '.png'), fullPage: true });
      await page.locator('#editionAdd').click(); await page.screenshot({ path: path.join(output, 'editions-picker-' + width + '.png'), fullPage: true });
      const bounds = await page.locator('#editionPicker').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.getElementById('editionPicker').contains(document.activeElement)), true, 'focus remains inside modal'); }
      await page.keyboard.press('Escape');
      await page.locator('#editionFinalize').click(); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => document.getElementById('editionState').textContent.includes('Finalized'));
      assert.equal(edition.status, 'finalized'); assert.equal(edition.visibility, 'private'); assert.equal(await page.locator('#editionSave').isVisible(), false); assert.equal(await page.locator('#editionContributors').isDisabled(), true); assert.equal(await page.locator('#editionPortraits').isDisabled(), true);
      await page.locator('#editionVisibility').click(); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => !document.getElementById('editionCopyLink').hidden);
      for (const control of ['editionFormat', 'editionContent', 'editionSources']) assert.equal(await page.locator('#' + control).isDisabled(), true);
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Fixture clipboard denied')) } }));
      await page.locator('#editionCopyLink').click(); await page.waitForFunction(() => document.getElementById('editionNotice').textContent.includes('Select and copy')); assert.equal(await page.locator('#editionShareUrl').evaluate(el => document.activeElement === el), true);
      await page.locator('#editionRename').click(); await page.locator('#editionConfirmValue').fill('Renamed issue'); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => document.getElementById('editionEditorTitle').textContent === 'Renamed issue');
      assert.equal(await page.locator('[aria-current="true"] strong').last().innerText(), 'Renamed issue');
      await page.locator('#editionRetract').click(); await page.locator('#editionConfirmCancel').click(); assert.equal(edition.retracted_at, undefined);
      await page.locator('#editionRetract').click(); await page.locator('#editionConfirmAccept').click(); assert.equal(await page.locator('#editionConfirm').isVisible(), true);
      await page.locator('#editionConfirmReason').fill('Fixture correction'); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => document.getElementById('editionState').textContent.includes('Retracted'));
      await page.locator('#editionArchive').click(); await page.locator('#editionConfirmReason').fill('Fixture archive'); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => document.getElementById('editionState').textContent.includes('Archived'));
      await page.locator('#editionListView').selectOption('archived'); await page.waitForFunction(() => document.querySelectorAll('#editionList [data-open]').length === 1);
      await page.locator('#editionRestore').click(); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => !document.getElementById('editionState').textContent.includes('Archived')); assert.equal(edition.visibility, 'private');
      await page.locator('#editionListView').selectOption('all'); await page.waitForFunction(() => document.querySelectorAll('#editionList [data-open]').length === 1);
      await page.screenshot({ path: path.join(output, 'editions-lifecycle-' + width + '.png'), fullPage: true });
      assert.deepEqual(errors, [], 'browser errors'); results.push({ width, status: 'pass', saveRequests: saves }); await context.close();
    }
    console.log(JSON.stringify({ results, screenshots: output }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
