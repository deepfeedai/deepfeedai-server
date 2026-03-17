/**
 * Deep Feed AI — routes/notifications.js
 * In-app notification center for signed-in public users.
 *
 * Notifications are currently created only for reply events
 * (when someone replies to a user's comment). Creation is handled
 * inside routes/comments.js when a comment with parentId is posted.
 *
 * GET /api/notifications?limit=20   — fetch recent notifications + unread count
 * PUT /api/notifications/read       — mark all notifications as read
 * PUT /api/notifications/:id/read   — mark a single notification as read
 */

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const router = express.Router();

const { getSecrets } = require('../lib/secrets');

/* ── Auth helper ─────────────────────────────────────────────────── */

async function getUserId(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const { userJwtSecret } = await getSecrets();
    const payload = jwt.verify(auth.slice(7), userJwtSecret);
    return payload.sub;
  } catch {
    return null;
  }
}

/* ── GET /api/notifications ──────────────────────────────────────── */
// Returns the most recent notifications for the signed-in user,
// along with an unread count (notifications where read_at IS NULL).
router.get('/', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

  try {
    const notifications = await db.prepare(`
      SELECT id, type, payload, read_at, created_at
      FROM notifications
      WHERE user_id = $1 AND tenant_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `).all(userId, req.tenantId, limit);

    const unreadRow = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM notifications
      WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL
    `).get(userId, req.tenantId);

    res.json({
      notifications: notifications.map(n => ({
        id:        n.id,
        type:      n.type,
        payload:   typeof n.payload === 'string' ? JSON.parse(n.payload) : n.payload,
        read:      n.read_at != null,
        createdAt: n.created_at,
      })),
      unreadCount: parseInt(unreadRow?.cnt ?? 0, 10),
    });
  } catch (err) {
    console.error('[notifications/list]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── PUT /api/notifications/read ─────────────────────────────────── */
// Mark ALL unread notifications for the current user as read.
router.put('/read', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await db.prepare(`
      UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL
    `).run(userId, req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/read-all]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── PUT /api/notifications/:id/read ─────────────────────────────── */
// Mark a single notification as read. Only marks if owned by current user.
router.put('/:id/read', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  try {
    await db.prepare(`
      UPDATE notifications SET read_at = NOW()
      WHERE id = $1 AND user_id = $2 AND tenant_id = $3 AND read_at IS NULL
    `).run(id, userId, req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/read-one]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * createReplyNotification(parentCommentUserId, payload)
 * Called from routes/comments.js when a reply is posted.
 * payload: { commentId, articleSlug, articleTitle, replyBody, replyerName }
 */
async function createReplyNotification(userId, payload, tenantId) {
  try {
    await db.prepare(`
      INSERT INTO notifications (user_id, type, payload, tenant_id) VALUES ($1, 'reply', $2, $3)
    `).run(userId, JSON.stringify(payload), tenantId);
  } catch (err) {
    // Non-fatal — notifications are best-effort
    console.warn('[notifications/create]', err.message);
  }
}

/**
 * createNewArticleNotification(writerId, articleSlug, articleTitle)
 * Called after a writer publishes a new original article.
 * Notifies all users who follow this writer.
 */
async function createNewArticleNotification(writerId, articleSlug, articleTitle, tenantId) {
  try {
    const followers = await db.prepare(
      'SELECT user_id FROM writer_follows WHERE writer_id = $1 AND tenant_id = $2'
    ).all(writerId, tenantId);

    if (!followers.length) return;

    const writer = await db.prepare(
      'SELECT name, slug, avatar_url FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(writerId, tenantId);

    const payload = JSON.stringify({
      articleSlug,
      articleTitle,
      writerName: writer?.name || 'A writer you follow',
      writerSlug: writer?.slug || null,
      writerAvatarUrl: writer?.avatar_url || null,
    });

    for (const { user_id } of followers) {
      await db.prepare(
        `INSERT INTO notifications (user_id, type, payload, tenant_id) VALUES ($1, 'new_article', $2, $3)`
      ).run(user_id, payload, tenantId);
    }
  } catch (err) {
    console.warn('[notifications/new-article]', err.message);
  }
}

module.exports = { router, createReplyNotification, createNewArticleNotification };
