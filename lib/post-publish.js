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
    // 5. Generate embedding for semantic search (RAG)
    // Non-blocking, fire-and-forget — if it fails, keyword search is the fallback
    if (article.content_type === 'original' || article.content_type === 'deep-dive') {
      _generateArticleEmbedding(article, tenantId).catch(() => {});
    }

    // 6. Proactive messaging — notify writer's channel about new article
    if (article.content_type === 'original' && article.writer_id) {
      _notifyWriterChannel(article, tenantId).catch(() => {});
    }
  } catch (err) {
    console.error('[post-publish] error:', err.message);
  }
}

/**
 * Generate and store an embedding vector for an article.
 * Uses title + summary/overview as the embedding text.
 */
async function _generateArticleEmbedding(article, tenantId) {
  try {
    const { generateEmbedding, isPgvectorAvailable } = require('./embeddings');
    if (!(await isPgvectorAvailable())) return;

    // Skip if already has an embedding
    const existing = await db.prepare(
      'SELECT 1 FROM articles WHERE id = $1 AND tenant_id = $2 AND embedding IS NOT NULL'
    ).get(article.id, tenantId);
    if (existing) return;

    const textToEmbed = `${article.title} — ${article.tldr_overview || article.summary || ''}`.slice(0, 1000);
    const vector = await generateEmbedding(tenantId, textToEmbed);

    await db.prepare(
      'UPDATE articles SET embedding = $1 WHERE id = $2 AND tenant_id = $3'
    ).run(JSON.stringify(vector), article.id, tenantId);
  } catch (err) {
    console.error('[post-publish] Embedding generation failed (non-fatal):', err.message);
  }
}

/**
 * Notify a writer's messaging channel about a new published article.
 * Max 3 proactive messages per writer per day to avoid spam.
 */
async function _notifyWriterChannel(article, tenantId) {
  try {
    // Check daily proactive message limit (max 3 per writer per day)
    const today = await db.prepare(`
      SELECT COUNT(*)::int AS cnt FROM newsroom_messages
      WHERE tenant_id = $1 AND from_writer_id = $2
        AND message_type = 'proactive' AND created_at > NOW() - INTERVAL '24 hours'
    `).get(tenantId, article.writer_id);
    if ((today?.cnt || 0) >= 3) return;

    // Get writer info
    const writer = await db.prepare(
      'SELECT name, slug FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(article.writer_id, tenantId);
    if (!writer) return;

    // Build article URL
    let articleUrl = '';
    try {
      const { getAppConfig } = require('./app-config');
      const config = await getAppConfig(tenantId);
      const siteUrl = (config.main_site_url || config.base_url || '').replace(/\/$/, '');
      if (siteUrl && article.slug) articleUrl = `${siteUrl}/article/${article.slug}`;
    } catch {}

    const snippet = (article.tldr_overview || article.summary || '').slice(0, 150);
    const message = `Just published: "${article.title}"${snippet ? `\n${snippet}` : ''}${articleUrl ? `\n${articleUrl}` : ''}`;

    // Find writer's messaging channels and notify
    const channels = await db.prepare(
      "SELECT platform, channel_id, thread_id FROM messaging_channels WHERE writer_id = $1 AND tenant_id = $2 AND is_active = true"
    ).all(article.writer_id, tenantId);

    for (const ch of channels) {
      try {
        if (ch.platform === 'discord') {
          const { sendDiscordMessage } = require('./messaging/discord');
          await sendDiscordMessage(ch.channel_id, message, tenantId);
        } else if (ch.platform === 'telegram') {
          const { sendTelegramMessage } = require('./messaging/telegram');
          await sendTelegramMessage(ch.channel_id, message, tenantId, ch.thread_id);
        } else if (ch.platform === 'slack') {
          const { sendSlackMessage } = require('./messaging/slack');
          await sendSlackMessage(ch.channel_id, message, tenantId);
        }
      } catch (err) {
        console.error(`[post-publish] Proactive message failed (${ch.platform}):`, err.message);
      }
    }

    // Record as newsroom message for tracking
    if (channels.length > 0) {
      await db.prepare(`
        INSERT INTO newsroom_messages (tenant_id, from_writer_id, message_type, content, context)
        VALUES ($1, $2, 'proactive', $3, $4)
      `).run(tenantId, article.writer_id, `Published: ${article.title}`, JSON.stringify({ articleId: article.id, channelCount: channels.length }));
    }
  } catch (err) {
    console.error('[post-publish] Channel notification failed (non-fatal):', err.message);
  }
}

module.exports = { onArticlePublished };
