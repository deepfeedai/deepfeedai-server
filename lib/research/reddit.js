/**
 * Reddit public JSON search (free, no auth, low volume).
 * Quality filter via minimum upvote threshold + subreddit allowlist (optional).
 */
async function search(_tenantId, query, opts = {}) {
  const count = Math.min(Math.max(opts.count || 10, 1), 20);
  const minScore = opts.minScore ?? 100;
  const sub = opts.subreddit; // optional, e.g. 'netsec' to scope
  const base = sub
    ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?restrict_sr=on`
    : 'https://www.reddit.com/search.json';
  const url = `${base}${sub ? '&' : '?'}q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=${count * 2}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DeepFeedAI-Research/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `reddit_${res.status}`, results: [] };
    const data = await res.json();
    const results = (data.data?.children || [])
      .map(c => c.data)
      .filter(d => (d.score || 0) >= minScore && (d.url || d.permalink))
      .slice(0, count)
      .map(d => ({
        source: 'reddit',
        url: d.url_overridden_by_dest || d.url || `https://www.reddit.com${d.permalink}`,
        title: d.title || '(untitled)',
        snippet: (d.selftext || '').slice(0, 280),
        publisher: `r/${d.subreddit || 'unknown'}`,
        published: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        score: d.score || 0,
        comments: d.num_comments || 0,
        author: d.author || null,
      }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err.message || 'fetch_failed', results: [] };
  }
}

module.exports = { search };
