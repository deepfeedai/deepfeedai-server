/**
 * Deep Feed AI — Quality gate / editorial scoring
 * Heuristic-based scoring for synthesized articles to decide auto-publish.
 * Returns { publish, newsworthiness, feature_worthy, score, reason }.
 */
const db = require('../db');

/**
 * Score an article on a 1-10 scale using fast heuristics (no LLM call).
 * @param {object} article — must have title, summary/full_content, category, source_article_ids
 * @returns {{ publish: boolean, score: number, newsworthiness: number, feature_worthy: boolean, reason: string }}
 */
async function getEditorialScore(article, tenantId) {
  let score = 5; // baseline
  const reasons = [];

  const title   = article.title || '';
  const body    = article.full_content || article.summary || '';
  const sources = parseSourceIds(article.source_article_ids);

  // ── Source diversity (count + publication diversity) ──────────
  const sourceNames = new Set();
  for (const s of sources) {
    if (typeof s === 'object' && s !== null && s.source) sourceNames.add(s.source);
  }
  const distinctPubs = sourceNames.size;

  if (sources.length >= 5 && distinctPubs >= 3) { score += 2; reasons.push('5+ sources, 3+ publications'); }
  else if (sources.length >= 5) { score += 1; reasons.push('5+ sources, low diversity'); }
  else if (sources.length >= 3 && distinctPubs >= 3) { score += 1; reasons.push('3+ sources, 3+ publications'); }
  else if (sources.length >= 3) { score += 0; reasons.push('3+ sources, low publication diversity'); }
  else if (sources.length <= 1) { score -= 1; reasons.push('single source'); }

  // ── Content length ──────────────────────────────────────────
  const wordCount = body.split(/\s+/).length;
  if (wordCount >= 300) { score += 1; reasons.push('substantial content'); }
  else if (wordCount < 100) { score -= 1; reasons.push('thin content'); }

  // ── Title quality ──────────────────────────────────────────
  if (title.length >= 30 && title.length <= 120) { score += 1; reasons.push('good title length'); }
  if (/^Analysis:|^Generic|^Summary/i.test(title)) { score -= 1; reasons.push('generic title'); }

  // ── Newsworthiness signals ─────────────────────────────────
  const newsSignals = /breaking|launch|announce|release|major|critical|vulnerability|billion|million|funding|acquire|partner/i;
  const newsworthiness = newsSignals.test(title + ' ' + body) ? Math.min(score + 1, 10) : Math.max(score - 1, 1);

  // ── Deep-dive format bonus ───────────────────────────────
  if (article.content_type === 'deep-dive') {
    score += 1;
    reasons.push('deep-dive format bonus');
  }

  // ── Daily publish cap check ────────────────────────────────
  let dailyCapOk = true;
  try {
    const targetSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'daily_publish_target'").get(tenantId);
    const dailyTarget = parseInt(targetSetting?.value) || 20;
    const todayCount = await db.prepare(
      `SELECT COUNT(*)::INTEGER AS cnt FROM articles
       WHERE tenant_id = $1 AND content_type IN ('original', 'deep-dive') AND is_published = 1
         AND published_at > NOW() - INTERVAL '24 hours'`
    ).get(tenantId);
    if ((todayCount?.cnt || 0) >= dailyTarget) {
      dailyCapOk = false;
      reasons.push(`daily cap (${dailyTarget}) reached`);
    }
  } catch { /* non-fatal */ }

  // ── Final score and decision ───────────────────────────────
  score = Math.max(1, Math.min(10, score));
  // Originals and deep dives are already prominent by content type — don't auto-feature
  const featureWorthy = score >= 8 && article.content_type !== 'original' && article.content_type !== 'deep-dive';
  const publish = score >= 6 && dailyCapOk;

  return {
    publish,
    score,
    newsworthiness: Math.max(1, Math.min(10, newsworthiness)),
    feature_worthy: featureWorthy,
    reason: reasons.join('; ') || 'baseline',
  };
}

/**
 * Score a curated article (RSS/NewsAPI/Brave) on a 1-10 scale.
 * Uses signals available at ingestion: title, summary, image, author, source.
 * @param {object} article — { title, summary, image_url, author, source }
 * @param {number} tenantId
 * @returns {{ publish: boolean, score: number, newsworthiness: number, feature_worthy: boolean, reason: string }}
 */
async function getCuratedScore(article, tenantId) {
  let score = 5; // baseline
  const reasons = [];

  const title   = article.title || '';
  const summary = article.summary || '';

  // ── Title length ─────────────────────────────────────────
  if (title.length >= 30 && title.length <= 120) { score += 1; reasons.push('good title length'); }
  else if (title.length < 15) { score -= 1; reasons.push('title too short'); }
  else if (title.length > 200) { score -= 1; reasons.push('title too long'); }

  // ── Title quality ────────────────────────────────────────
  if (title === title.toUpperCase() && title.length > 10) { score -= 1; reasons.push('all-caps title'); }
  if (/you won.t believe|this one trick|shocking|mind.?blowing|what happens next/i.test(title)) {
    score -= 1; reasons.push('clickbait title');
  }

  // ── Summary presence and length ──────────────────────────
  if (summary.length >= 200) { score += 1; reasons.push('substantial summary'); }
  else if (summary.length >= 50) { score += 1; reasons.push('has summary'); }
  else { score -= 1; reasons.push('missing or thin summary'); }

  // ── Image presence ───────────────────────────────────────
  if (article.image_url) { score += 1; reasons.push('has image'); }

  // ── Author presence ──────────────────────────────────────
  if (article.author) { score += 1; reasons.push('has author'); }

  // ── Newsworthiness signals ───────────────────────────────
  const newsSignals = /breaking|launch|announce|release|major|critical|vulnerability|billion|million|funding|acquire|partner/i;
  const text = title + ' ' + summary;
  const isNewsworthy = newsSignals.test(text);
  if (isNewsworthy) { score += 1; reasons.push('newsworthy'); }
  const newsworthiness = isNewsworthy ? Math.min(score + 1, 10) : Math.max(score - 1, 1);

  // ── Source reputation (10+ prior articles = established) ─
  try {
    const srcCount = await db.prepare(
      `SELECT COUNT(*)::INTEGER AS cnt FROM articles WHERE tenant_id = $1 AND source = $2`
    ).get(tenantId, article.source);
    if ((srcCount?.cnt || 0) >= 10) { score += 1; reasons.push('established source'); }
  } catch { /* non-fatal */ }

  // ── Duplicate title check (exact match, last 48h) ────────
  try {
    const dup = await db.prepare(
      `SELECT id FROM articles WHERE tenant_id = $1 AND LOWER(title) = LOWER($2) AND created_at > NOW() - INTERVAL '48 hours' LIMIT 1`
    ).get(tenantId, title);
    if (dup) { score -= 3; reasons.push('duplicate title'); }
  } catch { /* non-fatal */ }

  // ── Final score and decision ─────────────────────────────
  score = Math.max(1, Math.min(10, score));
  const publish = score >= 5;

  return {
    publish,
    score,
    newsworthiness: Math.max(1, Math.min(10, newsworthiness)),
    feature_worthy: false, // curated articles don't get auto-featured
    reason: reasons.join('; ') || 'baseline',
  };
}

function parseSourceIds(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

module.exports = { getEditorialScore, getCuratedScore };
