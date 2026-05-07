/**
 * Deep Feed AI — lib/notify.js
 * Transactional email notifications via Resend REST API.
 *
 * Uses Node's built-in https — no extra npm package required.
 *
 * Required env var:
 *   RESEND_API_KEY  — get one free at resend.com (3,000 emails/month)
 *
 * Optional env var:
 *   NOTIFY_FROM     — sender address (default: notifications@deepfeedai.com)
 *                     Must be from a domain verified in Resend.
 */

'use strict';

const https = require('https');
const { getSiteConfig } = require('./site-config');
const { logUsage } = require('./ai-usage');
const { getAppConfig } = require('./app-config');

const RESEND_API = 'api.resend.com';

/**
 * Low-level: POST to Resend API.
 */
function resendSend(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const options = {
      hostname: RESEND_API,
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(data.message || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a reply notification email.
 *
 * @param {object} opts
 *   opts.toEmail       — recipient email
 *   opts.toName        — recipient display name
 *   opts.replierName   — name of the person who replied
 *   opts.articleSlug   — article slug
 *   opts.articleTitle  — article title (for subject line)
 *   opts.replyBody     — excerpt of the reply (max 300 chars)
 *   opts.commentId     — original comment id (for deep link)
 *   opts.unsubToken    — unsubscribe token for opt-out link
 */
async function sendReplyNotification(opts, tenantId) {
  const appCfg = await getAppConfig(tenantId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping reply notification');
    return;
  }

  const site = await getSiteConfig(tenantId);
  const siteName    = site.name || 'Deep Feed AI';
  const siteUrl     = (site.url || appCfg.main_site_url || 'https://deepfeedai.com').replace(/\/$/, '');
  const logoEmoji   = site.logo_emoji || '🤖';
  const logoHtml    = site.logo_html || `${logoEmoji}&nbsp;${siteName}`;
  const fromName    = site.email_from_name || siteName;
  const fromAddr    = process.env.NOTIFY_FROM || `${fromName} <notifications@${site.domain || 'deepfeedai.com'}>`;

  const articleUrl   = `${siteUrl}/article/${opts.articleSlug}#comment-${opts.commentId}`;
  const unsubUrl     = `${siteUrl}/api/notify/unsubscribe?token=${opts.unsubToken}`;
  const replyExcerpt = (opts.replyBody || '').slice(0, 300);
  const safeTitle    = (opts.articleTitle || 'an article').slice(0, 80);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="padding:0 0 24px 0;">
          <a href="${siteUrl}" style="text-decoration:none;color:#00d9ff;font-size:18px;font-weight:700;">
            ${logoHtml}
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            💬 New Reply
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            ${escHtml(opts.replierName)} replied to your comment
          </h1>

          <!-- Reply excerpt -->
          <div style="background:#0f1117;border-left:3px solid #00d9ff;border-radius:4px;padding:14px 16px;margin:0 0 24px;">
            <p style="margin:0;font-size:14px;color:#cbd5e1;line-height:1.6;">
              ${escHtml(replyExcerpt)}${replyExcerpt.length < (opts.replyBody || '').length ? '…' : ''}
            </p>
          </div>

          <p style="margin:0 0 20px;font-size:13px;color:#94a3b8;">
            On: <strong style="color:#f0f0f0;">${escHtml(safeTitle)}</strong>
          </p>

          <a href="${articleUrl}"
             style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;
                    text-decoration:none;padding:12px 24px;border-radius:8px;">
            View Reply →
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          You're receiving this because you commented on ${escHtml(siteName)}.<br>
          <a href="${unsubUrl}" style="color:#475569;text-decoration:underline;">Unsubscribe from reply notifications</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `${opts.replierName} replied to your comment on ${siteName}.\n\n"${replyExcerpt}"\n\nView the reply: ${articleUrl}\n\nUnsubscribe: ${unsubUrl}`;

  const _start = Date.now();
  try {
    await resendSend({
      from:    fromAddr,
      to:      [`${opts.toName} <${opts.toEmail}>`],
      subject: `💬 ${opts.replierName} replied to your comment`,
      html,
      text,
    }, apiKey);
    logUsage({ provider: 'resend', operation: 'email', articleSlug: opts.articleSlug, trigger: 'auto-assign', emailCount: 1, durationMs: Date.now() - _start, tenantId }).catch(() => {});
  } catch (err) {
    logUsage({ provider: 'resend', operation: 'email', articleSlug: opts.articleSlug, trigger: 'auto-assign', emailCount: 1, durationMs: Date.now() - _start, success: false, error: err.message, tenantId }).catch(() => {});
    throw err;
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Send a budget alert email to the admin.
 * @param {{ level: string, pctUsed: number, monthlySpend: number, monthlyBudget: number }} alert
 */
async function sendBudgetAlert(alert, tenantId) {
  const appCfg = await getAppConfig(tenantId);
  const apiKey = appCfg.resend_api_key;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) {
    console.warn('[Notify] RESEND_API_KEY or ADMIN_EMAIL not set — skipping budget alert');
    return;
  }

  const site = await getSiteConfig(tenantId);
  const siteName = site.name || 'Deep Feed AI';
  const fromName = site.email_from_name || siteName;
  const fromAddr = process.env.NOTIFY_FROM || `${fromName} <notifications@${site.domain || 'deepfeedai.com'}>`;

  const levelEmoji = alert.level === 'critical' ? '🔴' : '🟡';
  const levelLabel = alert.level === 'critical' ? 'CRITICAL' : 'WARNING';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">${escHtml(siteName)} Admin</span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            ${levelEmoji} AI Budget ${levelLabel}
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            Monthly AI spend at ${alert.pctUsed}%
          </h1>
          <div style="background:#0f1117;border-radius:4px;padding:14px 16px;margin:0 0 24px;">
            <p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;">
              <strong>Spent:</strong> $${alert.monthlySpend.toFixed(2)} / $${alert.monthlyBudget.toFixed(2)}
            </p>
            <div style="background:#1e293b;border-radius:4px;height:8px;overflow:hidden;">
              <div style="background:${alert.level === 'critical' ? '#ef4444' : '#f59e0b'};height:100%;width:${Math.min(alert.pctUsed, 100)}%;border-radius:4px;"></div>
            </div>
          </div>
          <p style="margin:0;font-size:13px;color:#94a3b8;">
            Adjust your budget in the admin panel under Settings, or update the <code>ai_monthly_budget</code> setting.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          Automated alert from ${escHtml(siteName)} Admin
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `[${levelLabel}] AI Budget at ${alert.pctUsed}% — $${alert.monthlySpend.toFixed(2)} / $${alert.monthlyBudget.toFixed(2)}. Adjust in admin Settings.`;

  const _start = Date.now();
  try {
    await resendSend({
      from: fromAddr,
      to: [adminEmail],
      subject: `${levelEmoji} AI Budget ${levelLabel}: ${alert.pctUsed}% used`,
      html,
      text,
    }, apiKey);
    logUsage({ provider: 'resend', operation: 'email', trigger: 'cron', emailCount: 1, durationMs: Date.now() - _start, tenantId }).catch(() => {});
  } catch (err) {
    logUsage({ provider: 'resend', operation: 'email', trigger: 'cron', emailCount: 1, durationMs: Date.now() - _start, success: false, error: err.message, tenantId }).catch(() => {});
    console.error('[Notify] Budget alert error:', err.message);
  }
}

/**
 * Send a synthesis forecast notification email to the admin.
 * @param {Array} forecasts — array of forecast objects with writerName, summary, clusters
 */
async function sendForecastNotification(forecasts, tenantId) {
  const appCfg = await getAppConfig(tenantId);
  const apiKey = appCfg.resend_api_key;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) {
    console.warn('[Notify] RESEND_API_KEY or ADMIN_EMAIL not set — skipping forecast notification');
    return;
  }

  const site = await getSiteConfig(tenantId);
  const siteName = site.name || 'Deep Feed AI';
  const fromName = site.email_from_name || siteName;
  const fromAddr = process.env.NOTIFY_FROM || `${fromName} <notifications@${site.domain || 'deepfeedai.com'}>`;
  const adminUrl = (appCfg.admin_url || process.env.ADMIN_URL || 'https://portal.deepfeedai.com').replace(/\/$/, '');

  const totalClusters = forecasts.reduce((acc, f) => acc + (f.summary?.totalClusters || 0), 0);
  const totalWouldGenerate = forecasts.reduce((acc, f) => acc + (f.summary?.wouldGenerate || 0), 0);

  const writerRows = forecasts.map(f => {
    const s = f.summary || {};
    const clusters = typeof f.clusters === 'string' ? JSON.parse(f.clusters) : (f.clusters || []);
    const topTopics = clusters.slice(0, 3).map(c => c.topic).join(', ');
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#f0f0f0;">${escHtml(f.writerName)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#cbd5e1;">${s.totalClusters || 0}</td>
        <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#22c55e;font-weight:600;">${s.wouldGenerate || 0}</td>
        <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#94a3b8;font-size:12px;">${escHtml(topTopics)}</td>
      </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">${escHtml(siteName)} Admin</span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            Synthesis Forecast
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            ${totalWouldGenerate} article${totalWouldGenerate !== 1 ? 's' : ''} ready to generate from ${totalClusters} cluster${totalClusters !== 1 ? 's' : ''}
          </h1>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;">Writer</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;">Clusters</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;">Generate</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;">Top Topics</th>
            </tr>
            ${writerRows}
          </table>
          <a href="${adminUrl}/pipeline.html"
             style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;
                    text-decoration:none;padding:12px 24px;border-radius:8px;">
            Review in Pipeline →
          </a>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          Automated forecast from ${escHtml(siteName)} Admin
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Synthesis Forecast: ${totalWouldGenerate} articles ready from ${totalClusters} clusters.\n\n${forecasts.map(f => `${f.writerName}: ${f.summary?.wouldGenerate || 0} to generate`).join('\n')}\n\nReview: ${adminUrl}/pipeline.html`;

  const _start = Date.now();
  try {
    await resendSend({
      from: fromAddr,
      to: [adminEmail],
      subject: `Synthesis Forecast: ${totalWouldGenerate} article${totalWouldGenerate !== 1 ? 's' : ''} ready to generate`,
      html,
      text,
    }, apiKey);
    logUsage({ provider: 'resend', operation: 'email', trigger: 'cron', emailCount: 1, durationMs: Date.now() - _start, tenantId }).catch(() => {});
  } catch (err) {
    logUsage({ provider: 'resend', operation: 'email', trigger: 'cron', emailCount: 1, durationMs: Date.now() - _start, success: false, error: err.message, tenantId }).catch(() => {});
    console.error('[Notify] Forecast notification error:', err.message);
  }
}

/**
 * Send a 6-digit email verification code for local registration.
 * Uses the platform tenant's Resend API key (signup happens before any tenant exists).
 */
async function sendVerificationEmail(opts) {
  const { getPlatformTenantId } = require('./platform-tenant');
  const platformId = await getPlatformTenantId();
  const appCfg = await getAppConfig(platformId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping verification email');
    return;
  }

  const fromAddr = process.env.NOTIFY_FROM || 'DeepFeedAI <notifications@deepfeedai.com>';
  const { toEmail, toName, code } = opts;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">&#129302;&nbsp;Deep Feed<span style="color:#00d9ff;">AI</span></span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            Email Verification
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            Verify your email address
          </h1>
          <p style="margin:0 0 20px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            Enter this code to complete your registration:
          </p>
          <div style="background:#0f1117;border-radius:8px;padding:20px;text-align:center;margin:0 0 20px;">
            <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#00d9ff;font-family:monospace;">
              ${code}
            </span>
          </div>
          <p style="margin:0;font-size:13px;color:#94a3b8;">
            This code expires in 15 minutes. If you didn't create an account, you can ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          DeepFeedAI — AI-powered news sites
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Your DeepFeedAI verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't create an account, you can ignore this email.`;

  try {
    await resendSend({
      from: fromAddr,
      to: [toName ? `${toName} <${toEmail}>` : toEmail],
      subject: 'Verify your email address',
      html,
      text,
    }, apiKey);
  } catch (err) {
    console.error('[Notify] Verification email error:', err.message);
    throw err;
  }
}

/**
 * Send a password reset link for local (email/password) users.
 */
async function sendPasswordResetEmail(opts) {
  const { getPlatformTenantId } = require('./platform-tenant');
  const platformId = await getPlatformTenantId();
  const appCfg = await getAppConfig(platformId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping password reset email');
    return;
  }

  const fromAddr = process.env.NOTIFY_FROM || 'DeepFeedAI <notifications@deepfeedai.com>';
  const { toEmail, toName, resetUrl } = opts;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">&#129302;&nbsp;Deep Feed<span style="color:#00d9ff;">AI</span></span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            Password Reset
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            Reset your password
          </h1>
          <p style="margin:0 0 20px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            Click the button below to set a new password. This link expires in 30 minutes.
          </p>
          <div style="text-align:center;margin:0 0 20px;">
            <a href="${escHtml(resetUrl)}" style="display:inline-block;background:#00d9ff;color:#000;font-weight:700;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none;">
              Reset Password
            </a>
          </div>
          <p style="margin:0;font-size:13px;color:#94a3b8;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          DeepFeedAI — AI-powered news sites
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Reset your DeepFeedAI password:\n\n${resetUrl}\n\nThis link expires in 30 minutes.\n\nIf you didn't request this, you can safely ignore this email.`;

  try {
    await resendSend({
      from: fromAddr,
      to: [toName ? `${toName} <${toEmail}>` : toEmail],
      subject: 'Reset your password',
      html,
      text,
    }, apiKey);
  } catch (err) {
    console.error('[Notify] Password reset email error:', err.message);
    throw err;
  }
}

/**
 * Send a tenant invitation email to a newly assigned owner.
 */
async function sendTenantInviteEmail(opts) {
  const { getPlatformTenantId } = require('./platform-tenant');
  const platformId = await getPlatformTenantId();
  const appCfg = await getAppConfig(platformId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping tenant invite email');
    return;
  }

  const fromAddr = process.env.NOTIFY_FROM || 'DeepFeedAI <notifications@deepfeedai.com>';
  const { toEmail, toName, tenantName, portalUrl } = opts;
  const loginUrl = `${portalUrl || 'https://portal.deepfeedai.com'}/login.html`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">&#129302;&nbsp;Deep Feed<span style="color:#00d9ff;">AI</span></span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">You've been invited</p>
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#f0f0f0;">
            Manage <span style="color:#00d9ff;">${tenantName}</span> on DeepFeedAI
          </h1>
          <p style="margin:0 0 24px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            You've been assigned as the owner of <strong>${tenantName}</strong>. Sign in to your DeepFeedAI portal to set up your newsroom — add AI keys, configure sources, and launch your site.
          </p>
          <a href="${loginUrl}" style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
            Sign in to your portal →
          </a>
          <p style="margin:24px 0 0;font-size:12px;color:#475569;line-height:1.6;">
            You can sign in with Google, GitHub, or your email address. If you didn't expect this invitation, you can ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          DeepFeedAI — AI-powered news sites
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `You've been invited to manage ${tenantName} on DeepFeedAI.\n\nSign in at ${loginUrl} to set up your newsroom.\n\nIf you didn't expect this, you can ignore this email.`;

  try {
    await resendSend({
      from: fromAddr,
      to: [toName ? `${toName} <${toEmail}>` : toEmail],
      subject: `You've been invited to manage ${tenantName} on DeepFeedAI`,
      html,
      text,
    }, apiKey);
  } catch (err) {
    console.error('[Notify] Tenant invite email error:', err.message);
    throw err;
  }
}

/**
 * Notify a waitlist member that signups are now open.
 */
async function sendWaitlistOpenEmail(opts) {
  const { getPlatformTenantId } = require('./platform-tenant');
  const platformId = await getPlatformTenantId();
  const appCfg = await getAppConfig(platformId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping waitlist email');
    return;
  }

  const fromAddr = process.env.NOTIFY_FROM || 'DeepFeedAI <notifications@deepfeedai.com>';
  const { toEmail, toName } = opts;
  const signupUrl = `${process.env.BASE_URL || 'https://portal.deepfeedai.com'}/signup.html`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">&#129302;&nbsp;Deep Feed<span style="color:#00d9ff;">AI</span></span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">You're in</p>
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#f0f0f0;">
            DeepFeedAI signups are <span style="color:#00d9ff;">now open</span>
          </h1>
          <p style="margin:0 0 24px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            You joined the waitlist${toName ? `, ${toName},` : ''} and now it's your turn. Create your AI-powered news site in minutes — add sources, configure your AI writer team, and start publishing automatically.
          </p>
          <a href="${signupUrl}" style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
            Create your site now →
          </a>
          <p style="margin:24px 0 0;font-size:12px;color:#475569;line-height:1.6;">
            This invite is for ${toEmail}. If you no longer want these emails, you can ignore this message.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          DeepFeedAI — AI-powered news sites
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `DeepFeedAI signups are now open!\n\nCreate your AI-powered news site at ${signupUrl}\n\nThis invite is for ${toEmail}.`;

  try {
    await resendSend({
      from: fromAddr,
      to: [toName ? `${toName} <${toEmail}>` : toEmail],
      subject: "DeepFeedAI signups are now open — you're in!",
      html,
      text,
    }, apiKey);
  } catch (err) {
    console.error('[Notify] Waitlist open email error:', err.message);
    throw err;
  }
}

/**
 * Add a contact to a Resend Audience.
 */
function resendAddContact({ email, firstName, lastName, audienceId, apiKey }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, first_name: firstName || '', last_name: lastName || '', unsubscribed: false });
    const options = {
      hostname: RESEND_API,
      path: `/audiences/${audienceId}/contacts`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(data.message || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a confirmation email when someone joins the waitlist,
 * and add them as a contact in the Resend Audience.
 */
async function sendWaitlistJoinedEmail(opts) {
  const { getPlatformTenantId } = require('./platform-tenant');
  const platformId = await getPlatformTenantId();
  const appCfg = await getAppConfig(platformId);
  const apiKey = appCfg.resend_api_key;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping waitlist confirmation');
    return;
  }

  const fromAddr = process.env.NOTIFY_FROM || 'DeepFeedAI <notifications@deepfeedai.com>';
  const { toEmail, toName } = opts;
  const siteUrl = 'https://deepfeedai.com';

  // Add to Resend Audience (non-fatal if it fails)
  const audienceId = appCfg.resend_audience_id;
  if (audienceId) {
    const nameParts = (toName || '').trim().split(' ');
    try {
      await resendAddContact({
        email: toEmail,
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        audienceId,
        apiKey,
      });
    } catch (err) {
      console.warn('[Notify] Resend audience add failed:', err.message);
    }
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 0 24px 0;">
          <span style="color:#00d9ff;font-size:18px;font-weight:700;">&#129302;&nbsp;Deep Feed<span style="color:#00d9ff;">AI</span></span>
        </td></tr>
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">You're on the list</p>
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#f0f0f0;">
            ${toName ? `Thanks, ${toName.split(' ')[0]}!` : 'Thanks for joining!'} We'll save your spot.
          </h1>
          <p style="margin:0 0 24px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            DeepFeedAI is in private beta right now. When we open up, you'll be the first to know — we'll send you a direct invite to create your AI-powered news site.
          </p>
          <p style="margin:0 0 24px;font-size:14px;color:#cbd5e1;line-height:1.6;">
            In the meantime, the live feed is open to everyone:
          </p>
          <a href="${siteUrl}" style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
            Read the news feed →
          </a>
          <p style="margin:24px 0 0;font-size:12px;color:#475569;line-height:1.6;">
            This confirmation is for ${toEmail}. If you didn't sign up, you can ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          DeepFeedAI — AI-powered news, built differently
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Thanks for joining the DeepFeedAI waitlist!\n\nWe're in private beta right now. When we open up, you'll be the first to know.\n\nIn the meantime, the live news feed is open: ${siteUrl}\n\nThis confirmation is for ${toEmail}.`;

  try {
    await resendSend({
      from: fromAddr,
      to: [toName ? `${toName} <${toEmail}>` : toEmail],
      subject: "You're on the DeepFeedAI waitlist",
      html,
      text,
    }, apiKey);
  } catch (err) {
    console.error('[Notify] Waitlist confirmation email error:', err.message);
    throw err;
  }
}

module.exports = { sendReplyNotification, sendBudgetAlert, sendForecastNotification, sendVerificationEmail, sendPasswordResetEmail, sendTenantInviteEmail, sendWaitlistOpenEmail, sendWaitlistJoinedEmail };
