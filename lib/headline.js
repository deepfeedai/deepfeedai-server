/**
 * Headline generation — produces display, SEO, social, and push variants
 * for a synthesized article. Called after synthesis insert, non-blocking.
 */
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const db = require('../db');

const CLICKBAIT_PATTERNS = [
  /you won'?t believe/i,
  /everything you (need to|should) know/i,
  /\bgame.?changer\b/i,
  /\blandmark (ruling|decision|moment|case)\b/i,
  /\bwhat happened next\b/i,
  /\bthis (will|is going to) (shock|surprise|amaze)\b/i,
  /^\d+ (reasons|things|ways|tips)/i,
  /\bexplosive (report|claim|revelation)\b/i,
];

function isClickbait(headline) {
  return headline && CLICKBAIT_PATTERNS.some(p => p.test(headline));
}

function clean(s) {
  return s ? s.trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * Generate headline variants for an article.
 * Returns { display, seo, social, push } or null on failure.
 * Non-blocking — callers should catch errors.
 */
async function generateHeadlines(article, writer, tenantId) {
  try {
    const beatRow = await db.prepare(`
      SELECT c.name FROM writer_beats wb
      JOIN categories c ON c.id = wb.category_id
      WHERE wb.writer_id = $1 AND wb.tenant_id = $2
      LIMIT 1
    `).get(writer.id, tenantId);

    const p = loadPrompt('headline');
    const { messages, ...meta } = p.render({
      articleSubtype: article.article_subtype || 'original',
      writerName: writer.name,
      beat: beatRow?.name || article.category || 'general',
      currentTitle: article.title,
      excerpt: (article.summary || '').slice(0, 280),
    });

    const result = await aiComplete({
      ...meta, messages, tenantId,
      trigger: 'headline-generation',
      writerId: writer.id,
    });

    if (!result?.text) return null;

    const text = result.text;
    const display = clean(text.match(/^DISPLAY:\s*(.+)/m)?.[1]);
    const seo     = clean(text.match(/^SEO:\s*(.+)/m)?.[1]);
    const social  = clean(text.match(/^SOCIAL:\s*(.+)/m)?.[1]);
    const push    = clean(text.match(/^PUSH:\s*(.+)/m)?.[1]);

    if (isClickbait(display)) {
      console.warn(`[headline] Clickbait pattern in display: "${display}" — discarding`);
      return null;
    }

    return { display, seo, social, push };
  } catch (err) {
    console.error('[headline] generateHeadlines error:', err.message);
    return null;
  }
}

/**
 * Generate headlines for an article and persist variants to the DB.
 * Non-blocking — call with .catch(() => {}) if fire-and-forget.
 */
async function generateAndStoreHeadlines(article, writer, tenantId) {
  const variants = await generateHeadlines(article, writer, tenantId);
  if (!variants) return null;

  await db.prepare(`
    UPDATE articles
    SET headline_seo = $1, headline_social = $2, headline_push = $3
    WHERE id = $4 AND tenant_id = $5
  `).run(variants.seo, variants.social, variants.push, article.id, tenantId);

  console.log(`[headline] Stored variants for article ${article.id}: SEO="${variants.seo}"`);
  return variants;
}

module.exports = { generateHeadlines, generateAndStoreHeadlines };
