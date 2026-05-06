/**
 * Admin Pitches API — manage writer agent story pitches.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPool } = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { burnTokensByTarget } = require('../lib/action-tokens');

// GET /api/admin/pitches — list pitches
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { status = 'pending', writer_id, limit: lim, offset: off } = req.query;
  const limit = Math.min(parseInt(lim) || 50, 200);
  const offset = Math.max(parseInt(off) || 0, 0);

  let query = `
    SELECT sp.*, w.name AS writer_name, w.avatar_url AS writer_avatar_url,
      COALESCE((
        SELECT json_agg(json_build_object('id', a.id, 'title', a.title, 'source', a.source))
        FROM articles a
        WHERE a.id = ANY(ARRAY(SELECT value::int FROM jsonb_array_elements_text(sp.source_article_ids) AS v(value)))
          AND a.tenant_id = sp.tenant_id
      ), '[]'::json) AS source_articles
    FROM story_pitches sp
    LEFT JOIN writers w ON w.id = sp.writer_id
    WHERE sp.tenant_id = $1
  `;
  let countQuery = 'SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id = $1';
  const params = [req.tenantId];
  const countParams = [req.tenantId];

  if (status && status !== 'all') {
    params.push(status);
    countParams.push(status);
    query += ` AND sp.status = $${params.length}`;
    countQuery += ` AND status = $${countParams.length}`;
  }
  if (writer_id) {
    params.push(parseInt(writer_id));
    countParams.push(parseInt(writer_id));
    query += ` AND sp.writer_id = $${params.length}`;
    countQuery += ` AND writer_id = $${countParams.length}`;
  }

  query += ' ORDER BY sp.priority DESC, sp.created_at DESC';
  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push(offset);
  query += ` OFFSET $${params.length}`;

  const [result, countResult] = await Promise.all([
    getPool().query(query, params),
    getPool().query(countQuery, countParams),
  ]);

  // Parse JSONB fields
  const pitches = result.rows.map(p => ({
    ...p,
    source_article_ids: typeof p.source_article_ids === 'string' ? JSON.parse(p.source_article_ids) : (p.source_article_ids || []),
    memory_refs: typeof p.memory_refs === 'string' ? JSON.parse(p.memory_refs) : (p.memory_refs || []),
    source_articles: typeof p.source_articles === 'string' ? JSON.parse(p.source_articles) : (p.source_articles || []),
  }));

  res.json({
    pitches,
    total: parseInt(countResult.rows[0]?.cnt || 0),
    hasMore: offset + pitches.length < parseInt(countResult.rows[0]?.cnt || 0),
  });
}));

// POST /api/admin/pitches/:id/approve — approve and trigger synthesis
router.post('/:id/approve', auth, requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const pitch = await db.prepare(
    'SELECT * FROM story_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);

  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (!['pending', 'proposed', 'approved', 'synthesized'].includes(pitch.status)) return res.status(400).json({ error: 'Pitch already resolved' });

  // Mark as approved
  await db.prepare(
    "UPDATE story_pitches SET status = 'approved', resolved_at = NOW() WHERE id = $1"
  ).run(pitch.id);

  // Get source articles for synthesis
  const sourceIds = typeof pitch.source_article_ids === 'string'
    ? JSON.parse(pitch.source_article_ids) : (pitch.source_article_ids || []);

  let synthesized = null;
  let synthesisSkipReason = null;

  if (sourceIds.length < 2) {
    synthesisSkipReason = `pitch has ${sourceIds.length} source(s) — need at least 2`;
  } else {
    try {
      const { synthesizeCluster } = require('../lib/synthesis');
      const sources = await db.prepare(
        `SELECT * FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2`
      ).all(sourceIds, req.tenantId);

      if (sources.length < 2) {
        synthesisSkipReason = `only ${sources.length} of ${sourceIds.length} source articles found in DB`;
        console.warn(`[pitches] approve #${pitch.id}: ${synthesisSkipReason}`);
      } else {
        const writer = await db.prepare(
          'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
        ).get(pitch.writer_id, req.tenantId);

        if (!writer) {
          synthesisSkipReason = `writer id=${pitch.writer_id} not found`;
          console.warn(`[pitches] approve #${pitch.id}: ${synthesisSkipReason}`);
        } else {
          const cluster = { topic: pitch.headline, articles: sources };
          synthesized = await synthesizeCluster(cluster, writer, req.tenantId);

          if (synthesized) {
            await db.prepare(
              "UPDATE story_pitches SET status = 'synthesized' WHERE id = $1"
            ).run(pitch.id);
          } else {
            synthesisSkipReason = 'synthesizeCluster returned null (check AI budget or quality gate)';
            console.warn(`[pitches] approve #${pitch.id}: ${synthesisSkipReason}`);
          }
        }
      }
    } catch (err) {
      synthesisSkipReason = err.message;
      console.error('[pitches] synthesis from pitch failed:', err.message);
    }
  }

  burnTokensByTarget('story_pitch', pitch.id, req.tenantId, req.user?.sub || null).catch(() => {});

  res.json({
    status: 'ok',
    pitch: { ...pitch, status: synthesized ? 'synthesized' : 'approved' },
    article: synthesized ? { id: synthesized.id, title: synthesized.title, slug: synthesized.slug } : null,
    synthesis_skip_reason: synthesized ? null : synthesisSkipReason,
  });
}));

// POST /api/admin/pitches/:id/dismiss — dismiss a pitch
router.post('/:id/dismiss', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const result = await db.prepare(
    "UPDATE story_pitches SET status = 'dismissed', resolved_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','proposed','approved','synthesized') RETURNING *"
  ).get(req.params.id, req.tenantId);

  if (!result) return res.status(404).json({ error: 'Pitch not found or already resolved' });
  burnTokensByTarget('story_pitch', Number(req.params.id), req.tenantId, req.user?.sub || null).catch(() => {});
  res.json({ status: 'ok', pitch: result });
}));

// DELETE /api/admin/pitches/:id
router.delete('/:id', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  await db.prepare(
    'DELETE FROM story_pitches WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, req.tenantId);
  res.json({ status: 'ok' });
}));

// GET /api/admin/pitches/count — pending count for badge
router.get('/count', auth, asyncHandler(async (req, res) => {
  const row = await db.prepare(
    "SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id = $1 AND status = 'pending'"
  ).get(req.tenantId);
  res.json({ count: row?.cnt || 0 });
}));

// GET /api/admin/newsroom — recent newsroom messages
router.get('/newsroom', auth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const messages = await getPool().query(`
    SELECT nm.*,
      fw.name AS from_writer_name, fw.avatar_url AS from_writer_avatar,
      tw.name AS to_writer_name,
      a.status AS article_status, a.is_published AS article_published
    FROM newsroom_messages nm
    LEFT JOIN writers fw ON fw.id = nm.from_writer_id
    LEFT JOIN writers tw ON tw.id = nm.to_writer_id
    LEFT JOIN articles a ON a.id = (nm.context->>'articleId')::integer
    WHERE nm.tenant_id = $1
    ORDER BY nm.created_at DESC
    LIMIT $2
  `, [req.tenantId, limit]);

  res.json({ messages: messages.rows });
}));

// DELETE /api/admin/newsroom/:id — delete a newsroom message
router.delete('/newsroom/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const result = await db.prepare(
    'DELETE FROM newsroom_messages WHERE id = $1 AND tenant_id = $2 RETURNING id'
  ).get(req.params.id, req.tenantId);
  if (!result) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true });
}));

// POST /api/admin/newsroom/clear — clear all newsroom messages
router.post('/newsroom/clear', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM newsroom_messages WHERE tenant_id = $1').run(req.tenantId);
  res.json({ ok: true });
}));

// POST /api/admin/pitches/test-editorial-review — run AI editor on a specific article
router.post('/test-editorial-review', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: 'articleId required' });

  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { editorialReview } = require('../lib/editorial');
  const verdict = await editorialReview(article, req.tenantId);

  // If editor flagged the article, move it to review status
  let newStatus = article.status;
  if (verdict && !verdict.publish && article.status === 'published') {
    await db.prepare(
      "UPDATE articles SET status = 'review', is_published = 0, submitted_for_review_at = NOW() WHERE id = $1 AND tenant_id = $2"
    ).run(articleId, req.tenantId);
    newStatus = 'review';
  }

  res.json({ article: { id: article.id, title: article.title, status: newStatus }, verdict });
}));

// ── Messaging Channels ──────────────────────────────────────────

// GET /api/admin/pitches/channels — list messaging channels
router.get('/channels', auth, requirePermission('settings.read'), asyncHandler(async (req, res) => {
  const channels = await getPool().query(`
    SELECT mc.*, w.name AS writer_name
    FROM messaging_channels mc
    LEFT JOIN writers w ON w.id = mc.writer_id
    WHERE mc.tenant_id = $1
    ORDER BY mc.created_at DESC
  `, [req.tenantId]);
  res.json({ channels: channels.rows });
}));

// POST /api/admin/pitches/channels — add a channel
router.post('/channels', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { platform, channel_id, writer_id, thread_id } = req.body;
  if (!platform || !channel_id) return res.status(400).json({ error: 'platform and channel_id required' });

  const row = await db.prepare(`
    INSERT INTO messaging_channels (tenant_id, platform, channel_id, writer_id, thread_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `).get(req.tenantId, platform, channel_id.trim(), writer_id ? parseInt(writer_id) : null, thread_id?.trim() || null);

  res.json({ channel: row });
}));

// DELETE /api/admin/pitches/channels/:id — remove a channel
router.delete('/channels/:id', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  await db.prepare(
    'DELETE FROM messaging_channels WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, req.tenantId);
  res.json({ status: 'ok' });
}));

// POST /api/admin/pitches/channels/:id/toggle — toggle active
router.post('/channels/:id/toggle', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const row = await db.prepare(
    'UPDATE messaging_channels SET is_active = NOT is_active WHERE id = $1 AND tenant_id = $2 RETURNING *'
  ).get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'Channel not found' });
  res.json({ channel: row });
}));

// GET /api/admin/pitches/telegram-chats — detect recent chats
// If webhook is active, temporarily removes it, fetches updates, then re-sets it.
router.get('/telegram-chats', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { getBotToken } = require('../lib/messaging/telegram');
  const token = await getBotToken(req.tenantId);
  if (!token) return res.status(400).json({ error: 'No Telegram bot token configured' });

  const api = `https://api.telegram.org/bot${token}`;

  // Get saved webhook URL from DB (most reliable) or from Telegram API
  const savedUrlRow = await db.prepare(
    "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'telegram_webhook_url'"
  ).get(req.tenantId);
  const infoRes = await fetch(`${api}/getWebhookInfo`, { signal: AbortSignal.timeout(10000) });
  const infoData = await infoRes.json();
  const hadWebhook = savedUrlRow?.value || infoData.result?.url || '';

  // Delete webhook to allow getUpdates (must confirm success)
  if (infoData.result?.url) {
    const delRes = await fetch(`${api}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
      signal: AbortSignal.timeout(10000),
    });
    const delData = await delRes.json();
    if (!delData.ok) {
      return res.status(502).json({ error: 'Failed to remove webhook: ' + (delData.description || 'unknown error') });
    }
    // Brief pause to let Telegram process the deletion
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    const response = await fetch(`${api}/getUpdates?limit=50&timeout=3`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const err = await response.text().catch(() => '');
      return res.status(502).json({ error: `Telegram API error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();
    const updates = data.result || [];

    // Extract unique chats and topics
    const seen = new Set();
    const chats = [];
    for (const update of updates) {
      const msg = update.message || update.edited_message;
      if (!msg?.chat) continue;
      const chatId = String(msg.chat.id);
      const threadId = msg.message_thread_id ? String(msg.message_thread_id) : null;
      const key = threadId ? `${chatId}:${threadId}` : chatId;
      if (seen.has(key)) continue;
      seen.add(key);

      const chatTitle = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || chatId;
      chats.push({
        chat_id: chatId,
        thread_id: threadId,
        title: threadId ? `${chatTitle} → Topic` : chatTitle,
        type: msg.chat.type,
        last_message: msg.text?.slice(0, 100) || '',
      });
    }

    res.json({ chats });
  } finally {
    // Re-set the webhook
    if (hadWebhook) {
      try {
        await fetch(`${api}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: hadWebhook }),
          signal: AbortSignal.timeout(10000),
        });
        console.log(`[telegram] Webhook restored: ${hadWebhook}`);
      } catch (err) {
        console.error('[telegram] Webhook restore failed:', err.message);
      }
    }
  }
}));

// POST /api/admin/pitches/telegram-webhook — set Telegram webhook
router.post('/telegram-webhook', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { setWebhook } = require('../lib/messaging/telegram');
  const webhookUrl = req.body?.webhook_url;
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'webhook_url is required and must use https://' });
  }

  // Save the webhook URL so it can be restored on server restart
  await getPool().query(
    `INSERT INTO settings (tenant_id, key, value, updated_at) VALUES ($1, 'telegram_webhook_url', $2, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [req.tenantId, webhookUrl]
  );
  const result = await setWebhook(req.tenantId, webhookUrl);
  res.json({ status: 'ok', webhook_url: webhookUrl, result });
}));

// GET /api/admin/pitches/slack-channels — detect Slack channels
router.get('/slack-channels', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { listChannels } = require('../lib/messaging/slack');
  const chats = await listChannels(req.tenantId);
  res.json({ chats });
}));

// POST /api/admin/pitches/discord-register-commands — register slash commands with Discord
router.post('/discord-register-commands', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { registerCommands } = require('../lib/messaging/discord');
  const result = await registerCommands(req.tenantId);
  res.json({ status: 'ok', commands: result.map(c => ({ id: c.id, name: c.name })) });
}));

// GET /api/admin/pitches/discord-channels — detect Discord channels
router.get('/discord-channels', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { listChannels } = require('../lib/messaging/discord');
  const chats = await listChannels(req.tenantId);
  res.json({ chats });
}));

// POST /api/admin/pitches/channels/enroll — bulk enroll channels with writers
router.post('/channels/enroll', auth, requirePermission('settings.update'), asyncHandler(async (req, res) => {
  const { enrollments } = req.body;
  if (!Array.isArray(enrollments) || !enrollments.length) {
    return res.status(400).json({ error: 'enrollments array required' });
  }

  const created = [];
  for (const e of enrollments) {
    if (!e.platform || !e.channel_id || !e.writer_id) continue;
    const row = await db.prepare(`
      INSERT INTO messaging_channels (tenant_id, platform, channel_id, thread_id, writer_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `).get(req.tenantId, e.platform, e.channel_id, e.thread_id || null, parseInt(e.writer_id));
    if (row) created.push(row);
  }

  res.json({ status: 'ok', enrolled: created.length });
}));

// PATCH /api/admin/pitches/:id/sources — add/replace source articles on a pending pitch
router.patch('/:id/sources', auth, requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const { source_article_ids } = req.body;
  if (!Array.isArray(source_article_ids)) return res.status(400).json({ error: 'source_article_ids must be an array' });

  const pitch = await db.prepare(
    'SELECT * FROM story_pitches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });
  if (pitch.status !== 'pending') return res.status(400).json({ error: 'Can only enrich pending pitches' });

  // Validate new IDs are integers
  const newIds = source_article_ids.map(Number).filter(n => Number.isFinite(n) && n > 0);

  // Merge with existing — don't replace
  const existing = Array.isArray(pitch.source_article_ids)
    ? pitch.source_article_ids
    : (typeof pitch.source_article_ids === 'string' ? JSON.parse(pitch.source_article_ids || '[]') : []);
  const merged = [...new Set([...existing.map(Number), ...newIds])].filter(n => Number.isFinite(n) && n > 0);

  await db.prepare(
    'UPDATE story_pitches SET source_article_ids = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(JSON.stringify(merged), pitch.id, req.tenantId);

  res.json({ status: 'ok', source_article_ids: merged });
}));

// GET /api/admin/pitches/articles-search — search curated articles to attach to a pitch
router.get('/articles-search', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  let rows;
  if (q) {
    rows = await db.prepare(`
      SELECT id, title, source, category, published_at, image_url
      FROM articles
      WHERE tenant_id = $1
        AND (content_type IS NULL OR content_type = 'curated')
        AND is_archived = 0
        AND (title ILIKE $2 OR source ILIKE $2)
      ORDER BY published_at DESC
      LIMIT $3
    `).all(req.tenantId, `%${q}%`, limit);
  } else {
    rows = await db.prepare(`
      SELECT id, title, source, category, published_at, image_url
      FROM articles
      WHERE tenant_id = $1
        AND (content_type IS NULL OR content_type = 'curated')
        AND is_archived = 0
      ORDER BY published_at DESC
      LIMIT $2
    `).all(req.tenantId, limit);
  }

  res.json({ articles: rows });
}));

module.exports = router;
