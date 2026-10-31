/* Offline browser/PDF acceptance fixtures. No application credentials or external network.
 * PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome
 * node scripts/edition-print-qa.cjs /absolute/output/directory
 * Inspect generated PDFs using Poppler; no files are sent to a printer.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve(process.argv[2] || '../deployment/newspaper-print-qa');
fs.mkdirSync(out, { recursive: true });
const root = path.join(__dirname, '../public');
// Apply the actual server's configured Helmet directives, plus Helmet's defaults.
// In particular img-src intentionally excludes blob:; do not weaken it for fixtures.
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const configured = /directives:\s*(\{[\s\S]*?\n    \}),/.exec(serverSource);
assert.ok(configured, 'Production CSP directives must be available to the fixture');
const directives = vm.runInNewContext('(' + configured[1] + ')');
assert.deepEqual(Array.from(directives.imgSrc), ["'self'", 'data:', 'https:']);
const csp = Object.entries({ ...directives, formAction: ["'self'"], upgradeInsecureRequests: [] })
  .map(([key, values]) => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) + (values.length ? ' ' + values.join(' ') : '')).join(';');
let browser;
const lorem = 'The newsroom examines evidence carefully and gives each conclusion context. Editors compare primary sources, check dates, and preserve attribution before publication. Readers need clear explanations that distinguish verified findings from uncertainty. This fixture is synthetic text for print layout testing and contains no user content. A readable newspaper keeps paragraphs intact where practical, allows long stories to continue naturally, and never hides the end of an article. ';
const article = (id, paragraphs) => ({ article_id: id, title: id === 1 ? 'A considered view of a changing world' : 'What careful reporting makes possible', byline: 'Test Editor ' + id, category: id === 1 ? 'The lead / Analysis' : 'Research & practice', source_updated_at: '2026-10-30T12:00:00Z', image_path: id === 1 ? '/api/editions/11111111-1111-4111-8111-111111111111/assets/1' : null, content: 'START-ARTICLE-' + id + '\n\n' + Array.from({ length: paragraphs }, (_, n) => (n % 4 === 0 ? '## Evidence and perspective ' + n + '\n\n' : '') + lorem.repeat(2)).join('\n\n') + '\n\nEND-ARTICLE-' + id });
const base = { id: '11111111-1111-4111-8111-111111111111', name: 'The Daily Perspective', issue_date: '2026-10-30', status: 'finalized', mode: 'published', visibility: 'private', revision: 1, lead_article_id: 1, settings: { paper: 'Letter', images: true, ink_saving: false }, articles: [article(1, 2)] };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (!['/edition-print.html', '/edition-print.css', '/edition-print.js'].includes(name)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(fs.readFileSync(name === '/edition-print.js' && process.env.EDITION_PRINT_SCRIPT ? process.env.EDITION_PRINT_SCRIPT : path.join(root, name)));
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
      if ((url.pathname.includes('/assets/') || url.pathname.includes('/portraits/'))) return route.fulfill({ status: denyImage ? 410 : 200, contentType: 'image/png', body: denyImage ? '' : imageBody });
      return route.fulfill({ status: denyDetail ? 410 : 200, contentType: 'application/json', body: JSON.stringify(denyDetail ? { error: 'withdrawn' } : { edition: current }) });
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('deepfeedai_token', 'offline-fixture');
    window.editionCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.editionCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  });
  await page.goto(origin + '/edition-print.html?id=11111111-1111-4111-8111-111111111111');
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
    await page.goto(origin + '/edition-print.html?id=11111111-1111-4111-8111-111111111111' + (publicMode ? '&public=1' : ''));
    await page.waitForSelector('body.print-ready');
    await page.locator('#editionPrint').waitFor({ state: 'visible' });
  }
  async function decodedImages(expected) {
    assert.equal(await page.locator('.edition-figure img').count(), expected);
    assert.equal(await page.locator('.edition-figure img').evaluateAll(images => images.filter(image => !image.hidden && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length), expected);
    assert.deepEqual(await page.evaluate(() => window.editionCspViolations), []);
  }
  const fiveImages = (publicMode) => Array.from({ length: 5 }, (_, index) => ({ ...article(index + 1, 1), image_path: '/api/editions/' + (publicMode ? 'public/' : '') + '11111111-1111-4111-8111-111111111111/assets/' + (index + 1) }));
  if (process.env.EDITION_CSP_BASELINE === '1') {
    current = { ...structuredClone(base), visibility: 'public', articles: fiveImages(true) };
    await ready(true);
    assert.match(await page.locator('#editionStatus').innerText(), /^5 image\(s\) unavailable/);
    const violations = await page.evaluate(() => window.editionCspViolations);
    assert.equal(violations.filter(v => v.directive === 'img-src' && v.blocked === 'blob').length, 5);
    fs.writeFileSync(path.join(out, 'baseline-csp.json'), JSON.stringify({ status: await page.locator('#editionStatus').innerText(), violations, csp }, null, 2));
    console.log('Baseline reproduced: all five authenticated snapshot responses were blocked as blob images by production CSP.');
    return;
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
    if (current.settings.images && !denyImage) await decodedImages(current.articles.filter(a => a.image_path).length);
    if (denyImage) assert.match(await page.locator('#editionStatus').innerText(), /image\(s\) unavailable/);
    await page.pdf({ path: path.join(out, name + '.pdf'), printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    await page.screenshot({ path: path.join(out, name + '-screen.png'), fullPage: name === 'letter-short' });
  }
  // A failed private image fetch can be retried without recreating or refreshing the edition.
  denyImage = false; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').textContent.startsWith('Ready to preview'));
  await decodedImages(1);
  current = { ...structuredClone(base), mode: 'proof', articles: fiveImages(false) }; await ready(); await decodedImages(5);
  await page.pdf({ path: path.join(out, 'private-proof-five-images.pdf'), printBackground: true, preferCSSPageSize: true });
  current = { ...structuredClone(base), visibility: 'public', articles: fiveImages(true) }; await ready(true); await decodedImages(5);
  await page.pdf({ path: path.join(out, 'public-five-images.pdf'), printBackground: true, preferCSSPageSize: true });
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
  denyDetail = false; current.visibility = 'public'; current.articles[0].image_path = '/api/editions/public/11111111-1111-4111-8111-111111111111/assets/1'; await ready(true);
  denyImage = true; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  // Finalized proof can never render on the public route, even if an API regresses.
  denyImage = false; current.mode = 'proof'; await page.goto(origin + '/edition-print.html?id=11111111-1111-4111-8111-111111111111&public=1');
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  current = { ...structuredClone(base), articles: [{ article_id: 1, title: 'Summary-only article', content: 'Saved summary', text_kind: 'excerpt' }] };
  await ready(); assert.match(await page.locator('.edition-excerpt').innerText(), /full text is not included/);
  current = { ...structuredClone(base), settings: { paper: 'Letter', images: false, ink_saving: false }, articles: [{ article_id: 1, title: 'Formatted editorial snapshot', content: '## Evidence and context\nA **bold claim** with *careful emphasis*, \x60inline code\x60 and a [source](https://example.invalid/report). References [1][2] remain literal.\n\n1. First item\n2. Second item\n\n> A quoted observation\n\n\x60\x60\x60\n' + 'long_unbroken_code_'.repeat(18) + '\n\x60\x60\x60' }] };
  await ready();
  assert.equal(await page.locator('.edition-body strong').innerText(), 'bold claim');
  assert.equal(await page.locator('.edition-body em').innerText(), 'careful emphasis');
  assert.equal(await page.locator('.edition-body h3').innerText(), 'Evidence and context');
  assert.equal(await page.locator('.edition-body a').getAttribute('href'), 'https://example.invalid/report');
  assert.equal(await page.locator('.edition-body ol li').count(), 2);
  assert.match(await page.locator('.edition-body').innerText(), /References \[1\]\[2\] remain literal/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.pdf({ path: path.join(out, 'markdown-formatting.pdf'), printBackground: true, preferCSSPageSize: true });
  await page.screenshot({ path: path.join(out, 'markdown-mobile.png'), fullPage: true });
  // Saved per-article mappings remain distinct even when citation numbers repeat.
  const referenceArticles = [51, 52].map(articleId => ({
    article_id: articleId, title: 'Sourced editorial snapshot ' + articleId,
    content: 'Verified reporting [1][2]. Unresolved historical marker [9].',
    references: [
      { number: 1, title: 'Source <one>', publisher: 'Fixture Journal', url: 'https://example.invalid/article-' + articleId + '/source-one' },
      { number: 2, title: 'Source two', publisher: 'Fixture Review', url: 'https://example.invalid/article-' + articleId + '/source-two' },
      { number: 3, title: '<img onerror=alert(1)>', publisher: '<script>no</script>', url: 'https://example.invalid/?token=DO_NOT_PRINT_TOKEN', warning: 'URL omitted for safety' }
    ]
  }));
  for (const mode of ['proof', 'published']) {
    current = { ...structuredClone(base), mode, visibility: mode === 'published' ? 'public' : 'private', settings: { paper: 'Letter', images: false, ink_saving: false }, articles: referenceArticles };
    await ready(mode === 'published');
    assert.equal(await page.locator('.edition-citation').count(), 4);
    assert.equal(await page.locator('.edition-source-url').count(), 4);
    assert.equal(await page.locator('.edition-sources img,.edition-sources script').count(), 0);
    const ids = await page.locator('.edition-sources [id]').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const articleId of [51, 52]) {
      await page.locator('a[href="#edition-ref-' + articleId + '-1"]').click();
      assert.equal(new URL(page.url()).hash, '#edition-ref-' + articleId + '-1');
      assert.equal(await page.locator('#edition-ref-' + articleId + '-1 .edition-source-url').innerText(), 'https://example.invalid/article-' + articleId + '/source-one');
    }
    assert.match(await page.locator('#editionPaper').innerText(), /Source details unavailable for \[9\]/);
    assert.doesNotMatch(await page.locator('#editionPaper').innerText(), /DO_NOT_PRINT_TOKEN/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.pdf({ path: path.join(out, 'sources-' + mode + '.pdf'), printBackground: true, preferCSSPageSize: true });
    await page.screenshot({ path: path.join(out, 'sources-' + mode + '-mobile.png'), fullPage: true });
  }
  // Contributor snapshots: actual portrait decoding under production CSP and flowing PDFs.
  const profile = { writer_id: 3, name: 'Amina / fixture persona', kind: 'ai_persona', role: 'writer', focus: 'Business', bio: ('This configured persona focuses on explaining business and technology. ').repeat(25), contribution: 'Assigned writer for this article', profile_version: 'fixture-v1' };
  for (const paper of ['Letter', 'A4']) {
    const portrait = '/api/editions/11111111-1111-4111-8111-111111111111/portraits/1';
    current = { ...structuredClone(base), mode: 'proof', settings: { paper, images: true, ink_saving: paper === 'A4', portraits: true, contributors: true }, articles: [1, 2].map(id => ({ ...article(id, 1), contributor: profile, portrait_path: portrait })), contributors: [{ writer_id: 3, article_count: 2, versions: [{ ...profile, portrait_path: portrait, article_ids: [1, 2] }] }] };
    await ready();
    assert.equal(await page.locator('.edition-portrait img').evaluateAll(images => images.filter(i => !i.hidden && i.naturalWidth > 0).length), 3);
    assert.equal(await page.locator('.edition-contributor-card').count(), 1);
    assert.match(await page.locator('.edition-contributor-count').innerText(), /Assigned to 2 articles/);
    assert.deepEqual(await page.evaluate(() => window.editionCspViolations), []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, 'contributors-' + paper + '-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1300, height: 1000 });
    await page.screenshot({ path: path.join(out, 'contributors-' + paper + '-desktop.png'), fullPage: true });
    await page.pdf({ path: path.join(out, 'contributors-' + paper + '.pdf'), printBackground: true, preferCSSPageSize: true });
    await page.locator('.edition-contributor-card a').first().click();
    assert.equal(new URL(page.url()).hash, '#edition-article-1');
    await page.setViewportSize({ width: 390, height: 844 });
  }
  denyImage = true; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').textContent.includes('unavailable'));
  assert.match(await page.locator('.edition-contributor-count').innerText(), /2 articles/);
  denyImage = false; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').textContent.startsWith('Ready'));
  assert.equal(await page.locator('.edition-portrait img:not([hidden])').count(), 3);
  current.mode = 'published'; current.visibility = 'public';
  current.articles.forEach(a => { if (a.image_path) a.image_path = a.image_path.replace('/editions/', '/editions/public/'); a.portrait_path = a.portrait_path.replace('/editions/', '/editions/public/'); });
  current.contributors[0].versions[0].portrait_path = '/api/editions/public/11111111-1111-4111-8111-111111111111/portraits/1';
  await ready(true); assert.equal(await page.locator('.edition-portrait img:not([hidden])').count(), 3);
  denyImage = true; await page.locator('#editionReload').click();
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  denyImage = false;
  current.settings.images = false; await ready(true); assert.equal(await page.locator('.edition-portrait').count(), 0);
  current.settings.contributors = false; await ready(true); assert.equal(await page.locator('.edition-contributors').count(), 0);
  const beforeNumericPublic = requestCount;
  await page.goto(origin + '/edition-print.html?id=1&public=1');
  await page.waitForFunction(() => document.getElementById('editionStatus').classList.contains('error'));
  assert.equal(requestCount, beforeNumericPublic); assert.equal(await page.locator('#editionPaper').innerHTML(), '');
  current = structuredClone(base); await page.goto(origin + '/edition-print.html?id=1'); await page.waitForSelector('body.print-ready');
  assert.equal(new URL(page.url()).searchParams.get('id'), base.id);
  // Layout matrix: real PDFs, both paper sizes, synthetic captured text only.
  const layoutCases = [];
  for (const format of ['newspaper', 'morning-brief', 'large-print', 'magazine']) {
    for (const paper of ['Letter', 'A4']) {
      for (const variant of ['short', 'long', 'missing', 'ink']) {
        const name = 'layout-' + format + '-' + paper + '-' + variant;
        layoutCases.push(name);
        const long = variant === 'long';
        const fixtureArticles = [1, 2].map(id => ({
          ...article(id, long ? 8 : 1),
          summary: id === 1 ? 'Saved description with supported evidence [1].' : '',
          contributor: profile,
          references: [{ number: 1, title: 'Saved supporting source', publisher: 'Fixture Journal', url: 'https://example.invalid/' + 'long-source-path-'.repeat(35) }]
        }));
        fixtureArticles[1].content = 'A safe fallback excerpt with citation [1].\n\n' + fixtureArticles[1].content + '\n\n```\n' + 'long_code_'.repeat(65) + '\n```\n\n| Literal table | cell |\n| --- | --- |\n| one | two |\n\n<script>window.hostileExecuted=true</script>';
        current = { ...structuredClone(base), mode: 'proof', settings: { format, paper, images: variant !== 'ink', ink_saving: variant === 'ink', sources: variant !== 'ink', contributors: true, portraits: false }, articles: fixtureArticles, contributors: [{ writer_id: 3, article_count: 2, versions: [{ ...profile, article_ids: [1, 2] }] }] };
        denyImage = variant === 'missing';
        await page.setViewportSize({ width: 1300, height: 1000 });
        await ready();
        assert.equal(await page.locator('.edition-article').count(), 2);
        assert.equal(await page.locator('.edition-contributor-card').count(), 1);
        assert.equal(await page.evaluate(() => window.hostileExecuted), undefined);
        assert.deepEqual(await page.evaluate(() => window.editionCspViolations), []);
        if (variant === 'ink') assert.equal(await page.locator('.edition-figure,.edition-sources').count(), 0);
        await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.print-toolbar').isVisible(), false);
        if (format === 'large-print') {
          assert.equal(await page.locator('.edition-body').first().evaluate(e => getComputedStyle(e).columnCount), 'auto');
          assert.ok(await page.locator('.edition-body').first().evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 20));
        }
        await page.pdf({ path: path.join(out, name + '.pdf'), printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
        await page.emulateMedia({ media: 'screen' });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' mobile overflow');
      }
    }
  }
  fs.writeFileSync(path.join(out, 'layout-results.json'), JSON.stringify({ cases: layoutCases, browser: await browser.version(), checks: ['both paper sizes', 'short and long captured articles', 'saved description and deterministic fallback', 'missing images', 'images and sources off', 'ink saving', 'contributors', 'long URL and code', 'literal unsupported tables', 'hostile markup inert', 'print controls hidden', 'large print single column and size', 'mobile overflow'] }, null, 2));
  denyImage = false;
  for (const publicMode of [false, true]) {
    current = { ...structuredClone(base), visibility: publicMode ? 'public' : 'private', settings: { format: 'morning-brief', paper: 'Letter', images: false, ink_saving: false }, articles: [article(1, 2), article(2, 1)] };
    await ready(publicMode);
    assert.doesNotMatch(await page.locator('.edition-body').first().innerText(), /END-ARTICLE-1/);
    await page.locator('.edition-full-link a').first().click();
    await page.waitForSelector('body.print-ready');
    assert.equal(new URL(page.url()).searchParams.get('article'), '1');
    assert.equal(new URL(page.url()).searchParams.get('public'), publicMode ? '1' : null);
    assert.equal(await page.locator('.edition-article').count(), 1);
    assert.match(await page.locator('.edition-body').innerText(), /END-ARTICLE-1/);
    assert.match(await page.locator('.edition-view-label').innerText(), /FULL SAVED ARTICLE VIEW/);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.print-toolbar').isVisible(), false);
    await page.pdf({ path: path.join(out, 'full-article-' + (publicMode ? 'public' : 'private') + '.pdf'), printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: 'screen' });
    await page.locator('.edition-return-link').click();
    await page.waitForSelector('body.print-ready');
    assert.equal(new URL(page.url()).searchParams.get('article'), null);
    assert.equal(new URL(page.url()).searchParams.get('public'), publicMode ? '1' : null);
    assert.equal(await page.locator('.edition-article').count(), 2);
  }
  assert.equal(paidRequests, 0); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ browser: await browser.version(), cases: cases.map(([name]) => name), paperSizes: ['Letter', 'A4'], mobileWidth: 390, csp, checked: ['production CSP enforced', 'five private proof images decoded', 'five public images decoded', 'image fetch retry without snapshot mutation', 'safe Markdown formatting and literal citation markers', 'saved source footers', 'per-article citation anchors', 'unknown source warnings', 'unsafe source URLs omitted', 'safe paper flow', 'proof watermark', 'images off', 'missing private image fallback', 'print revalidation', 'repeated click guard', 'withdrawal clears DOM', 'public asset withdrawal clears DOM', 'public proof rejection', 'keyboard focus', 'mobile overflow', 'contributor snapshot portraits', 'contributor Letter/A4 PDFs', 'deduplicated profiles', 'portrait retry and images-off'], paidRequests, errors }, null, 2));
  await browser.close(); server.close(); console.log('Edition print browser fixtures passed: ' + out);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.close(); });
