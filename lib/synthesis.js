/**
 * Deep Feed AI — Synthesis engine
 * Clusters related articles and generates original analytical pieces via Gemini.
 */
const db = require('../db');
const { toSlug, sanitizeForPrompt, significantWords, STOP_WORDS } = require('./utils');
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
    const { loadPrompt } = require('./prompt-loader');
    const p = loadPrompt('scrape-summarize');
    const { messages, ...meta } = p.render({
      title: sanitizeForPrompt(article.title, 200),
      text: sanitizeForPrompt(text, 4000),
    });
    const result = await aiComplete({
      ...meta, messages, tenantId,
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
 * Clean and truncate a title for use as a cluster topic label.
 * Strips trailing source-name suffix (e.g. " | BleepingComputer"), collapses
 * whitespace, and cuts at a word boundary near `max` characters.
 */
function truncateTitle(title, max = 60) {
  if (!title) return '';
  let s = String(title).replace(/\s+/g, ' ').trim();
  // Strip trailing " | Source" or " - Source" suffix
  s = s.replace(/\s*[|\-–—]\s*[A-Z][\w.\s&'-]{2,40}$/, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
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

      // Require minimum cluster size AND distinct publications.
      // Distinct-sources floor: max(2, min(minSize, 3)) — synthesis is about
      // multi-source corroboration, so a hard floor of 2 distinct publications
      // is enforced even when min_cluster_size is set to 1.
      const distinctSources = new Set(group.map(g => g.article.source).filter(Boolean));
      const minSources = Math.max(2, Math.min(minSize, 3));
      if (group.length >= minSize && distinctSources.size >= minSources) {
        for (const g of group) used.add(wordSets.indexOf(g));

        // Topic = category + top shared keyword — but ONLY if the keyword
        // actually appears in titles of 2+ cluster members. Otherwise fall
        // back to the seed article's title (truncated) so we don't get
        // low-signal names like "Why Nearly Is Dominating".
        const topKeyword = [...sharedWords.entries()]
          .filter(([w, count]) => count >= 2 && w.length > 3)
          .sort((a, b) => b[1] - a[1])
          .map(([w]) => w)[0];

        const topic = topKeyword
          ? `${cat} — ${topKeyword}`
          : `${cat} — ${truncateTitle(group[0].article.title, 60)}`;

        clusters.push({
          topic,
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
 * Parse a pgvector-formatted string like "[0.1,0.2,...]" into an array of numbers.
 * Returns null if the input isn't parseable (missing embedding, bad format, etc).
 */
function parseEmbedding(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

/** Cosine similarity between two equal-length numeric arrays. */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Extract entity-like tokens (capitalised words / acronyms / numbers) from
 * title + summary. Used as a coherence gate in semantic clustering — two
 * articles can be embedded-similar but about different stories ("Apple
 * earnings" vs. "Apple Vision Pro launch") and entity overlap weeds those out.
 *
 * Heuristics (intentionally cheap — no NER model):
 *   - Capitalised tokens 3+ chars long that are not at sentence start when
 *     they're the only capital in the sentence (rough proper-noun signal).
 *   - All-caps acronyms 2-6 chars (FTC, OpenAI, GPT, NVDA).
 *   - Numbers attached to a word (iPhone 17, GPT-5, $100M).
 *   - Lower-cased and de-duped.
 */
function extractEntities(text) {
  if (!text) return new Set();
  const cleaned = String(text).replace(/<[^>]+>/g, ' ').slice(0, 400);
  const out = new Set();
  // Capitalised words and acronyms — "OpenAI", "FTC", "Vision Pro", "GPT-5"
  const capWord = /\b([A-Z][A-Za-z0-9]{2,}(?:[-/][A-Za-z0-9]+)*)\b/g;
  let m;
  while ((m = capWord.exec(cleaned)) !== null) {
    const tok = m[1].toLowerCase();
    if (tok.length >= 3) out.add(tok);
  }
  // Versions/numbers attached to letters — captures "gpt-5", "ios-18"
  const versioned = /\b([a-z]{2,}[-_ ]?\d+(?:\.\d+)?)\b/gi;
  while ((m = versioned.exec(cleaned)) !== null) {
    out.add(m[1].toLowerCase().replace(/[\s_]+/g, '-'));
  }
  // Drop generic capitalised words that are stop-y when lowercased
  for (const w of Array.from(out)) {
    if (STOP_WORDS.has(w)) out.delete(w);
  }
  return out;
}

/**
 * Recency multiplier in [floor, 1.0]. Used to weigh embedding similarity:
 * a 6-day-old neighbour is less likely to belong to today's story even if
 * its embedding is close. Linear decay over `decayHours`, floored at `floor`
 * so very old material isn't fully discarded — just demoted.
 */
function recencyWeight(article, decayHours = 168, floor = 0.7) {
  const ts = article?.created_at || article?.published_at;
  if (!ts) return 1.0;
  const ageHours = (Date.now() - new Date(ts).getTime()) / 3_600_000;
  if (ageHours <= 0) return 1.0;
  if (ageHours >= decayHours) return floor;
  const t = ageHours / decayHours;
  return 1.0 - t * (1.0 - floor);
}

/**
 * Pre-group articles by an existing topic_tag so the upstream LLM tagger's
 * verdict isn't thrown away during clustering. Returns:
 *   { byTag: Map<tag, articles[]>, untagged: articles[] }
 * Only groups with >=2 articles AND >=2 distinct sources are returned in byTag;
 * everything else falls through to untagged for the normal embedding path.
 */
function groupByTopicTag(articles) {
  const byTag = new Map();
  const untagged = [];
  for (const a of articles) {
    const tag = (a.topic_tag || '').trim();
    if (!tag) { untagged.push(a); continue; }
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(a);
  }
  // Promote only tags that already have multi-source corroboration; the
  // rest fall back to embedding/keyword clustering so a singleton-tagged
  // article can still join a larger semantic group.
  const promoted = new Map();
  for (const [tag, items] of byTag) {
    const sources = new Set(items.map(a => a.source).filter(Boolean));
    if (items.length >= 2 && sources.size >= 2) {
      promoted.set(tag, items);
    } else {
      untagged.push(...items);
    }
  }
  return { byTag: promoted, untagged };
}

/**
 * Semantic clustering using article embeddings. Groups articles whose
 * embeddings are ≥ SEMANTIC_THRESHOLD cosine similar AND share at least one
 * significant non-stop-word in their titles (coherence check to prevent
 * semantic over-merging).
 *
 * Falls back to keyword clustering for articles without embeddings.
 *
 * @param {object[]} articles - pool articles (may or may not have .embedding)
 * @param {number} minSize - writer's min_cluster_size
 * @param {object} opts
 * @param {number} opts.threshold - cosine similarity threshold (default 0.72)
 * @returns {Promise<object[]>} clusters
 */
async function clusterArticlesSemantic(articles, minSize = 3, opts = {}) {
  const threshold      = opts.threshold        ?? 0.72;
  const maxClusterSize = opts.maxClusterSize   ?? 8;
  const decayHours     = opts.recencyDecayHours ?? 168;
  const requireEntity  = opts.requireEntityOverlap !== false;
  const useTopicTag    = opts.useTopicTagHints !== false;

  // Dedup same as keyword path
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

  const nicheStopWords = buildNicheStopWords(deduped);
  const clusters = [];

  // ── Pre-grouping by topic_tag ────────────────────────────────
  // If the upstream LLM-driven topic_tag has already grouped sources, take
  // that as ground truth and emit those clusters first. This is the cheapest,
  // highest-confidence signal we have — embeddings are a fallback for
  // un-tagged or singleton-tagged sources.
  let pool = deduped;
  if (useTopicTag) {
    const { byTag, untagged } = groupByTopicTag(deduped);
    for (const [tag, items] of byTag) {
      const distinctSources = new Set(items.map(a => a.source).filter(Boolean));
      const minSources = Math.max(2, Math.min(minSize, 3));
      if (items.length < minSize || distinctSources.size < minSources) {
        // Sub-threshold pre-group falls back to embedding pool
        untagged.push(...items);
        continue;
      }
      // Cap by recency × source diversity
      const sorted = [...items].sort((a, b) => {
        const ra = recencyWeight(a, decayHours);
        const rb = recencyWeight(b, decayHours);
        return rb - ra;
      });
      const capped = sorted.slice(0, maxClusterSize);
      const cat = capped[0]?.category || 'General';
      clusters.push({
        topic: `${cat} — ${tag}`,
        articles: capped,
        _topicTag: tag,
        _source: 'topic_tag',
      });
    }
    pool = untagged;
  }

  // Split remaining pool: articles with embeddings go through semantic
  // path; others keyword.
  const withEmbed = [];
  const withoutEmbed = [];
  for (const a of pool) {
    const vec = parseEmbedding(a.embedding);
    if (vec && vec.length) withEmbed.push({ article: a, vec });
    else withoutEmbed.push(a);
  }

  // Group semantic candidates by category
  const byCategory = {};
  for (const item of withEmbed) {
    const cat = item.article.category || 'General';
    (byCategory[cat] = byCategory[cat] || []).push(item);
  }

  // Pre-compute entities for every embedded item (cached on the wrapper)
  for (const item of withEmbed) {
    item._entities = extractEntities(`${item.article.title || ''} ${item.article.summary || ''}`);
    item._recency = recencyWeight(item.article, decayHours);
  }

  for (const [cat, items] of Object.entries(byCategory)) {
    if (cat === 'Uncategorized') continue;
    // Sort items by recency desc so seeds are the freshest stories — this
    // produces clusters anchored to current news, not stale items.
    items.sort((a, b) => b._recency - a._recency);
    const used = new Set();
    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const group = [items[i]];
      used.add(i);
      for (let j = i + 1; j < items.length; j++) {
        if (used.has(j)) continue;
        // Compare candidate against ALL current group members; take best
        // recency-weighted sim. The candidate's recency is the dominant
        // factor — old items can still join a fresh group, but they need
        // to be very similar.
        let bestSim = 0;
        for (const m of group) {
          const raw = cosineSimilarity(m.vec, items[j].vec);
          const weighted = raw * Math.min(m._recency, items[j]._recency);
          if (weighted > bestSim) bestSim = weighted;
        }
        if (bestSim < threshold) continue;
        // Coherence: require ≥1 shared significant title word with ANY member
        const candWords = new Set(significantWords(items[j].article.title, nicheStopWords));
        let shareKw = false;
        for (const m of group) {
          const mWords = new Set(significantWords(m.article.title, nicheStopWords));
          for (const w of candWords) { if (mWords.has(w)) { shareKw = true; break; } }
          if (shareKw) break;
        }
        if (!shareKw) continue;
        // Stricter coherence: also require ≥1 shared entity (proper noun /
        // acronym / version number). Skipped when both sides have no entities
        // at all — short headlines wouldn't get a fair shake.
        if (requireEntity) {
          const candEnts = items[j]._entities;
          let shareEnt = false;
          let anyEnts = candEnts.size > 0;
          for (const m of group) {
            anyEnts = anyEnts || m._entities.size > 0;
            for (const e of candEnts) { if (m._entities.has(e)) { shareEnt = true; break; } }
            if (shareEnt) break;
          }
          if (anyEnts && !shareEnt) continue;
        }
        group.push(items[j]);
        used.add(j);
        // Cap group size — prefer most-similar / most-recent additions.
        // Once we hit the cap, stop extending.
        if (group.length >= maxClusterSize) break;
      }

      // Apply gates
      const distinctSources = new Set(group.map(g => g.article.source).filter(Boolean));
      const minSources = Math.max(2, Math.min(minSize, 3));
      if (group.length < minSize || distinctSources.size < minSources) continue;

      // Topic: top-frequency non-stop keyword across titles of >=2 members
      const wordCounts = new Map();
      for (const m of group) {
        for (const w of new Set(significantWords(m.article.title, nicheStopWords))) {
          wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
        }
      }
      const topKeyword = [...wordCounts.entries()]
        .filter(([w, c]) => c >= 2 && w.length > 3)
        .sort((a, b) => b[1] - a[1])
        .map(([w]) => w)[0];
      const topic = topKeyword
        ? `${cat} — ${topKeyword}`
        : `${cat} — ${truncateTitle(group[0].article.title, 60)}`;

      // Mean pairwise similarity for strength
      let sumSim = 0, pairs = 0;
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) {
          sumSim += cosineSimilarity(group[a].vec, group[b].vec); pairs++;
        }
      }
      const semanticStrength = pairs > 0 ? Math.round((sumSim / pairs) * 100) / 100 : 0;

      clusters.push({
        topic,
        articles: group.map(g => g.article),
        _semanticStrength: semanticStrength,
        _source: 'semantic',
      });
    }
  }

  // Articles without embeddings: run them through the keyword path so nothing
  // is lost during the rollout. Any overlap between the two paths' article IDs
  // is deduped below.
  if (withoutEmbed.length) {
    const kwClusters = clusterArticles(withoutEmbed, minSize);
    for (const c of kwClusters) {
      clusters.push(c);
    }
  }

  return clusters;
}

/**
 * Dispatcher: chooses between semantic and keyword clustering based on tenant
 * setting and embedding availability. Defaults to 'semantic' when pgvector
 * is available, 'keyword' otherwise.
 */
async function clusterArticlesForWriter(articles, minSize, tenantId) {
  let mode = 'keyword';
  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'synthesis_clustering_mode'"
    ).get(tenantId);
    const configured = (row?.value || '').toLowerCase();
    if (configured === 'semantic' || configured === 'keyword' || configured === 'hybrid') {
      mode = configured;
    } else {
      // Auto: use semantic if pgvector available
      try {
        const { isPgvectorAvailable } = require('./embeddings');
        if (await isPgvectorAvailable()) mode = 'semantic';
      } catch { /* keep keyword */ }
    }
  } catch { /* keep keyword */ }

  // Per-tenant narrowing knobs (Phase N1). Reasonable defaults preserve
  // current behaviour on tenants that haven't configured anything; setting
  // them lets an editor tighten or loosen the gates.
  const semOpts = await loadSemanticClusteringOpts(tenantId);

  if (mode === 'semantic') return clusterArticlesSemantic(articles, minSize, semOpts);
  if (mode === 'hybrid') {
    const [sem, kw] = await Promise.all([
      clusterArticlesSemantic(articles, minSize, semOpts),
      Promise.resolve(clusterArticles(articles, minSize)),
    ]);
    // Dedup by first-article-id as a simple cluster key
    const seen = new Set();
    const merged = [];
    for (const c of [...sem, ...kw]) {
      const key = (c.articles[0] && c.articles[0].id) || c.topic;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    return merged;
  }
  return clusterArticles(articles, minSize);
}

/**
 * Load semantic clustering knobs from the settings table for a tenant.
 * Returns an opts object suitable for `clusterArticlesSemantic(...)`.
 *
 * Recognised keys:
 *   synthesis_max_cluster_size            integer (default 8)
 *   synthesis_recency_decay_hours         integer (default 168)
 *   synthesis_require_entity_overlap      bool    (default true)
 *   synthesis_use_topic_tag_hints         bool    (default true)
 *   synthesis_semantic_threshold          float   (default 0.72)
 */
async function loadSemanticClusteringOpts(tenantId) {
  const opts = {};
  try {
    const rows = await db.prepare(`
      SELECT key, value FROM settings
       WHERE tenant_id = $1
         AND key IN (
           'synthesis_max_cluster_size',
           'synthesis_recency_decay_hours',
           'synthesis_require_entity_overlap',
           'synthesis_use_topic_tag_hints',
           'synthesis_semantic_threshold'
         )
    `).all(tenantId);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (byKey.synthesis_max_cluster_size != null) {
      const n = parseInt(byKey.synthesis_max_cluster_size, 10);
      if (Number.isFinite(n) && n >= 2 && n <= 30) opts.maxClusterSize = n;
    }
    if (byKey.synthesis_recency_decay_hours != null) {
      const n = parseInt(byKey.synthesis_recency_decay_hours, 10);
      if (Number.isFinite(n) && n >= 6 && n <= 720) opts.recencyDecayHours = n;
    }
    if (byKey.synthesis_require_entity_overlap != null) {
      opts.requireEntityOverlap = String(byKey.synthesis_require_entity_overlap).toLowerCase() !== 'false';
    }
    if (byKey.synthesis_use_topic_tag_hints != null) {
      opts.useTopicTagHints = String(byKey.synthesis_use_topic_tag_hints).toLowerCase() !== 'false';
    }
    if (byKey.synthesis_semantic_threshold != null) {
      const n = parseFloat(byKey.synthesis_semantic_threshold);
      if (Number.isFinite(n) && n >= 0.5 && n <= 0.95) opts.threshold = n;
    }
  } catch { /* settings missing — use defaults */ }
  return opts;
}

/**
 * Detect whether a cluster continues an ongoing story this writer already
 * owns. Returns thread context when:
 *   1. The cluster has a dominant topic_tag (from N1 pre-grouping or
 *      majority of source articles), AND
 *   2. The writer has at least one published original/deep-dive in the
 *      last 14 days sharing that topic_tag.
 *
 * Returns:
 *   { topicTag, parentArticle, priorArticles[] }   — when thread detected
 *   null                                            — otherwise
 *
 * The parent (most-recent prior in the thread) drives the follow-up prompt's
 * "DO NOT repeat this" gate; the full priorArticles list is injected into
 * the system prompt so the writer sees the entire thread arc, not just the
 * last beat.
 */
/**
 * Pure helper — pick the dominant topic_tag for a cluster.
 *
 *   1. Honour `cluster._topicTag` when set by clusterArticlesSemantic's
 *      pre-grouping (highest-confidence signal).
 *   2. Fall back to the modal topic_tag across source articles, but only
 *      when it appears on >= half the cluster. Single-source outliers do
 *      NOT promote — otherwise one mistagged article could yank the whole
 *      cluster into someone else's thread.
 *
 * Returns the tag string or null.
 */
function pickClusterTopicTag(cluster) {
  if (!cluster) return null;
  if (cluster._topicTag) return cluster._topicTag;
  const articles = cluster.articles || [];
  if (!articles.length) return null;
  const counts = new Map();
  for (const a of articles) {
    const t = (a.topic_tag || '').trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (!counts.size) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [tag, count] = sorted[0];
  if (count < Math.ceil(articles.length / 2)) return null;
  return tag;
}

async function detectThreadContext(cluster, writer, tenantId) {
  if (!writer || !writer.id || !tenantId) return null;
  const tag = pickClusterTopicTag(cluster);
  if (!tag) return null;

  const priors = await db.prepare(`
    SELECT id, slug, title, summary, full_content, published_at
    FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
      AND topic_tag = $3
      AND published_at > NOW() - INTERVAL '14 days'
    ORDER BY published_at DESC
    LIMIT 5
  `).all(writer.id, tenantId, tag).catch(() => []);

  if (!priors.length) return null;
  return { topicTag: tag, parentArticle: priors[0], priorArticles: priors };
}

/**
 * Call Gemini to synthesize a cluster of articles into an original analytical piece.
 * Inserts the result into the articles table.  Returns the inserted row or null.
 */
async function synthesizeCluster(cluster, writer, tenantId, opts = {}) {
  // opts.pitchType — when known (from a pitch or cluster), passed to
  // buildWriterPrompt so voice_samples can be injected as few-shot.
  const pitchType = opts.pitchType || null;
  try {
    require('./presence').setPresence(writer.id, tenantId, 'drafting').catch(() => {});
    // Fetch writer's recent published articles for continuity
    const recentArticles = await db.prepare(`
      SELECT id, title, slug, summary FROM articles
      WHERE writer_id = $1 AND tenant_id = $2
        AND content_type IN ('original', 'deep-dive')
        AND is_published = 1
      ORDER BY published_at DESC LIMIT 5
    `).all(writer.id, tenantId);

    // Fetch relevant editorial memories for this topic
    const { getRelevantMemories } = require('./writer-memory');
    const memories = await getRelevantMemories(writer.id, tenantId, cluster.topic);

    // Newsroom coordination: check what other writers recently covered in this category
    let newsroomContext = '';
    try {
      const category = cluster.articles[0]?.category;
      if (category) {
        const recentByOthers = await db.prepare(`
          SELECT a.title, w.name AS writer_name FROM articles a
          JOIN writers w ON w.id = a.writer_id
          WHERE a.tenant_id = $1 AND a.writer_id != $2
            AND a.content_type IN ('original', 'deep-dive') AND a.is_published = 1
            AND a.category = $3 AND a.published_at > NOW() - INTERVAL '48 hours'
          ORDER BY a.published_at DESC LIMIT 3
        `).all(tenantId, writer.id, category);

        if (recentByOthers.length) {
          newsroomContext = '\n\nRecent coverage by your colleagues in this area (avoid duplicating, find a fresh angle):\n'
            + recentByOthers.map(a => `- ${a.writer_name}: "${a.title}"`).join('\n');

          // Record coordination message
          const { recordNewsroomMessage } = require('./messaging');
          recordNewsroomMessage(tenantId, writer.id, null, 'coordination',
            `Checking colleagues' recent coverage in ${category} before writing about ${cluster.topic}. Found ${recentByOthers.length} recent piece(s).`,
            { topic: cluster.topic, relatedArticles: recentByOthers.map(a => a.title) }
          ).catch(() => {});
        }
      }
    } catch { /* non-critical */ }

    const systemPrompt = await buildWriterPrompt(writer, { recentArticles, memories, pitchType }) + newsroomContext;

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

    // Filter and cap sources: remove junk, keep top 10 by relevance
    const MAX_SYNTHESIS_SOURCES = 10;
    const topicWords = new Set((cluster.topic || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let filteredArticles = cluster.articles.filter(a => {
      const title = (a.title || '').toLowerCase();
      // Filter out promotional/ticket/discount sources
      if (/\bsave\s+(up\s+to\s+)?\$|discount|ticket|pass\b/i.test(title)) return false;
      if (/\bapplications?\s+open\b/i.test(title)) return false;
      return true;
    });

    // Score remaining by keyword overlap with topic, take top N
    if (filteredArticles.length > MAX_SYNTHESIS_SOURCES) {
      filteredArticles = filteredArticles.map(a => {
        const words = (a.title || '').toLowerCase().split(/\s+/);
        const overlap = words.filter(w => topicWords.has(w)).length;
        return { ...a, _relevance: overlap };
      }).sort((a, b) => b._relevance - a._relevance).slice(0, MAX_SYNTHESIS_SOURCES);
    }

    if (filteredArticles.length < 3) {
      // Not enough substantive sources after filtering — use original (unfiltered) top 10
      filteredArticles = cluster.articles.slice(0, MAX_SYNTHESIS_SOURCES);
    }

    console.log(`[synthesis] Sources: ${cluster.articles.length} total → ${filteredArticles.length} after filtering (topic: "${cluster.topic}")`);

    const sourceSummaries = filteredArticles.map((a, i) => {
      const detail = a.enriched_summary
        ? sanitizeForPrompt(a.enriched_summary, 800)
        : sanitizeForPrompt(a.summary, 300);
      return `${i + 1}. "${sanitizeForPrompt(a.title, 200)}" (${sanitizeForPrompt(a.source, 50) || 'Unknown'}):\n${detail}`;
    }).join('\n\n');

    const { loadPrompt } = require('./prompt-loader');

    const { getStructuralBrief } = require('./article-type-templates');
    let articleSubtype = cluster.article_subtype || null;
    const structuralBrief = articleSubtype ? `\n${getStructuralBrief(articleSubtype)}\n` : '';

    // Follow-up path: triggered either explicitly (cluster.article_subtype
    // === 'followup' with a parent_article_id) OR via auto-detection (the
    // writer already covered this topic_tag in the last 14 days).
    let synthMessages, synthMeta;
    let parentArticleId = cluster.parent_article_id || null;
    let detectedThread = null;
    let isFollowup = cluster.article_subtype === 'followup' && cluster.parent_article_id;

    if (!isFollowup && opts.allowAutoFollowup !== false) {
      // Auto-detect: if a writer already has a piece on this topic_tag, this
      // becomes a follow-up rather than a redundant restatement. Skip when
      // the caller pinned a non-followup pitch type that explicitly wants
      // the original prompt (e.g. roundup, deep_dive, explainer).
      const skipPitchTypes = new Set(['roundup', 'deep_dive', 'explainer', 'analysis']);
      if (!skipPitchTypes.has(pitchType)) {
        detectedThread = await detectThreadContext(cluster, writer, tenantId);
        if (detectedThread) {
          isFollowup = true;
          parentArticleId = detectedThread.parentArticle.id;
          articleSubtype = articleSubtype || 'followup';
          console.log(`[synthesis] auto-followup: writer ${writer.id} continuing thread "${detectedThread.topicTag}" (${detectedThread.priorArticles.length} prior pieces, parent=${parentArticleId})`);
        }
      }
    }

    if (isFollowup) {
      let parentArticle;
      let allPriors = [];

      if (detectedThread) {
        parentArticle = detectedThread.parentArticle;
        allPriors = detectedThread.priorArticles;
      } else {
        parentArticle = await db.prepare(
          'SELECT id, title, full_content, summary FROM articles WHERE id = $1 AND tenant_id = $2'
        ).get(parentArticleId, tenantId);
        if (parentArticle) allPriors = [parentArticle];
      }

      const priorTitle = parentArticle?.title || 'prior coverage';
      const priorContent = sanitizeForPrompt(
        parentArticle?.full_content || parentArticle?.summary || '', 1200
      );

      // When a writer has a multi-piece arc on this thread, pass the full
      // chain (titles + short excerpts) so the new piece extends the arc
      // instead of repeating beats from earlier pieces.
      let priorThreadArc = '';
      if (allPriors.length > 1) {
        priorThreadArc = '\n\nYour prior pieces in this story arc (chronological — most recent last):\n'
          + allPriors.slice().reverse().map((p, i) => {
              const excerpt = sanitizeForPrompt((p.summary || '').replace(/<[^>]+>/g, ''), 200);
              return `${i + 1}. "${p.title}" — ${excerpt}`;
            }).join('\n');
      }

      const followupPrompt = loadPrompt('synthesis-followup');
      ({ messages: synthMessages, ...synthMeta } = followupPrompt.render({
        systemPrompt: systemPrompt + priorThreadArc,
        topic: cluster.topic,
        priorTitle,
        priorContent,
        sourceSummaries,
      }));
    } else {
      const synthPrompt = loadPrompt('synthesis');
      ({ messages: synthMessages, ...synthMeta } = synthPrompt.render({
        systemPrompt,
        articleCount: String(filteredArticles.length),
        timespan,
        topic: cluster.topic,
        sourceSummaries,
        paragraphCount: String(paragraphCount),
        structuralBrief,
      }));
    }

    const result = await aiComplete({
      ...synthMeta, messages: synthMessages, tenantId,
      trigger: 'manual',
      writerId: writer.id,
    });
    if (!result) throw new Error('Budget exceeded or AI unavailable');
    const content = result.text;
    if (!content) throw new Error('AI returned no content');

    // Parse TITLE:, EXCERPT:, PULL_QUOTE:, TOPIC_TAG:, body, and FOLLOWUPS: sections
    const titleMatch = content.match(/^TITLE:\s*(.+)/m);
    const title = titleMatch
      ? titleMatch[1].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes if any
      : `Analysis: ${cluster.topic}`;
    const excerptMatch  = content.match(/^EXCERPT:\s*(.+)/m);
    const pullQuoteMatch = content.match(/^PULL_QUOTE:\s*(.+)/m);
    const pullQuote      = pullQuoteMatch ? pullQuoteMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    const topicTagMatch = content.match(/^TOPIC_TAG:\s*(.+)/m);
    const topicTag      = topicTagMatch
      ? topicTagMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
      : null;

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

    let body = content
      .replace(/^TITLE:.*\n?/m, '')
      .replace(/^EXCERPT:.*\n?/m, '')
      .replace(/^PULL_QUOTE:.*\n?/m, '')
      .replace(/^TOPIC_TAG:.*\n?/m, '')
      .replace(/FOLLOWUPS:[\s\S]*$/, '')
      .replace(/^---+\s*\n/gm, '')
      .trim();

    // Guard: reject truncated or empty generations
    const bodyWordCount = body.split(/\s+/).filter(Boolean).length;
    if (bodyWordCount < 200) {
      console.error(`[synthesis] Rejected truncated output for "${title}" — only ${bodyWordCount} words (need 200+)`);
      throw new Error(`Generated content too short (${bodyWordCount} words). Possible token limit or context overflow.`);
    }

    // Normalise citations: [1, 2, 3] → [1][2][3] (so every citation renders
    // as a link on the reader client) and [@ID] → markdown link (so writer
    // self-references become real hyperlinks instead of unclickable text).
    try {
      const { normaliseCitations } = require('./citation-normalise');
      const { getAppConfig } = require('./app-config');
      const cfg = await getAppConfig(tenantId).catch(() => ({}));
      const siteUrl = (cfg.main_site_url || '').replace(/\/$/, '');
      body = normaliseCitations(body, { priorArticles: recentArticles, siteUrl });
      // Also normalise the follow-up answers in place — they carry the
      // same citation patterns and need the same links.
      followups.forEach(f => {
        if (f.answer) f.answer = normaliseCitations(f.answer, { priorArticles: recentArticles, siteUrl });
      });
    } catch (err) {
      console.error('[synthesis] citation normalise failed (non-fatal):', err.message);
    }

    const slug = toSlug(title) || 'synthesis-' + Date.now();
    const summary = excerptMatch
      ? excerptMatch[1].trim().slice(0, 500)
      : body.slice(0, 280).replace(/\s+\S*$/, '') + '…';

    // Store rich source objects so the frontend can render citations without extra API calls
    const sourceRefs = filteredArticles.map(a => ({
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
    if (detectedThread) {
      synthesisMeta.thread = {
        topic_tag: detectedThread.topicTag,
        prior_count: detectedThread.priorArticles.length,
        parent_id: detectedThread.parentArticle.id,
        auto: true,
      };
    }

    // Insert as draft (is_published = 0); quality gate decides whether to publish
    const row = await db.prepare(`
      INSERT INTO articles (tenant_id, title, slug, summary, full_content, pull_quote, source, category, content_type,
        writer_id, source_article_ids, synthesis_meta, followups, article_subtype, parent_article_id, topic_tag, is_published, status, published_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'original', $9, $10, $11, $12, $13, $14, $15, 0, 'draft', NOW(), NOW(), NOW())
      RETURNING *
    `).get(
      tenantId,
      title,
      slug,
      summary,
      body,
      pullQuote,
      writer.name,
      cluster.articles[0]?.category || 'General',
      writer.id,
      JSON.stringify(sourceRefs),
      JSON.stringify(synthesisMeta),
      followups.length ? JSON.stringify(followups) : null,
      articleSubtype,
      parentArticleId,
      // Inherit detected thread tag if the model didn't propose its own —
      // this keeps the chain queryable even when the prompt drifts.
      topicTag || (detectedThread ? detectedThread.topicTag : null),
    );

    if (!row) throw new Error('DB INSERT returned no row — check articles table schema');

    // Generate headline variants asynchronously — non-blocking
    const { generateAndStoreHeadlines } = require('./headline');
    generateAndStoreHeadlines(row, writer, tenantId).catch(err =>
      console.warn('[synthesis] Headline generation failed (non-critical):', err.message)
    );

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
          // Heuristic gate passed — now run AI editorial review
          let editorApproved = true;
          try {
            const { editorialReview } = require('./editorial');
            const verdict = await editorialReview(row, tenantId);
            // Score >= 7 auto-publishes regardless of publish flag (issues are logged, not blocking)
            const scoreOverride = verdict && verdict.score >= 7;
            if (verdict && !verdict.publish && !scoreOverride) {
              editorApproved = false;
              console.log(`[synthesis] Editor rejected article ${row.id} (score ${verdict.score}): ${(verdict.issues || []).join('; ')}`);
            } else if (verdict && !verdict.publish && scoreOverride) {
              console.log(`[synthesis] Editor flagged article ${row.id} (score ${verdict.score}) but publishing — score override`);
            }
          } catch (edErr) {
            console.error('[synthesis] Editorial review error (proceeding with publish):', edErr.message);
            // If editorial review fails, fall through to publish (don't block on review errors)
          }

          if (editorApproved) {
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
            // Editor rejected — send to review queue
            await db.prepare(
              "UPDATE articles SET status = 'review', submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
            ).run(row.id, tenantId);
            row.status = 'review';
          }
        } else {
          // Heuristic quality gate failed — send to review queue
          await db.prepare(
            "UPDATE articles SET status = 'review', submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
          ).run(row.id, tenantId);
          row.status = 'review';
          // Run AI editorial review fire-and-forget so the queue shows a real score + notes
          const { editorialReview } = require('./editorial');
          editorialReview(row, tenantId).catch(err =>
            console.warn('[synthesis] Editorial review (review-queue) failed:', err.message)
          );
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
      // Fallback: send to review instead of auto-publishing
      await db.prepare(
        "UPDATE articles SET status = 'review', submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
      ).run(row.id, tenantId);
      row.status = 'review';
      console.log(`[synthesis] Article ${row.id} "${title}" sent to review (quality gate error)`);
      const { editorialReview } = require('./editorial');
      editorialReview(row, tenantId).catch(err =>
        console.warn('[synthesis] Editorial review (gate-error fallback) failed:', err.message)
      );
    }

    // Fire-and-forget: extract editorial memories from this article
    const { extractAndStoreMemories } = require('./writer-memory');
    extractAndStoreMemories(row.id, writer.id, tenantId).catch(err => {
      console.error('[synthesis] memory extraction error:', err.message);
    });

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
  const minSize = writer.min_cluster_size || 2;

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

  const clusters = await clusterArticlesForWriter(pool.articles, minSize, tenantId);

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
  const ddRecentArticles = await db.prepare(`
    SELECT id, title, slug, summary FROM articles
    WHERE writer_id = $1 AND tenant_id = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
    ORDER BY published_at DESC LIMIT 5
  `).all(writer.id, tenantId);
  const { getRelevantMemories } = require('./writer-memory');
  const ddMemories = await getRelevantMemories(writer.id, tenantId, category);
  const systemPrompt = await buildWriterPrompt(writer, { recentArticles: ddRecentArticles, memories: ddMemories });

  // 8. Deep-dive prompt (loaded from file)
  const { loadPrompt } = require('./prompt-loader');
  const ddPrompt = loadPrompt('deep-dive');
  const { messages: ddMessages, ...ddMeta } = ddPrompt.render({
    systemPrompt,
    category,
    clusterCount: String(clusters.length),
    sourceCount: String(allSources.length),
    clusterSummaries,
    numberedSourceList,
  });

  const ddResult = await aiComplete({
    ...ddMeta, messages: ddMessages, tenantId,
    trigger: 'manual',
    writerId: writer.id,
  });
  if (!ddResult) throw new Error('Budget exceeded or AI unavailable');
  const content = ddResult.text;
  if (!content) throw new Error('AI returned no content');

  // 9. Parse TITLE, EXCERPT, PULL_QUOTE, TOPIC_TAG, FOLLOWUPS, + body
  const titleMatch = content.match(/^TITLE:\s*(.+)/m);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : `Weekly Deep Dive: ${category}`;
  const excerptMatch  = content.match(/^EXCERPT:\s*(.+)/m);
  const pullQuoteMatch = content.match(/^PULL_QUOTE:\s*(.+)/m);
  const pullQuote      = pullQuoteMatch ? pullQuoteMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  const topicTagMatch = content.match(/^TOPIC_TAG:\s*(.+)/m);
  const topicTag      = topicTagMatch
    ? topicTagMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    : null;

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

  let body = content
    .replace(/^TITLE:.*\n?/m, '')
    .replace(/^EXCERPT:.*\n?/m, '')
    .replace(/^PULL_QUOTE:.*\n?/m, '')
    .replace(/^TOPIC_TAG:.*\n?/m, '')
    .replace(/FOLLOWUPS:[\s\S]*$/, '')
    .replace(/^---+\s*\n/gm, '')
    .trim();

  // Normalise citations — same pass as synthesizeCluster. Deep dives
  // tend to span 5+ sources and are the worst offenders for multi-source
  // bracket lists like "[1, 2, 3, 5, 7]".
  try {
    const { normaliseCitations } = require('./citation-normalise');
    const { getAppConfig } = require('./app-config');
    const cfg = await getAppConfig(tenantId).catch(() => ({}));
    const siteUrl = (cfg.main_site_url || '').replace(/\/$/, '');
    body = normaliseCitations(body, { priorArticles: ddRecentArticles, siteUrl });
    ddFollowups.forEach(f => {
      if (f.answer) f.answer = normaliseCitations(f.answer, { priorArticles: ddRecentArticles, siteUrl });
    });
  } catch (err) {
    console.error('[deep-dive] citation normalise failed (non-fatal):', err.message);
  }

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
    INSERT INTO articles (tenant_id, title, slug, summary, full_content, pull_quote, source, category, content_type,
      writer_id, source_article_ids, synthesis_meta, followups, topic_tag, is_published, published_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deep-dive', $9, $10, $11, $12, $13, 0, NOW(), NOW(), NOW())
    RETURNING *
  `).get(
    tenantId,
    title,
    slug,
    summary,
    body,
    pullQuote,
    writer.name,
    category,
    writer.id,
    JSON.stringify(sourceRefs),
    JSON.stringify(synthesisMeta),
    ddFollowups.length ? JSON.stringify(ddFollowups) : null,
    topicTag,
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
    // Fallback: send to review instead of auto-publishing
    await db.prepare(
      "UPDATE articles SET status = 'review', submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
    ).run(row.id, tenantId);
    row.status = 'review';
    console.log(`[synthesis] Deep-dive ${row.id} sent to review (quality gate error)`);
  }

  // 14. Fire-and-forget: extract editorial memories from deep-dive
  const { extractAndStoreMemories } = require('./writer-memory');
  extractAndStoreMemories(row.id, writer.id, tenantId).catch(err => {
    console.error('[synthesis] deep-dive memory extraction error:', err.message);
  });

  // 15. Return inserted row
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
  const minSize = writer.min_cluster_size || 2;

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

/**
 * Per-category breakdown of curated articles in the lookback window.
 * Returns categories with article counts + distinct source counts.
 * Used for synthesis diagnostics.
 */
async function getCategoryBreakdown(tenantId, lookbackHours) {
  const rows = await db.prepare(`
    SELECT COALESCE(category, '(Uncategorized)') AS category,
           COUNT(*)::int AS count,
           COUNT(DISTINCT source)::int AS distinct_sources
    FROM articles
    WHERE tenant_id = $2
      AND (content_type IS NULL OR content_type NOT IN ('original', 'deep-dive'))
      AND is_archived = 0
      AND created_at > NOW() - make_interval(hours => $1)
    GROUP BY category
    ORDER BY count DESC
  `).all(lookbackHours, tenantId);
  return rows.map(r => ({ category: r.category, count: r.count, distinctSources: r.distinct_sources }));
}

/**
 * Phase B — synthesize an original from an approved counter-angle pitch.
 * Anchors a cluster on the pitch's source article, expands by embedding similarity
 * to nearby curated items in the pitching writer's beats (capped at 5), runs the
 * existing synthesizeCluster path with the writer's ownership and the pitch's
 * angle as the topic so the prompt is steered by the angle.
 *
 * Updates article_pitches.spawned_article_id + status='published' on success.
 *
 * @param {number} pitchId
 * @param {number} tenantId
 * @returns {Promise<{ ok: boolean, article?: object, reason?: string }>}
 */
async function synthesizeFromPitch(pitchId, tenantId) {
  const pitch = await db.prepare(
    'SELECT * FROM article_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(pitchId, tenantId);
  if (!pitch) return { ok: false, reason: 'pitch not found' };
  if (pitch.status !== 'approved') return { ok: false, reason: `pitch is ${pitch.status}, not approved` };
  if (pitch.spawned_article_id) return { ok: false, reason: 'pitch already spawned an article' };
  if (!pitch.pitched_by_writer_id) return { ok: false, reason: 'pitch has no writer (editor-tip pitches need a writer assigned before synthesis)' };

  const writer = await db.prepare(
    'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(pitch.pitched_by_writer_id, tenantId);
  if (!writer) return { ok: false, reason: 'pitching writer not found' };

  const source = await db.prepare(
    'SELECT * FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(pitch.source_article_id, tenantId);
  if (!source) return { ok: false, reason: 'source article not found' };

  // Expand cluster via embedding similarity, scoped to this writer's beats.
  // Falls back to source-only if embeddings unavailable.
  let nearby = [];
  if (source.embedding) {
    try {
      nearby = await db.prepare(`
        SELECT a.*, 1 - (a.embedding <=> $1::vector) AS similarity
        FROM articles a
        WHERE a.tenant_id = $2
          AND a.id != $3
          AND (a.content_type IS NULL OR a.content_type = 'curated')
          AND a.embedding IS NOT NULL
          AND a.category IN (
            SELECT c.name FROM writer_beats wb
            JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
            WHERE wb.writer_id = $4 AND wb.tenant_id = $2
          )
          AND (1 - (a.embedding <=> $1::vector)) >= 0.72
        ORDER BY a.embedding <=> $1::vector
        LIMIT 5
      `).all(source.embedding, tenantId, source.id, writer.id);
    } catch (err) {
      console.warn('[synthesis] pitch cluster expansion failed, using source-only:', err.message);
    }
  }

  // Explicitly attached articles (via /api/research/ingest with pitch_id) — always
  // included regardless of embedding/beat/similarity. Dedupe against source + nearby.
  let attached = [];
  const attachedIds = Array.isArray(pitch.attached_article_ids) ? pitch.attached_article_ids : [];
  if (attachedIds.length) {
    try {
      const existingIds = new Set([source.id, ...nearby.map(n => n.id)]);
      const toFetch = attachedIds.filter(id => !existingIds.has(id));
      if (toFetch.length) {
        attached = await db.prepare(
          'SELECT * FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2'
        ).all(toFetch, tenantId);
      }
    } catch (err) {
      console.warn('[synthesis] pitch attached_article_ids fetch failed:', err.message);
    }
  }

  const cluster = {
    topic: pitch.angle_summary,
    articles: [source, ...attached, ...nearby],
  };

  // thread_update pitch (N3): if the source already carries a topic_tag,
  // pin it as the cluster's topicTag so the auto-followup detector in
  // synthesizeCluster picks up the thread without ambiguity. This makes
  // thread_update behave like an editor-commissioned follow-up rather
  // than a fresh original.
  const pitchType = pitch.pitch_type || 'original';
  if (pitchType === 'thread_update' && source.topic_tag) {
    cluster._topicTag = source.topic_tag;
  }

  console.log(`[synthesis] pitch #${pitchId} — synthesizing for ${writer.name} on "${source.title}" with ${cluster.articles.length} source(s)`);

  // Pass the pitch's type through so voice_samples (when the flag is on)
  // can pick a matching exemplar — a roundup pitch gets a roundup sample,
  // a deep_dive pitch gets a deep_dive sample, etc.
  const article = await synthesizeCluster(cluster, writer, tenantId, {
    pitchType,
  });
  if (!article) return { ok: false, reason: 'synthesizeCluster returned null' };

  // Stamp pitch link in synthesis_meta so the article's provenance is queryable
  let meta = {};
  try { meta = typeof article.synthesis_meta === 'string' ? JSON.parse(article.synthesis_meta) : (article.synthesis_meta || {}); } catch {}
  meta.from_pitch = pitchId;
  meta.pitch_angle = pitch.angle_summary;
  await db.prepare(
    'UPDATE articles SET synthesis_meta = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(JSON.stringify(meta), article.id, tenantId);

  await db.prepare(
    "UPDATE article_pitches SET spawned_article_id = $1, status = 'published' WHERE id = $2 AND tenant_id = $3"
  ).run(article.id, pitchId, tenantId);

  return { ok: true, article };
}

/**
 * Rewrite an existing original article using editorial feedback.
 * The writer's persona steers the rewrite; the feedback is injected as an
 * explicit revision brief so the AI addresses every issue raised.
 * On success, overwrites full_content in place and resubmits for review.
 */
async function rewriteArticleWithFeedback(article, writer, feedback, tenantId) {
  try {
    if (!article.full_content) {
      console.warn(`[synthesis] rewrite skipped — article ${article.id} has no full_content`);
      return null;
    }

    const { complete: aiComplete } = require('./ai-router');
    const { buildWriterPrompt } = require('./writer-assign');

    const writerPrompt = await buildWriterPrompt(writer, {});

    const userContent = [
      writerPrompt,
      '\n\n---\n\n',
      'You previously submitted the following article, which has been returned for revision:\n\n',
      `Title: ${article.title}\n\n`,
      article.full_content,
      '\n\n---\n\n',
      'Editorial feedback:\n\n',
      feedback,
      '\n\n---\n\n',
      'Rewrite the article in full, addressing every point in the feedback. ',
      'Keep your voice and perspective. Return only the revised article body in markdown — ',
      'no title, no preamble, no "Here is the revised article" header.',
    ].join('');

    const result = await aiComplete({
      operation:   'synthesis',
      tenantId,
      messages:    [{ role: 'user', content: userContent }],
      temperature: 0.7,
      maxTokens:   4000,
      trigger:     'rewrite',
    });

    if (!result?.text?.trim()) {
      console.warn(`[synthesis] rewrite returned empty result for article ${article.id}`);
      return null;
    }

    const newContent = result.text.trim();

    // Overwrite in place and resubmit for review; clear stale verdict so the
    // queue shows a pending state while the new review runs.
    await db.prepare(`
      UPDATE articles SET
        full_content = $1,
        status = 'review',
        submitted_for_review_at = NOW(),
        review_notes = NULL,
        editor_verdict = NULL,
        last_reviewed_at = NULL,
        updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `).run(newContent, article.id, tenantId);

    // Audit log — no req object here so insert directly as system action
    db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, user_email, action, resource, resource_id, details, created_at)
      VALUES ($1, NULL, 'system', 'article.rewritten', 'article', $2, $3, NOW())
    `).run(tenantId, article.id, JSON.stringify({ title: article.title, writer: writer.name, trigger: 'editor_revision' })).catch(() => {});

    // Newsroom activity feed — visible in the Newsroom tab
    const { recordNewsroomMessage } = require('./messaging');
    recordNewsroomMessage(
      tenantId,
      writer.id,
      null,
      'rewrite-submitted',
      `Rewrote "${article.title}" addressing editorial feedback and resubmitted for review.`,
      { articleId: article.id, trigger: 'editor_revision' },
    ).catch(() => {});

    // Newsroom events table (activity feed cards in pitches/newsroom)
    const { recordEvent } = require('./newsroom-events');
    recordEvent({
      tenantId,
      type:           'article_rewritten',
      actorWriterId:  writer.id,
      targetArticleId: article.id,
      payload:        { title: article.title, trigger: 'editor_revision' },
    }).catch(() => {});

    // Re-run editorial review on the revised content.
    // Pass force=true to bypass the cooldown — the editor explicitly requested this rewrite.
    let reviewResult = null;
    try {
      const { editorialReview } = require('./editorial');
      const fresh = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(article.id, tenantId);
      if (fresh) reviewResult = await editorialReview(fresh, tenantId, { force: true });
    } catch (err) {
      console.warn('[synthesis] post-rewrite editorial review failed (non-fatal):', err.message);
    }

    // If the revision scored well (publish=true), editorial review won't fire review_needed
    // because it only notifies when publish=false. But the article still sits in the review
    // queue (we never auto-publish rewrites). Notify editors so they know to come approve it.
    if (reviewResult?.publish === true) {
      try {
        const { notify } = require('./notifications');
        const editors = await db.prepare(
          "SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner', 'admin', 'editor', 'superadmin')"
        ).all(tenantId);
        for (const ed of editors) {
          notify({
            tenantId,
            userId:   ed.id,
            kind:     'article_revision_ready',
            title:    'Revision ready to approve',
            body:     `"${article.title}" was rewritten and passed review (score: ${reviewResult.score}/10) — ready for your approval.`,
            payload:  { article_id: article.id, title: article.title, score: reviewResult.score },
            actionable: [
              { label: 'Open article', actionKind: 'article.open', targetId: article.id, targetType: 'article' },
            ],
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[synthesis] revision-ready notification failed (non-fatal):', err.message);
      }
    }

    console.log(`[synthesis] Rewrote article ${article.id} "${article.title}" and resubmitted for review`);
    return { id: article.id };
  } catch (err) {
    console.error(`[synthesis] rewriteArticleWithFeedback failed for article ${article.id}:`, err.message);
    return null;
  }
}

module.exports = {
  enrichArticle, overlapScore, clusterArticles, clusterArticlesSemantic, clusterArticlesForWriter,
  synthesizeCluster, synthesizeFromPitch, runSynthesisForWriter, generateDeepDive, runWeeklyDeepDives,
  getCooldownStatus, getArticlePool, evaluateClusters, computeClusterStrength, generateProposedHeadline,
  generateForecast, getLatestForecast, checkWatchlist, loadWatchlist, getCategoryBreakdown,
  rewriteArticleWithFeedback,
  // N1 narrowing helpers (exported for tests)
  extractEntities, recencyWeight, groupByTopicTag,
  // N2 thread detection (exported for tests)
  detectThreadContext, pickClusterTopicTag,
};
