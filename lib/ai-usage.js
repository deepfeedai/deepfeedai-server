/**
 * Deep Feed AI Admin — lib/ai-usage.js
 * Central module for logging AI API usage and estimating costs.
 * All logUsage() calls should be fire-and-forget (wrapped in .catch(() => {}))
 * so logging never blocks the main operation.
 */
const db = require('../db');

// Credits per dollar — 1 credit = $0.001
const CREDIT_RATE = 1000;

// Pricing per provider/model — overridable via `ai_pricing` settings key
// `cachedInput` = price per 1M for prompt-cache hits (typically much cheaper than fresh input)
const DEFAULT_PRICING = {
  // Direct text-to-image API: text input and image output per million tokens.
  'gpt-image-2': {input:5, output:30},
  'gpt-image-2.5-sunburst': {input:5, output:30},
  'gpt-image-2.5-flare': {input:5, output:30},
  // Gemini — cached content billed at ~25% of fresh
  'gemini-2.5-flash':      { input: 0.15,  cachedInput: 0.0375, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075, cachedInput: 0.019,  output: 0.30 },
  // OpenAI — cached billed at 50% of fresh
  'gpt-4o':                { input: 2.50,  cachedInput: 1.25,   output: 10.00 },
  'gpt-4o-mini':           { input: 0.15,  cachedInput: 0.075,  output: 0.60 },
  'gpt-4.1':               { input: 2.00,  cachedInput: 0.50,   output: 8.00 },
  'gpt-4.1-mini':          { input: 0.40,  cachedInput: 0.10,   output: 1.60 },
  'gpt-4.1-nano':          { input: 0.10,  cachedInput: 0.025,  output: 0.40 },
  // Anthropic — cached billed at 10% of fresh (prompt caching discount)
  'claude-sonnet-4-20250514':   { input: 3.00, cachedInput: 0.30, output: 15.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80, cachedInput: 0.08, output: 4.00 },
  // OpenRouter — passthrough, assume no cache discount unless upstream reports it
  'openrouter/auto':            { input: 0.50, cachedInput: 0.50, output: 2.00 },
  'openrouter/free':            { input: 0,    cachedInput: 0,    output: 0 },
  // Ollama (local — no cost)
  'ollama':                { input: 0, cachedInput: 0, output: 0 },
  // Non-LLM providers
  'imagen-4':              { perImage: 0.04 },
  'imagen-4.0-generate-001': { perImage: 0.04 },
  'dall-e-3':              { perImage: 0.08 },   // DALL-E 3 standard at 1792x1024
  'dall-e-3-hd':           { perImage: 0.12 },   // DALL-E 3 HD at 1792x1024
  'eleven_turbo_v2':       { perKChars: 0.30 },
  'resend':                { perEmail: 0.00028, freeQuota: 3000 },
  'newsapi':               { perRequest: 0.0 },               // free tier
  'brave':                 { perRequest: 0.005 },
};

const _pricingCache = new Map(); // tenantId -> { pricing, ts }
const PRICING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get pricing config, checking for override in settings.
 */
async function getPricing(tenantId) {
  const now = Date.now();
  const cached = _pricingCache.get(tenantId);
  if (cached && (now - cached.ts) < PRICING_CACHE_TTL) {
    return cached.pricing;
  }
  let pricing;
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'ai_pricing' AND tenant_id = $1").get(tenantId);
    if (row && row.value) {
      pricing = { ...DEFAULT_PRICING, ...JSON.parse(row.value) };
    } else {
      pricing = DEFAULT_PRICING;
    }
  } catch {
    pricing = DEFAULT_PRICING;
  }
  _pricingCache.set(tenantId, { pricing, ts: now });
  return pricing;
}

/**
 * Estimate cost in USD for a single API call.
 */
async function estimateCost(provider, model, { inputTokens, outputTokens, inputTokensCached, inputTokensFresh, characters, imageCount, emailCount, tenantId } = {}) {
  const pricing = await getPricing(tenantId);

  // Token-based — split cached vs fresh when available
  if (model && pricing[model] && (inputTokens || outputTokens || inputTokensCached || inputTokensFresh)) {
    const p = pricing[model];
    // If caller provided the split, use it; else treat entire input_tokens as fresh
    let cachedTokens = inputTokensCached || 0;
    let freshTokens = inputTokensFresh;
    if (freshTokens == null) {
      freshTokens = Math.max(0, (inputTokens || 0) - cachedTokens);
    }
    const cachedCost = cachedTokens / 1_000_000 * (p.cachedInput ?? p.input ?? 0);
    const freshCost  = freshTokens  / 1_000_000 * (p.input ?? 0);
    const outCost    = (outputTokens || 0) / 1_000_000 * (p.output ?? 0);
    return cachedCost + freshCost + outCost;
  }

  // Character-based (ElevenLabs)
  if (provider === 'elevenlabs' && characters) {
    const p = pricing['eleven_turbo_v2'] || {};
    return (characters / 1000) * (p.perKChars || 0);
  }

  // Image-based (Imagen / DALL-E) — price per model when available, fall back to provider default
  if (imageCount && (provider === 'imagen' || provider === 'dalle')) {
    const p = pricing[model] || pricing[provider === 'imagen' ? 'imagen-4' : 'dall-e-3'] || {};
    return imageCount * (p.perImage || 0);
  }

  // Email-based (Resend)
  if (provider === 'resend' && emailCount) {
    const p = pricing['resend'] || {};
    return emailCount * (p.perEmail || 0);
  }

  // Request-based (NewsAPI, Brave)
  if (provider === 'newsapi' || provider === 'brave') {
    const p = pricing[provider] || {};
    return p.perRequest || 0;
  }

  return 0;
}

/**
 * Estimate credits for a single API call.
 * Credits = cost * CREDIT_RATE, rounded to nearest integer.
 */
async function estimateCredits(provider, model, opts) {
  const cost = await estimateCost(provider, model, opts);
  return Math.round(cost * CREDIT_RATE);
}

/**
 * Extract token counts from a Gemini API response body.
 * Returns { promptTokenCount, candidatesTokenCount, totalTokenCount } or nulls.
 */
function extractGeminiTokens(responseData) {
  const usage = responseData?.usageMetadata;
  return {
    promptTokenCount:     usage?.promptTokenCount     || null,
    candidatesTokenCount: usage?.candidatesTokenCount  || null,
    totalTokenCount:      usage?.totalTokenCount       || null,
  };
}

/**
 * Log a single API usage event to the ai_usage table.
 * This should always be called as: logUsage({...}).catch(() => {})
 */
async function logUsage({
  provider, model, operation,
  articleSlug, writerId, trigger,
  inputTokens, outputTokens,
  inputTokensCached, inputTokensFresh,
  characters, imageCount, emailCount,
  durationMs, success, error,
  tenantId,
  isByai = false,
  agentSessionId = null,
}) {
  // If caller gave us total `inputTokens` but no split, treat all as fresh.
  // If they gave cached but no fresh, derive fresh = total - cached.
  let cached = inputTokensCached || 0;
  let fresh = inputTokensFresh;
  if (fresh == null) {
    fresh = Math.max(0, (inputTokens || 0) - cached);
  }
  const totalInput = inputTokens != null ? inputTokens : (cached + fresh);

  const cost = await estimateCost(provider, model, {
    inputTokens: totalInput,
    outputTokens,
    inputTokensCached: cached,
    inputTokensFresh: fresh,
    characters, imageCount, emailCount, tenantId,
  });
  // BYAI calls: track cost for analytics but set credits to 0 (tenant bears their own cost)
  const credits = isByai ? 0 : Math.round(cost * CREDIT_RATE);

  await db.prepare(`
    INSERT INTO ai_usage (
      tenant_id, provider, model, operation, article_slug, writer_id, trigger,
      input_tokens, input_tokens_cached, input_tokens_fresh, output_tokens,
      characters, image_count, email_count,
      estimated_cost, credits_used, duration_ms, success, error_message, is_byai,
      agent_session_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
  `).run(
    tenantId,
    provider,
    model || null,
    operation,
    articleSlug || null,
    writerId || null,
    trigger || 'manual',
    totalInput || null,
    cached || 0,
    fresh || 0,
    outputTokens || null,
    characters || null,
    imageCount || null,
    emailCount || null,
    cost,
    credits,
    durationMs || null,
    success !== false,
    error ? String(error).slice(0, 500) : null,
    isByai,
    agentSessionId,
  );
}

/**
 * Get total spend for today (UTC).
 */
async function getTodaySpend(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseFloat(row.total) || 0;
}

/**
 * Get total spend for current month (UTC).
 */
async function getMonthlySpend(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseFloat(row.total) || 0;
}

/**
 * Get total credits used today (UTC).
 */
async function getTodayCredits(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Get total credits used this month (UTC).
 */
async function getMonthlyCredits(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Total LLM tokens consumed today by BYOK calls for a tenant.
 * Used by canSpendByok() to enforce tenant-configured token limits.
 */
async function getTodayTokensByok(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND is_byai = true
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Total LLM tokens consumed this month by BYOK calls for a tenant.
 */
async function getMonthlyTokensByok(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
      AND is_byai = true
      AND created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

module.exports = {
  logUsage,
  estimateCost,
  estimateCredits,
  extractGeminiTokens,
  getTodaySpend,
  getMonthlySpend,
  getTodayCredits,
  getMonthlyCredits,
  getTodayTokensByok,
  getMonthlyTokensByok,
  DEFAULT_PRICING,
  CREDIT_RATE,
};
