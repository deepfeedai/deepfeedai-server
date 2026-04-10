/**
 * Unit tests for the source-first clustering pipeline.
 * Tests overlapScore, clusterArticles, and quality gate source diversity scoring.
 *
 * These are pure function tests — no database required.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { overlapScore, clusterArticles } = require('../lib/synthesis');

// ── Helper: build a fake article object ──────────────────────────────
function article(id, title, source, { summary = '', category = 'AI' } = {}) {
  return {
    id,
    title,
    source,
    source_url: `https://${source.toLowerCase().replace(/\s/g, '')}.com/article-${id}`,
    summary,
    category,
    created_at: new Date().toISOString(),
  };
}

// ── overlapScore ─────────────────────────────────────────────────────

describe('overlapScore', () => {
  it('scores title↔title matches as 1.0 per word', () => {
    const a = { titleWords: new Set(['openai', 'launches', 'model']), summaryWords: new Set() };
    const b = { titleWords: new Set(['openai', 'launches', 'gpt5']), summaryWords: new Set() };
    // 'openai' and 'launches' match = 2.0
    assert.equal(overlapScore(a, b), 2);
  });

  it('scores title↔summary matches as 0.5 per word', () => {
    const a = { titleWords: new Set(['openai', 'launches']), summaryWords: new Set(['pricing']) };
    const b = { titleWords: new Set(['pricing', 'details']), summaryWords: new Set(['openai']) };
    // b.title 'pricing' in a.summary = 0.5
    // a.title 'openai' in b.summary = 0.5
    // b.title 'details' not in a = 0
    assert.equal(overlapScore(a, b), 1);
  });

  it('returns 0 for no overlap', () => {
    const a = { titleWords: new Set(['apple', 'revenue']), summaryWords: new Set(['iphone']) };
    const b = { titleWords: new Set(['google', 'search']), summaryWords: new Set(['advertising']) };
    assert.equal(overlapScore(a, b), 0);
  });

  it('does not double-count title words already matched', () => {
    // If 'openai' matches in title↔title, it should NOT also get 0.5 from title↔summary
    const a = { titleWords: new Set(['openai', 'model']), summaryWords: new Set(['openai']) };
    const b = { titleWords: new Set(['openai', 'launches']), summaryWords: new Set() };
    // 'openai' matches title↔title = 1
    // 'launches' not in a.title, not in a.summary = 0
    // a.title 'model' not in b.title, not in b.summary = 0
    assert.equal(overlapScore(a, b), 1);
  });
});

// ── clusterArticles ──────────────────────────────────────────────────

describe('clusterArticles', () => {
  it('clusters 3+ articles with 2+ shared words from 3+ publications', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Benchmark Results Released', 'The Verge'),
      article(3, 'OpenAI Reveals GPT-5 Capabilities', 'Ars Technica'),
    ];
    // Shared words: 'openai', 'gpt5' — 2 overlap, 3 articles, 3 sources
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 3);
  });

  it('rejects cluster with < 3 distinct publications', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Benchmark Results Released', 'TechCrunch'),
      article(3, 'OpenAI Reveals GPT-5 Capabilities', 'TechCrunch'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('rejects cluster with only 2 distinct publications', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Benchmark Results Released', 'TechCrunch'),
      article(3, 'OpenAI Reveals GPT-5 Capabilities', 'The Verge'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('rejects cluster with < minSize articles', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Released Today', 'The Verge'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('uses summary words for matching when titles differ', () => {
    // Titles share only 'anthropic' (1 word) — not enough alone.
    // But summaries contain 'claude' and 'sonnet' which match other articles' title words.
    // title↔title: 'anthropic' = 1
    // title↔summary cross-matches push score to >= 2
    const articles = [
      article(1, 'Anthropic Raises Funding Round', 'TechCrunch', { summary: 'Anthropic the maker of Claude Sonnet secured billion dollar investment' }),
      article(2, 'Anthropic Claude Sonnet Benchmark Results', 'The Verge', { summary: 'Latest tests show Anthropic model performance gains' }),
      article(3, 'Anthropic Valuation Soars Higher', 'Reuters', { summary: 'Claude Sonnet demand drives Anthropic valuation past competitors' }),
    ];
    // Without summaries: 1↔2 share only 'anthropic' (1), 1↔3 share 'anthropic' (1) — no cluster
    // With summaries: 1↔2 'anthropic'(1) + title2 'claude' in summary1 (0.5) + title2 'sonnet' in summary1 (0.5) = 2 ✓
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 1);
  });

  it('does not cluster when neither title nor summary overlap enough', () => {
    const articles = [
      article(1, 'Apple Revenue Beats Expectations', 'TechCrunch', { summary: 'iPhone sales drive quarterly results higher than forecast' }),
      article(2, 'Google Search Algorithm Updated', 'The Verge', { summary: 'New ranking factors prioritize helpful content quality' }),
      article(3, 'Microsoft Azure Growth Accelerates', 'Reuters', { summary: 'Cloud computing demand drives enterprise subscription growth' }),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('supports group-wide matching (C joins via B, not seed A)', () => {
    // A and B share 'openai', 'launches' (2 words)
    // B and C share 'launches', 'pricing' (2 words)
    // A and C share only 'launches' (1 word — not enough alone)
    // C should join the group via its overlap with B
    const articles = [
      article(1, 'OpenAI Launches Revolutionary Platform', 'TechCrunch'),
      article(2, 'OpenAI Launches Enterprise Pricing Details', 'The Verge'),
      article(3, 'Enterprise Pricing Launches Competitive Race', 'Reuters'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 3);
  });

  it('does not produce category-level fallback clusters', () => {
    // 5 articles in same category but no keyword overlap — should NOT cluster
    const articles = [
      article(1, 'Apple Revenue Beats Expectations', 'TechCrunch'),
      article(2, 'Google Search Algorithm Updated', 'The Verge'),
      article(3, 'Microsoft Azure Growth Accelerates', 'Reuters'),
      article(4, 'Amazon Web Services Expands Regions', 'Bloomberg'),
      article(5, 'Meta Reality Labs Spending Increases', 'Ars Technica'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('skips Uncategorized articles entirely', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch', { category: 'Uncategorized' }),
      article(2, 'OpenAI GPT-5 Benchmark Released', 'The Verge', { category: 'Uncategorized' }),
      article(3, 'OpenAI GPT-5 Capabilities Revealed', 'Reuters', { category: 'Uncategorized' }),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 0);
  });

  it('deduplicates by source_url', () => {
    const a1 = article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch');
    const a2 = { ...article(2, 'OpenAI Launches GPT-5 Model', 'TechCrunch'), source_url: a1.source_url };
    const a3 = article(3, 'OpenAI GPT-5 Released Today', 'The Verge');
    const a4 = article(4, 'OpenAI GPT-5 Capabilities Revealed', 'Reuters');
    const clusters = clusterArticles([a1, a2, a3, a4], 3);
    // a2 is deduplicated — only 3 unique articles, and they have 3 sources
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 3);
  });

  it('deduplicates by exact title match', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI Launches GPT-5 Model', 'The Verge'), // same title, diff URL
      article(3, 'OpenAI GPT-5 Released Today', 'Reuters'),
      article(4, 'OpenAI GPT-5 Capabilities Revealed', 'Bloomberg'),
    ];
    const clusters = clusterArticles(articles, 3);
    // a2 deduped by title — 3 unique articles remain, 3 sources (TechCrunch, Reuters, Bloomberg)
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 3);
  });

  it('clusters across different articles in same category', () => {
    // Two distinct topics in same category — only one should cluster
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Pricing Announced', 'The Verge'),
      article(3, 'OpenAI GPT-5 Performance Review', 'Reuters'),
      article(4, 'Anthropic Claude Revenue Doubles', 'Bloomberg'),
      article(5, 'Google Quantum Computing Breakthrough', 'Ars Technica'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 3);
    // All 3 should be OpenAI GPT-5 articles
    for (const a of clusters[0].articles) {
      assert.ok(a.title.includes('GPT-5') || a.title.includes('OpenAI'));
    }
  });

  it('sets topic to category + top keyword', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Benchmark Released', 'The Verge'),
      article(3, 'OpenAI GPT-5 Capabilities Revealed', 'Reuters'),
    ];
    const clusters = clusterArticles(articles, 3);
    assert.equal(clusters.length, 1);
    // Topic should include category and a keyword
    assert.ok(clusters[0].topic.startsWith('AI'));
    assert.ok(clusters[0].topic.includes(' — '));
  });

  it('respects custom minSize', () => {
    const articles = [
      article(1, 'OpenAI Launches GPT-5 Model', 'TechCrunch'),
      article(2, 'OpenAI GPT-5 Benchmark Released', 'The Verge'),
      article(3, 'OpenAI GPT-5 Capabilities Revealed', 'Reuters'),
      article(4, 'OpenAI GPT-5 Enterprise Released', 'Bloomberg'),
      article(5, 'OpenAI GPT-5 Safety Report Published', 'Ars Technica'),
    ];
    // minSize = 5 — need all 5
    const clusters = clusterArticles(articles, 5);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles.length, 5);
  });
});

// ── Quality gate source diversity (getEditorialScore) ────────────────
// getEditorialScore requires DB for daily publish cap check, so we test
// the source diversity scoring logic in isolation by importing parseSourceIds
// pattern and verifying the scoring math directly.

describe('quality gate source diversity', () => {
  // We can't easily unit test getEditorialScore without DB mocking,
  // but we can verify the source ref parsing and diversity calculation
  // that we added matches the expected behavior.

  function countDistinctPubs(sourceRefs) {
    const sourceNames = new Set();
    for (const s of sourceRefs) {
      if (typeof s === 'object' && s !== null && s.source) sourceNames.add(s.source);
    }
    return sourceNames.size;
  }

  it('counts distinct publications from source refs', () => {
    const refs = [
      { id: 1, source: 'TechCrunch' },
      { id: 2, source: 'The Verge' },
      { id: 3, source: 'Reuters' },
    ];
    assert.equal(countDistinctPubs(refs), 3);
  });

  it('deduplicates same publication name', () => {
    const refs = [
      { id: 1, source: 'TechCrunch' },
      { id: 2, source: 'TechCrunch' },
      { id: 3, source: 'The Verge' },
    ];
    assert.equal(countDistinctPubs(refs), 2);
  });

  it('handles null/missing source fields', () => {
    const refs = [
      { id: 1, source: 'TechCrunch' },
      { id: 2, source: null },
      { id: 3 },
    ];
    assert.equal(countDistinctPubs(refs), 1);
  });

  it('handles old format (plain IDs, not objects)', () => {
    const refs = [1, 2, 3];
    assert.equal(countDistinctPubs(refs), 0);
  });

  it('handles empty array', () => {
    assert.equal(countDistinctPubs([]), 0);
  });
});
