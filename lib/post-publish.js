/**
 * Deep Feed AI — Post-publish hooks
 * Runs after an article is published (auto or manual).
 * All operations are fire-and-forget and budget-checked.
 */
const db = require('../db');
const { canSpend } = require('./budget');
const { generateAndStoreImage, generateInlineImages } = require('./media-helpers');
const { findBestWriter, generateWriterTldr } = require('./writer-assign');

/**
 * Run post-publish hooks for a newly published article.
 * Called as: onArticlePublished(articleId).catch(() => {})
 *
 * Hooks (all non-blocking):
 * 1. Pre-warm TLDR summary (budget-checked)
 * 2. Generate thumbnail if missing (budget-checked, handled by generateAndStoreImage)
 * 3. Auto-assign writer if unassigned (free)
 * 4. Generate writer TLDR if missing (deferred from ingest, skips synthesis originals)
 */
async function onArticlePublished(articleId, tenantId) {
  try {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!article || article.is_archived) return;

    // 1. Pre-warm TLDR + persist generated_title and topic_tag
    const summaryBudget = await canSpend('summary', tenantId);
    if (summaryBudget.allowed && !article.disable_summary) {
      try {
        const { prewarmSummary } = require('../routes/summary');
        const summary = await prewarmSummary(article.title, (article.summary || article.full_content || '').slice(0, 800), tenantId);
        if (summary) {
          const genTitle = summary.headline || null;
          const topicTag = summary.topicTag || null;
          if (genTitle || topicTag) {
            await db.prepare(
              'UPDATE articles SET generated_title = COALESCE($1, generated_title), topic_tag = COALESCE($2, topic_tag) WHERE id = $3 AND tenant_id = $4'
            ).run(genTitle, topicTag, article.id, tenantId);
          }
        }
      } catch { /* ignore */ }
    }

    // 2. Generate thumbnail if missing (budget check is inside generateAndStoreImage)
    // 5. Generate inline images for originals & deep dives (chained after hero thumbnail)
    const isInlineEligible = (article.content_type === 'original' || article.content_type === 'deep-dive') && article.full_content;
    if (!article.image_url) {
      generateAndStoreImage(articleId, tenantId)
        .then(() => {
          if (isInlineEligible) generateInlineImages(articleId, tenantId).catch(() => {});
        })
        .catch(() => {
          if (isInlineEligible) generateInlineImages(articleId, tenantId).catch(() => {});
        });
    } else if (isInlineEligible) {
      generateInlineImages(articleId, tenantId).catch(() => {});
    }

    // 3. Auto-assign writer if unassigned (free — no API call for assignment itself)
    if (!article.writer_id) {
      try {
        const artObj = { id: article.id, title: article.title, summary: article.summary, category: article.category, source: article.source };
        const writer = await findBestWriter(artObj, tenantId);
        if (writer) {
          await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3').run(writer.id, article.id, tenantId);
          article.writer_id = writer.id;
        }
      } catch { /* ignore */ }
    }

    // 4. Generate writer TLDR if missing (deferred from ingest to avoid wasting
    //    tokens on articles that synthesis will consume). Skip synthesis originals
    //    since they already have AI-generated content.
    if (!article.tldr_overview && article.content_type !== 'original' && article.writer_id) {
      try {
        const tldrBudget = await canSpend('writer-tldr', tenantId);
        if (tldrBudget.allowed) {
          const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, tenantId);
          if (writer) {
            const artObj = { id: article.id, title: article.title, summary: article.summary, category: article.category, source: article.source, slug: article.slug };
            const tldr = await generateWriterTldr(artObj, writer, tenantId);
            if (tldr) await db.prepare('UPDATE articles SET tldr_overview = $1 WHERE id = $2 AND tenant_id = $3').run(tldr, article.id, tenantId);
          }
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[post-publish] error:', err.message);
  }
}

module.exports = { onArticlePublished };
