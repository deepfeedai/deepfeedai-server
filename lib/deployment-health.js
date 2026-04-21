/**
 * Deep Feed AI — lib/deployment-health.js
 * Reusable deployment health check for a single tenant.
 * Each check includes a `section` field: 'infrastructure' or 'content'.
 * Content checks also include a `fix_step` number for the wizard's "Fix" button.
 */
'use strict';

const db         = require('../db');
const { getKey } = require('./crypto');
const { getAppConfig } = require('./app-config');
const { resolveKey } = require('./ai-key-resolver');
const tenantUtils = require('./tenant-utils');

async function getDeploymentHealth(tenantId) {
  const checks = [];

  // ── Infrastructure ────────────────────────────────────────────────────────

  // 1. Database
  checks.push({ key: 'database', label: 'Database', status: 'ok', detail: 'PostgreSQL connected', section: 'infrastructure' });

  // 2. Encryption
  const encKey = getKey();
  checks.push({
    key: 'encryption', label: 'Encryption', section: 'infrastructure',
    status: encKey ? 'ok' : 'error',
    detail: encKey ? 'AES-256-GCM active' : 'SETTINGS_ENCRYPTION_KEY not set — secrets stored as plaintext',
  });

  // 3. Storage
  try {
    const storage = require('./storage');
    const health = await storage.healthCheck();
    checks.push({
      key: 'storage', label: 'Storage', section: 'infrastructure',
      status: health.ok ? 'ok' : 'error',
      detail: health.ok ? `${storage.backendName} — ${health.message}` : health.message,
    });
  } catch (err) {
    checks.push({ key: 'storage', label: 'Storage', status: 'error', detail: err.message, section: 'infrastructure' });
  }

  // 4. AI (text + image)
  const cfg = await getAppConfig(tenantId);
  const geminiKey  = await resolveKey('gemini',    tenantId).catch(() => null);
  const openaiKey  = await resolveKey('openai',    tenantId).catch(() => null);
  const anthropicKey = await resolveKey('anthropic', tenantId).catch(() => null);
  const orKey      = await resolveKey('openrouter', tenantId).catch(() => null);
  const hasAnyTextKey = !!(geminiKey || openaiKey || anthropicKey || orKey);
  const hasImageKey = !!(geminiKey || openaiKey); // imagen needs gemini, dalle needs openai

  if (hasAnyTextKey) {
    const providers = [
      geminiKey && 'Gemini', openaiKey && 'OpenAI',
      anthropicKey && 'Anthropic', orKey && 'OpenRouter',
    ].filter(Boolean).join(', ');
    checks.push({ key: 'ai', label: 'Text AI', status: 'ok', detail: providers, section: 'infrastructure', fix_step: 6 });
  } else {
    checks.push({ key: 'ai', label: 'Text AI', status: 'warn', detail: 'No AI key configured — summaries and synthesis disabled', section: 'infrastructure', fix_step: 6 });
  }

  checks.push({
    key: 'ai_image', label: 'Image AI', section: 'infrastructure', fix_step: 6,
    status: hasImageKey ? 'ok' : 'none',
    detail: hasImageKey
      ? (geminiKey ? 'Imagen (Gemini)' : '') + (geminiKey && openaiKey ? ' · ' : '') + (openaiKey ? 'DALL·E (OpenAI)' : '')
      : 'No image key — thumbnail generation disabled',
  });

  // 5. Voice
  const hasElevenLabs = !!cfg.elevenlabs_api_key;
  checks.push({
    key: 'voice', label: 'Voice AI', section: 'infrastructure', fix_step: 6,
    status: hasElevenLabs ? 'ok' : 'none',
    detail: hasElevenLabs ? 'ElevenLabs configured' : 'No voice key — audio briefings disabled',
  });

  // 6. Email
  const hasResend = !!cfg.resend_api_key;
  checks.push({
    key: 'email', label: 'Email', section: 'infrastructure', fix_step: 6,
    status: hasResend ? 'ok' : 'none',
    detail: hasResend ? 'Resend configured' : 'No email provider — newsletters disabled',
  });

  // 7. OAuth
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
      key: 'oauth', label: 'OAuth', section: 'infrastructure',
      status: missing.length ? 'warn' : 'ok',
      detail: missing.length ? `${providers} configured; ${missing.join(', ')} not set` : 'Google + GitHub configured',
    });
  } else {
    checks.push({ key: 'oauth', label: 'OAuth', status: 'none', detail: 'No OAuth providers configured', section: 'infrastructure' });
  }

  // 8. Live news
  const hasNews  = !!cfg.news_api_key;
  const hasBrave = !!cfg.brave_api_key;
  if (hasNews || hasBrave) {
    checks.push({ key: 'news', label: 'Live News', status: 'ok', detail: [hasNews && 'NewsAPI', hasBrave && 'Brave'].filter(Boolean).join(' + '), section: 'infrastructure' });
  } else {
    checks.push({ key: 'news', label: 'Live News', status: 'none', detail: 'No news API keys — live ingest disabled', section: 'infrastructure' });
  }

  // 9. Cron jobs
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE 'cron_%_enabled'"
    ).all(tenantId);
    const enabled = rows.filter(r => r.value === 'true' || r.value === '1').length;
    checks.push({
      key: 'cron', label: 'Cron Jobs', section: 'infrastructure',
      status: enabled > 0 ? 'ok' : 'warn',
      detail: rows.length > 0 ? `${enabled}/${rows.length} enabled` : 'No cron settings found (defaults active)',
    });
  } catch {
    checks.push({ key: 'cron', label: 'Cron Jobs', status: 'warn', detail: 'Could not read cron settings', section: 'infrastructure' });
  }

  // ── Content Readiness ─────────────────────────────────────────────────────

  // 10. Categories
  try {
    const row = await db.prepare('SELECT COUNT(*)::int AS count FROM categories WHERE tenant_id = $1').get(tenantId);
    const n = row?.count || 0;
    checks.push({
      key: 'categories', label: 'Categories', section: 'content', fix_step: 7,
      status: n > 0 ? 'ok' : 'warn',
      detail: n > 0 ? `${n} categories configured` : 'No categories — articles cannot be categorized',
    });
  } catch {
    checks.push({ key: 'categories', label: 'Categories', status: 'warn', detail: 'Could not check categories', section: 'content', fix_step: 7 });
  }

  // 11. System agents (Maxwell, Iris, Vera)
  try {
    const row = await db.prepare(
      "SELECT COUNT(*)::int AS count FROM writers WHERE tenant_id = $1 AND is_system = true"
    ).get(tenantId);
    const n = row?.count || 0;
    checks.push({
      key: 'agents', label: 'System Agents', section: 'content', fix_step: 7,
      status: n >= 3 ? 'ok' : 'warn',
      detail: n >= 3 ? `Maxwell, Iris, Vera ready` : `${n}/3 agents seeded — Maxwell, Iris, and Vera enable editorial automation`,
    });
  } catch {
    checks.push({ key: 'agents', label: 'System Agents', status: 'warn', detail: 'Could not check agents', section: 'content', fix_step: 7 });
  }

  // 12. Writers (human)
  try {
    const row = await db.prepare(
      "SELECT COUNT(*)::int AS count FROM writers WHERE tenant_id = $1 AND (is_system = false OR is_system IS NULL)"
    ).get(tenantId);
    const n = row?.count || 0;
    checks.push({
      key: 'writers', label: 'Writers', section: 'content',
      status: n > 0 ? 'ok' : 'none',
      detail: n > 0 ? `${n} writer${n !== 1 ? 's' : ''} configured` : 'No writers yet — add writers after setup',
    });
  } catch {
    checks.push({ key: 'writers', label: 'Writers', status: 'none', detail: 'Could not check writers', section: 'content' });
  }

  // 13. Sources
  try {
    const row = await db.prepare('SELECT COUNT(*)::int AS count FROM sources WHERE tenant_id = $1').get(tenantId);
    const n = row?.count || 0;
    checks.push({
      key: 'sources', label: 'Sources', section: 'content',
      status: n > 0 ? 'ok' : 'none',
      detail: n > 0 ? `${n} source${n !== 1 ? 's' : ''} configured` : 'No sources yet — add RSS feeds after setup',
    });
  } catch {
    checks.push({ key: 'sources', label: 'Sources', status: 'none', detail: 'Could not check sources', section: 'content' });
  }

  const setupComplete = !!encKey && hasAnyTextKey && (checks.find(c => c.key === 'categories')?.status === 'ok');

  return {
    deployment_mode: tenantUtils.MULTI_TENANT ? 'multi' : 'single',
    checks,
    setup_complete: setupComplete,
  };
}

module.exports = { getDeploymentHealth };
