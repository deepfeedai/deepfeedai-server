/**
 * Deep Feed AI Admin — lib/schemas.js
 * Zod validation schemas for all inbound request bodies.
 * Import the relevant schema in each route and call schema.safeParse(req.body).
 */
const { z } = require('zod');

// ── Articles ────────────────────────────────────────────────────────

const articleCreate = z.object({
  writer_id: z.number().int().positive().nullable().optional(),
  title:       z.string().min(1).max(500),
  summary:     z.string().max(2000).nullish(),
  content:     z.string().max(50000).nullish(),
  content_blocks: z.object({ version: z.string().optional(), blocks: z.array(z.any()) }).nullish(),
  category:    z.string().max(100).default('Industry'),
  source:      z.string().max(200).nullish(),
  source_url:  z.preprocess(v => (v === '' ? null : v), z.string().url().max(2000).nullish()),
  image_url:   z.preprocess(v => (v === '' ? null : v), z.string().max(2000).refine(v => !v || v.startsWith('/') || v.startsWith('https://') || v.startsWith('http://'), { message: 'Must be a URL or path starting with /' }).nullish()),
  author:      z.string().max(200).nullish(),
  is_featured: z.coerce.boolean().default(false),
  featured_priority: z.coerce.number().int().min(1).max(10).nullish(),
  is_published:z.coerce.boolean().default(false),
  published_at:z.string().datetime({ offset: true }).nullish(),
  disable_summary: z.coerce.boolean().default(false),
});

const articleUpdate = articleCreate.partial();

// ── Sources ─────────────────────────────────────────────────────────

const sourceCreate = z.object({
  name:            z.string().min(1).max(200),
  url:             z.string().url().max(2000),
  priority:        z.coerce.number().int().min(1).max(100).default(1),
  is_active:       z.coerce.boolean().default(true),
  auto_publish_max:z.coerce.number().int().min(1).max(200).default(50),
  default_category:z.string().max(100).nullish(),
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
  beats:       z.array(z.coerce.number().int()).default([]),
  keywords:    z.array(z.string().max(100)).default([]),
  system_prompt: z.string().max(10000).nullish(),
  is_auto:     z.coerce.boolean().default(false),
  synthesis_schedule: z.enum(['frequent', 'daily', 'twice-daily', 'weekly', 'manual']).default('daily'),
  synthesis_lookback_hours: z.coerce.number().int().min(1).max(8760).default(168),
  min_cluster_size: z.coerce.number().int().min(1).max(100).default(2),
  elevenlabs_voice_id: z.string().max(200).nullish(),
  tone:        z.string().max(200).nullish(),
  expertise_level: z.string().max(200).nullish(),
  style_guide: z.string().max(5000).nullish(),
  few_shot_examples: z.array(z.object({ title: z.string().max(500), excerpt: z.string().max(2000) })).default([]),
  gender: z.enum(['male', 'female', 'non-binary']).nullish(),
  ethnicity: z.string().max(200).nullish(),
  signature_phrases: z.array(z.string().max(200)).max(5).nullish(),
  contrarian_level: z.coerce.number().min(0).max(1).default(0.5),
  beat_angle: z.string().max(500).nullish(),
  chat_prompt: z.string().max(10000).nullish(),
  role: z.enum(['writer', 'editor', 'designer', 'analyst', 'moderator', 'copy-editor']).default('writer'),
  team_id: z.coerce.number().int().nullish(),
  is_system: z.coerce.boolean().default(false),
  // Newsroom chat personality — CSS color string (e.g. "#8b5cf6"). Null means
  // fall back to deterministic palette (lib/writer-colors.js).
  accent_color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex color').max(20).nullish(),
  // Per-writer avatar style override — pins the style family + freeform notes
  // so avatar regenerations stay consistent. Null = use tenant art direction.
  avatar_style_family: z.preprocess(
    v => v === '' ? null : v,
    z.enum([
      'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
      'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
      'anime-portrait', 'cel-shaded', 'studio-illustration', 'comic-book', '3d-render',
    ]).nullish(),
  ),
  avatar_style_notes: z.preprocess(v => v === '' ? null : v, z.string().max(1000).nullish()),
  style_id: z.coerce.number().int().nullish(),
  daily_article_budget: z.coerce.number().int().min(0).max(100).nullish(),
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
    const errors = (result.error.issues || result.error.errors || []).map(e => `${e.path.join('.')}: ${e.message}`);
    res.status(400).json({ error: 'Validation failed', details: errors });
    return null;
  }
  return result.data;
}

const localLogin = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1),
});

// ── User Management ────────────────────────────────────────────────

const userCreate = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  role: z.string().min(1).max(50),
});

const userUpdate = z.object({
  display_name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional().nullable(),
  role: z.string().min(1).max(50).optional(),
  is_active: z.number().int().min(0).max(1).optional(),
});

const passwordReset = z.object({
  password: z.string().min(8).max(128),
});

const passwordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

// ── Role Management ────────────────────────────────────────────────

const roleCreate = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).min(1),
});

const roleUpdate = z.object({
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).min(1).optional(),
});

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
  localLogin,
  settingsUpdate,
  userCreate,
  userUpdate,
  passwordReset,
  passwordChange,
  roleCreate,
  roleUpdate,
  validate,
};
