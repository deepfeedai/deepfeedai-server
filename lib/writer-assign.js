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
 * Build a system prompt for a writer, incorporating beats, tone, expertise,
 * style guide, few-shot examples, and — when the voice_samples feature flag
 * is on and a pitchType is supplied — up to 2 matching voice samples to
 * anchor the writer's distinctive style.
 *
 * Callers that know the target pitch type (synthesis, rewrite) pass
 * `pitchType`. Callers that don't (TLDR, standup) pass nothing and get
 * the legacy behaviour.
 */
async function buildWriterPrompt(writer, { recentArticles, memories, pitchType } = {}) {
  let prompt = writer.system_prompt?.trim();

  if (!prompt) {
    // Minimal fallback for writers with no prompt configured yet
    let beatList = writer.beat || 'general news';
    try {
      const beats = await db.prepare(
        'SELECT c.name FROM writer_beats wb JOIN categories c ON c.id = wb.category_id WHERE wb.writer_id = $1 AND wb.tenant_id = $2'
      ).all(writer.id, writer.tenant_id);
      if (beats.length) beatList = beats.map(b => b.name).join(', ');
    } catch {}
    prompt = `You are ${writer.name}, a journalist covering ${beatList}.`;
  }

  if (recentArticles?.length) {
    // Include article id so the writer can produce [@ID] tags that the
    // synthesis post-processor expands into real markdown links. Prior
    // to this, recent coverage was identifiable by title only and
    // back-references rendered as unlinked prose.
    prompt += `\n\nYour recent coverage (reference prior pieces using [@ID] or [@ID|label]):`;
    for (const a of recentArticles) {
      const excerpt = (a.summary || '').replace(/<[^>]+>/g, '').slice(0, 150);
      const idTag = a.id ? `[@${a.id}] ` : '';
      prompt += `\n- ${idTag}"${a.title}": ${excerpt}`;
    }
  }

  if (memories?.length) {
    prompt += `\n\nYour editorial memory (positions and threads you're tracking):`;
    for (const m of memories) {
      prompt += `\n- [${m.memory_type}] ${m.subject}: ${m.content}`;
    }
  }

  // Voice samples — only when caller supplies a pitch type AND the
  // voice_samples flag is on for this tenant. Pulls up to 2 non-negative
  // samples matching the type; prefers pinned, then quality_score, then
  // recency. Falls back to no samples silently on any failure.
  if (pitchType && writer.id && writer.tenant_id) {
    try {
      const { isFeatureEnabled } = require('./feature-registry');
      const on = await isFeatureEnabled(writer.tenant_id, 'voice_samples').catch(() => false);
      if (on) {
        const rows = await db.prepare(`
          SELECT title, body FROM writer_samples
           WHERE tenant_id = $1 AND writer_id = $2
             AND is_negative = false
             AND (pitch_type = $3 OR pitch_type = 'original')
           ORDER BY (pitch_type = $3) DESC,
                    is_pinned DESC,
                    quality_score DESC NULLS LAST,
                    updated_at DESC
           LIMIT 2
        `).all(writer.tenant_id, writer.id, pitchType);
        if (rows.length) {
          prompt += `\n\nExamples of your voice for this kind of piece (study the tone + structure; don't copy the subject matter):`;
          rows.forEach((s, i) => {
            prompt += `\n\n### Example ${i + 1}: "${s.title}"\n${s.body}`;
          });
        }

        // Anti-examples (negative samples) — explicitly warn the model off
        // patterns the editor flagged as wrong for this writer.
        const negRows = await db.prepare(`
          SELECT title, body FROM writer_samples
           WHERE tenant_id = $1 AND writer_id = $2
             AND is_negative = true
             AND (pitch_type = $3 OR pitch_type = 'original')
           ORDER BY is_pinned DESC, updated_at DESC
           LIMIT 1
        `).all(writer.tenant_id, writer.id, pitchType);
        if (negRows.length) {
          prompt += `\n\nAnti-example — DO NOT write like this:\n### "${negRows[0].title}"\n${negRows[0].body}`;
        }
      }
    } catch (err) {
      // Non-fatal: voice samples are an enhancement, never a dependency.
      console.error('[writer-assign] voice_samples load failed:', err.message);
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
