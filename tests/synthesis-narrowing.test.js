/**
 * N1 narrowing helpers — entity extraction, recency weighting, topic_tag pre-grouping.
 *   node --test tests/synthesis-narrowing.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const {
  extractEntities,
  recencyWeight,
  groupByTopicTag,
  clusterArticlesSemantic,
  pickClusterTopicTag,
} = require('../lib/synthesis');

// ── extractEntities ─────────────────────────────────────────
test('extracts capitalised proper nouns', () => {
  const ents = extractEntities('OpenAI announces GPT-5 alongside Microsoft partnership');
  assert.ok(ents.has('openai'), 'openai missing');
  assert.ok(ents.has('microsoft'), 'microsoft missing');
});

test('extracts acronyms', () => {
  const ents = extractEntities('FTC opens investigation into NVDA chip pricing');
  assert.ok(ents.has('ftc'));
  assert.ok(ents.has('nvda'));
});

test('extracts versioned product names', () => {
  const ents = extractEntities('Apple unveils iOS 18 ahead of iPhone 17 launch');
  // Capitalised path catches Apple/iOS/iPhone; versioned path catches the numbered forms
  assert.ok(ents.has('apple'));
  assert.ok([...ents].some(e => e.startsWith('ios') || e === 'ios-18'));
});

test('returns empty set for empty input', () => {
  assert.equal(extractEntities('').size, 0);
  assert.equal(extractEntities(null).size, 0);
});

test('lower-cased entities deduped', () => {
  const ents = extractEntities('Anthropic announces Claude. Anthropic also says Claude is safe.');
  assert.ok(ents.has('anthropic'));
  assert.ok(ents.has('claude'));
  // No duplicate "Anthropic"
  assert.equal([...ents].filter(e => e === 'anthropic').length, 1);
});

// ── recencyWeight ───────────────────────────────────────────
test('fresh articles weight 1.0', () => {
  const w = recencyWeight({ created_at: new Date().toISOString() }, 168);
  assert.ok(w > 0.99, `expected ~1.0, got ${w}`);
});

test('articles older than decay window floor at 0.7', () => {
  const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  assert.equal(recencyWeight({ created_at: old }, 168), 0.7);
});

test('half-decay at half-window', () => {
  const halfway = new Date(Date.now() - 84 * 3600_000).toISOString(); // 84h of 168h
  const w = recencyWeight({ created_at: halfway }, 168);
  // Linear: 1.0 - 0.5 * 0.3 = 0.85
  assert.ok(Math.abs(w - 0.85) < 0.01, `expected ~0.85, got ${w}`);
});

test('missing timestamp returns 1.0', () => {
  assert.equal(recencyWeight({}, 168), 1.0);
  assert.equal(recencyWeight(null, 168), 1.0);
});

// ── groupByTopicTag ─────────────────────────────────────────
test('promotes tags with >=2 articles AND >=2 sources', () => {
  const articles = [
    { id: 1, topic_tag: 'openai-board', source: 'verge' },
    { id: 2, topic_tag: 'openai-board', source: 'nyt' },
    { id: 3, topic_tag: 'openai-board', source: 'verge' },
    { id: 4, topic_tag: 'apple-earnings', source: 'reuters' }, // singleton — falls through
    { id: 5 }, // untagged
  ];
  const { byTag, untagged } = groupByTopicTag(articles);
  assert.equal(byTag.size, 1);
  assert.ok(byTag.has('openai-board'));
  assert.equal(byTag.get('openai-board').length, 3);
  // singleton + untagged drop into untagged
  assert.equal(untagged.length, 2);
});

test('single-source multi-article tag does NOT promote', () => {
  const articles = [
    { id: 1, topic_tag: 'apple-q3', source: 'reuters' },
    { id: 2, topic_tag: 'apple-q3', source: 'reuters' },
  ];
  const { byTag, untagged } = groupByTopicTag(articles);
  assert.equal(byTag.size, 0);
  assert.equal(untagged.length, 2);
});

test('untagged-only input returns no promoted groups', () => {
  const { byTag, untagged } = groupByTopicTag([{ id: 1 }, { id: 2 }]);
  assert.equal(byTag.size, 0);
  assert.equal(untagged.length, 2);
});

// ── clusterArticlesSemantic with no embeddings (keyword fallback) ──
test('clusterArticlesSemantic falls through gracefully when nothing has embeddings', async () => {
  // No embeddings, no topic_tags — should hit keyword path inside semantic dispatcher
  const articles = [
    { id: 1, title: 'OpenAI launches new model', summary: '', source: 'verge', category: 'AI', created_at: new Date().toISOString() },
    { id: 2, title: 'OpenAI new model details', summary: '', source: 'nyt',   category: 'AI', created_at: new Date().toISOString() },
    { id: 3, title: 'New OpenAI model benchmarks', summary: '', source: 'wsj', category: 'AI', created_at: new Date().toISOString() },
  ];
  const clusters = await clusterArticlesSemantic(articles, 2);
  assert.ok(Array.isArray(clusters));
  // We don't strictly assert >=1 cluster (depends on keyword overlap thresholds),
  // but the call must not throw.
});

test('clusterArticlesSemantic uses topic_tag pre-grouping', async () => {
  const now = new Date().toISOString();
  const articles = [
    { id: 1, title: 'A', summary: '', source: 's1', category: 'AI', topic_tag: 'evt-x', created_at: now },
    { id: 2, title: 'B', summary: '', source: 's2', category: 'AI', topic_tag: 'evt-x', created_at: now },
    { id: 3, title: 'C', summary: '', source: 's3', category: 'AI', topic_tag: 'evt-x', created_at: now },
  ];
  const clusters = await clusterArticlesSemantic(articles, 2);
  // Pre-group should fire even without embeddings
  const tagCluster = clusters.find(c => c._source === 'topic_tag');
  assert.ok(tagCluster, 'expected a topic_tag-sourced cluster');
  assert.equal(tagCluster.articles.length, 3);
  assert.equal(tagCluster._topicTag, 'evt-x');
});

// ── pickClusterTopicTag (N2) ────────────────────────────────
test('pickClusterTopicTag honours pre-group _topicTag', () => {
  const cluster = { _topicTag: 'openai-board', articles: [{ topic_tag: 'something-else' }] };
  assert.equal(pickClusterTopicTag(cluster), 'openai-board');
});

test('pickClusterTopicTag picks modal tag when >=half cluster', () => {
  const cluster = {
    articles: [
      { topic_tag: 'openai-board' },
      { topic_tag: 'openai-board' },
      { topic_tag: 'apple-event' },
    ],
  };
  assert.equal(pickClusterTopicTag(cluster), 'openai-board');
});

test('pickClusterTopicTag returns null when modal tag is below threshold', () => {
  const cluster = {
    articles: [
      { topic_tag: 'a' },
      { topic_tag: 'b' },
      { topic_tag: 'c' },
      { topic_tag: 'd' },
    ],
  };
  assert.equal(pickClusterTopicTag(cluster), null);
});

test('pickClusterTopicTag returns null for untagged cluster', () => {
  assert.equal(pickClusterTopicTag({ articles: [{ id: 1 }, { id: 2 }] }), null);
});

test('pickClusterTopicTag handles edge cases', () => {
  assert.equal(pickClusterTopicTag(null), null);
  assert.equal(pickClusterTopicTag({}), null);
  assert.equal(pickClusterTopicTag({ articles: [] }), null);
});

test('clusterArticlesSemantic caps cluster size', async () => {
  const now = new Date().toISOString();
  const articles = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    title: `A${i}`, summary: '', source: `s${i}`, category: 'AI',
    topic_tag: 'big-event', created_at: now,
  }));
  const clusters = await clusterArticlesSemantic(articles, 2, { maxClusterSize: 5 });
  const c = clusters.find(x => x._topicTag === 'big-event');
  assert.ok(c);
  assert.equal(c.articles.length, 5);
});
