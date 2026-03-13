/**
 * Deep Feed AI — Synthesis engine
 * Clusters related articles and generates original analytical pieces via Gemini.
 */
const db = require('../db');
const { toSlug } = require('./utils');
const { prewarmSummary } = require('../routes/summary');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
 * Extract significant words from a title string.
 */
function significantWords(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Group articles by topic.
 * Strategy 1: within each category, find articles sharing 1+ significant title words.
 * Strategy 2 (fallback): if no keyword clusters meet minSize, treat each category with
 *   enough articles as its own cluster — the category name becomes the topic.
 * Returns array of { topic, articles } where articles.length >= minSize.
 */
function clusterArticles(articles, minSize = 3) {
  // Group by category
  const byCategory = {};
  for (const a of articles) {
    const cat = a.category || 'General';
    (byCategory[cat] = byCategory[cat] || []).push(a);
  }

  const clusters = [];

  for (const [cat, catArticles] of Object.entries(byCategory)) {
    // --- Strategy 1: keyword overlap (1+ shared significant words) ---
    const wordSets = catArticles.map(a => ({
      article: a,
      words: new Set(significantWords(a.title)),
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
        if (shared >= 1) {
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
async function synthesizeCluster(cluster, writer) {
  try {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on this environment');

    const systemPrompt = writer.system_prompt
      || `You are ${writer.name}, a tech journalist covering ${writer.beat || 'technology'}.`;

    const sourceSummaries = cluster.articles.map((a, i) =>
      `${i + 1}. "${a.title}" (${a.source || 'Unknown'}): ${(a.summary || '').replace(/<[^>]+>/g, '').slice(0, 300)}`
    ).join('\n');

    const prompt = `${systemPrompt}

Write a 3-4 paragraph analytical article that synthesizes the following related sources into a cohesive original piece. Provide your own analysis and insights connecting the themes. Write in your distinctive voice and style.

Topic area: ${cluster.topic}

Sources:
${sourceSummaries}

Respond in exactly this format — no extra commentary:
TITLE: [a specific, compelling, publication-ready headline for this piece]

[3-4 paragraphs of analytical prose. No headers, no bullet points, flowing paragraphs only.]`;

    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status);
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
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

    const slug = (toSlug(title) || 'synthesis') + '-' + Date.now();
    const summary = body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

    // Store rich source objects so the frontend can render citations without extra API calls
    const sourceRefs = cluster.articles.map(a => ({
      id:         a.id,
      title:      a.title,
      source:     a.source || null,
      source_url: a.source_url || null,
    }));

    const row = await db.prepare(`
      INSERT INTO articles (title, slug, summary, full_content, source, category, content_type,
        writer_id, source_article_ids, is_published, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'original', $7, $8, 1, NOW(), NOW(), NOW())
      RETURNING *
    `).get(
      title,
      slug,
      summary,
      body,
      writer.name,
      cluster.articles[0]?.category || 'General',
      writer.id,
      JSON.stringify(sourceRefs),
    );

    if (!row) throw new Error('DB INSERT returned no row — check articles table schema');

    // Pre-warm the summary cache so the first page visitor never waits for Gemini
    prewarmSummary(title, body.slice(0, 800)).catch(() => {});

    return row;
  } catch (err) {
    console.error('[synthesis] synthesizeCluster error:', err.message);
    throw err; // re-throw so caller can surface the real error
  }
}

/**
 * Run full synthesis pipeline for a single auto-writer.
 * Fetches recent non-original articles matching the writer's beat, clusters them,
 * and generates original pieces for each valid cluster.
 * Returns { generated, clusters, skipped }.
 */
async function runSynthesisForWriter(writerId) {
  const writer = await db.prepare('SELECT * FROM voices WHERE id = $1').get(writerId);
  if (!writer) return { generated: 0, clusters: 0, skipped: 'Writer not found' };

  const lookbackHours = writer.synthesis_lookback_hours || 168;
  const minSize = writer.min_cluster_size || 3;

  // Fetch all recent non-original articles — beat shapes the writer's voice/angle, not article selection
  const articles = await db.prepare(`
    SELECT * FROM articles
    WHERE (content_type IS NULL OR content_type != 'original')
      AND is_archived = 0
      AND created_at > NOW() - ($1 || ' hours')::INTERVAL
    ORDER BY created_at DESC LIMIT 200
  `).all(lookbackHours);

  if (!articles.length) return { generated: 0, clusters: 0, skipped: 'No recent articles found' };

  const clusters = clusterArticles(articles, minSize);
  if (!clusters.length) return { generated: 0, clusters: 0, skipped: 'No clusters met minimum size' };

  let generated = 0;
  const errors = [];
  for (const cluster of clusters) {
    try {
      const result = await synthesizeCluster(cluster, writer);
      if (result) generated++;
      else errors.push(`Cluster "${cluster.topic}": synthesizeCluster returned null (check GEMINI_API_KEY or DB)`);
    } catch (err) {
      errors.push(`Cluster "${cluster.topic}": ${err.message}`);
    }
  }

  return { generated, clusters: clusters.length, skipped: null, errors: errors.length ? errors : undefined };
}

module.exports = { clusterArticles, synthesizeCluster, runSynthesisForWriter };
