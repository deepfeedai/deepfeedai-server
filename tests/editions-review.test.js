'use strict';
// Independent boundary checks: local disposable files only, no database or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const editions = require('../lib/editions');
const print = require('../public/edition-print');

test('edition media cannot traverse or borrow another workspace asset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edition-review-'));
  const prior = process.env.STORAGE_LOCAL_DIR;
  try {
    process.env.STORAGE_LOCAL_DIR = root;
    await fs.mkdir(path.join(root, 'tenants', '1'), { recursive: true });
    await fs.mkdir(path.join(root, 'tenants', '2'), { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9kAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(root, 'tenants', '1', 'own.png'), png);
    await fs.writeFile(path.join(root, 'tenants', '2', 'private.png'), png);
    const own = await editions.localImage('/media/tenants/1/own.png', 1);
    assert.equal(own.image_mime, 'image/png');
    assert.deepEqual(own.image_data, png);
    for (const url of [
      '/media/tenants/2/private.png',
      '/media/tenants/1/../2/private.png',
      '/media/tenants/1/%2e%2e/2/private.png',
      '/media/tenants/1/%2e%2e%2f2/private.png',
      '/media/tenants/1/%2e%2e%5c2%5cprivate.png',
      '/media/tenants/1/own.png?download=1',
      'https://attacker.invalid/media/tenants/1/own.png',
      'file:///media/tenants/1/own.png',
    ]) {
      const result = await editions.localImage(url, 1);
      assert.equal(result.image_data, undefined, url);
      assert.match(result.image_notice, /omitted/i);
    }
    await fs.writeFile(path.join(root, 'tenants', '1', 'fake.png'), '<svg onload="alert(1)"></svg>');
    assert.equal((await editions.localImage('/media/tenants/1/fake.png', 1)).image_data, undefined);
  } finally {
    if (prior === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('article HTML and encoded markup remain inert in the print renderer', () => {
  const content = editions.text('<h1>Coverage</h1><script>SECRET_EXECUTION()</script><p>Safe &lt;img src=x onerror=alert(1)&gt;</p>');
  const html = print.paperMarkup({
    name: '<img src=x onerror=alert(1)>', issue_date: '2026-10-30', mode: 'proof', status: 'working',
    settings: { paper: 'Letter', ink_saving: false, images: false },
    articles: [{ article_id: 1, title: '</h2><script>alert(1)</script>', byline: '<iframe>', content }],
  });
  assert.ok(!html.includes('SECRET_EXECUTION'));
  assert.ok(!/<script|<iframe|<img\s/i.test(html));
  assert.match(html, /&lt;img/);
  assert.match(html, /DRAFT/);
});

test('private and public print assets cannot cross authorization namespaces', () => {
  assert.equal(print.safeAssetPath('/api/editions/public/11111111-1111-4111-8111-111111111111/assets/2', false), null);
  assert.equal(print.safeAssetPath('/api/editions/11111111-1111-4111-8111-111111111111/assets/2', true), null);
  for (const value of ['//attacker.invalid/x', 'https://attacker.invalid/x', '/api/editions/11111111-1111-4111-8111-111111111111/assets/2?token=x', '/api/editions/../secrets', '/api/editions/11111111-1111-4111-8111-111111111111/assets/2/../../public/1']) {
    assert.equal(print.safeAssetPath(value, false), null, value);
  }
  assert.equal(print.safeAssetPath('/api/editions/11111111-1111-4111-8111-111111111111/assets/2', false), '/api/editions/11111111-1111-4111-8111-111111111111/assets/2');
});

function mockPreview(fetch) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, innerHTML: '', textContent: '', hidden: false, disabled: false,
      handlers: {}, addEventListener(name, callback) { this.handlers[name] = callback; },
    });
    return elements.get(id);
  };
  const classes = new Set(['print-ready']);
  const document = {
    getElementById: element,
    body: { classList: { remove: name => classes.delete(name), add: name => classes.add(name) } },
    addEventListener() {},
  };
  const state = { timer: null, prints: 0 };
  const win = {
    document, location: { search: '?id=1', pathname: '/edition-print.html', assign() { throw Error('Unexpected navigation'); } },
    localStorage: { getItem: () => 'offline-test-token' },
    AbortController, URL: { revokeObjectURL() {} }, fetch,
    setTimeout(callback) { state.timer = callback; return 1; }, clearTimeout() {},
    addEventListener() {}, print() { state.prints++; },
    requestAnimationFrame: callback => callback(),
  };
  element('editionPaper').innerHTML = 'Stale private article';
  return { win, state, element, classes };
}

test('expired private preview removes stale text and never opens print', async () => {
  const mock = mockPreview(async () => ({ ok: false, status: 401 }));
  const controller = print.boot(mock.win);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.ready, false);
  assert.equal(mock.element('editionPaper').innerHTML, '');
  assert.equal(mock.element('editionPaper').hidden, true);
  assert.match(mock.element('editionStatus').textContent, /session has expired/i);
  await mock.element('editionPrint').handlers.click();
  assert.equal(mock.state.prints, 0);
});

test('timed-out preview clears content and returns a usable retry control', async () => {
  const mock = mockPreview((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const controller = print.boot(mock.win);
  mock.state.timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.ready, false);
  assert.equal(mock.element('editionPaper').innerHTML, '');
  assert.equal(mock.element('editionPrint').disabled, true);
  assert.equal(mock.element('editionReload').disabled, false);
  assert.match(mock.element('editionStatus').textContent, /timed out.*retry/i);
});
