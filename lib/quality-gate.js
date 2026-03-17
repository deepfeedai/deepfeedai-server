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

  // ── Source diversity (more sources = higher confidence) ───────
  if (sources.length >= 5) { score += 2; reasons.push('5+ sources'); }
  else if (sources.length >= 3) { score += 1; reasons.push('3+ sources'); }
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

  // ── Daily publish cap check ────────────────────────────────
  let dailyCapOk = true;
  try {
    const targetSetting = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'daily_publish_target'").get(tenantId);
    const dailyTarget = parseInt(targetSetting?.value) || 20;
    const todayCount = await db.prepare(
      `SELECT COUNT(*)::INTEGER AS cnt FROM articles
       WHERE tenant_id = $1 AND content_type = 'original' AND is_published = 1
         AND published_at > NOW() - INTERVAL '24 hours'`
    ).get(tenantId);
    if ((todayCount?.cnt || 0) >= dailyTarget) {
      dailyCapOk = false;
      reasons.push(`daily cap (${dailyTarget}) reached`);
    }
  } catch { /* non-fatal */ }

  // ── Final score and decision ───────────────────────────────
  score = Math.max(1, Math.min(10, score));
  const featureWorthy = score >= 8;
  const publish = score >= 6 && dailyCapOk;

  return {
    publish,
    score,
    newsworthiness: Math.max(1, Math.min(10, newsworthiness)),
    feature_worthy: featureWorthy,
    reason: reasons.join('; ') || 'baseline',
  };
}

function parseSourceIds(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

module.exports = { getEditorialScore };
