/**
 * Deep Feed AI — Breaking story dispatch (v1).
 *
 * v1 scope: write an audit log entry recording that a breaking alert was
 * dispatched or skipped, and return the subscriber count so the caller can
 * surface it in the notification. Actual email/web-push send-out is
 * deliberately deferred — this hook is the stable queue point we'll wire
 * those into in a follow-up.
 */
'use strict';

const db = require('../db');

async function countSubscribers(tenantId) {
  try {
    const row = await db.prepare(
      "SELECT COUNT(*)::int AS cnt FROM subscribers WHERE tenant_id = $1 AND (unsubscribed IS NULL OR unsubscribed = 0)"
    ).get(tenantId);
    return row?.cnt || 0;
  } catch {
    return 0;
  }
}

async function queueBreakingDispatch(articleId, tenantId, userId) {
  const subscriberCount = await countSubscribers(tenantId);
  const article = await db.prepare(
    'SELECT id, title, generated_title, slug FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);
  if (!article) throw new Error('article_not_found');

  try {
    await db.prepare(
      `INSERT INTO admin_audit_log (tenant_id, user_id, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, 'breaking_dispatched', 'articles', $3, $4, NOW())`
    ).run(tenantId, userId, articleId, JSON.stringify({
      subscriber_count: subscriberCount,
      title: article.generated_title || article.title,
      slug: article.slug,
    }));
  } catch (err) {
    // non-fatal — audit table may not exist in dev
    console.warn('[breaking-dispatch] audit insert failed:', err.message);
  }

  console.log(`[breaking-dispatch] QUEUED article=${articleId} tenant=${tenantId} subscribers=${subscriberCount} — email/push send deferred to follow-up`);
  return { article_id: articleId, subscriber_count: subscriberCount };
}

async function recordBreakingSkipped(articleId, tenantId, userId) {
  try {
    await db.prepare(
      `INSERT INTO admin_audit_log (tenant_id, user_id, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, 'breaking_skipped', 'articles', $3, $4, NOW())`
    ).run(tenantId, userId, articleId, JSON.stringify({}));
  } catch (err) {
    console.warn('[breaking-dispatch] audit insert failed:', err.message);
  }
  return { article_id: articleId };
}

module.exports = { queueBreakingDispatch, recordBreakingSkipped, countSubscribers };
