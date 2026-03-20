/**
 * Deep Feed AI — Synthesis engine
 * Clusters related articles and generates original analytical pieces via Gemini.
 */
const db = require('../db');
const { toSlug, sanitizeForPrompt } = require('./utils');
const { prewarmSummary } = require('../routes/summary');
const { logUsage, extractGeminiTokens } = require('./ai-usage');
const { getEditorialScore } = require('./quality-gate');
const { generateAndStoreImage } = require('./media-helpers');
const { canSpend } = require('./budget');
const { onArticlePublished } = require('./post-publish');
const { createNewArticleNotification } = require('../routes/notifications');
const { buildWriterPrompt } = require('./writer-assign');
const { getGeminiKey } = require('./gemini-config');

const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const GEMINI_DD_MODEL = 'gemini-2.5-flash';
const GEMINI_DD_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DD_MODEL}:generateContent`;

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','in','on','at','to','for','of',
  'and','or','but','with','from','this','that','it','its','be','has','have','had',
  // common filler words that shouldn't drive topic names
  'you','your','we','our','my','i','he','she','they','them','their',
  'new','now','just','more','will','can','get','use','let','make','how',
  'what','when','who','which','about','says','say','said','also','like',
  'one','two','three','us','up','out','over','after','into',
]);

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
 * Extract significant words from a title string.
 * @param {string} title
 * @param {Set} [nicheStopWords] — additional niche-specific words to filter
 */
function significantWords(title, nicheStopWords) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w) && (!nicheStopWords || !nicheStopWords.has(w)));
}

/**
 * Group articles by topic.
 * Strategy 1: within each category, find articles sharing 1+ significant title words.
 * Strategy 2 (fallback): if no keyword clusters meet minSize, treat each category with
 *   enough articles as its own cluster — the category name becomes the topic.
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

    // --- Strategy 1: keyword overlap (3+ shared significant words) ---
    const wordSets = catArticles.map(a => ({
      article: a,
      words: new Set(significantWords(a.title, nicheStopWords)),
    }));

    const used = new Set();

    for (let i = 0; i < wordSets.length; i++) {
      if (used.has(i)) continue;
      const group = [wordSets[i]];
      const sharedWords = new Map();

      for (const w of wordSets[i].words) {
        sharedWords.set(w, (sharedWords.get(w) || 0) + 1);
      }

      for (let j = i + 1; j < wordSets.length; j++) {
        if (used.has(j)) continue;
        let shared = 0;
        for (const w of wordSets[j].words) {
          if (wordSets[i].words.has(w)) shared++;
        }
        if (shared >= 3) {
          group.push(wordSets[j]);
          for (const w of wordSets[j].words) {
            sharedWords.set(w, (sharedWords.get(w) || 0) + 1);
          }
        }
      }

      if (group.length >= minSize) {
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

    // --- Strategy 2: category-level fallback for unclustered articles ---
    const unclustered = catArticles.filter((_, i) => !used.has(i));
    if (unclustered.length >= minSize) {
      clusters.push({
        topic: cat,
        articles: unclustered,
      });
    }
  }

  return clusters;
}

/**
 * Call Gemini to synthesize a cluster of articles into an original analytical piece.
 * Inserts the result into the articles table.  Returns the inserted row or null.
 */
async function synthesizeCluster(cluster, writer, tenantId) {
  try {
    const apiKey = await getGeminiKey(tenantId);
    if (!apiKey) throw new Error('No Gemini API key configured (check Settings or GEMINI_API_KEY env var)');

    // Budget check — skip if daily/monthly budget exhausted
    const budgetCheck = await canSpend('synthesis', tenantId);
    if (!budgetCheck.allowed) throw new Error(`Budget exceeded: ${budgetCheck.reason}`);

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

    const sourceSummaries = cluster.articles.map((a, i) =>
      `${i + 1}. "${sanitizeForPrompt(a.title, 200)}" (${sanitizeForPrompt(a.source, 50) || 'Unknown'}): ${sanitizeForPrompt(a.summary, 300)}`
    ).join('\n');

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

[your article text with inline [1], [2] citations]`;

    const _start = Date.now();
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status);
      logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'synthesis', writerId: writer.id, trigger: 'manual', durationMs: Date.now() - _start, success: false, error: `${res.status}: ${String(errText).slice(0, 200)}`, tenantId }).catch(() => {});
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const _tokens = extractGeminiTokens(data);
    logUsage({ provider: 'gemini', model: GEMINI_MODEL, operation: 'synthesis', writerId: writer.id, trigger: 'manual', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start, tenantId }).catch(() => {});
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) {
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || JSON.stringify(data).slice(0, 200);
      throw new Error(`Gemini returned no content — ${reason}`);
    }

    // Parse Gemini's TITLE: line and body separately
    const titleMatch = content.match(/^TITLE:\s*(.+)/m);
    const title = titleMatch
      ? titleMatch[1].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes if any
      : `Analysis: ${cluster.topic}`;
    const body = content.replace(/^TITLE:.*\n?/m, '').trim();

    const slug = toSlug(title) || 'synthesis-' + Date.now();
    const summary = body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

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
        writer_id, source_article_ids, synthesis_meta, is_published, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'original', $8, $9, $10, 0, NOW(), NOW(), NOW())
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
      console.error('[synthesis] quality gate error:', gateErr.message);
      // Fallback: publish anyway
      await db.prepare('UPDATE articles SET is_published = 1 WHERE id = $1 AND tenant_id = $2').run(row.id, tenantId);
      row.is_published = 1;
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
 * Run full synthesis pipeline for a single auto-writer.
 * @param {number|string} writerId
 * @param {object} opts
 * @param {boolean} [opts.force=false] — skip cooldown and dedup checks
 * Returns { generated, clusters, skipped }.
 */
async function runSynthesisForWriter(writerId, { force = false, tenantId } = {}) {
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, tenantId);
  if (!writer) return { generated: 0, clusters: 0, skipped: 'Writer not found' };

  // Cooldown: don't re-run if a synthesis already ran within the last 23h (unless forced)
  if (!force) {
    const lastRun = await db.prepare(
      `SELECT MAX(created_at) AS last FROM articles WHERE tenant_id = $1 AND content_type = 'original' AND writer_id = $2`
    ).get(tenantId, writerId);
    if (lastRun?.last) {
      const hoursSince = (Date.now() - new Date(lastRun.last).getTime()) / 3_600_000;
      if (hoursSince < 23) {
        return { generated: 0, clusters: 0, skipped: `Cooldown: last synthesis ${Math.round(hoursSince)}h ago (use ?force=true to override)` };
      }
    }
  }

  const lookbackHours = writer.synthesis_lookback_hours || 168;
  const minSize = writer.min_cluster_size || 3;

  // Beat-scoped synthesis: prefer articles assigned to this writer, then fall back
  // to unassigned articles in the writer's beat category if below min cluster size.
  let articles = await db.prepare(`
    SELECT * FROM articles
    WHERE tenant_id = $3
      AND (content_type IS NULL OR content_type != 'original')
      AND is_archived = 0
      AND writer_id = $2
      AND created_at > NOW() - make_interval(hours => $1)
    ORDER BY created_at DESC LIMIT 200
  `).all(lookbackHours, writerId, tenantId);

  // Fallback: if writer-scoped articles are too few, add unassigned articles in the writer's beat categories
  if (articles.length < minSize) {
    const beatArticles = await db.prepare(`
      SELECT * FROM articles
      WHERE tenant_id = $3
        AND (content_type IS NULL OR content_type != 'original')
        AND is_archived = 0
        AND (writer_id IS NULL)
        AND category IN (
          SELECT c.name FROM writer_beats wb
          JOIN categories c ON c.id = wb.category_id
          WHERE wb.writer_id = $2
        )
        AND created_at > NOW() - make_interval(hours => $1)
      ORDER BY created_at DESC LIMIT 200
    `).all(lookbackHours, writerId, tenantId);

    // Merge, deduplicating by id
    const existingIds = new Set(articles.map(a => a.id));
    for (const a of beatArticles) {
      if (!existingIds.has(a.id)) articles.push(a);
    }
  }

  if (!articles.length) return { generated: 0, clusters: 0, skipped: 'No recent articles found' };

  const clusters = clusterArticles(articles, minSize);
  if (!clusters.length) return { generated: 0, clusters: 0, skipped: 'No clusters met minimum size' };

  let generated = 0;
  let skippedDedup = 0;
  const errors = [];
  for (const cluster of clusters) {
    try {
      // Skip clusters that substantially overlap with a recently generated original
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

  return { generated, clusters: clusters.length, skippedDedup, skipped: null, errors: errors.length ? errors : undefined };
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
      `SELECT id FROM articles WHERE tenant_id = $1 AND content_type = 'deep-dive' AND category = $2 AND created_at > NOW() - INTERVAL '6 days' LIMIT 1`
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

  const numberedSourceList = allSources.map((a, i) =>
    `[${i + 1}] "${sanitizeForPrompt(a.title, 200)}" (${sanitizeForPrompt(a.source, 50) || 'Unknown'}): ${sanitizeForPrompt(a.summary, 200)}`
  ).join('\n');

  // 6. Build cluster thread summaries
  const clusterSummaries = clusters.map((c, ci) => {
    const articleList = c.articles.slice(0, 10).map(a => {
      const idx = allSources.findIndex(s => s.id === a.id);
      return idx >= 0 ? `  - [${idx + 1}] ${sanitizeForPrompt(a.title, 120)}` : `  - ${sanitizeForPrompt(a.title, 120)}`;
    }).join('\n');
    return `Thread ${ci + 1}: ${c.topic} (${c.articles.length} articles)\n${articleList}`;
  }).join('\n\n');

  // 7. Call Gemini (non-lite model for higher quality)
  const apiKey = await getGeminiKey(tenantId);
  if (!apiKey) throw new Error('No Gemini API key configured (check Settings or GEMINI_API_KEY env var)');

  const budgetCheck = await canSpend('synthesis', tenantId);
  if (!budgetCheck.allowed) throw new Error(`Budget exceeded: ${budgetCheck.reason}`);

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

[article with ## section headers and inline [N] citations]`;

  const _start = Date.now();
  const res = await fetch(`${GEMINI_DD_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.status);
    logUsage({ provider: 'gemini', model: GEMINI_DD_MODEL, operation: 'deep-dive', writerId: writer.id, trigger: 'manual', durationMs: Date.now() - _start, success: false, error: `${res.status}: ${String(errText).slice(0, 200)}`, tenantId }).catch(() => {});
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const _tokens = extractGeminiTokens(data);
  logUsage({ provider: 'gemini', model: GEMINI_DD_MODEL, operation: 'deep-dive', writerId: writer.id, trigger: 'manual', inputTokens: _tokens.promptTokenCount, outputTokens: _tokens.candidatesTokenCount, durationMs: Date.now() - _start, tenantId }).catch(() => {});
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!content) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || JSON.stringify(data).slice(0, 200);
    throw new Error(`Gemini returned no content — ${reason}`);
  }

  // 9. Parse TITLE + body
  const titleMatch = content.match(/^TITLE:\s*(.+)/m);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : `Weekly Deep Dive: ${category}`;
  const body = content.replace(/^TITLE:.*\n?/m, '').trim();

  const slug = toSlug(title) || 'deep-dive-' + Date.now();
  const summary = body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

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
      writer_id, source_article_ids, synthesis_meta, is_published, published_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'deep-dive', $8, $9, $10, 0, NOW(), NOW(), NOW())
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

module.exports = { clusterArticles, synthesizeCluster, runSynthesisForWriter, generateDeepDive, runWeeklyDeepDives };
