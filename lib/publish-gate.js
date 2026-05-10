'use strict';
const db = require('../db');
const { getAppConfig } = require('./app-config');
const { nextDropWindow } = require('./news-budget');

/**
 * Evaluate whether an article should publish immediately, be scheduled for a
 * drop window, or be blocked by the daily cap.
 *
 * Returns one of:
 *   { action: 'publish' }
 *   { action: 'schedule',   at: Date,       appCfg }
 *   { action: 'cap_reached', scheduleAt: Date, count, cap, appCfg }
 *
 * @param {number} tenantId
 * @param {{ force?: boolean, appCfg?: object }} opts
 *   force  — admin override: bypasses the daily cap check.
 *            Does NOT bypass publish_mode — use a direct publish query for that.
 *   appCfg — pre-loaded config to avoid a duplicate fetch.
 */
async function evaluatePublish(tenantId, opts = {}) {
  const { force = false, appCfg: preloaded } = opts;
  const appCfg = preloaded || await getAppConfig(tenantId).catch(() => ({}));
  const tz = appCfg.newsroom_timezone || 'UTC';

  if (!force) {
    // Default to 6 when unconfigured; set to '0' explicitly to disable the cap.
    const cap   = appCfg.daily_publish_cap != null ? (parseInt(appCfg.daily_publish_cap,   10) || 0) : 6;
    const burst = parseInt(appCfg.daily_publish_burst, 10) || 0;
    const effectiveCap = cap > 0 ? cap + burst : 0;

    if (effectiveCap > 0) {
      const row = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM articles
         WHERE tenant_id = $1 AND is_published = 1
           AND published_at >= CURRENT_DATE
           AND published_at < CURRENT_DATE + INTERVAL '1 day'`
      ).get(tenantId);
      const todayCount = parseInt(row?.cnt ?? 0, 10);
      if (todayCount >= effectiveCap) {
        const scheduleAt = nextDropWindow(tz, appCfg.drop_windows);
        return { action: 'cap_reached', scheduleAt, count: todayCount, cap: effectiveCap, appCfg };
      }
    }
  }

  if (appCfg.publish_mode === 'scheduled') {
    const at = nextDropWindow(tz, appCfg.drop_windows);
    return { action: 'schedule', at, appCfg };
  }

  return { action: 'publish', appCfg };
}

/**
 * Return today's published-article count for a tenant.
 * Used by the article-publisher cron for cap enforcement.
 */
async function getTodayPublishCount(tenantId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM articles
     WHERE tenant_id = $1 AND is_published = 1
       AND published_at >= CURRENT_DATE
       AND published_at < CURRENT_DATE + INTERVAL '1 day'`
  ).get(tenantId);
  return parseInt(row?.cnt ?? 0, 10);
}

module.exports = { evaluatePublish, getTodayPublishCount };
