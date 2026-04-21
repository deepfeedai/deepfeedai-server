/**
 * Deep Feed AI — Writer auto-assignment helpers
 */
const db = require('../db');

const { complete: aiComplete } = require('./ai-router');

// Common abbreviation map for normalized matching
const ABBREVIATIONS = {
  'ai':   ['artificial intelligence'],
  'ml':   ['machine learning'],
  'llm':  ['large language model', 'large language models'],
  'nlp':  ['natural language processing'],
  'cv':   ['computer vision'],
  'rl':   ['reinforcement learning'],
  'gpu':  ['graphics processing unit'],
  'api':  ['application programming interface'],
  'saas': ['software as a service'],
  'iot':  ['internet of things'],
  'ar':   ['augmented reality'],
  'vr':   ['virtual reality'],
  'xr':   ['extended reality'],
};

// Build reverse map: full phrase → abbreviation
const REVERSE_ABBREV = {};
for (const [abbr, expansions] of Object.entries(ABBREVIATIONS)) {
  for (const exp of expansions) {
    REVERSE_ABBREV[exp] = abbr;
  }
}

/**
 * Build a system prompt for a writer, incorporating beats, tone, expertise, style guide,
 * and few-shot examples. Used by both TLDR generation and synthesis.
 */
async function buildWriterPrompt(writer, { recentArticles, memories } = {}) {
  // Fetch beats from junction table
  let beatList = 'technology';
  try {
    const beats = await db.prepare(`
      SELECT c.name FROM writer_beats wb JOIN categories c ON c.id = wb.category_id WHERE wb.writer_id = $1 AND wb.tenant_id = $2
    `).all(writer.id, writer.tenant_id);
    if (beats.length) beatList = beats.map(b => b.name).join(', ');
  } catch { /* fallback to legacy beat */ if (writer.beat) beatList = writer.beat; }

  let prompt = writer.system_prompt || `You are ${writer.name}, a tech journalist covering ${beatList}.`;
  if (writer.tone) prompt += `\nTone: ${writer.tone}.`;
  if (writer.expertise_level) prompt += `\nExpertise level: ${writer.expertise_level}.`;
  if (writer.style_guide) prompt += `\nStyle guide: ${writer.style_guide}`;

  // Personality enhancements
  if (writer.beat_angle) {
    prompt += `\nYour angle: You cover ${beatList} through the lens of ${writer.beat_angle}.`;
  }
  if (writer.signature_phrases?.length) {
    prompt += `\nSignature phrases you sometimes use: ${writer.signature_phrases.join('; ')}`;
  }
  if (writer.contrarian_level != null && writer.contrarian_level > 0.6) {
    prompt += `\nYou tend to push back against consensus. Question popular narratives and highlight what others are missing.`;
  } else if (writer.contrarian_level != null && writer.contrarian_level < 0.3) {
    prompt += `\nYou report the facts straight. Balanced, authoritative, no hot takes.`;
  }

  const fse = typeof writer.few_shot_examples === 'string'
    ? JSON.parse(writer.few_shot_examples || '[]') : (writer.few_shot_examples || []);
  if (fse.length) {
    prompt += `\n\nExamples of your writing style:`;
    for (const ex of fse) prompt += `\n- "${ex.title}": ${ex.excerpt}`;
  }

  // Layer 1: Recent article context — helps writer reference prior coverage
  if (recentArticles?.length) {
    prompt += `\n\nYour recent coverage (reference prior pieces where relevant):`;
    for (const a of recentArticles) {
      const excerpt = (a.summary || '').replace(/<[^>]+>/g, '').slice(0, 150);
      prompt += `\n- "${a.title}": ${excerpt}`;
    }
  }

  // Layer 2: Writer memory — editorial positions, running threads, predictions
  if (memories?.length) {
    prompt += `\n\nYour editorial memory (positions and threads you're tracking):`;
    for (const m of memories) {
      prompt += `\n- [${m.memory_type}] ${m.subject}: ${m.content}`;
    }
  }

  return prompt;
}

/**
 * Find the best auto-assign writer for an article based on beat + keyword scoring.
 * Optional `prefetchedWriters` avoids re-querying the writers list (useful for bulk ops).
 * Returns the writer row or null.
 */
async function findBestWriter(article, tenantId, prefetchedWriters) {
  try {
    const writers = prefetchedWriters || await db.prepare(`
      SELECT w.*, array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) AS beat_names
      FROM writers w
      LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = $1
      LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
      WHERE w.is_auto = true AND w.tenant_id = $1
      GROUP BY w.id
    `).all(tenantId);
    if (!writers.length) return null;

    const titleLower   = (article.title || '').toLowerCase();
    const summaryLower = (article.summary || '').toLowerCase();
    const catLower     = (article.category || '').toLowerCase();
    const combined     = titleLower + ' ' + summaryLower;

    let best = null;
    let bestScore = 0;
    let bestCount = Infinity;

    for (const w of writers) {
      let score = 0;

      // +3 if any beat matches article category
      const beatNames = (w.beat_names || []).map(b => b.toLowerCase());
      if (beatNames.includes(catLower)) score += 3;

      // Keyword matching with abbreviation expansion
      const keywords = w.keywords ? (Array.isArray(w.keywords) ? w.keywords : JSON.parse(w.keywords)) : [];
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();

        // Title matches weighted +2 (more relevant than summary)
        if (titleLower.includes(kwLower)) { score += 2; continue; }
        if (summaryLower.includes(kwLower)) { score += 1; continue; }

        // Check abbreviation expansions
        const expansions = ABBREVIATIONS[kwLower];
        if (expansions) {
          if (expansions.some(exp => combined.includes(exp))) { score += 1; continue; }
        }
        // Check reverse: keyword is a full phrase, look for abbreviation in text
        const abbr = REVERSE_ABBREV[kwLower];
        if (abbr) {
          // Match abbreviation as whole word to avoid false positives
          const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
          if (abbrRegex.test(combined)) { score += 1; continue; }
        }
      }

      if (score <= 0) continue;

      // Tiebreak: fewer assigned articles wins
      if (score > bestScore) {
        const { count } = await db.prepare('SELECT COUNT(*) AS count FROM articles WHERE writer_id = $1 AND tenant_id = $2').get(w.id, tenantId);
        best = w; bestScore = score; bestCount = count;
      } else if (score === bestScore) {
        const { count } = await db.prepare('SELECT COUNT(*) AS count FROM articles WHERE writer_id = $1 AND tenant_id = $2').get(w.id, tenantId);
        if (count < bestCount) { best = w; bestCount = count; }
      }
    }

    return best;
  } catch (err) {
    console.error('[writer-assign] findBestWriter error:', err.message);
    return null;
  }
}

/**
 * Round-robin fallback writer picker. Used when findBestWriter returns null
 * (no category/keyword match, or no writers have is_auto=true). Returns the
 * non-system writer with the fewest currently-assigned articles so
 * assignment still lands somewhere reasonable.
 *
 * Returns null only when the tenant genuinely has zero eligible writers.
 */
async function findRoundRobinWriter(tenantId) {
  try {
    // Non-system, tenant-scoped. No is_auto filter — we've already tried
    // the scoring path; at this point we just need SOMEONE to pick up
    // the work.
    const writers = await db.prepare(`
      SELECT w.id, w.name,
             COALESCE((SELECT COUNT(*) FROM articles a
                       WHERE a.writer_id = w.id AND a.tenant_id = w.tenant_id), 0) AS assigned_count
      FROM writers w
      WHERE w.tenant_id = $1
        AND COALESCE(w.is_system, false) = false
      ORDER BY assigned_count ASC, w.id ASC
      LIMIT 1
    `).all(tenantId);
    return writers[0] || null;
  } catch (err) {
    console.error('[writer-assign] findRoundRobinWriter error:', err.message);
    return null;
  }
}

/**
 * findBestWriter + round-robin fallback. Use this from the auto-assign
 * entry points (per-pitch button, bulk orphan recovery, approve handler)
 * where returning "nobody" makes the feature look broken. Pure findBestWriter
 * is preserved for callers that genuinely want the null-on-no-match
 * semantic (RSS ingest).
 */
async function findWriterWithFallback(article, tenantId, prefetchedWriters) {
  const best = await findBestWriter(article, tenantId, prefetchedWriters);
  if (best && best.id) return best;
  return await findRoundRobinWriter(tenantId);
}

/**
 * Generate a writer-styled TLDR for an article using Gemini.
 * Returns the text string or null (never throws).
 */
async function generateWriterTldr(article, writer, tenantId) {
  try {
    const systemPrompt = await buildWriterPrompt(writer);

    const { loadPrompt } = require('./prompt-loader');
    const p = loadPrompt('writer-tldr');
    const { messages, ...meta } = p.render({
      systemPrompt,
      title: article.title,
      summary: (article.summary || '').replace(/<[^>]+>/g, '').slice(0, 800),
      source: article.source || 'Unknown',
      category: article.category || 'Technology',
    });

    const result = await aiComplete({
      ...meta, messages, tenantId,
      trigger: 'auto-assign',
      articleSlug: article.slug,
      writerId: writer.id,
    });

    return result?.text || null;
  } catch (err) {
    console.error('[writer-assign] generateWriterTldr error:', err.message);
    return null;
  }
}

module.exports = { findBestWriter, findWriterWithFallback, findRoundRobinWriter, generateWriterTldr, buildWriterPrompt };
