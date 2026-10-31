'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const print = require('../public/edition-print');
const id = '11111111-1111-4111-8111-111111111111';
const edition = { id, name: 'Layout fixture', mode: 'published', status: 'finalized', settings: {}, articles: [{ article_id: 3, title: 'Saved story', byline: 'Saved Writer', content: 'Opening evidence [7].\n\n' + 'Further evidence. '.repeat(100) + 'FINAL-TEXT', summary: 'Captured description [7].', references: [{ number: 7, title: 'Original source', url: 'https://example.org/evidence' }] }] };
test('legacy and invalid formats default to unchanged full newspaper presentation', () => {
  for (const format of [undefined, 'booklet', '__proto__', '<script>']) {
    const value = { ...edition, settings: { format } };
    assert.deepEqual(print.layoutSettings(value), { format: 'newspaper', excerpt: false, sources: true });
    assert.match(print.paperMarkup(value), /FINAL-TEXT/);
  }
});
test('Morning Brief uses captured descriptions and never changes input snapshots', () => {
  const value = structuredClone(edition); value.settings.format = 'morning-brief';
  const before = JSON.stringify(value), result = print.paperMarkup(value, { publicMode: true });
  assert.match(result, /EXCERPT \/ Saved article description/);
  assert.match(result, /Captured description \[7\]/); assert.match(result, /Original source/);
  assert.doesNotMatch(result, /FINAL-TEXT/); assert.match(result, /Read full saved article/);
  assert.match(result, /id=11111111-1111-4111-8111-111111111111&amp;public=1&amp;article=3/);
  assert.equal(JSON.stringify(value), before);
});
test('fallback excerpts are bounded literal text with intact numbered markers and hostile markup inert', () => {
  const article = { ...edition.articles[0], summary: '', content: '<script>alert(1)</script> `code[7]` ' + 'word '.repeat(200) };
  const value = { ...edition, settings: { format: 'morning-brief' }, articles: [article] };
  const selected = print.excerptText(article);
  assert.ok(selected.shortened); assert.ok(selected.text.length <= 900);
  const result = print.paperMarkup(value);
  assert.match(result, /Opening text from saved article \(shortened\)/);
  assert.match(result, /&lt;script&gt;/); assert.doesNotMatch(result, /<script\b[^>]*>|class="edition-citation"/i);
  assert.match(result, /code\[7\]/);
  const boundary = print.excerptText({ content: 'x'.repeat(898) + '[7]' });
  assert.equal(boundary.text, 'x'.repeat(898));
  assert.equal(print.excerptText({ content: '[' + '0'.repeat(2000) }).text.length, 900);
  assert.ok(print.excerptText({ content: '[' + 'word '.repeat(300) }).text.startsWith('[word '));
});
test('sources off retains citation text and attribution without dead citation links', () => {
  const result = print.paperMarkup({ ...edition, settings: { sources: false } });
  assert.match(result, /Saved Writer/); assert.match(result, /\[7\]/); assert.match(result, /Sources omitted/);
  assert.doesNotMatch(result, /class="edition-citation"|class="edition-sources"/);
});
test('full saved article view is authorized through the same edition and is explicitly labeled', () => {
  const value = { ...edition, mode: 'proof', settings: { format: 'morning-brief' } };
  const result = print.paperMarkup(value, { article: '3' });
  assert.match(result, /FULL SAVED ARTICLE VIEW/); assert.match(result, /Return to complete edition/);
  assert.match(result, /FINAL-TEXT/); assert.match(result, /DRAFT \/ PRIVATE EDITORIAL PROOF/);
  assert.match(result, /href="#edition-ref-3-7"/);
  for (const article of ['0', '-3', '03', '3x', '<script>', '999', '9007199254740993']) {
    assert.equal(print.selectedArticle(value, article), null);
    assert.doesNotMatch(print.paperMarkup(value, { article }), /FULL SAVED ARTICLE VIEW|FINAL-TEXT/);
  }
});
test('all formats honor paper-independent choices and explicit excerpt mode', () => {
  for (const paper of ['Letter', 'A4']) for (const format of ['newspaper', 'morning-brief', 'large-print', 'magazine']) {
    const value = { ...edition, settings: { paper, format, content_mode: 'excerpt', images: false, ink_saving: true } };
    assert.equal(print.normalizedSettings(value).paper, paper);
    assert.equal(print.layoutSettings(value).format, format);
    assert.match(print.paperMarkup(value), /EXCERPT/); assert.doesNotMatch(print.paperMarkup(value), /<img/);
  }
});
