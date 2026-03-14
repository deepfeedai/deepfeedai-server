/**
 * Deep Feed AI Admin — lib/schemas.js
 * Zod validation schemas for all inbound request bodies.
 * Import the relevant schema in each route and call schema.safeParse(req.body).
 */
const { z } = require('zod');

// ── Articles ────────────────────────────────────────────────────────

const articleCreate = z.object({
  title:       z.string().min(1).max(500),
  summary:     z.string().max(2000).nullish(),
  content:     z.string().max(50000).nullish(),
  category:    z.string().max(100).default('Industry'),
  source:      z.string().max(200).nullish(),
  source_url:  z.string().url().max(2000).nullish(),
  image_url:   z.string().url().max(2000).nullish(),
  author:      z.string().max(200).nullish(),
  is_featured: z.coerce.boolean().default(false),
  is_published:z.coerce.boolean().default(true),
  published_at:z.string().datetime({ offset: true }).nullish(),
});

const articleUpdate = articleCreate.partial();

// ── Sources ─────────────────────────────────────────────────────────

const sourceCreate = z.object({
  name:            z.string().min(1).max(200),
  url:             z.string().url().max(2000),
  priority:        z.coerce.number().int().min(1).max(100).default(1),
  is_active:       z.coerce.boolean().default(true),
  auto_publish:    z.coerce.boolean().default(false),
  auto_publish_max:z.coerce.number().int().min(1).max(50).default(5),
});

const sourceUpdate = sourceCreate.partial();

// ── Voices ──────────────────────────────────────────────────────────

const voiceCreate = z.object({
  name:        z.string().min(1).max(200),
  voice_id:    z.string().min(1).max(200),
  description: z.string().max(500).default(''),
  is_default:  z.coerce.boolean().default(false),
});

const voiceUpdate = voiceCreate.partial().required({ name: true, voice_id: true });

// ── Writers ─────────────────────────────────────────────────────────

const writerCreate = z.object({
  name:        z.string().min(1).max(200),
  slug:        z.string().max(200).nullish(),
  bio:         z.string().max(2000).nullish(),
  beat:        z.string().max(200).nullish(),
  keywords:    z.array(z.string().max(100)).default([]),
  system_prompt: z.string().max(10000).nullish(),
  is_auto:     z.coerce.boolean().default(false),
  synthesis_schedule: z.enum(['daily', 'weekly', 'manual']).default('daily'),
  synthesis_lookback_hours: z.coerce.number().int().min(1).max(8760).default(168),
  min_cluster_size: z.coerce.number().int().min(1).max(100).default(3),
  voice_id:    z.coerce.number().int().nullish(),
});

const writerUpdate = writerCreate.partial().required({ name: true });

// ── Auth ────────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

// ── Settings ────────────────────────────────────────────────────────

const settingsUpdate = z.record(z.string().max(100), z.string().max(5000));

// ── Helper ──────────────────────────────────────────────────────────

/**
 * Validate req.body against a schema.
 * Returns { data } on success or sends a 400 JSON error and returns null.
 */
function validate(schema, body, res) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    res.status(400).json({ error: 'Validation failed', details: errors });
    return null;
  }
  return result.data;
}

module.exports = {
  articleCreate,
  articleUpdate,
  sourceCreate,
  sourceUpdate,
  voiceCreate,
  voiceUpdate,
  writerCreate,
  writerUpdate,
  loginSchema,
  settingsUpdate,
  validate,
};
