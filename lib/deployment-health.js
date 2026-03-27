/**
 * Deep Feed AI — lib/deployment-health.js
 * Reusable deployment health check for a single tenant.
 * Designed to be called per-tenant; a future platform-wide endpoint
 * can iterate getActiveTenantIds() and call this for each.
 */
'use strict';

const { getKey } = require('./crypto');
const { getAppConfig } = require('./app-config');
const tenantUtils = require('./tenant-utils');

/**
 * Run deployment health checks for a given tenant.
 * @param {number} tenantId
 * @returns {Promise<{deployment_mode: string, checks: Array, setup_complete: boolean}>}
 */
async function getDeploymentHealth(tenantId) {
  const checks = [];

  // 1. Database — if we got this far, it's connected
  checks.push({ key: 'database', label: 'Database', status: 'ok', detail: 'PostgreSQL connected' });

  // 2. Encryption
  const encKey = getKey();
  checks.push({
    key: 'encryption',
    label: 'Encryption',
    status: encKey ? 'ok' : 'error',
    detail: encKey ? 'AES-256-GCM active' : 'SETTINGS_ENCRYPTION_KEY not set — secrets stored as plaintext',
  });

  // 3. Storage
  try {
    const storage = require('./storage');
    const health = await storage.healthCheck();
    checks.push({
      key: 'storage',
      label: 'Storage',
      status: health.ok ? 'ok' : 'error',
      detail: health.ok ? `${storage.backendName} — ${health.message}` : health.message,
    });
  } catch (err) {
    checks.push({ key: 'storage', label: 'Storage', status: 'error', detail: err.message });
  }

  // 4. AI
  const cfg = await getAppConfig(tenantId);
  const hasGemini = !!cfg.gemini_api_key;
  const hasElevenLabs = !!cfg.elevenlabs_api_key;
  if (hasGemini) {
    checks.push({ key: 'ai', label: 'AI API', status: 'ok', detail: `Gemini${hasElevenLabs ? ' + ElevenLabs' : ''}` });
  } else {
    checks.push({ key: 'ai', label: 'AI API', status: 'warn', detail: 'No AI API key configured — summaries disabled' });
  }

  // 5. Email
  const hasResend = !!cfg.resend_api_key;
  checks.push({
    key: 'email',
    label: 'Email',
    status: hasResend ? 'ok' : 'none',
    detail: hasResend ? 'Resend configured' : 'No email provider — newsletters disabled',
  });

  // 6. OAuth
  let oauthConfig;
  try {
    const { getOAuthConfig } = require('./oauth-config');
    oauthConfig = await getOAuthConfig();
  } catch { oauthConfig = {}; }
  const hasGoogle = !!oauthConfig.googleClientId;
  const hasGithub = !!oauthConfig.githubClientId;
  if (hasGoogle || hasGithub) {
    const providers = [hasGoogle && 'Google', hasGithub && 'GitHub'].filter(Boolean).join(', ');
    const missing = [!hasGoogle && 'Google', !hasGithub && 'GitHub'].filter(Boolean);
    checks.push({
      key: 'oauth',
      label: 'OAuth',
      status: missing.length ? 'warn' : 'ok',
      detail: missing.length ? `${providers} configured; ${missing.join(', ')} not set` : `Google + GitHub configured`,
    });
  } else {
    checks.push({ key: 'oauth', label: 'OAuth', status: 'none', detail: 'No OAuth providers configured' });
  }

  // 7. Live news
  const hasNews = !!cfg.news_api_key;
  const hasBrave = !!cfg.brave_api_key;
  if (hasNews || hasBrave) {
    const providers = [hasNews && 'NewsAPI', hasBrave && 'Brave'].filter(Boolean).join(' + ');
    checks.push({ key: 'news', label: 'Live News', status: 'ok', detail: providers });
  } else {
    checks.push({ key: 'news', label: 'Live News', status: 'none', detail: 'No news API keys configured' });
  }

  // 8. Payments (skip in single-tenant if not configured — it's rarely needed)
  let hasStripe = false;
  try {
    const { getStripeConfig } = require('./stripe-config');
    const stripe = await getStripeConfig();
    hasStripe = !!stripe.secretKey;
  } catch { /* not configured */ }
  checks.push({
    key: 'payments',
    label: 'Payments',
    status: hasStripe ? 'ok' : 'none',
    detail: hasStripe ? 'Stripe configured' : 'Stripe not configured',
  });

  // 9. Cron jobs — count enabled
  try {
    const db = require('../db');
    const rows = await db.prepare(
      "SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE 'cron_%_enabled'"
    ).all(tenantId);
    const enabled = rows.filter(r => r.value === 'true' || r.value === '1').length;
    const total = rows.length;
    checks.push({
      key: 'cron',
      label: 'Cron Jobs',
      status: enabled > 0 ? 'ok' : 'warn',
      detail: total > 0 ? `${enabled}/${total} enabled` : 'No cron settings found (defaults active)',
    });
  } catch {
    checks.push({ key: 'cron', label: 'Cron Jobs', status: 'warn', detail: 'Could not read cron settings' });
  }

  // Determine overall setup_complete: encryption + AI are the minimum bar
  const setupComplete = !!encKey && hasGemini;

  return {
    deployment_mode: tenantUtils.MULTI_TENANT ? 'multi' : 'single',
    checks,
    setup_complete: setupComplete,
  };
}

module.exports = { getDeploymentHealth };
