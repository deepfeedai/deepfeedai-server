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
const DEFAULT_PRICING = {
  // Gemini
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60  },  // per 1M tokens
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30  },  // per 1M tokens
  // OpenAI
  'gpt-4o':                { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':           { input: 0.15,  output: 0.60  },
  'gpt-4.1':               { input: 2.00,  output: 8.00  },
  'gpt-4.1-mini':          { input: 0.40,  output: 1.60  },
  'gpt-4.1-nano':          { input: 0.10,  output: 0.40  },
  // Anthropic
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },
  // Ollama (local — no cost)
  'ollama':                { input: 0, output: 0 },
  // Non-LLM providers
  'imagen-4':              { perImage: 0.04 },
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
async function estimateCost(provider, model, { inputTokens, outputTokens, characters, imageCount, emailCount, tenantId } = {}) {
  const pricing = await getPricing(tenantId);

  // Token-based (Gemini)
  if (model && pricing[model] && (inputTokens || outputTokens)) {
    const p = pricing[model];
    const inCost  = (inputTokens  || 0) / 1_000_000 * (p.input  || 0);
    const outCost = (outputTokens || 0) / 1_000_000 * (p.output || 0);
    return inCost + outCost;
  }

  // Character-based (ElevenLabs)
  if (provider === 'elevenlabs' && characters) {
    const p = pricing['eleven_turbo_v2'] || {};
    return (characters / 1000) * (p.perKChars || 0);
  }

  // Image-based (Imagen)
  if (provider === 'imagen' && imageCount) {
    const p = pricing['imagen-4'] || {};
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
  characters, imageCount, emailCount,
  durationMs, success, error,
  tenantId,
  isByai = false,
}) {
  const cost = await estimateCost(provider, model, {
    inputTokens, outputTokens, characters, imageCount, emailCount, tenantId,
  });
  // BYAI calls: track cost for analytics but set credits to 0 (tenant bears their own cost)
  const credits = isByai ? 0 : Math.round(cost * CREDIT_RATE);

  await db.prepare(`
    INSERT INTO ai_usage (
      tenant_id, provider, model, operation, article_slug, writer_id, trigger,
      input_tokens, output_tokens, characters, image_count, email_count,
      estimated_cost, credits_used, duration_ms, success, error_message, is_byai
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  `).run(
    tenantId,
    provider,
    model || null,
    operation,
    articleSlug || null,
    writerId || null,
    trigger || 'manual',
    inputTokens || null,
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

module.exports = {
  logUsage,
  estimateCost,
  estimateCredits,
  extractGeminiTokens,
  getTodaySpend,
  getMonthlySpend,
  getTodayCredits,
  getMonthlyCredits,
  DEFAULT_PRICING,
  CREDIT_RATE,
};
