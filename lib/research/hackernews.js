/**
 * Hacker News search via Algolia (free, no key required).
 * Filters to stories with a minimum score threshold for signal.
 */
async function search(_tenantId, query, opts = {}) {
  const count = Math.min(Math.max(opts.count || 10, 1), 20);
  const minScore = opts.minScore ?? 50;
  // tags=story limits to submissions, not comments. Sort by relevance + recency.
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count * 2}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `hn_${res.status}`, results: [] };
    const data = await res.json();
    const results = (data.hits || [])
      .filter(h => (h.points || 0) >= minScore && (h.url || h.story_text))
      .slice(0, count)
      .map(h => ({
        source: 'hackernews',
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: h.title || h.story_title || '(untitled)',
        snippet: (h.story_text || '').slice(0, 280),
        publisher: 'Hacker News',
        published: h.created_at || null,
        score: h.points || 0,
        comments: h.num_comments || 0,
        author: h.author || null,
      }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err.message || 'fetch_failed', results: [] };
  }
}

module.exports = { search };
