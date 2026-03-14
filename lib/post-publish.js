/**
 * Deep Feed AI — Post-publish hooks
 * Runs after an article is published (auto or manual).
 * All operations are fire-and-forget and budget-checked.
 */
const db = require('../db');
const { canSpend } = require('./budget');
const { generateAndStoreImage } = require('./media-helpers');
const { findBestWriter, generateWriterTldr } = require('./writer-assign');

/**
 * Run post-publish hooks for a newly published article.
 * Called as: onArticlePublished(articleId).catch(() => {})
 *
 * Hooks (all non-blocking):
 * 1. Pre-warm TLDR summary (budget-checked)
 * 2. Generate thumbnail if missing (budget-checked, handled by generateAndStoreImage)
 * 3. Auto-assign writer if unassigned (free)
 */
async function onArticlePublished(articleId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(articleId);
    if (!article || article.is_archived) return;

    // 1. Pre-warm TLDR (lazy-require to avoid circular dependency)
    const summaryBudget = await canSpend('summary');
    if (summaryBudget.allowed) {
      try {
        const { prewarmSummary } = require('../routes/summary');
        prewarmSummary(article.title, (article.summary || article.full_content || '').slice(0, 800)).catch(() => {});
      } catch { /* ignore */ }
    }

    // 2. Generate thumbnail if missing (budget check is inside generateAndStoreImage)
    if (!article.image_url) {
      generateAndStoreImage(articleId).catch(() => {});
    }

    // 3. Auto-assign writer if unassigned (free — no API call for assignment itself)
    if (!article.writer_id) {
      try {
        const artObj = { id: article.id, title: article.title, summary: article.summary, category: article.category, source: article.source };
        const writer = await findBestWriter(artObj);
        if (writer) {
          await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2').run(writer.id, article.id);
          // Writer TLDR is a Gemini call — budget-check it
          const tldrBudget = await canSpend('writer-tldr');
          if (tldrBudget.allowed) {
            const tldr = await generateWriterTldr(artObj, writer);
            if (tldr) await db.prepare('UPDATE articles SET tldr_overview = $1 WHERE id = $2').run(tldr, article.id);
          }
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[post-publish] error:', err.message);
  }
}

module.exports = { onArticlePublished };
