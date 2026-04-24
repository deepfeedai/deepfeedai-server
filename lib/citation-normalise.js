/**
 * Deep Feed AI — Citation normalisation
 *
 * Fixes two article-body bugs coming out of synthesis:
 *
 * 1. Multi-source bracketed citations like "[1, 2, 3, 5]" or "[1-3]" or
 *    "[1,2,5]" don't render as links on the reader site (the client-side
 *    citation parser expects ONE number per bracket). Normalise every
 *    multi-source expression to a run of single brackets: "[1][2][3][5]".
 *
 * 2. Writer self-references like "[Raj's prior coverage]" are unlinked
 *    because the writer had no ID to reference with. Introduce a
 *    structured prior-coverage tag "[@ARTICLE_ID]" that the writer
 *    emits when referencing their own earlier piece; normalise it into
 *    a markdown link "[<title>](<siteUrl>/article/<slug>)" pointing at
 *    the actual article.
 *
 * Pure, dependency-free — safe to unit-test.
 */
'use strict';

// Matches any bracketed run of digits + separators: [1, 2, 3], [1,2,3],
// [1 2 3], [1-3], [1–3 (en-dash)], mix of them. Excludes single bracket
// like [1] which is already normalised. Also excludes bracket content
// that starts with non-digit (e.g., [Raj's prior coverage]) — those are
// handled separately or left alone.
const MULTI_CITE_RE = /\[([0-9][0-9,\s\-–—]*[0-9])\]/g;

// Range separators we accept inside a multi-citation bracket
const RANGE_SEP_RE = /\s*[-–—]\s*/;

// Prior-coverage tag: [@42], [@42|override label], or [@42:slug-fallback]
// The ID is authoritative; slug/label are hints we prefer when present.
const PRIOR_CITE_RE = /\[@(\d+)(?:[:|]([^\]]*))?\]/g;

/**
 * Expand a multi-source bracket like "[1, 2, 3, 5]" into "[1][2][3][5]".
 * Leaves single-number brackets (e.g., "[1]") untouched.
 * Expands ranges: "[1-3]" → "[1][2][3]" (bounded so a typo'd "[1-999]"
 * can't blow up output).
 */
function normaliseMultiSourceCitations(text) {
  if (!text) return text;
  return String(text).replace(MULTI_CITE_RE, (whole, inner) => {
    // Split on commas first, then expand any ranges in each part.
    const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
    const numbers = [];
    for (const part of parts) {
      if (RANGE_SEP_RE.test(part)) {
        const [a, b] = part.split(RANGE_SEP_RE).map(s => parseInt(s.trim(), 10));
        if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 20) {
          for (let i = a; i <= b; i++) numbers.push(i);
        } else {
          // Bogus range — leave the whole token alone.
          return whole;
        }
      } else {
        // Might be a single number OR space-separated numbers ("1 2 3")
        const spaceSplit = part.split(/\s+/).map(s => parseInt(s, 10)).filter(Number.isFinite);
        if (!spaceSplit.length) return whole;
        numbers.push(...spaceSplit);
      }
    }
    if (numbers.length <= 1) return whole; // not actually multi-source
    return numbers.map(n => `[${n}]`).join('');
  });
}

/**
 * Expand "[@42]" tags into markdown links to the given writer's prior
 * articles. `priorArticles` should be an array of { id, slug, title }.
 *
 * Unresolved IDs (writer referenced an article id not in the list) are
 * replaced with a plain italicised title if an override label was given,
 * or left as-is. Never throws.
 */
function expandPriorCoverageTags(text, priorArticles, siteUrl) {
  if (!text) return text;
  const byId = new Map((priorArticles || []).map(a => [Number(a.id), a]));
  const base = (siteUrl || '').replace(/\/$/, '');
  return String(text).replace(PRIOR_CITE_RE, (whole, idStr, labelOrSlug) => {
    const id = parseInt(idStr, 10);
    const article = byId.get(id);
    const label = (labelOrSlug || '').trim();
    if (article && article.slug && article.title) {
      const href = base ? `${base}/article/${article.slug}` : `/article/${article.slug}`;
      const linkText = label || article.title;
      return `[${linkText}](${href})`;
    }
    // Fallback — strip the tag but keep any label so text still reads.
    if (label) return `_${label}_`;
    return whole;
  });
}

/**
 * Full citation pass: multi-source normalisation then prior-coverage
 * expansion. Callers that only need one can use the individual helpers.
 */
function normaliseCitations(text, { priorArticles, siteUrl } = {}) {
  let out = normaliseMultiSourceCitations(text);
  out = expandPriorCoverageTags(out, priorArticles, siteUrl);
  return out;
}

module.exports = {
  normaliseMultiSourceCitations,
  expandPriorCoverageTags,
  normaliseCitations,
};
