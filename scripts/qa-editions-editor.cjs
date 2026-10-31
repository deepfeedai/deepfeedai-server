'use strict';
// Isolated real-browser editor QA. All API traffic is intercepted with disposable fixtures.
// PLAYWRIGHT_MODULE and CHROME_PATH may point to preinstalled local tooling.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../public');
const output = process.env.EDITION_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'editions-editor-'));
const articles = Array.from({ length: 22 }, (_, i) => ({ id: i + 1, title: 'A considered newsroom article ' + (i + 1), summary: 'Clear context and practical reporting for the issue. This text is a disposable browser fixture.', byline: 'Fixture Writer', category: 'Research', is_published: true }));
const seed = () => ({ id: 1, name: 'The Weekend Edition', issue_date: '2026-10-30', mode: 'published', status: 'working', visibility: 'private', revision: 1, settings: { paper: 'Letter', ink_saving: false, images: true }, articles: [articles[0]].map(a => ({ ...a, article_id: a.id })), lead_article_id: 1 });
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
        if (u.pathname === '/api/editions') { if (method === 'GET') result = { editions: [edition], total: 1 }; else { const body = req.postDataJSON(); saves++; edition = { ...edition, ...body, articles: body.article_ids.map(id => ({ ...articles[id - 1], article_id: id })), revision: edition.revision + 1 }; result = { edition }; } }
        else if (u.pathname === '/api/editions/articles') { const q = (u.searchParams.get('q') || '').toLowerCase(); const rows = articles.filter(a => a.title.toLowerCase().includes(q)); const offset = Number(u.searchParams.get('offset')); result = { articles: rows.slice(offset, offset + 20), total: rows.length }; }
        else if (u.pathname === '/api/editions/1') { if (method === 'GET') result = { edition }; else { saves++; if (failure) return route.fulfill({ status: 409, json: { error: 'Edition changed; reload first' } }); const body = req.postDataJSON(); edition = { ...edition, ...body, articles: body.article_ids.map(id => ({ ...articles[id - 1], article_id: id })), revision: edition.revision + 1 }; result = { edition }; } }
        else if (u.pathname.endsWith('/finalize')) { edition = { ...edition, status: 'finalized', revision: edition.revision + 1 }; result = { edition }; }
        else if (u.pathname === '/api/site-config') result = { name: 'Fixture Newsroom' };
        else if (u.pathname === '/api/features') result = { features: {} };
        else if (u.pathname === '/api/categories') result = [];
        await route.fulfill({ status: 200, json: result });
      });
      await page.goto('http://127.0.0.1:' + server.address().port + '/editions.html?id=1');
      await page.locator('#editionName').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.getElementById('editionName').value === 'The Weekend Edition');
      await page.locator('#editionAdd').click(); await page.locator('[data-pick="2"]').check(); await page.locator('#editionSearchNext').click(); await page.locator('[data-pick="21"]').check(); assert.match(await page.locator('#editionPickedCount').innerText(), /^2 selected/);
      await page.locator('#editionSearch').fill('article 2'); await page.locator('#editionSearchForm button').click(); await page.locator('#editionPickerApply').click(); assert.equal(await page.locator('#editionSelection .edition-story-card').count(), 3);
      await page.locator('#editionSelection [data-action="lead"][data-id="21"]').click(); assert.equal(await page.locator('#editionSelection h4').first().innerText(), articles[20].title);
      await page.locator('#editionAdd').click(); await page.locator('[data-pick="3"]').check(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#editionSelection .edition-story-card').count(), 3); assert.equal(await page.locator('#editionAdd').evaluate(el => document.activeElement === el), true);
      await page.locator('#editionContributors').check(); await page.locator('#editionPortraits').check();
      await page.locator('#editionName').fill('Fixture edited issue'); failure = true; await page.locator('#editionSave').click(); await page.waitForFunction(() => document.getElementById('editionNotice').textContent.includes('Could not confirm')); assert.equal(await page.locator('#editionName').inputValue(), 'Fixture edited issue'); failure = false;
      await page.locator('#editionSave').dblclick(); await page.waitForFunction(() => document.getElementById('editionNotice').textContent.includes('Edition saved')); assert.equal(saves, 2, 'double click must issue only one successful save'); assert.equal(edition.settings.contributors, true); assert.equal(edition.settings.portraits, true);
      await page.locator('#editionFinalize').click(); await page.locator('#editionConfirmCancel').click(); assert.equal(edition.status, 'working');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(overflow, false, 'horizontal overflow at ' + width);
      await page.screenshot({ path: path.join(output, 'editions-editor-' + width + '.png'), fullPage: true });
      await page.locator('#editionAdd').click(); await page.screenshot({ path: path.join(output, 'editions-picker-' + width + '.png'), fullPage: true });
      const bounds = await page.locator('#editionPicker').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.getElementById('editionPicker').contains(document.activeElement)), true, 'focus remains inside modal'); }
      await page.keyboard.press('Escape');
      await page.locator('#editionFinalize').click(); await page.locator('#editionConfirmAccept').click(); await page.waitForFunction(() => document.getElementById('editionState').textContent.includes('Finalized'));
      assert.equal(edition.status, 'finalized'); assert.equal(edition.visibility, 'private'); assert.equal(await page.locator('#editionSave').isVisible(), false); assert.equal(await page.locator('#editionContributors').isDisabled(), true); assert.equal(await page.locator('#editionPortraits').isDisabled(), true);
      assert.deepEqual(errors, [], 'browser errors'); results.push({ width, status: 'pass', saveRequests: saves }); await context.close();
    }
    console.log(JSON.stringify({ results, screenshots: output }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
