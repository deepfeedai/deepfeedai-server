/**
 * Deep Feed AI — Synthesis engine
 * Clusters related articles and generates original analytical pieces via Gemini.
 */
const db = require('../db');
const { toSlug, sanitizeForPrompt, significantWords, STOP_WORDS } = require('./utils');
const { prewarmSummary } = require('../routes/summary');
const { getEditorialScore } = require('./quality-gate');
const { generateAndStoreImage } = require('./media-helpers');
const { onArticlePublished } = require('./post-publish');
const { createNewArticleNotification } = require('../routes/notifications');
const { buildWriterPrompt } = require('./writer-assign');
const { complete: aiComplete } = require('./ai-router');
const { scrapeArticleText } = require('./scrape');

/**
 * Enrich a source article by scraping the full text and generating a structured summary.
 * Stores enriched_summary and scrape_status on the article row.
 * @param {number} articleId
 * @param {number} tenantId
 * @returns {Promise<string|null>} The enriched summary or null
 */
async function enrichArticle(articleId, tenantId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article || article.enriched_summary || article.scrape_status === 'blocked') return null;
    if (!article.source_url) {
      await db.prepare("UPDATE articles SET scrape_status = 'failed' WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);
      return null;
    }

    // 1. Scrape full article text
    const text = await scrapeArticleText(article.source_url, tenantId);
    if (!text) {
      await db.prepare("UPDATE articles SET scrape_status = 'failed' WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);
      return null;
    }

    // 2. Summarize with cheap LLM
    const result = await aiComplete({
      operation: 'scrape-summarize',
      tenantId,
      messages: [{
        role: 'user',
        content: `Summarize this article in 3-5 bullet points. Include specific facts, numbers, quotes, names, and claims. Be precise — these bullets will be used as source material for a journalist writing a synthesis article.

Article title: ${sanitizeForPrompt(article.title, 200)}
Article text:
${sanitizeForPrompt(text, 4000)}`
      }],
      maxTokens: 512,
      temperature: 0.2,
      skipBudget: false,
      trigger: 'auto-enrich',
    });

    const enriched = result?.text?.trim() || null;
    if (enriched) {
      await db.prepare(
        "UPDATE articles SET enriched_summary = $1, scrape_status = 'ready' WHERE id = $2 AND tenant_id = $3"
      ).run(enriched, articleId, tenantId);
    } else {
      await db.prepare("UPDATE articles SET scrape_status = 'failed' WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId);
    }
    return enriched;
  } catch (err) {
    console.error('[enrich] enrichArticle error:', err.message);
    await db.prepare("UPDATE articles SET scrape_status = 'failed' WHERE id = $1 AND tenant_id = $2").run(articleId, tenantId).catch(() => {});
    return null;
  }
}

/**
 * Build a set of niche-specific stop words from category names.
 * Words that appear in category names (e.g., "wrestling", "market", "tech")
 * are too common within that niche to be useful for clustering.
 */
function buildNicheStopWords(articles) {
  const nicheWords = new Set();
  for (const a of articles) {
    if (a.category) {
      const words = a.category.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
      for (const w of words) {
        if (w.length > 1) nicheWords.add(w);
      }
    }
    // Also treat the source name words as too common (e.g., "news", "report", "daily", "update")
    if (a.source) {
      const words = a.source.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
      for (const w of words) {
        if (w.length > 2) nicheWords.add(w);
      }
    }
  }
  return nicheWords;
}

/**
 * Compute overlap score between two article word sets.
 * Title↔title matches count as 1, title↔summary matches count as 0.5.
 */
function overlapScore(a, b) {
  let score = 0;
  for (const w of b.titleWords) {
    if (a.titleWords.has(w)) { score++; continue; }
    if (a.summaryWords.has(w)) score += 0.5;
  }
  for (const w of a.titleWords) {
    if (!b.titleWords.has(w) && b.summaryWords.has(w)) score += 0.5;
  }
  return score;
}

/**
 * Group articles by topic.
 * Within each category, find articles sharing 2+ significant words (title + summary).
 * Uses group-wide matching: candidates are compared against all group members, not just the seed.
 * Requires 3+ distinct publications per cluster to ensure genuine multi-source journalism.
 * Returns array of { topic, articles } where articles.length >= minSize.
 */
function clusterArticles(articles, minSize = 3) {
  // Deduplicate by source_url and title — same article ingested from multiple sources
  const seenUrls = new Set();
  const seenTitles = new Set();
  const deduped = articles.filter(a => {
    const url = a.source_url;
    const titleKey = (a.title || '').toLowerCase().trim();
    if (url && seenUrls.has(url)) return false;
    if (titleKey && seenTitles.has(titleKey)) return false;
    if (url) seenUrls.add(url);
    if (titleKey) seenTitles.add(titleKey);
    return true;
  });

  // Build niche-specific stop words from category/source names in this batch
  const nicheStopWords = buildNicheStopWords(deduped);

  // Group by category
  const byCategory = {};
  for (const a of deduped) {
    const cat = a.category || 'General';
    (byCategory[cat] = byCategory[cat] || []).push(a);
  }

  const clusters = [];

  for (const [cat, catArticles] of Object.entries(byCategory)) {
    // Skip uncategorized articles — low-confidence classifications should not feed synthesis
    if (cat === 'Uncategorized') continue;

    // Build word sets from both title and summary for richer matching
    const wordSets = catArticles.map(a => ({
      article: a,
      titleWords: new Set(significantWords(a.title, nicheStopWords)),
      summaryWords: new Set(significantWords((a.summary || '').slice(0, 200), nicheStopWords)),
    }));

    const used = new Set();

    for (let i = 0; i < wordSets.length; i++) {
      if (used.has(i)) continue;
      const group = [wordSets[i]];
      const sharedWords = new Map();

      for (const w of wordSets[i].titleWords) {
        sharedWords.set(w, (sharedWords.get(w) || 0) + 1);
      }

      for (let j = i + 1; j < wordSets.length; j++) {
        if (used.has(j)) continue;

        // Group-wide matching: check overlap against ALL group members, take the best
        let bestScore = 0;
        for (const member of group) {
          bestScore = Math.max(bestScore, overlapScore(member, wordSets[j]));
        }

        if (bestScore >= 2) {
          group.push(wordSets[j]);
          for (const w of wordSets[j].titleWords) {
            sharedWords.set(w, (sharedWords.get(w) || 0) + 1);
          }
        }
      }

      // Require minimum cluster size AND 3+ distinct publications
      const distinctSources = new Set(group.map(g => g.article.source).filter(Boolean));
      if (group.length >= minSize && distinctSources.size >= 3) {
        for (const g of group) used.add(wordSets.indexOf(g));

        // Topic = category + top keyword (if meaningful keyword exists)
        const topKeyword = [...sharedWords.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([w]) => w)
          .find(w => w.length > 3); // skip very short words as topic descriptor

        clusters.push({
          topic: topKeyword ? `${cat} — ${topKeyword}` : cat,
          articles: group.map(g => g.article),
        });
      }
    }

    // No category-level fallback — if articles don't cluster, they stay as
    // source material until more related sources arrive.
  }

  return clusters;
}

/**
 * Call Gemini to synthesize a cluster of articles into an original analytical piece.
 * Inserts the result into the articles table.  Returns the inserted row or null.
 */
async function synthesizeCluster(cluster, writer, tenantId) {
  try {
    const systemPrompt = await buildWriterPrompt(writer);

    // Dynamic length based on cluster size
    const paragraphCount = cluster.articles.length <= 3 ? 3
      : cluster.articles.length <= 5 ? 4
      : cluster.articles.length <= 8 ? 5
      : 6;

    // Compute timespan from oldest article in cluster
    const oldest = Math.min(...cluster.articles.map(a => new Date(a.created_at || Date.now()).getTime()));
    const spanHours = Math.max(1, Math.round((Date.now() - oldest) / 3_600_000));
    const timespan = spanHours <= 4 ? `${spanHours} hours`
      : spanHours <= 48 ? `${Math.round(spanHours / 24)} day(s)`
      : `${Math.round(spanHours / 168)} week(s)`;

    const sourceSummaries = cluster.articles.map((a, i) => {
      const detail = a.enriched_summary
        ? sanitizeForPrompt(a.enriched_summary, 800)
        : sanitizeForPrompt(a.summary, 300);
      return `${i + 1}. "${sanitizeForPrompt(a.title, 200)}" (${sanitizeForPrompt(a.source, 50) || 'Unknown'}):\n${detail}`;
    }).join('\n\n');

    const prompt = `${systemPrompt}

Synthesize the following ${cluster.articles.length} related sources published over the last ${timespan} into an original analytical article. Provide your own analysis and insights connecting the themes. Write in your distinctive voice and style.

Topic area: ${cluster.topic}

Sources (cite these inline using the format [1], [2], etc.):
${sourceSummaries}

Requirements:
- Open with a strong lede that hooks the reader — a surprising finding, a sharp contrast, or a concrete detail. Do NOT open with generic phrases like "In the rapidly evolving world of..." or "In a significant development..."
- When referencing information from a source, cite it inline using [1], [2], etc. Not every sentence needs a citation, but key claims should be attributed.
- Where sources disagree or offer different angles, highlight the contrast.
- Close with a forward-looking "so what" — what this means for the reader and what to watch next.
- Write ${paragraphCount} paragraphs of analytical prose. No section headers, no bullet points, flowing paragraphs only.

Respond in exactly this format — no extra commentary:
TITLE: [a specific, compelling, publication-ready headline — not generic, not clickbait]
EXCERPT: [1-2 sentence hook that captures the article's key insight — max 280 characters]

[your article text with inline [1], [2] citations]

FOLLOWUPS:
Q1: [a sharp, specific question the reader is now wondering — name a company, person, or technology. Not "What are the implications?" but "Can AMD's MI350 actually compete at this price point?"]
A1: [2-3 sentences answering directly in your voice. Never say "the article states" or "according to the article" — you ARE the writer, speak from your own analysis. Use [N] citations.]
Q2: [a contrarian or "what's being missed" question — the angle no one is talking about yet]
A2: [answer in your voice — offer a take, not a summary]
Q3: [a forward-looking question with a specific timeframe or trigger — not "What's next?" but "Will this survive the next earnings cycle?"]
A3: [answer in your voice — make a call, hedge if needed, but have a point of view]`;

    const result = await aiComplete({
      operation: 'synthesis',
      tenantId,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4096,
      trigger: 'manual',
      writerId: writer.id,
    });
    if (!result) throw new Error('Budget exceeded or AI unavailable');
    const content = result.text;
    if (!content) throw new Error('AI returned no content');

    // Parse TITLE:, EXCERPT:, body, and FOLLOWUPS: sections
    const titleMatch = content.match(/^TITLE:\s*(.+)/m);
    const title = titleMatch
      ? titleMatch[1].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes if any
      : `Analysis: ${cluster.topic}`;
    const excerptMatch = content.match(/^EXCERPT:\s*(.+)/m);

    // Extract follow-up Q&As before stripping from body
    const followups = [];
    const followupsMatch = content.match(/FOLLOWUPS:\s*\n([\s\S]*?)$/);
    if (followupsMatch) {
      const ftext = followupsMatch[1];
      const qMatches = [...ftext.matchAll(/Q(\d+):\s*(.+)\nA\1:\s*([\s\S]+?)(?=\nQ\d+:|$)/g)];
      for (const m of qMatches) {
        followups.push({ question: m[2].trim(), answer: m[3].trim() });
      }
    }

    const body = content
      .replace(/^TITLE:.*\n?/m, '')
      .replace(/^EXCERPT:.*\n?/m, '')
      .replace(/FOLLOWUPS:[\s\S]*$/, '')
      .trim();

    // Guard: reject truncated or empty generations
    const bodyWordCount = body.split(/\s+/).filter(Boolean).length;
    if (bodyWordCount < 100) {
      console.error(`[synthesis] Rejected truncated output for "${title}" — only ${bodyWordCount} words (need 100+)`);
      throw new Error(`Generated content too short (${bodyWordCount} words). Possible token limit issue.`);
    }

    const slug = toSlug(title) || 'synthesis-' + Date.now();
    const summary = excerptMatch
      ? excerptMatch[1].trim().slice(0, 500)
      : body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

    // Store rich source objects so the frontend can render citations without extra API calls
    const sourceRefs = cluster.articles.map(a => ({
      id:         a.id,
      title:      a.title,
      source:     a.source || null,
      source_url: a.source_url || null,
    }));

    // Synthesis metadata for frontend context banner
    const synthesisMeta = {
      source_count: cluster.articles.length,
      source_names: [...new Set(cluster.articles.map(a => a.source).filter(Boolean))],
      timespan_hours: spanHours,
      word_count: body.split(/\s+/).filter(Boolean).length,
    };

    // Insert as draft (is_published = 0); quality gate decides whether to publish
    const row = await db.prepare(`
      INSERT INTO articles (tenant_id, title, slug, summary, full_content, source, category, content_type,
        writer_id, source_article_ids, synthesis_meta, followups, is_published, status, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'original', $8, $9, $10, $11, 0, 'draft', NOW(), NOW(), NOW())
      RETURNING *
    `).get(
      tenantId,
      title,
      slug,
      summary,
      body,
      writer.name,
      cluster.articles[0]?.category || 'General',
      writer.id,
      JSON.stringify(sourceRefs),
      JSON.stringify(synthesisMeta),
      followups.length ? JSON.stringify(followups) : null,
    );

    if (!row) throw new Error('DB INSERT returned no row — check articles table schema');

    // Quality gate: score and auto-publish if it passes
    try {
      const scoringEnabled = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'auto_editorial_scoring'").get(tenantId);
      if (scoringEnabled?.value !== '0') {
        const gate = await getEditorialScore(row, tenantId);
        await db.prepare(
          'UPDATE articles SET editorial_score = $1 WHERE id = $2 AND tenant_id = $3'
        ).run(gate.score, row.id, tenantId);
        row.editorial_score = gate.score;

        if (gate.publish) {
          await db.prepare(
            "UPDATE articles SET is_published = 1, status = 'published' WHERE id = $1 AND tenant_id = $2"
          ).run(row.id, tenantId);
          row.is_published = 1;
          row.status = 'published';

          if (gate.feature_worthy) {
            await db.prepare(
              'UPDATE articles SET is_featured = 1 WHERE id = $1 AND tenant_id = $2'
            ).run(row.id, tenantId);
            row.is_featured = 1;
          }

          // Fire post-publish hooks (TLDR prewarm, thumbnail, etc.)
          onArticlePublished(row.id, tenantId).catch(() => {});
          // Notify followers of this writer
          if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
        } else {
          // Quality gate failed — send to review queue
          await db.prepare(
            "UPDATE articles SET status = 'review', submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
          ).run(row.id, tenantId);
          row.status = 'review';
        }
      } else {
        // Scoring disabled — auto-publish like before
        await db.prepare("UPDATE articles SET is_published = 1, status = 'published' WHERE id = $1 AND tenant_id = $2").run(row.id, tenantId);
        row.is_published = 1;
        row.status = 'published';
        onArticlePublished(row.id, tenantId).catch(() => {});
        if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
      }
    } catch (gateErr) {
      console.error('[synthesis] quality gate error:', gateErr.message);
      // Fallback: publish anyway
      await db.prepare("UPDATE articles SET is_published = 1, status = 'published' WHERE id = $1 AND tenant_id = $2").run(row.id, tenantId);
      row.is_published = 1;
      row.status = 'published';
      onArticlePublished(row.id, tenantId).catch(() => {});
      if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
    }

    return row;
  } catch (err) {
    console.error('[synthesis] synthesizeCluster error:', err.message);
    throw err; // re-throw so caller can surface the real error
  }
}

/**
 * Check whether a cluster duplicates an existing original article.
 * Returns true if ≥50% of the cluster's source article IDs appear in any recent original.
 */
async function isDuplicateCluster(cluster, tenantId, threshold = 0.5) {
  const clusterIds = new Set(cluster.articles.map(a => a.id));
  const recentOriginals = await db.prepare(
    `SELECT source_article_ids FROM articles
     WHERE tenant_id = $1 AND content_type = 'original'
       AND created_at > NOW() - INTERVAL '14 days'`
  ).all(tenantId);

  for (const orig of recentOriginals) {
    try {
      const raw = typeof orig.source_article_ids === 'string'
        ? JSON.parse(orig.source_article_ids)
        : (orig.source_article_ids || []);
      // Handle both [{id,...}] (new format) and [id, id] (old format)
      const ids = raw.map(r => (typeof r === 'object' && r !== null) ? r.id : r);
      const overlap = ids.filter(id => clusterIds.has(id)).length;
      if (overlap / clusterIds.size >= threshold) return true;
    } catch { /* malformed — skip */ }
  }
  return false;
}

/**
 * Compute cluster strength — how tightly related the articles are.
 * Measures average pairwise keyword overlap across articles in the cluster.
 * @returns {number} 0-1 score (higher = more tightly related)
 */
function computeClusterStrength(cluster) {
  const articles = cluster.articles || [];
  if (articles.length < 2) return 0;

  const nicheStopWords = buildNicheStopWords(articles);
  const wordSets = articles.map(a => new Set(significantWords(a.title, nicheStopWords)));

  let totalOverlap = 0;
  let pairs = 0;
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const union = new Set([...wordSets[i], ...wordSets[j]]);
      if (union.size === 0) continue;
      let intersection = 0;
      for (const w of wordSets[i]) {
        if (wordSets[j].has(w)) intersection++;
      }
      totalOverlap += intersection / union.size;
      pairs++;
    }
  }

  return pairs > 0 ? Math.round((totalOverlap / pairs) * 100) / 100 : 0;
}

/**
 * Generate a proposed headline for a cluster based on topic and article count.
 * Template-based — no LLM call.
 */
function generateProposedHeadline(cluster) {
  const topic = cluster.topic || 'General';
  const articles = cluster.articles || [];
  const parts = topic.split(' — ');
  const category = parts[0];
  const keyword = parts[1];
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

  if (keyword) {
    const kw = cap(keyword);
    const templates = [
      `${kw}: The Emerging ${category} Trend to Watch`,
      `Why ${kw} Is Dominating ${category} Right Now`,
      `${category} Analysis: The ${kw} Factor`,
      `Breaking Down the ${kw} Surge in ${category}`,
    ];
    return templates[keyword.charCodeAt(0) % templates.length];
  }

  // Try to find an angle from the most frequent title keyword
  const nicheStopWords = buildNicheStopWords(articles);
  const freq = {};
  for (const a of articles) {
    for (const w of significantWords(a.title, nicheStopWords)) {
      if (w.length > 3) freq[w] = (freq[w] || 0) + 1;
    }
  }
  const topWord = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];

  if (topWord && topWord[1] >= 2) {
    const angle = cap(topWord[0]);
    const templates = [
      `${category} Briefing: The ${angle} Connection`,
      `What's Driving ${angle} in ${category} This Week`,
      `${category}: The ${angle} Story Unfolding Now`,
    ];
    return templates[topWord[0].charCodeAt(0) % templates.length];
  }

  const templates = [
    `${category}: Key Developments and What They Mean`,
    `This Week in ${category}: Trends Taking Shape`,
    `${category} Briefing: What You Need to Know`,
    `The Big Picture in ${category} Right Now`,
  ];
  return templates[category.charCodeAt(0) % templates.length];
}

/**
 * Get cooldown status for a writer's synthesis.
 * Cooldown threshold scales with the writer's synthesis schedule.
 * @returns {{ active: boolean, hoursSinceLastRun: number|null, threshold: number }}
 */
const SCHEDULE_COOLDOWNS = { frequent: 1.5, daily: 20, 'twice-daily': 10, weekly: 144 };

async function getCooldownStatus(writerId, tenantId) {
  const writer = await db.prepare('SELECT synthesis_schedule FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
  const schedule = writer?.synthesis_schedule || 'daily';
  const threshold = SCHEDULE_COOLDOWNS[schedule] || 20;
  const lastRun = await db.prepare(
    `SELECT MAX(created_at) AS last FROM articles WHERE tenant_id = $1 AND content_type = 'original' AND writer_id = $2`
  ).get(tenantId, writerId);
  if (!lastRun?.last) return { active: false, hoursSinceLastRun: null, threshold };
  const hoursSinceLastRun = (Date.now() - new Date(lastRun.last).getTime()) / 3_600_000;
  return { active: hoursSinceLastRun < threshold, hoursSinceLastRun: Math.round(hoursSinceLastRun * 10) / 10, threshold };
}

/**
 * Fetch the article pool for a writer's synthesis.
 * Prefers articles assigned to the writer, falls back to unassigned articles in writer's beat categories.
 * @returns {{ articles: object[], writerScopedCount: number, beatFallbackCount: number }}
 */
async function getArticlePool(writerId, tenantId, lookbackHours, minSize) {
  // Primary pool: articles assigned to this writer
  let articles = await db.prepare(`
    SELECT * FROM articles
    WHERE tenant_id = $3
      AND (content_type IS NULL OR content_type NOT IN ('original', 'deep-dive'))
      AND is_archived = 0
      AND writer_id = $2
      AND created_at > NOW() - make_interval(hours => $1)
    ORDER BY created_at DESC LIMIT 200
  `).all(lookbackHours, writerId, tenantId);

  const writerScopedCount = articles.length;
  let beatFallbackCount = 0;

  // Beat pool: all articles in this writer's beat categories — regardless of assignment.
  // This ensures source articles assigned to other writers or unassigned are still
  // available for clustering. Synthesis needs the broadest possible pool to form
  // clusters with 3+ distinct publications.
  if (articles.length < minSize || true) { // always check beat pool for richer clustering
    const beatArticles = await db.prepare(`
      SELECT * FROM articles
      WHERE tenant_id = $3
        AND (content_type IS NULL OR content_type NOT IN ('original', 'deep-dive'))
        AND is_archived = 0
        AND category IN (
          SELECT c.name FROM writer_beats wb
          JOIN categories c ON c.id = wb.category_id
          WHERE wb.writer_id = $2
        )
        AND created_at > NOW() - make_interval(hours => $1)
      ORDER BY created_at DESC LIMIT 500
    `).all(lookbackHours, writerId, tenantId);

    const existingIds = new Set(articles.map(a => a.id));
    for (const a of beatArticles) {
      if (!existingIds.has(a.id)) {
        articles.push(a);
        beatFallbackCount++;
      }
    }
  }

  return { articles, writerScopedCount, beatFallbackCount };
}

/**
 * Evaluate clusters for dedup overlap without generating.
 * @returns {Array<{ topic, articleCount, articles: Array<{id,title,source,source_url}>, wouldSkipDedup, overlapPct }>}
 */
// In-memory watchlist cache (5-min TTL)
const watchlistCache = { data: null, ts: 0, tenantId: null };
const WATCHLIST_TTL = 5 * 60 * 1000;

/**
 * Load watchlist entries for a tenant (cached).
 */
async function loadWatchlist(tenantId) {
  const now = Date.now();
  if (watchlistCache.data && watchlistCache.tenantId === tenantId && (now - watchlistCache.ts) < WATCHLIST_TTL) {
    return watchlistCache.data;
  }
  const rows = await db.prepare('SELECT * FROM synthesis_watchlist WHERE tenant_id = $1').all(tenantId);
  const wanted = rows.filter(r => r.type === 'wanted').map(r => r.keyword.toLowerCase());
  const blocked = rows.filter(r => r.type === 'blocked').map(r => r.keyword.toLowerCase());
  watchlistCache.data = { wanted, blocked };
  watchlistCache.ts = now;
  watchlistCache.tenantId = tenantId;
  return watchlistCache.data;
}

/**
 * Check a cluster against the watchlist.
 * @returns {{ blocked: boolean, blockedKeywords: string[], wanted: boolean, wantedKeywords: string[] }}
 */
async function checkWatchlist(cluster, tenantId) {
  const { wanted, blocked } = await loadWatchlist(tenantId);
  if (!wanted.length && !blocked.length) return { blocked: false, blockedKeywords: [], wanted: false, wantedKeywords: [] };

  // Build searchable text from topic + article titles
  const text = [cluster.topic, ...cluster.articles.map(a => a.title || '')].join(' ').toLowerCase();

  const matchedBlocked = blocked.filter(kw => text.includes(kw));
  const matchedWanted = wanted.filter(kw => text.includes(kw));

  return {
    blocked: matchedBlocked.length > 0,
    blockedKeywords: matchedBlocked,
    wanted: matchedWanted.length > 0,
    wantedKeywords: matchedWanted,
  };
}

async function evaluateClusters(clusters, tenantId, force) {
  const recentOriginals = await db.prepare(
    `SELECT source_article_ids FROM articles
     WHERE tenant_id = $1 AND content_type = 'original'
       AND created_at > NOW() - INTERVAL '14 days'`
  ).all(tenantId);

  // Parse all recent original source IDs once
  const parsedOriginals = recentOriginals.map(orig => {
    try {
      const raw = typeof orig.source_article_ids === 'string'
        ? JSON.parse(orig.source_article_ids)
        : (orig.source_article_ids || []);
      return raw.map(r => (typeof r === 'object' && r !== null) ? r.id : r);
    } catch { return []; }
  });

  const results = [];
  for (const cluster of clusters) {
    const clusterIds = new Set(cluster.articles.map(a => a.id));
    let maxOverlap = 0;

    if (!force) {
      for (const origIds of parsedOriginals) {
        const overlap = origIds.filter(id => clusterIds.has(id)).length;
        const pct = overlap / clusterIds.size;
        if (pct > maxOverlap) maxOverlap = pct;
      }
    }

    const watchlist = await checkWatchlist(cluster, tenantId);

    results.push({
      topic: cluster.topic,
      articleCount: cluster.articles.length,
      articles: cluster.articles.map(a => ({
        id: a.id,
        title: a.title,
        source: a.source || null,
        source_url: a.source_url || null,
      })),
      wouldSkipDedup: !force && maxOverlap >= 0.5,
      overlapPct: Math.round(maxOverlap * 100),
      strength: computeClusterStrength(cluster),
      proposedHeadline: generateProposedHeadline(cluster),
      watchlist,
    });
  }
  return results;
}

/**
 * Run full synthesis pipeline for a single auto-writer.
 * @param {number|string} writerId
 * @param {object} opts
 * @param {boolean} [opts.force=false] — skip cooldown and dedup checks
 * @param {boolean} [opts.dryRun=false] — evaluate pipeline without generating
 * @param {number[]} [opts.clusterIndices] — only generate these cluster indices
 * Returns { generated, clusters, skipped } or dry-run result.
 */
async function runSynthesisForWriter(writerId, { force = false, tenantId, dryRun = false, clusterIndices } = {}) {
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
  if (!writer) return { generated: 0, clusters: 0, skipped: 'Writer not found' };

  const lookbackHours = writer.synthesis_lookback_hours || 168;
  const minSize = writer.min_cluster_size || 3;

  const cooldown = await getCooldownStatus(writerId, tenantId);

  // For dry run, always show cooldown status but continue to show clusters
  if (!dryRun && !force && cooldown.active) {
    return { generated: 0, clusters: 0, skipped: `Cooldown: last synthesis ${Math.round(cooldown.hoursSinceLastRun)}h ago (use ?force=true to override)` };
  }

  const pool = await getArticlePool(writerId, tenantId, lookbackHours, minSize);

  if (!pool.articles.length) {
    if (dryRun) {
      return {
        dryRun: true,
        writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
        cooldown,
        articlePool: { total: 0, writerScoped: 0, beatFallback: 0 },
        clusters: [],
        summary: { totalClusters: 0, wouldGenerate: 0, wouldSkipDedup: 0 },
      };
    }
    return { generated: 0, clusters: 0, skipped: 'No recent articles found' };
  }

  const clusters = clusterArticles(pool.articles, minSize);

  if (!clusters.length) {
    if (dryRun) {
      return {
        dryRun: true,
        writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
        cooldown,
        articlePool: { total: pool.articles.length, writerScoped: pool.writerScopedCount, beatFallback: pool.beatFallbackCount },
        clusters: [],
        summary: { totalClusters: 0, wouldGenerate: 0, wouldSkipDedup: 0 },
      };
    }
    return { generated: 0, clusters: 0, skipped: 'No clusters met minimum size' };
  }

  // Evaluate all clusters for dedup
  const evaluated = await evaluateClusters(clusters, tenantId, force);

  if (dryRun) {
    const wouldGenerate = evaluated.filter(c => !c.wouldSkipDedup).length;
    const wouldSkipDedup = evaluated.filter(c => c.wouldSkipDedup).length;
    return {
      dryRun: true,
      writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
      cooldown,
      articlePool: { total: pool.articles.length, writerScoped: pool.writerScopedCount, beatFallback: pool.beatFallbackCount },
      clusters: evaluated,
      summary: { totalClusters: evaluated.length, wouldGenerate, wouldSkipDedup },
    };
  }

  // Actual generation
  let generated = 0;
  let skippedDedup = 0;
  let skippedBlocked = 0;
  const errors = [];

  // If clusterIndices provided, only generate those specific clusters
  const targetClusters = clusterIndices
    ? clusters.filter((_, i) => clusterIndices.includes(i))
    : clusters;

  for (const cluster of targetClusters) {
    try {
      // Check watchlist — skip blocked topics
      const wl = await checkWatchlist(cluster, tenantId);
      if (wl.blocked) {
        skippedBlocked++;
        continue;
      }
      if (!force && await isDuplicateCluster(cluster, tenantId)) {
        skippedDedup++;
        continue;
      }
      const result = await synthesizeCluster(cluster, writer, tenantId);
      if (result) generated++;
      else errors.push(`Cluster "${cluster.topic}": synthesizeCluster returned null (check GEMINI_API_KEY or DB)`);
    } catch (err) {
      errors.push(`Cluster "${cluster.topic}": ${err.message}`);
    }
  }

  return { generated, clusters: targetClusters.length, skippedDedup, skippedBlocked, skipped: null, errors: errors.length ? errors : undefined };
}

/**
 * Generate a weekly deep-dive roundup article for a single category.
 * @param {string} category
 * @param {number} tenantId
 * @param {object} [opts]
 * @param {number} [opts.writerId] — force a specific writer
 * @param {boolean} [opts.force] — bypass cooldown
 * Returns the inserted article row or throws.
 */
async function generateDeepDive(category, tenantId, { writerId, force } = {}) {
  // 1. Find best writer for this category
  let writer;
  if (writerId) {
    writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
    if (!writer) throw new Error(`Writer ${writerId} not found`);
  } else {
    // Best auto-writer: join writer_beats + categories + writers, tiebreak by fewest deep dives
    const candidates = await db.prepare(`
      SELECT w.*, COUNT(a.id) AS dd_count
      FROM writers w
      JOIN writer_beats wb ON wb.writer_id = w.id
      JOIN categories c ON c.id = wb.category_id AND c.name = $2
      LEFT JOIN articles a ON a.writer_id = w.id AND a.tenant_id = $1
        AND a.content_type = 'deep-dive' AND a.created_at > NOW() - INTERVAL '30 days'
      WHERE w.tenant_id = $1 AND w.is_auto = true
      GROUP BY w.id
      ORDER BY dd_count ASC, w.id ASC
      LIMIT 1
    `).get(tenantId, category);
    writer = candidates;
    if (!writer) {
      // Fallback: any auto-writer
      writer = await db.prepare('SELECT * FROM writers WHERE tenant_id = $1 AND is_auto = true LIMIT 1').get(tenantId);
    }
    if (!writer) throw new Error('No auto-writer available for deep dive');
  }

  // 2. Cooldown: skip if deep dive for this category exists within last 6 days
  if (!force) {
    const recent = await db.prepare(
      `SELECT id FROM articles WHERE tenant_id = $1 AND content_type = 'deep-dive' AND category = $2 AND created_at > NOW() - INTERVAL '3 days' LIMIT 1`
    ).get(tenantId, category);
    if (recent) {
      return { skipped: true, reason: `Deep dive for ${category} already exists within last 6 days (use ?force=true to override)` };
    }
  }

  // 3. Fetch curated articles from past 7 days
  const articles = await db.prepare(`
    SELECT * FROM articles
    WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
      AND is_archived = 0 AND category = $2
      AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 500
  `).all(tenantId, category);

  if (articles.length < 5) {
    return { skipped: true, reason: `Only ${articles.length} curated articles for ${category} (need at least 5)` };
  }

  // 4. Cluster articles (lower minSize for deep dives)
  const clusters = clusterArticles(articles, 2);

  // Collect unclustered articles for "other" bucket
  const clusteredIds = new Set(clusters.flatMap(c => c.articles.map(a => a.id)));
  const unclustered = articles.filter(a => !clusteredIds.has(a.id));
  if (unclustered.length > 0) {
    clusters.push({ topic: `${category} — Other`, articles: unclustered });
  }

  if (!clusters.length) {
    return { skipped: true, reason: 'No clusters formed from articles' };
  }

  // 5. Build flat numbered source list across all clusters (cap at 30)
  const allSources = [];
  for (const cluster of clusters) {
    for (const a of cluster.articles) {
      if (allSources.length >= 30) break;
      allSources.push(a);
    }
    if (allSources.length >= 30) break;
  }

  const numberedSourceList = allSources.map((a, i) => {
    const detail = a.enriched_summary
      ? sanitizeForPrompt(a.enriched_summary, 500)
      : sanitizeForPrompt(a.summary, 200);
    return `[${i + 1}] "${sanitizeForPrompt(a.title, 200)}" (${sanitizeForPrompt(a.source, 50) || 'Unknown'}):\n${detail}`;
  }).join('\n\n');

  // 6. Build cluster thread summaries
  const clusterSummaries = clusters.map((c, ci) => {
    const articleList = c.articles.slice(0, 10).map(a => {
      const idx = allSources.findIndex(s => s.id === a.id);
      return idx >= 0 ? `  - [${idx + 1}] ${sanitizeForPrompt(a.title, 120)}` : `  - ${sanitizeForPrompt(a.title, 120)}`;
    }).join('\n');
    return `Thread ${ci + 1}: ${c.topic} (${c.articles.length} articles)\n${articleList}`;
  }).join('\n\n');

  // 7. Call AI (uses powerful tier via ai-router)
  const systemPrompt = await buildWriterPrompt(writer);

  // 8. Deep-dive prompt
  const prompt = `${systemPrompt}

Write a comprehensive weekly roundup for the "${category}" category.
Synthesize the key developments, trends, and stories from the past week
into a single, authoritative deep-dive article.

Below are ${clusters.length} story threads from the week, with ${allSources.length} total sources.

${clusterSummaries}

Requirements:
- Open with a compelling lede capturing the week's dominant theme.
  Do NOT open with "This week in..." or "It's been a busy week..."
- Organize the body into 3-5 sections, each with a Markdown ## header
  naming the specific subtopic (not generic labels)
- Each section: 2-4 paragraphs of analytical prose
- Cite sources inline using [1], [2], etc.
- Draw connections across different story threads where they relate
- End with a "## What to Watch" section: 2-3 forward-looking bullets
- Target 1200-2000 words total
- No bullet points except in "What to Watch"

Combined source list (cite using [N]):
${numberedSourceList}

Respond in exactly this format:
TITLE: [specific headline, e.g. "The Week AI Learned to X: ${category} Roundup"]
EXCERPT: [1-2 sentence hook summarizing the week's biggest theme — max 280 characters]

[article with ## section headers and inline [N] citations]

FOLLOWUPS:
Q1: [a sharp question naming a specific company, person, or trend from the week — not generic, not "What were the key themes?"]
A1: [2-3 sentences in your voice — you ARE the writer, don't reference "the article". Offer analysis, not a recap. Use [N] citations.]
Q2: [a "what's being missed" question — the thread connecting two stories that no one else has drawn yet]
A2: [answer in your voice — connect the dots, have a take]
Q3: [a specific prediction or trigger to watch — "Will X happen before Y?" not "What's next?"]
A3: [answer in your voice — make a call]`;

  const ddResult = await aiComplete({
    operation: 'deep-dive',
    tenantId,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8192,
    trigger: 'manual',
    writerId: writer.id,
  });
  if (!ddResult) throw new Error('Budget exceeded or AI unavailable');
  const content = ddResult.text;
  if (!content) throw new Error('AI returned no content');

  // 9. Parse TITLE, EXCERPT, FOLLOWUPS, + body
  const titleMatch = content.match(/^TITLE:\s*(.+)/m);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : `Weekly Deep Dive: ${category}`;
  const excerptMatch = content.match(/^EXCERPT:\s*(.+)/m);

  // Extract follow-up Q&As
  const ddFollowups = [];
  const ddFollowupsMatch = content.match(/FOLLOWUPS:\s*\n([\s\S]*?)$/);
  if (ddFollowupsMatch) {
    const ftext = ddFollowupsMatch[1];
    const qMatches = [...ftext.matchAll(/Q(\d+):\s*(.+)\nA\1:\s*([\s\S]+?)(?=\nQ\d+:|$)/g)];
    for (const m of qMatches) {
      ddFollowups.push({ question: m[2].trim(), answer: m[3].trim() });
    }
  }

  const body = content
    .replace(/^TITLE:.*\n?/m, '')
    .replace(/^EXCERPT:.*\n?/m, '')
    .replace(/FOLLOWUPS:[\s\S]*$/, '')
    .trim();

  // Guard: reject truncated or empty deep dive generations
  const ddWordCount = body.split(/\s+/).filter(Boolean).length;
  if (ddWordCount < 200) {
    throw new Error(`Deep dive content too short (${ddWordCount} words). Possible token limit issue.`);
  }

  const slug = toSlug(title) || 'deep-dive-' + Date.now();
  const summary = excerptMatch
    ? excerptMatch[1].trim().slice(0, 500)
    : body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

  // 10. Build sourceRefs
  const sourceRefs = allSources.map(a => ({
    id:         a.id,
    title:      a.title,
    source:     a.source || null,
    source_url: a.source_url || null,
  }));

  // 11. Build synthesis_meta
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const synthesisMeta = {
    source_count: allSources.length,
    source_names: [...new Set(allSources.map(a => a.source).filter(Boolean))],
    timespan_hours: 168,
    word_count: wordCount,
    deep_dive: true,
    category,
    cluster_count: clusters.length,
    thread_topics: clusters.map(c => c.topic),
  };

  // 12. INSERT with content_type = 'deep-dive'
  const row = await db.prepare(`
    INSERT INTO articles (tenant_id, title, slug, summary, full_content, source, category, content_type,
      writer_id, source_article_ids, synthesis_meta, followups, is_published, published_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'deep-dive', $8, $9, $10, $11, 0, NOW(), NOW(), NOW())
    RETURNING *
  `).get(
    tenantId,
    title,
    slug,
    summary,
    body,
    writer.name,
    category,
    writer.id,
    JSON.stringify(sourceRefs),
    JSON.stringify(synthesisMeta),
    ddFollowups.length ? JSON.stringify(ddFollowups) : null,
  );

  if (!row) throw new Error('DB INSERT returned no row — check articles table schema');

  // 13. Quality gate + post-publish hooks (same pattern as synthesizeCluster)
  try {
    const scoringEnabled = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'auto_editorial_scoring'").get(tenantId);
    if (scoringEnabled?.value !== '0') {
      const gate = await getEditorialScore(row, tenantId);
      await db.prepare(
        'UPDATE articles SET editorial_score = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(gate.score, row.id, tenantId);
      row.editorial_score = gate.score;

      if (gate.publish) {
        await db.prepare(
          'UPDATE articles SET is_published = 1 WHERE id = $1 AND tenant_id = $2'
        ).run(row.id, tenantId);
        row.is_published = 1;

        if (gate.feature_worthy) {
          await db.prepare(
            'UPDATE articles SET is_featured = 1 WHERE id = $1 AND tenant_id = $2'
          ).run(row.id, tenantId);
          row.is_featured = 1;
        }

        // Fire post-publish hooks (TLDR prewarm, thumbnail, etc.)
        onArticlePublished(row.id, tenantId).catch(() => {});
        // Notify followers of this writer
        if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
      }
    } else {
      // Scoring disabled — auto-publish like before
      await db.prepare('UPDATE articles SET is_published = 1 WHERE id = $1 AND tenant_id = $2').run(row.id, tenantId);
      row.is_published = 1;
      onArticlePublished(row.id, tenantId).catch(() => {});
      if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
    }
  } catch (gateErr) {
    console.error('[synthesis] deep-dive quality gate error:', gateErr.message);
    // Fallback: publish anyway
    await db.prepare('UPDATE articles SET is_published = 1 WHERE id = $1 AND tenant_id = $2').run(row.id, tenantId);
    row.is_published = 1;
    onArticlePublished(row.id, tenantId).catch(() => {});
    if (writer.id) createNewArticleNotification(writer.id, slug, title, tenantId).catch(() => {});
  }

  // 14. Return inserted row
  return row;
}

/**
 * Run weekly deep dives for all qualifying categories in a tenant.
 * @param {number} tenantId
 * @param {object} [opts]
 * @param {boolean} [opts.force] — bypass cooldown
 * Returns { generated, skipped, errors, categories }.
 */
async function runWeeklyDeepDives(tenantId, { force } = {}) {
  // Fetch distinct categories with recent published articles
  const rows = await db.prepare(`
    SELECT DISTINCT category FROM articles
    WHERE tenant_id = $1 AND is_published = 1 AND category != 'Uncategorized'
      AND created_at > NOW() - INTERVAL '7 days'
  `).all(tenantId);

  let generated = 0;
  let skipped = 0;
  const errors = [];
  const categories = [];

  for (const { category } of rows) {
    // Count curated articles in last 7 days
    const countRow = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM articles
      WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
        AND is_archived = 0 AND category = $2
        AND created_at > NOW() - INTERVAL '7 days'
    `).get(tenantId, category);

    if ((countRow?.cnt || 0) < 5) {
      skipped++;
      continue;
    }

    try {
      const result = await generateDeepDive(category, tenantId, { force });
      if (result?.skipped) {
        skipped++;
      } else {
        generated++;
        categories.push(category);
      }
    } catch (err) {
      errors.push(`${category}: ${err.message}`);
    }
  }

  return { generated, skipped, errors: errors.length ? errors : undefined, categories };
}

/**
 * Generate and store a synthesis forecast for a writer.
 * Runs the full evaluation pipeline without generating, persists to synthesis_forecasts.
 */
async function generateForecast(writerId, tenantId) {
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
  if (!writer) return null;

  const lookbackHours = writer.synthesis_lookback_hours || 168;
  const minSize = writer.min_cluster_size || 3;

  const cooldown = await getCooldownStatus(writerId, tenantId);
  const pool = await getArticlePool(writerId, tenantId, lookbackHours, minSize);
  const clusters = clusterArticles(pool.articles, minSize);
  const evaluated = await evaluateClusters(clusters, tenantId, false);

  const wouldGenerate = evaluated.filter(c => !c.wouldSkipDedup).length;
  const wouldSkipDedup = evaluated.filter(c => c.wouldSkipDedup).length;
  const summary = { totalClusters: evaluated.length, wouldGenerate, wouldSkipDedup, articlePoolSize: pool.articles.length, cooldown };

  // Mark prior pending forecasts for this writer as stale
  await db.prepare(
    `UPDATE synthesis_forecasts SET status = 'stale' WHERE tenant_id = $1 AND writer_id = $2 AND status = 'pending'`
  ).run(tenantId, writerId);

  const row = await db.prepare(`
    INSERT INTO synthesis_forecasts (tenant_id, writer_id, clusters, summary)
    VALUES ($1, $2, $3, $4) RETURNING *
  `).get(tenantId, writerId, JSON.stringify(evaluated), JSON.stringify(summary));

  return { ...row, writerName: writer.name };
}

/**
 * Get the latest pending forecast for a writer.
 */
async function getLatestForecast(writerId, tenantId) {
  return db.prepare(
    `SELECT * FROM synthesis_forecasts WHERE tenant_id = $1 AND writer_id = $2 AND status = 'pending' ORDER BY forecast_at DESC LIMIT 1`
  ).get(tenantId, writerId);
}

module.exports = {
  enrichArticle, overlapScore, clusterArticles, synthesizeCluster, runSynthesisForWriter, generateDeepDive, runWeeklyDeepDives,
  getCooldownStatus, getArticlePool, evaluateClusters, computeClusterStrength, generateProposedHeadline,
  generateForecast, getLatestForecast, checkWatchlist, loadWatchlist,
};
