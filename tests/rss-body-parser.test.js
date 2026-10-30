'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { rssImportBodyParser, IMPORT_BODY_LIMIT } = require('../lib/rss-body-parser');
const { parseImport } = require('../lib/rss-format');

test('production parser ordering accepts bounded imports, including JSON escaping, without broadening other routes', async () => {
  const production = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  const scopedAt = production.indexOf("app.use(require('./lib/rss-body-parser').rssImportBodyParser());");
  const defaultAt = production.indexOf("app.use(express.json({ limit: '64kb' }));");
  assert.ok(scopedAt >= 0 && defaultAt > scopedAt, 'Production must mount the bounded import parser before the default parser');
  const app = express();
  app.use(rssImportBodyParser());
  app.use(express.json({ limit: '64kb' }));
  app.post(['/api/sources/import', '/api/sources/import-preview', '/api/sources/import-opml', '/api/sources/bulk-add'], async (req, res) => {
    try { res.json({ count: (await parseImport(req.body)).length }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/sources', (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Request rejected' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    const content = 'https://example.com/rss\n'.padEnd(500000, ' ');
    for (const path of ['/api/sources/import', '/api/sources/import-preview', '/api/sources/import-opml']) {
      assert.equal((await send(path, JSON.stringify({ format: 'urls', content }))).status, 200);
    }
    const escaped = '{"format":"urls","content":"' + [...content].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
    assert.ok(escaped.length > 2_000_000);
    assert.equal((await send('/api/sources/import-preview', escaped)).status, 200);
    assert.equal((await send('/api/sources/import', JSON.stringify({ content: content + ' ' }))).status, 400);
    assert.equal((await send('/api/sources/bulk-add', JSON.stringify({ sources: [{ url: 'https://example.com/rss', name: 'x'.repeat(500000) }] }))).status, 400);
    assert.equal((await send('/api/sources/import', JSON.stringify({ content: 'x'.repeat(IMPORT_BODY_LIMIT) }))).status, 413);
    assert.equal((await send('/api/sources', JSON.stringify({ content }))).status, 413);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
