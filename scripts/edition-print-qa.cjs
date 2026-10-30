/* Offline browser/PDF acceptance fixtures. No application credentials or external network.
 * PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome
 * node scripts/edition-print-qa.cjs /absolute/output/directory
 * Inspect generated PDFs using Poppler; no files are sent to a printer.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve(process.argv[2] || '../deployment/newspaper-print-qa');
fs.mkdirSync(out, { recursive: true });
const root = path.join(__dirname, '../public');
let browser;
const lorem = 'The newsroom examines evidence carefully and gives each conclusion context. Editors compare primary sources, check dates, and preserve attribution before publication. Readers need clear explanations that distinguish verified findings from uncertainty. This fixture is synthetic text for print layout testing and contains no user content. A readable newspaper keeps paragraphs intact where practical, allows long stories to continue naturally, and never hides the end of an article. ';
const article = (id, paragraphs) => ({ article_id: id, title: id === 1 ? 'A considered view of a changing world' : 'What careful reporting makes possible', byline: 'Test Editor ' + id, category: id === 1 ? 'The lead / Analysis' : 'Research & practice', source_updated_at: '2026-10-30T12:00:00Z', image_path: id === 1 ? '/api/editions/1/assets/1' : null, content: 'START-ARTICLE-' + id + '\n\n' + Array.from({ length: paragraphs }, (_, n) => (n % 4 === 0 ? '## Evidence and perspective ' + n + '\n\n' : '') + lorem.repeat(2)).join('\n\n') + '\n\nEND-ARTICLE-' + id });
const base = { id: 1, name: 'The Daily Perspective', issue_date: '2026-10-30', status: 'finalized', mode: 'published', visibility: 'private', revision: 1, lead_article_id: 1, settings: { paper: 'Letter', images: true, ink_saving: false }, articles: [article(1, 2)] };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (!['/edition-print.html', '/edition-print.css', '/edition-print.js'].includes(name)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(fs.readFileSync(path.join(root, name)));
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const page = await context.newPage();
  let current = structuredClone(base), denyDetail = false, denyImage = false, requestCount = 0, paidRequests = 0, imageBody;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { paidRequests++; return route.abort(); }
    if (url.pathname.startsWith('/api/editions/')) {
      requestCount++;
      assert.equal(request.method(), 'GET');
      const isPublic = url.pathname.startsWith('/api/editions/public/');
      if (isPublic) assert.equal(request.headers().authorization, undefined);
      else assert.equal(request.headers().authorization, 'Bearer offline-fixture');
      if (url.pathname.includes('/assets/')) return route.fulfill({ status: denyImage ? 410 : 200, contentType: 'image/png', body: denyImage ? '' : imageBody });
      return route.fulfill({ status: denyDetail ? 410 : 200, contentType: 'application/json', body: JSON.stringify(denyDetail ? { error: 'withdrawn' } : { edition: current }) });
    }
    return route.continue();
  });
  await page.addInitScript(() => localStorage.setItem('deepfeedai_token', 'offline-fixture'));
  await page.goto(origin + '/edition-print.html?id=1');
  // Generate an unmistakably synthetic local image for layout checks.
  imageBody = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 600; const x = c.getContext('2d');
    x.fillStyle = '#dbe6e7'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#326372';
    x.beginPath(); x.moveTo(0, 500); x.lineTo(370, 140); x.lineTo(730, 430); x.lineTo(1050, 220); x.lineTo(1400, 500); x.closePath(); x.fill();
    x.fillStyle = '#d5aa5e'; x.beginPath(); x.arc(1130, 130, 70, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#193844'; x.font = '38px sans-serif'; x.fillText('SYNTHETIC PRINT FIXTURE', 45, 555); return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const errors = []; page.on('pageerror', err => errors.push(err.message));
  async function ready(publicMode = false) {
    await page.goto(origin + '/edition-print.html?id=1' + (publicMode ? '&public=1' : ''));
    await page.waitForSelector('body.print-ready');
    await page.locator('#editionPrint').waitFor({ state: 'visible' });
  }
  const cases = [
    ['letter-short', { settings: { paper: 'Letter', images: true, ink_saving: false }, articles: [article(1, 1)] }],
    ['a4-long', { settings: { paper: 'A4', images: true, ink_saving: false }, articles: [article(1, 12), article(2, 12), article(3, 12)] }],
    ['letter-long-ink', { settings: { paper: 'Letter', images: false, ink_saving: true }, articles: [article(1, 12), article(2, 12)] }],
    ['letter-proof', { mode: 'proof', settings: { paper: 'Letter', images: true, ink_saving: true }, articles: [article(1, 4)] }],
    ['letter-missing-image', { settings: { paper: 'Letter', images: true, ink_saving: false }, articles: [article(1, 2)], missing: true }],
  ];
  for (const [name, patch] of cases) {
    current = { ...structuredClone(base), ...patch }; denyImage = !!patch.missing;
    await ready();
    assert.equal(await page.locator('.edition-article').count(), current.articles.length);
    assert.equal(await page.locator('#editionWatermark').isVisible(), current.mode === 'proof');
    if (!current.settings.images) assert.equal(await page.locator('.edition-figure').count(), 0);
    if (denyImage) assert.match(await page.locator('#editionStatus').innerText(), /image\(s\) unavailable/);
    await page.pdf({ path: path.join(out, name + '.pdf'), printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    await page.screenshot({ path: path.join(out, name + '-screen.png'), fullPage: name === 'letter-short' });
  }
  denyImage = false; current = structuredClone(base); await ready();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
  await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement !== document.body));
  // Print button rechecks access and prevents repeated clicks while the request is pending.
  await page.evaluate(() => { window.printCalls = 0; window.print = () => window.printCalls++; });
  const before = requestCount;
  await page.locator('#editionPrint').click();
  await page.waitForFunction(() => window.printCalls === 1);
  assert.ok(requestCount > before);
  // Repeated DOM clicks while loading do not open two print dialogs.
  await page.evaluate(() => { document.getElementById('editionPrint').click(); document.getElementById('editionPrint').click(); });
  await page.waitForFunction(() => window.printCalls === 2);
  assert.equal(await page.evaluate(() => window.printCalls), 2);
  // A withdrawal/access failure clears the entire existing preview, not merely its status line.
  denyDetail = true; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), ''); assert.equal(await page.locator('#editionPrint').isDisabled(), true);
  await page.pdf({ path: path.join(out, 'unavailable.pdf'), preferCSSPageSize: true });
  denyDetail = false; current.visibility = 'public'; current.articles[0].image_path = '/api/editions/public/1/assets/1'; await ready(true);
  denyImage = true; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  // Finalized proof can never render on the public route, even if an API regresses.
  denyImage = false; current.mode = 'proof'; await page.goto(origin + '/edition-print.html?id=1&public=1');
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  current = { ...structuredClone(base), articles: [{ article_id: 1, title: 'Summary-only article', content: 'Saved summary', text_kind: 'excerpt' }] };
  await ready(); assert.match(await page.locator('.edition-excerpt').innerText(), /full text is not included/);
  assert.equal(paidRequests, 0); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ browser: await browser.version(), cases: cases.map(([name]) => name), paperSizes: ['Letter', 'A4'], mobileWidth: 390, checked: ['safe paper flow', 'proof watermark', 'images off', 'missing private image fallback', 'print revalidation', 'repeated click guard', 'withdrawal clears DOM', 'public asset withdrawal clears DOM', 'public proof rejection', 'keyboard focus', 'mobile overflow'], paidRequests, errors }, null, 2));
  await browser.close(); server.close(); console.log('Edition print browser fixtures passed: ' + out);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.close(); });
