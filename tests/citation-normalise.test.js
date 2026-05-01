/**
 * Citation normalisation tests.
 *   node --test tests/citation-normalise.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const {
  normaliseMultiSourceCitations,
  expandPriorCoverageTags,
  normaliseCitations,
} = require('../lib/citation-normalise');

// ── Multi-source normalisation ──────────────────────────────
test('single-number brackets are left alone', () => {
  assert.equal(normaliseMultiSourceCitations('see [1] and [2]'), 'see [1] and [2]');
  assert.equal(normaliseMultiSourceCitations('[42]'), '[42]');
});

test('comma-separated citations split into individual brackets', () => {
  assert.equal(normaliseMultiSourceCitations('claim [1, 2, 3, 5]'), 'claim [1][2][3][5]');
  assert.equal(normaliseMultiSourceCitations('[1,2,3]'), '[1][2][3]');
  assert.equal(normaliseMultiSourceCitations('[1,  2 , 3]'), '[1][2][3]');
});

test('hyphen ranges expand up to 20 elements', () => {
  assert.equal(normaliseMultiSourceCitations('[1-3]'), '[1][2][3]');
  // En-dash + em-dash also accepted
  assert.equal(normaliseMultiSourceCitations('[1–3]'), '[1][2][3]');
  assert.equal(normaliseMultiSourceCitations('[2—4]'), '[2][3][4]');
});

test('absurdly large ranges are left alone (safety)', () => {
  const out = normaliseMultiSourceCitations('[1-999]');
  assert.equal(out, '[1-999]');
});

test('invalid ranges are left alone', () => {
  assert.equal(normaliseMultiSourceCitations('[5-3]'), '[5-3]'); // backwards
});

test('mixed commas + ranges work together', () => {
  assert.equal(normaliseMultiSourceCitations('[1, 3-5, 8]'), '[1][3][4][5][8]');
});

test('space-separated numbers split correctly', () => {
  assert.equal(normaliseMultiSourceCitations('[1 2 3]'), '[1][2][3]');
});

test('non-numeric bracket content is left alone', () => {
  assert.equal(normaliseMultiSourceCitations("[Raj's prior coverage]"), "[Raj's prior coverage]");
  assert.equal(normaliseMultiSourceCitations('[as noted]'), '[as noted]');
});

test('handles the exact example from the bug report', () => {
  const input = 'persistent demand for skilled human researchers and administrators [1, 2, 3, 5] alongside the strategic formation of regional AI consortia [4]';
  const expected = 'persistent demand for skilled human researchers and administrators [1][2][3][5] alongside the strategic formation of regional AI consortia [4]';
  assert.equal(normaliseMultiSourceCitations(input), expected);
});

// ── Prior-coverage tag expansion ────────────────────────────
test('[@ID] expands to markdown link when writer has the article', () => {
  const priorArticles = [{ id: 42, slug: 'ai-agents-rising', title: 'AI Agents Rising' }];
  const out = expandPriorCoverageTags(
    'As I noted [@42], the trend continues.',
    priorArticles,
    'https://acme.example.com',
  );
  assert.equal(out, 'As I noted [AI Agents Rising](https://acme.example.com/article/ai-agents-rising), the trend continues.');
});

test('[@ID|custom label] uses the override label', () => {
  const priorArticles = [{ id: 42, slug: 'ai-agents-rising', title: 'AI Agents Rising' }];
  const out = expandPriorCoverageTags('as I argued [@42|last week], this is inevitable.', priorArticles, 'https://x.com');
  assert.equal(out, 'as I argued [last week](https://x.com/article/ai-agents-rising), this is inevitable.');
});

test('unresolved [@ID] falls back gracefully', () => {
  const out = expandPriorCoverageTags('see [@999], the old piece', [], 'https://x.com');
  assert.equal(out, 'see [@999], the old piece'); // tag left as-is
});

test('unresolved [@ID|label] keeps the italicised label', () => {
  const out = expandPriorCoverageTags('see [@999|my prior piece] for context', [], 'https://x.com');
  assert.equal(out, 'see _my prior piece_ for context');
});

test('handles multiple prior-coverage tags in one body', () => {
  const priorArticles = [
    { id: 1, slug: 'a', title: 'Piece A' },
    { id: 2, slug: 'b', title: 'Piece B' },
  ];
  const out = expandPriorCoverageTags(
    'first I said [@1], then I said [@2].',
    priorArticles,
    'https://x.com',
  );
  assert.equal(out, 'first I said [Piece A](https://x.com/article/a), then I said [Piece B](https://x.com/article/b).');
});

test('siteUrl with trailing slash is stripped', () => {
  const priorArticles = [{ id: 1, slug: 'a', title: 'A' }];
  const out = expandPriorCoverageTags('[@1]', priorArticles, 'https://x.com/');
  assert.equal(out, '[A](https://x.com/article/a)');
});

// ── Full pipeline ───────────────────────────────────────────
test('normaliseCitations chains both passes', () => {
  const priorArticles = [{ id: 42, slug: 'ai-tools', title: 'AI Tools Deep Dive' }];
  const input = 'As I\'ve noted [@42], the confluence of trends [1, 2, 3, 5] suggests shifts [4].';
  const out = normaliseCitations(input, { priorArticles, siteUrl: 'https://acme.com' });
  assert.ok(out.includes('[AI Tools Deep Dive](https://acme.com/article/ai-tools)'));
  assert.ok(out.includes('[1][2][3][5]'));
  assert.ok(out.includes('[4]'));
});

test('empty + null text handled safely', () => {
  assert.equal(normaliseMultiSourceCitations(''), '');
  assert.equal(normaliseMultiSourceCitations(null), null);
  assert.equal(normaliseCitations(undefined, { priorArticles: [] }), undefined);
});
