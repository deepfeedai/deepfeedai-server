/**
 * Deep Feed AI — Synthesis engine
 * Clusters related articles and generates original analytical pieces via Gemini.
 */
const db = require('../db');
const { toSlug } = require('./utils');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','in','on','at','to','for','of',
  'and','or','but','with','from','this','that','it','its','be','has','have','had',
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

        const sorted = [...sharedWords.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([w]) => w);

        clusters.push({
          topic: sorted.join(' ') || cat,
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
    if (!GEMINI_API_KEY) return null;

    const systemPrompt = writer.system_prompt
      || `You are ${writer.name}, a tech journalist covering ${writer.beat || 'technology'}.`;

    const sourceSummaries = cluster.articles.map((a, i) =>
      `${i + 1}. "${a.title}" (${a.source || 'Unknown'}): ${(a.summary || '').replace(/<[^>]+>/g, '').slice(0, 300)}`
    ).join('\n');

    const prompt = `${systemPrompt}

Write a 3-4 paragraph analytical article that synthesizes the following related sources into a cohesive original piece. Provide your own analysis and insights connecting the themes. Write in your distinctive voice and style.

Topic: ${cluster.topic}

Sources:
${sourceSummaries}

Your analytical article:`;

    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) return null;

    const title = `Analysis: ${cluster.topic}`;
    const slug = toSlug(title) || `synthesis-${Date.now()}`;
    const ids = cluster.articles.map(a => a.id);

    const row = await db.prepare(`
      INSERT INTO articles (title, slug, summary, source, category, content_type,
        writer_id, source_article_ids, is_published, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'original', $6, $7, 1, NOW(), NOW())
      RETURNING *
    `).get(
      title,
      slug,
      content,
      'Synthesis',
      cluster.articles[0]?.category || 'Other',
      writer.id,
      JSON.stringify(ids),
    );

    return row || null;
  } catch (err) {
    console.error('[synthesis] synthesizeCluster error:', err.message);
    return null;
  }
}

/**
 * Run full synthesis pipeline for a single auto-writer.
 * Fetches recent non-original articles matching the writer's beat, clusters them,
 * and generates original pieces for each valid cluster.
 * Returns { generated, clusters, skipped }.
 */
async function runSynthesisForWriter(writerId) {
  const writer = await db.prepare('SELECT * FROM voices WHERE id = $1 AND is_auto = true').get(writerId);
  if (!writer) return { generated: 0, clusters: 0, skipped: 'Writer not found or not auto-enabled' };

  // Fetch recent non-original articles matching this writer's beat (last 7 days)
  const beatFilter = writer.beat
    ? `AND LOWER(category) = LOWER('${writer.beat.replace(/'/g, "''")}')`
    : '';

  const articles = await db.prepare(`
    SELECT * FROM articles
    WHERE (content_type IS NULL OR content_type != 'original')
      AND is_archived = 0
      AND created_at > NOW() - INTERVAL '7 days'
      ${beatFilter}
    ORDER BY created_at DESC
  `).all();

  if (!articles.length) return { generated: 0, clusters: 0, skipped: 'No recent articles found' };

  const clusters = clusterArticles(articles);
  if (!clusters.length) return { generated: 0, clusters: 0, skipped: 'No clusters met minimum size' };

  let generated = 0;
  for (const cluster of clusters) {
    const result = await synthesizeCluster(cluster, writer);
    if (result) generated++;
  }

  return { generated, clusters: clusters.length, skipped: null };
}

module.exports = { clusterArticles, synthesizeCluster, runSynthesisForWriter };
