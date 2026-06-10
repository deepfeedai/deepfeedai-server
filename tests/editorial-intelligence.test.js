const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreStoryCandidates,
  validateSourceIds,
  draftBriefFromCandidate,
} = require('../lib/editorial-intelligence');

function article(id, title, source, category, hoursAgo = 0) {
  return {
    id,
    title,
    generated_title: title,
    summary: `${title} with concrete details and source reporting.`,
    source,
    category,
    created_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  };
}

test('candidate scoring ranks fresh multi-source stories above stale weaker stories', () => {
  const signals = {
    articles: [
      article(1, 'OpenAI agent platform launches for enterprise developers', 'TechWire', 'AI', 1),
      article(2, 'OpenAI agent platform expands enterprise developer tools', 'The Verge', 'AI', 2),
      article(3, 'OpenAI agent platform gains early enterprise customers', 'Reuters', 'AI', 3),
      article(4, 'Laptop market slows as PC demand weakens again', 'PC Daily', 'Hardware', 72),
      article(5, 'Laptop market slows after weak PC demand report', 'Gadget Post', 'Hardware', 74),
    ],
    recentOriginals: [],
    threads: [],
    writers: [
      { id: 10, name: 'Ada', is_auto: true, beats: ['AI'] },
      { id: 11, name: 'Byron', is_auto: true, beats: ['Hardware'] },
    ],
  };

  const scored = scoreStoryCandidates(signals);
  assert.ok(scored.length >= 2);
  assert.equal(scored[0].category, 'AI');
  assert.equal(scored[0].recommended_writer_id, 10);
  assert.ok(scored[0].score > scored.find(c => c.category === 'Hardware').score);
});

test('novelty scoring penalizes candidates that overlap recent originals', () => {
  const baseSignals = {
    articles: [
      article(1, 'Cloudflare outage disrupts AI app traffic', 'Status Wire', 'Cloud', 1),
      article(2, 'Cloudflare outage hits AI application providers', 'Infra News', 'Cloud', 2),
    ],
    threads: [],
    writers: [{ id: 20, name: 'Nora', is_auto: true, beats: ['Cloud'] }],
  };
  const fresh = scoreStoryCandidates({ ...baseSignals, recentOriginals: [] })[0];
  const repeated = scoreStoryCandidates({
    ...baseSignals,
    recentOriginals: [{ title: 'Cloudflare outage disrupts AI app traffic', source_article_ids: [1, 2] }],
  })[0];

  assert.ok(fresh.score_components.novelty > repeated.score_components.novelty);
  assert.ok(fresh.score > repeated.score);
});

test('brief drafting rejects source IDs outside the candidate evidence bundle', () => {
  assert.deepEqual(validateSourceIds([1, 2], [1, 2, 3]), [1, 2]);
  assert.throws(() => validateSourceIds([1, 99], [1, 2, 3]), /unavailable source IDs: 99/);
});

test('draftBriefFromCandidate preserves angle inputs and real source IDs', () => {
  const candidate = scoreStoryCandidates({
    articles: [
      article(7, 'Anthropic ships safety evals for Claude deployments', 'Model Beat', 'AI Safety', 1),
      article(8, 'Claude deployment safety evals expand to enterprises', 'AI Ledger', 'AI Safety', 2),
    ],
    recentOriginals: [],
    threads: [],
    writers: [{ id: 30, name: 'Mira', is_auto: true, beats: ['AI Safety'] }],
  })[0];

  const brief = draftBriefFromCandidate(candidate);
  assert.ok(brief.headline.includes('Claude') || brief.headline.includes('Anthropic'));
  assert.deepEqual(brief.source_article_ids.sort((a, b) => a - b), [7, 8]);
  assert.equal(brief.recommended_writer_id, 30);
  assert.ok(brief.angle.length > 40);
});
