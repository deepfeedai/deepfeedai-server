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

    // Story levels — auto-compute importance from cluster signals (fire-and-forget).
    // When the effective tier is 'breaking', also dispatch an actionable
    // notification to editors with send/skip buttons (gated by story_levels +
    // notifications_center flags).
    try {
      const storyLevels = require('./story-levels');
      storyLevels.computeAndSetImportance(article.id, tenantId)
        .then(async () => {
          const fresh = await db.prepare(
            'SELECT id, title, generated_title, slug, importance, importance_locked, importance_updated_at, published_at FROM articles WHERE id = $1 AND tenant_id = $2'
          ).get(article.id, tenantId).catch(() => null);
          if (!fresh) return;
          const effective = storyLevels.computeEffectiveImportance(fresh);
          if (effective !== 'breaking') return;
          try {
            const { isFeatureEnabled } = require('./feature-registry');
            const slOn = await isFeatureEnabled(tenantId, 'story_levels').catch(() => false);
            if (!slOn) return;
            const { notify } = require('./notifications');
            const editors = await db.prepare(
              "SELECT id FROM users WHERE tenant_id = $1 AND (role = 'admin' OR role = 'editor')"
            ).all(tenantId).catch(() => []);
            const title = fresh.generated_title || fresh.title;
            const srcRow = await db.prepare(
              "SELECT COUNT(DISTINCT source)::int AS cnt FROM articles WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated') AND published_at > NOW() - INTERVAL '2 hours'"
            ).get(tenantId).catch(() => ({ cnt: 0 }));
            for (const e of editors) {
              notify({
                tenantId,
                userId: e.id,
                kind: 'breaking_dispatch_pending',
                title: 'Breaking story ready to dispatch',
                body: `${title} — ${srcRow?.cnt || 0} source(s) in last 2h`,
                payload: { article_id: article.id, slug: fresh.slug },
                actionable: [
                  { label: 'Send breaking alert', actionKind: 'breaking.dispatch', targetId: article.id, targetType: 'article', style: 'primary' },
                  { label: 'Skip', actionKind: 'breaking.skip', targetId: article.id, targetType: 'article' },
                ],
              }).catch(() => {});
            }
          } catch { /* non-fatal */ }
        })
        .catch(() => {});
    } catch { /* non-fatal */ }

    // Newsroom feed event — fire-and-forget
    try {
      const { recordEvent } = require('./newsroom-events');
      recordEvent({
        tenantId, type: 'published',
        actorWriterId: article.writer_id || null,
        targetArticleId: article.id,
        payload: {
          title: article.generated_title || article.title,
          slug: article.slug,
          category: article.category,
          content_type: article.content_type,
          summary: (article.tldr_overview || article.summary || '').slice(0, 280),
        },
      });
    } catch { /* non-fatal */ }

    // 1. Generate headline rewrite + topic_tag for story threading
    const summaryBudget = await canSpend('summary', tenantId);
    if (summaryBudget.allowed && !article.disable_summary) {
      try {
        const { complete: aiComplete } = require('./ai-router');
        const { loadPrompt } = require('./prompt-loader');
        const { getSiteConfig } = require('./site-config');
        const site = await getSiteConfig(tenantId);
        const persona = site.ai_persona || 'You are a tech news analyst.';
        const p = loadPrompt('summary');
        const { messages } = p.render({
          persona,
          styleInstruction: 'Analyze this article and respond with ONLY valid JSON (no markdown, no code fences) in this exact shape:',
          matterInstruction: '"whyItMatters": "One sentence on the broader significance for the AI industry."',
          ruleInstruction: '- Be specific and factual. No fluff.',
          title: article.title.replace(/[\x00-\x1F]/g, '').slice(0, 300),
          description: article.summary ? `Context: ${article.summary.slice(0, 500)}` : '',
        });
        const result = await aiComplete({ operation: 'summary', tenantId, messages: [{ role: 'user', content: messages[0].content }], temperature: 0.3, maxTokens: 500, trigger: 'auto-assign' });
        if (result?.text) {
          const cleaned = result.text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
          const parsed = JSON.parse(cleaned);
          const genTitle   = parsed.headline || null;
          const topicTag   = parsed.topicTag || null;
          const tldrContext = parsed.context || null;
          if (genTitle || topicTag || tldrContext) {
            await db.prepare(
              'UPDATE articles SET generated_title = COALESCE($1, generated_title), topic_tag = COALESCE($2, topic_tag), tldr_context = COALESCE($3, tldr_context) WHERE id = $4 AND tenant_id = $5'
            ).run(genTitle, topicTag, tldrContext, article.id, tenantId);
            if (genTitle)    article.generated_title = genTitle;
            if (topicTag)    article.topic_tag = topicTag;
            if (tldrContext) article.tldr_context = tldrContext;
          }
        }
      } catch { /* ignore */ }
    }

    // 1b-i. Notify users who follow this topic_tag (fire-and-forget).
    if (article.topic_tag && article.is_published) {
      setImmediate(() => {
        (async () => {
          try {
            const { notify } = require('./notifications');
            const followers = await db.prepare(
              'SELECT user_id FROM user_topic_follows WHERE tenant_id = $1 AND topic_tag = $2'
            ).all(tenantId, article.topic_tag);
            if (!followers.length) return;
            const title     = article.generated_title || article.title;
            const topicLabel = article.topic_tag.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            for (const f of followers) {
              notify({
                tenantId,
                userId: f.user_id,
                kind:   'topic_article_published',
                title:  `New on ${topicLabel}`,
                body:   title,
                payload: { article_id: article.id, slug: article.slug, topic_tag: article.topic_tag },
                actionable: [
                  { label: 'Read article', actionKind: 'article.open', targetId: article.id, targetType: 'article' },
                ],
              }).catch(() => {});
            }
          } catch { /* non-fatal */ }
        })();
      });
    }

    // 1b-ii. Upsert story_threads row (N3) — only for originals/deep-dives that
    // have a topic_tag. Fire-and-forget; never blocks publish.
    if (article.topic_tag && ['original', 'deep-dive'].includes(article.content_type)) {
      try {
        const { upsertThreadOnPublish } = require('./story-threads');
        upsertThreadOnPublish(article, tenantId).catch(() => {});
      } catch { /* non-fatal */ }
    }

    // 2. Generate thumbnail + inline images via job queue (retries, visibility)
    const isInlineEligible = (article.content_type === 'original' || article.content_type === 'deep-dive') && article.full_content;
    if (!article.image_url || isInlineEligible) {
      const { enqueueJob } = require('./jobs/queue');
      const { JOB_TYPE } = require('./jobs/constants');
      enqueueJob({
        tenantId,
        type:           JOB_TYPE.GENERATE_IMAGE,
        payload:        { articleId, skipThumbnail: !!article.image_url, inlineEligible: isInlineEligible },
        idempotencyKey: `img:${tenantId}:${articleId}`,
      }).catch(() => {});
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
    // 5. Generate embedding for semantic search (RAG) via job queue
    if (article.content_type === 'original' || article.content_type === 'deep-dive') {
      const { enqueueJob } = require('./jobs/queue');
      const { JOB_TYPE, PRIORITY } = require('./jobs/constants');
      enqueueJob({
        tenantId,
        type:           JOB_TYPE.GENERATE_EMBEDDING,
        payload:        { articleId },
        priority:       PRIORITY.LOW,
        idempotencyKey: `emb:${tenantId}:${articleId}:v1`,
      }).catch(() => {});
    }

    // 6. Story timeline detection — assign article to matching stories or create a new one
    if (article.topic_tag) {
      try {
        const { detectAndAssignStories } = require('./story-timelines');
        detectAndAssignStories(article, tenantId).catch(() => {});
      } catch { /* non-fatal */ }
    }

    // 7. Proactive messaging — notify writer's channel about new article
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
    const displayTitle = article.generated_title || article.title;
    const message = `Just published: "${displayTitle}"${snippet ? `\n${snippet}` : ''}${articleUrl ? `\n${articleUrl}` : ''}`;

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
      `).run(tenantId, article.writer_id, `Published: ${displayTitle}`, JSON.stringify({ articleId: article.id, channelCount: channels.length }));
    }
  } catch (err) {
    console.error('[post-publish] Channel notification failed (non-fatal):', err.message);
  }
}

module.exports = { onArticlePublished, generateArticleEmbedding: _generateArticleEmbedding };
