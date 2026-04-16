/**
 * Deep Feed AI — Feature Registry
 * Centralized feature toggle system with plan-level defaults and per-tenant overrides.
 * Resolution order: self-hosted bypass → tenant override → plan default → global default.
 */
'use strict';

const db = require('../db');
const { getPlanInfo } = require('./plan-limits');
const tenantUtils = require('./tenant-utils');

// ── Cache ───────────────────────────────────────────────────────────
const _featureCache = new Map(); // Map<tenantId, { features, ts }>
const CACHE_TTL = 60 * 1000;

/**
 * All feature definitions. Seeded to the `feature_definitions` table on startup.
 * This is the single source of truth for which features exist.
 */
const FEATURE_DEFINITIONS = [
  // ── Content ──
  { key: 'seo_titles',                  name: 'SEO Titles',                   description: 'AI-generated SEO-optimized titles',          category: 'content',      value_type: 'boolean', default_value: 'false', sort_order: 10 },
  { key: 'auto_synthesis',              name: 'Auto Synthesis',               description: 'Automated AI article generation from sources', category: 'content',     value_type: 'boolean', default_value: 'false', sort_order: 11 },
  { key: 'deep_dives',                  name: 'Deep Dives',                   description: 'Weekly category roundup articles',            category: 'content',      value_type: 'boolean', default_value: 'false', sort_order: 12 },
  { key: 'writer_style_customization',  name: 'Writer Style Customization',   description: 'Custom tone, expertise, style guide for writers', category: 'content',  value_type: 'boolean', default_value: 'false', sort_order: 13 },
  { key: 'curated_shared_wire',         name: 'Shared Curated Wire',          description: 'Writers see curated source articles in their beats, not just ones assigned to them', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 14 },
  { key: 'article_pitches',             name: 'Counter-Angle Pitches',        description: 'Writers can pitch alternative angles on sources owned by another writer; editors approve/reject in the review queue', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 15 },
  { key: 'max_originals_per_source',    name: 'Max Originals Per Source',     description: 'Soft cap on originals spawned from a single curated source (editor can override per-pitch). Only active when Counter-Angle Pitches is enabled.', category: 'content', value_type: 'numeric', default_value: '2', sort_order: 16 },
  { key: 'agent_web_research',          name: 'Agent Web Research',           description: 'Writers + editors can search Brave/HN/Reddit and ingest external sources as curated articles to backfill weak clusters or seed coverage of new stories', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 17 },
  { key: 'external_search_daily_cap',   name: 'External Search Daily Cap',    description: 'Max external search calls (Brave + HN + Reddit) per tenant per day. Only active when Agent Web Research is enabled.', category: 'content', value_type: 'numeric', default_value: '200', sort_order: 18 },
  { key: 'external_research_daily_cap', name: 'External Ingest Daily Cap',    description: 'Max external articles ingested as curated per tenant per day. Only active when Agent Web Research is enabled.',          category: 'content', value_type: 'numeric', default_value: '50',  sort_order: 19 },
  { key: 'editor_workspace',            name: 'Editor Workspace',             description: 'In-admin web chat with writer agents and (later) newsroom activity feed', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 25 },
  { key: 'newsroom_social',             name: 'Newsroom Social',              description: 'Reactions and threading on activity feed cards. Requires Editor Workspace.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 26 },
  { key: 'story_levels',                name: 'Story Levels',                 description: 'Auto-tag articles as breaking / major / trending based on cluster velocity, source diversity, and editorial score', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 27 },
  { key: 'notifications_center',        name: 'Notifications Center',         description: 'Enables in-web notification bell and event-driven notifications', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 28 },
  { key: 'cross_channel_actions',       name: 'Cross-Channel Actions',        description: 'Enables HMAC-signed action tokens for approve/reject/assign from messaging channels', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29 },
  { key: 'editor_commissioned_stories', name: 'Editor-Commissioned Stories',  description: 'Editor can ask Maxwell to commission a story on a topic: drafts a brief, vets external sources, picks a writer, and creates a button-gated pitch via the notifications/actions system. Requires Agent Web Research, Counter-Angle Pitches, Notifications Center, and Cross-Channel Actions.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.5 },
  { key: 'graphic_designer',            name: 'Graphic Designer Agent',       description: 'Enables "Iris", an art-director agent who maintains visual brand coherence across thumbnails and writer avatars. Provides tools to review recent images, regenerate thumbnails/avatars with style overrides, set a tenant style guide, and propose style pivots via button-gated notifications. Daily regen budget enforced.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.7 },
  { key: 'designer_daily_regen_limit',  name: 'Designer Daily Regen Limit',    description: 'Max thumbnail + avatar regenerations the designer agent can perform per tenant per day. Only active when Graphic Designer Agent is enabled.', category: 'content', value_type: 'numeric', default_value: '20', sort_order: 29.8 },
  { key: 'daily_standups',             name: 'Daily Writer Standups',         description: 'Each writer agent generates a morning standup at 7:30 AM UTC: what they\'re tracking, pending pitches, and what they plan to cover. Posted to the newsroom feed and messaging channels.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.9 },
  { key: 'orchestrator_enabled',       name: 'Newsroom Orchestrator',         description: 'Multi-stage pipeline: Trend Scout discovers stories → Investigative Skeptic verifies sources → Lead Researcher fills gaps → writer synthesizes → editorial gate. Runs every 30 min. Human-approval gates pause the pipeline at conflict points.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.95 },
  { key: 'copy_editor_enabled',        name: 'Copy Editor (Vera)',             description: 'Vera runs a structured copy-editing pass before Maxwell\'s editorial review: grammar, spelling, headline quality, lede strength, AP style. Results shown in the editorial queue as accept/reject correction cards. Non-blocking — Maxwell still runs if Vera errors.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.96 },
  { key: 'daily_brief',               name: 'Daily Editorial Brief',          description: 'Maxwell generates an end-of-day editorial brief at 6 PM UTC summarising articles published, pitch activity, review queue, and AI spend. Posted to the newsroom feed.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.97 },
  { key: 'weekly_digest',             name: 'Weekly Editorial Digest',        description: 'Maxwell generates a Friday week-in-review digest covering output, beat coverage gaps, engagement highlights, and a forward look at next week. Posted to the newsroom feed.', category: 'content', value_type: 'boolean', default_value: 'false', sort_order: 29.98 },

  // ── AI & Automation ──
  { key: 'byok',                        name: 'Bring Your Own Key',           description: 'Use your own API keys and choose provider per operation (Gemini, OpenAI, Anthropic, OpenRouter, Ollama)', category: 'ai', value_type: 'boolean', default_value: 'false', sort_order: 20 },
  { key: 'custom_ai_pricing',           name: 'Custom AI Pricing',            description: 'Override default AI pricing per model',       category: 'ai',           value_type: 'boolean', default_value: 'false', sort_order: 22 },
  { key: 'synthesis_forecasting',       name: 'Synthesis Forecasting',        description: 'Pre-synthesis predictions and alerts',        category: 'ai',           value_type: 'boolean', default_value: 'false', sort_order: 22 },

  // ── Media ──
  { key: 'audio',                       name: 'Audio Generation',             description: 'AI text-to-speech for articles',              category: 'media',        value_type: 'boolean', default_value: 'false', sort_order: 30 },
  { key: 'image_generation',            name: 'Image Generation',             description: 'AI-generated article thumbnails',             category: 'media',        value_type: 'boolean', default_value: 'false', sort_order: 31 },

  // ── Engagement ──
  { key: 'comments',                    name: 'Comments',                     description: 'User comments on articles',                   category: 'engagement',   value_type: 'boolean', default_value: 'true',  sort_order: 40 },
  { key: 'reactions',                   name: 'Reactions',                    description: 'Emoji reactions on articles and comments',     category: 'engagement',   value_type: 'boolean', default_value: 'true',  sort_order: 41 },
  { key: 'favorites',                   name: 'Favorites',                    description: 'Article bookmarking for users',               category: 'engagement',   value_type: 'boolean', default_value: 'true',  sort_order: 42 },
  { key: 'spam_detection',              name: 'Spam Detection',               description: 'AI-powered spam and toxicity filtering',      category: 'engagement',   value_type: 'boolean', default_value: 'false', sort_order: 43 },

  // ── Distribution ──
  { key: 'newsletter',                  name: 'Newsletter',                   description: 'Email newsletter generation and sending',     category: 'distribution', value_type: 'boolean', default_value: 'false', sort_order: 50 },
  { key: 'featured_rotation',           name: 'Featured Rotation',            description: 'Automated featured article rotation',         category: 'distribution', value_type: 'boolean', default_value: 'false', sort_order: 51 },
  { key: 'banners',                     name: 'Banners',                      description: 'Tenant-level banner notifications',           category: 'distribution', value_type: 'boolean', default_value: 'true',  sort_order: 52 },

  // ── Administration ──
  { key: 'custom_domain',               name: 'Custom Domain',                description: 'Custom domain for tenant site',               category: 'admin',        value_type: 'boolean', default_value: 'false', sort_order: 60 },
  { key: 'custom_roles',                name: 'Custom Roles',                 description: 'Create custom RBAC roles',                    category: 'admin',        value_type: 'boolean', default_value: 'false', sort_order: 61 },
  { key: 'advanced_analytics',          name: 'Advanced Analytics',           description: 'Detailed analytics dashboards',               category: 'admin',        value_type: 'boolean', default_value: 'false', sort_order: 62 },
  { key: 'audit_logs',                  name: 'Audit Logs',                   description: 'Admin action audit trail',                    category: 'admin',        value_type: 'boolean', default_value: 'true',  sort_order: 63 },
  { key: 'audit_retention_days',        name: 'Audit Retention Days',         description: 'How long audit logs are kept',                category: 'admin',        value_type: 'numeric', default_value: '7',     sort_order: 64 },

  // ── Discovery ──
  { key: 'saved_searches',              name: 'Saved Searches',               description: 'Save and rerun discovery searches',           category: 'discovery',    value_type: 'boolean', default_value: 'false', sort_order: 70 },
  { key: 'live_news',                   name: 'Live News',                    description: 'Live news fetch from external APIs',           category: 'discovery',    value_type: 'boolean', default_value: 'true',  sort_order: 71 },

  // ── Platform ──
  { key: 'platform_chat',               name: 'Platform Chat',                description: 'AI chat assistant in admin portal/platform',   category: 'ai',           value_type: 'boolean', default_value: 'false', sort_order: 80 },
  { key: 'article_assist',              name: 'Article Editor Assistant',      description: 'AI assistant for article editing',             category: 'ai',           value_type: 'boolean', default_value: 'false', sort_order: 81 },
];

// O(1) lookup map for feature definitions
const FEATURE_MAP = new Map(FEATURE_DEFINITIONS.map(d => [d.key, d]));

/**
 * Plan-level feature values. Seeded into `plan_features` on startup.
 * Only entries that differ from default_value need to be listed.
 */
const PLAN_FEATURE_SEEDS = {
  free: {
    // Uses defaults for most — comments, reactions, favorites, banners, audit_logs, live_news = true
    // Everything else stays false/low
    audit_retention_days: '7',
  },
  starter: {
    auto_synthesis: 'true',
    image_generation: 'true',
    writer_style_customization: 'true',
    spam_detection: 'true',
    newsletter: 'true',
    saved_searches: 'true',
    audit_retention_days: '30',
  },
  pro: {
    seo_titles: 'true',
    auto_synthesis: 'true',
    deep_dives: 'true',
    writer_style_customization: 'true',
    byok: 'true',
    synthesis_forecasting: 'true',
    audio: 'true',
    image_generation: 'true',
    spam_detection: 'true',
    newsletter: 'true',
    featured_rotation: 'true',
    custom_domain: 'true',
    custom_roles: 'true',
    advanced_analytics: 'true',
    saved_searches: 'true',
    audit_retention_days: '90',
    platform_chat: 'true',
    article_assist: 'true',
  },
  business: {
    seo_titles: 'true',
    auto_synthesis: 'true',
    deep_dives: 'true',
    writer_style_customization: 'true',
    byok: 'true',
    custom_ai_pricing: 'true',
    synthesis_forecasting: 'true',
    audio: 'true',
    image_generation: 'true',
    spam_detection: 'true',
    newsletter: 'true',
    featured_rotation: 'true',
    custom_domain: 'true',
    custom_roles: 'true',
    advanced_analytics: 'true',
    saved_searches: 'true',
    audit_retention_days: '365',
    platform_chat: 'true',
    article_assist: 'true',
  },
  internal: {
    seo_titles: 'true',
    auto_synthesis: 'true',
    deep_dives: 'true',
    writer_style_customization: 'true',
    byok: 'true',
    custom_ai_pricing: 'true',
    synthesis_forecasting: 'true',
    audio: 'true',
    image_generation: 'true',
    spam_detection: 'true',
    newsletter: 'true',
    featured_rotation: 'true',
    custom_domain: 'true',
    custom_roles: 'true',
    advanced_analytics: 'true',
    saved_searches: 'true',
    audit_retention_days: null, // null = unlimited
    platform_chat: 'true',
    article_assist: 'true',
  },
};

// ── Core Resolution ─────────────────────────────────────────────────

/**
 * Load all resolved features for a tenant in one query.
 * Returns Map<featureKey, { value: string, source: 'override'|'plan'|'default', expiresAt? }>
 */
async function _loadFeatures(tenantId) {
  const planInfo = await getPlanInfo(tenantId);
  const effectivePlan = planInfo?.effectivePlan || 'free';

  // Single query: join definitions + plan values + tenant overrides
  const rows = await db.prepare(`
    SELECT
      fd.key,
      fd.value_type,
      fd.default_value,
      pf.value       AS plan_value,
      tfo.value      AS override_value,
      tfo.expires_at AS override_expires_at,
      tfo.reason     AS override_reason
    FROM feature_definitions fd
    LEFT JOIN plan_features pf
      ON pf.feature_key = fd.key AND pf.plan = $1
    LEFT JOIN tenant_feature_overrides tfo
      ON tfo.feature_key = fd.key AND tfo.tenant_id = $2
    ORDER BY fd.sort_order
  `).all(effectivePlan, tenantId);

  const features = {};
  const now = new Date();
  for (const row of rows) {
    // Check override first (skip if expired)
    if (row.override_value !== null && row.override_value !== undefined) {
      const expired = row.override_expires_at && new Date(row.override_expires_at) <= now;
      if (!expired) {
        features[row.key] = {
          value: row.override_value,
          source: 'override',
          expiresAt: row.override_expires_at || null,
          reason: row.override_reason || null,
        };
        continue;
      }
    }
    // Then plan value
    if (row.plan_value !== null && row.plan_value !== undefined) {
      features[row.key] = { value: row.plan_value, source: 'plan' };
      continue;
    }
    // Then global default
    features[row.key] = { value: row.default_value, source: 'default' };
  }
  return features;
}

/**
 * Get all resolved features for a tenant (cached).
 */
async function getAllFeatures(tenantId) {
  if (!tenantUtils.MULTI_TENANT) {
    return _selfHostedFeatures(tenantId);
  }

  const now = Date.now();
  const cached = _featureCache.get(tenantId);
  if (cached && (now - cached.ts) < CACHE_TTL) {
    return cached.features;
  }

  const features = await _loadFeatures(tenantId);
  _featureCache.set(tenantId, { features, ts: now });
  return features;
}

/**
 * Self-hosted: all features enabled, but respect explicit overrides for tenant 1.
 */
async function _selfHostedFeatures(tenantId) {
  const now = Date.now();
  const cacheKey = `sh_${tenantId}`;
  const cached = _featureCache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL) {
    return cached.features;
  }

  // Load any explicit overrides for this tenant
  const overrides = await db.prepare(`
    SELECT feature_key, value, expires_at, reason
    FROM tenant_feature_overrides
    WHERE tenant_id = $1
  `).all(tenantId);

  const overrideMap = {};
  const nowDate = new Date();
  for (const o of overrides) {
    if (o.expires_at && new Date(o.expires_at) <= nowDate) continue;
    overrideMap[o.feature_key] = { value: o.value, source: 'override', expiresAt: o.expires_at, reason: o.reason };
  }

  const features = {};
  for (const def of FEATURE_DEFINITIONS) {
    if (overrideMap[def.key]) {
      features[def.key] = overrideMap[def.key];
    } else if (def.value_type === 'boolean') {
      features[def.key] = { value: 'true', source: 'self-hosted' };
    } else if (def.value_type === 'numeric') {
      features[def.key] = { value: null, source: 'self-hosted' }; // null = unlimited
    }
  }

  _featureCache.set(cacheKey, { features, ts: now });
  return features;
}

/**
 * Check if a boolean feature is enabled for a tenant.
 */
async function isFeatureEnabled(tenantId, featureKey) {
  const features = await getAllFeatures(tenantId);
  const entry = features[featureKey];
  if (!entry) return false;
  return entry.value === 'true' || entry.value === true;
}

/**
 * Get the raw value of a feature for a tenant.
 */
async function getFeatureValue(tenantId, featureKey) {
  const features = await getAllFeatures(tenantId);
  const entry = features[featureKey];
  if (!entry) return null;
  return entry.value;
}

/**
 * Get a flat map of feature key → resolved value (for public API).
 */
async function getFlatFeatures(tenantId) {
  const features = await getAllFeatures(tenantId);
  const flat = {};
  for (const [key, entry] of Object.entries(features)) {
    const def = FEATURE_MAP.get(key);
    if (def?.value_type === 'boolean') {
      flat[key] = entry.value === 'true' || entry.value === true;
    } else if (def?.value_type === 'numeric') {
      flat[key] = entry.value === null ? null : Number(entry.value);
    } else {
      flat[key] = entry.value;
    }
  }
  return flat;
}

function bustFeatureCache(tenantId) {
  if (tenantId) {
    _featureCache.delete(tenantId);
    _featureCache.delete(`sh_${tenantId}`);
  } else {
    _featureCache.clear();
  }
}

function isSelfHosted() {
  return !tenantUtils.MULTI_TENANT;
}

module.exports = {
  FEATURE_DEFINITIONS,
  FEATURE_MAP,
  PLAN_FEATURE_SEEDS,
  isFeatureEnabled,
  getFeatureValue,
  getAllFeatures,
  getFlatFeatures,
  bustFeatureCache,
  isSelfHosted,
};
