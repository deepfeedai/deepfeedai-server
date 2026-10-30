'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const print = require('../public/edition-print');
const edition = { id: 1, name: 'The Weekly', issue_date: '2026-10-30', status: 'finalized', mode: 'published', visibility: 'private', lead_article_id: 2, settings: { paper: 'Letter', images: true, ink_saving: false }, articles: [{ article_id: 1, title: 'First article', content: 'Paragraph one.\n\n## Section\n\nParagraph two.', byline: 'Editor One' }, { article_id: 2, title: 'Lead article', content: 'Lead text', byline: 'Editor Two' }] };
test('Edition print safely renders plain text, headings and lists without interpreting HTML', () => {
  const markup = print.paperMarkup({ ...edition, name: '<img src=x onerror=alert(1)>', articles: [{ article_id: 1, title: '<script>alert(1)</script>', byline: 'A&B', content: '<iframe src=//evil.invalid></iframe>\r\n\r\n## A heading\r\n\r\n- one\r\n- two' }] });
  assert.ok(!markup.includes('<script>')); assert.ok(!markup.includes('<iframe')); assert.ok(markup.includes('&lt;script&gt;')); assert.ok(markup.includes('A&amp;B'));
  assert.ok(markup.includes('<h3>A heading</h3>')); assert.ok(markup.includes('<ul><li>one</li><li>two</li></ul>'));
});
test('Edition print retains saved order and emphasizes only the designated lead', () => {
  const markup = print.paperMarkup(edition);
  assert.ok(markup.indexOf('First article') < markup.indexOf('Lead article'));
  assert.equal((markup.match(/class="edition-article lead"/g) || []).length, 1);
  assert.ok(markup.includes('Editor One')); assert.ok(markup.includes('October 30, 2026'));
});
test('Every working edition and private proof is visibly marked DRAFT; finalized reader edition is not', () => {
  assert.ok(print.isProof({ ...edition, mode: 'proof' })); assert.ok(print.isProof({ ...edition, status: 'working' }));
  assert.equal(print.isProof(edition), false);
  assert.match(print.paperMarkup({ ...edition, mode: 'proof' }), /DRAFT \/ PRIVATE EDITORIAL PROOF/);
  assert.doesNotMatch(print.paperMarkup(edition), /DRAFT \/ PRIVATE/);
});
test('Print settings are bounded and images-off removes all image placeholders and notices', () => {
  assert.deepEqual(print.normalizedSettings({ settings: { paper: 'A4', ink_saving: true, images: false } }), { paper: 'A4', ink: true, images: false });
  assert.equal(print.normalizedSettings({ settings: { paper: 'A4; url(evil)' } }).paper, 'Letter');
  const markup = print.paperMarkup({ ...edition, settings: { images: false }, articles: [{ article_id: 1, image_path: '/api/editions/1/assets/1', image_notice: 'A missing image', content: 'Text retained' }] });
  assert.doesNotMatch(markup, /<img|<figure|A missing image/); assert.match(markup, /Text retained/);
});
test('Private archive withdrawal notice is explicit and image paths cannot leak authorization to another route', () => {
  assert.match(print.paperMarkup({ ...edition, articles: [{ article_id: 1, withdrawn: true, content: 'Archived text' }] }), /no longer publicly available/);
  assert.equal(print.safeAssetPath('/api/editions/1/assets/22', false), '/api/editions/1/assets/22');
  assert.equal(print.safeAssetPath('/api/editions/public/1/assets/22', true), '/api/editions/public/1/assets/22');
  for (const route of ['https://evil.invalid/a.png', '//evil.invalid', '/api/editions/1/assets/22?secret=x', '/api/editions/../settings', '/api/editions/1/assets/%2e%2e', '/api/editions/public/1/assets/22']) assert.equal(print.safeAssetPath(route, false), null);
  assert.equal(print.safeAssetPath('/api/editions/1/assets/22', true), null);
});
test('Print stylesheet allows flowing multipage columns and hides controls, with no simulated page numbers', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/edition-print.css'), 'utf8');
  assert.match(css, /@page\s*\{\s*size: Letter/); assert.match(css, /@media print/); assert.match(css, /widows: 3; orphans: 3/);
  assert.match(css, /body:not\(\.print-ready\) \.edition-paper/); assert.match(css, /\.print-toolbar,\.print-guidance/);
  assert.doesNotMatch(css, /counter\(page\)|overflow:\s*hidden|height:\s*11in/);
});
test('Summary-only snapshot fallback is explicitly labeled as an excerpt', () => {
  assert.match(print.paperMarkup({ ...edition, articles: [{ article_id: 1, content: 'A saved summary', text_kind: 'excerpt' }] }), /EXCERPT \/ Saved article summary; full text is not included/);
  assert.match(print.paperMarkup({ ...edition, articles: [{ article_id: 1, summary: 'Legacy summary without content' }] }), /EXCERPT/);
  assert.doesNotMatch(print.paperMarkup(edition), /EXCERPT/);
});
