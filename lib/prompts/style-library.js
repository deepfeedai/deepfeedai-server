/**
 * Deep Feed AI — lib/prompts/style-library.js
 *
 * Shared visual style system for article thumbnails, inline images, and writer
 * avatars. The goal is variety + brand coherence: instead of pinning every
 * image to one photorealistic suffix, we rotate across a curated set of
 * style families with category-aware routing, mood, composition, and a
 * shared list of banned stock tropes.
 *
 * Exports:
 *   STYLE_FAMILIES   — 8 named style descriptors
 *   CATEGORY_STYLES  — category name -> array of family names (pool)
 *   MOODS            — mood descriptors
 *   COMPOSITIONS     — generic composition rotation (articles)
 *   AVATAR_COMPOSITION — fixed portrait composition for avatars
 *   NEGATIVE_TROPES  — shared negative prompt list
 *   TIER_MOODS       — map of story-level tier -> candidate mood(s)
 *   getStyleByName(name)
 *   getStylesForCategory(category)
 */
'use strict';

/** @typedef {{name: string, prompt: string, negative: string, tags: string[]}} StyleFamily */

/** @type {StyleFamily[]} */
const STYLE_FAMILIES = [
  {
    name: 'editorial-illustration',
    prompt: 'editorial illustration, muted palette, flat shapes, New Yorker inspired, clean composition, hand-drawn linework, thoughtful negative space',
    negative: 'no photorealistic rendering, no 3D render',
    tags: ['analytical', 'analytical-deep', 'explainer', 'opinion'],
  },
  {
    name: 'documentary-photo',
    prompt: 'documentary photograph, natural lighting, 35mm film grain, candid moment, desaturated tones, journalistic framing, Magnum Photos sensibility',
    negative: 'no illustration, no cartoon, no CGI',
    tags: ['breaking', 'field-report', 'profile'],
  },
  {
    name: 'noir',
    prompt: 'noir cinematography, high-contrast chiaroscuro, deep shadows, single warm key light against cool shadow, 1970s thriller mood, grain',
    negative: 'no bright cheerful palette, no pastel',
    tags: ['cautionary', 'investigative', 'cybersecurity'],
  },
  {
    name: 'minimalist-vector',
    prompt: 'minimalist vector art, two or three flat colors, geometric forms, generous white space, Swiss design, crisp edges',
    negative: 'no gradients, no photorealism, no texture overlays',
    tags: ['product', 'launch', 'explainer'],
  },
  {
    name: 'isometric-tech',
    prompt: 'isometric technical illustration, precise 30-degree axonometric projection, pastel tech palette, soft ambient occlusion, diagrammatic clarity',
    negative: 'no photorealism, no lens flare',
    tags: ['research', 'technical', 'infrastructure'],
  },
  {
    name: 'vintage-print',
    prompt: 'vintage print poster, risograph textures, two-tone spot color, halftone dots, 1960s publication aesthetic, slightly misregistered layers',
    negative: 'no glossy digital finish, no hyperreal detail',
    tags: ['historical', 'analytical', 'culture'],
  },
  {
    name: 'cinematic-poster',
    prompt: 'cinematic theatrical poster, dramatic rim lighting, bold central subject, atmospheric haze, wide anamorphic feel, orange-teal accents used sparingly',
    negative: 'no flat illustration, no clip-art composition',
    tags: ['celebratory', 'launch', 'event'],
  },
  {
    name: 'mixed-media',
    prompt: 'mixed-media collage, torn paper edges, analog photo fragments combined with hand-drawn marks, scanned textures, conceptual layering',
    negative: 'no pure photograph, no smooth digital illustration',
    tags: ['culture', 'analytical-deep', 'longform'],
  },
];

const STYLES_BY_NAME = Object.fromEntries(STYLE_FAMILIES.map(s => [s.name, s]));

/**
 * Category -> style pool. Keys are matched case-insensitively against the
 * article's category. Anything not listed falls back to the full pool.
 * Covers the common DeepFeedAI category set (categories are tenant-defined,
 * so this is a best-effort curated map — unknown categories degrade to all 8).
 */
const CATEGORY_STYLES = {
  'Cybersecurity':        ['noir', 'documentary-photo', 'isometric-tech'],
  'AI Regulation':        ['editorial-illustration', 'vintage-print'],
  'Regulation':           ['editorial-illustration', 'vintage-print'],
  'Policy':               ['editorial-illustration', 'vintage-print'],
  'Product Launches':     ['minimalist-vector', 'cinematic-poster'],
  'Products':             ['minimalist-vector', 'cinematic-poster'],
  'AI Research':          ['isometric-tech', 'mixed-media', 'editorial-illustration'],
  'Research':             ['isometric-tech', 'mixed-media', 'editorial-illustration'],
  'Business':             ['documentary-photo', 'editorial-illustration', 'cinematic-poster'],
  'Funding':              ['minimalist-vector', 'editorial-illustration'],
  'Open Source':          ['isometric-tech', 'minimalist-vector'],
  'Infrastructure':       ['isometric-tech', 'documentary-photo'],
  'Culture':              ['mixed-media', 'vintage-print', 'editorial-illustration'],
  'Ethics':               ['editorial-illustration', 'noir', 'vintage-print'],
  'Hardware':             ['isometric-tech', 'cinematic-poster'],
  'Robotics':             ['cinematic-poster', 'documentary-photo', 'isometric-tech'],
  'Industry':             ['documentary-photo', 'editorial-illustration'],
  'General':              ['editorial-illustration', 'documentary-photo', 'minimalist-vector'],
};

const ALL_FAMILY_NAMES = STYLE_FAMILIES.map(s => s.name);

/** Mood library — selected per image call. */
const MOODS = ['urgent', 'analytical', 'contemplative', 'celebratory', 'cautionary', 'curious'];

/** Story-tier -> candidate moods. When multiple, caller picks randomly. */
const TIER_MOODS = {
  breaking: ['urgent'],
  major:    ['cautionary'],
  trending: ['curious'],
  standard: ['analytical', 'contemplative'],
};

/** Composition rotation for article images (random pick). */
const COMPOSITIONS = [
  'wide establishing shot',
  'intimate close-up detail',
  'overhead top-down perspective',
  'asymmetric off-center crop',
  'symbolic still-life arrangement',
  'rule-of-thirds mid-distance framing',
];

/** Fixed composition for writer avatars. */
const AVATAR_COMPOSITION = 'head and shoulders portrait, studio lighting, subject centered';

/** Shared list of banned stock tropes (safety + anti-cliche). */
const NEGATIVE_TROPES = [
  'no stock photography clichés',
  'no hooded hacker',
  'no glowing brain',
  'no corporate handshake',
  'no checklist graphics',
  'no generic office scene',
  'no abstract swirls',
  'no crystal ball metaphor',
  'no neural network blob',
  'no text or words',
  'no watermarks',
  'no recognizable faces of real people',
];

function getStyleByName(name) {
  if (!name) return null;
  return STYLES_BY_NAME[name] || null;
}

/** Case-insensitive category -> style pool lookup; returns family names. */
function getStylesForCategory(category) {
  if (!category) return ALL_FAMILY_NAMES.slice();
  const key = Object.keys(CATEGORY_STYLES).find(
    k => k.toLowerCase() === String(category).toLowerCase()
  );
  if (key) return CATEGORY_STYLES[key].slice();
  return ALL_FAMILY_NAMES.slice();
}

module.exports = {
  STYLE_FAMILIES,
  CATEGORY_STYLES,
  MOODS,
  TIER_MOODS,
  COMPOSITIONS,
  AVATAR_COMPOSITION,
  NEGATIVE_TROPES,
  ALL_FAMILY_NAMES,
  getStyleByName,
  getStylesForCategory,
};
