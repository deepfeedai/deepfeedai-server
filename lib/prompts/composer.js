/**
 * Deep Feed AI — lib/prompts/composer.js
 *
 * Single entry point for composing final image prompts. Wraps a visual
 * concept (usually produced by lib/media-helpers.js `getVisualConcept` via
 * Gemini) with a style family, mood, composition, and shared negative
 * tropes.
 *
 * The concept-first pipeline is preserved: `getVisualConcept` still runs
 * upstream and generates the story-specific concept. Composer only adds
 * stylistic variety on top so the feed doesn't look same-y.
 */
'use strict';

const crypto = require('crypto');
const {
  STYLE_FAMILIES,
  MOODS,
  TIER_MOODS,
  COMPOSITIONS,
  AVATAR_COMPOSITION,
  NEGATIVE_TROPES,
  AVATAR_NEGATIVE_TROPES,
  ALL_FAMILY_NAMES,
  getStyleByName,
  getStylesForCategory,
} = require('./style-library');

/**
 * Deterministic jitter — same concept string always lands on the same style
 * within the given pool. Prevents "same title, different style" churn on
 * regenerations while still giving variety across different articles.
 */
function hashPick(str, pool) {
  if (!pool.length) return null;
  const h = crypto.createHash('sha1').update(String(str || '')).digest();
  const idx = h.readUInt32BE(0) % pool.length;
  return pool[idx];
}

function randomPick(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Normalise a tenant art direction value. Accepts:
 *   - null / undefined / ''
 *   - a bare string: 'noir'
 *   - JSON string: '{"style":"noir","applies_to":["thumbnails"]}'
 *   - an object with same shape
 * Returns { style: string|null, appliesTo: string[]|null } or null if unset.
 */
function parseArtDirection(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') {
    if (raw.prompt) {
      return {
        style: null,
        customPrompt: String(raw.prompt),
        appliesTo: Array.isArray(raw.applies_to) ? raw.applies_to : null,
        notes: raw.notes || null,
      };
    }
    return {
      style: raw.style || null,
      customPrompt: null,
      appliesTo: Array.isArray(raw.applies_to) ? raw.applies_to : null,
      notes: raw.notes || null,
    };
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj.prompt) {
        return {
          style: null,
          customPrompt: String(obj.prompt),
          appliesTo: Array.isArray(obj.applies_to) ? obj.applies_to : null,
          notes: obj.notes || null,
        };
      }
      return {
        style: obj.style || null,
        customPrompt: null,
        appliesTo: Array.isArray(obj.applies_to) ? obj.applies_to : null,
        notes: obj.notes || null,
      };
    } catch { /* fall through */ }
  }
  return { style: s, customPrompt: null, appliesTo: null, notes: null };
}

/** Whether a tenant art direction setting applies to the given target. */
function artDirectionApplies(parsed, target) {
  if (!parsed || (!parsed.style && !parsed.customPrompt)) return false;
  if (!parsed.appliesTo) return true;
  // Normalise synonyms
  const normal = {
    'thumbnail': 'thumbnails',
    'thumbnails': 'thumbnails',
    'inline': 'thumbnails',    // inline images follow the article surface
    'avatar': 'avatars',
    'avatars': 'avatars',
  };
  const want = normal[target] || target;
  return parsed.appliesTo.some(a => (normal[a] || a) === want);
}

/**
 * Pick the style family.
 * - If tenantArtDirection is set and applies, use that family.
 * - For writer avatars: default to 'editorial-illustration' (consistent
 *   within a tenant), unless art direction overrides.
 * - For articles: pick deterministically from the category pool based on
 *   the concept hash.
 */
function pickStyle({ concept, category, articleType, tenantArtDirection }) {
  const parsed = parseArtDirection(tenantArtDirection);
  const surface = articleType === 'writer-avatar' ? 'avatars' : 'thumbnails';

  if (parsed && artDirectionApplies(parsed, surface)) {
    const forced = getStyleByName(parsed.style);
    if (forced) return forced;
  }

  if (articleType === 'writer-avatar') {
    return getStyleByName('editorial-illustration') || STYLE_FAMILIES[0];
  }

  const pool = getStylesForCategory(category);
  const name = hashPick(concept || category || 'default', pool);
  return getStyleByName(name) || STYLE_FAMILIES[0];
}

/**
 * Pick a mood. For articles: breaking/major/trending tier moods are
 * authoritative. For standard-tier or no-tier, content sentiment from
 * getVisualConcept() drives the mood when available, else falls back to the
 * tier pool or full random. For avatars: writer's tone if provided, else
 * 'contemplative'.
 */
function pickMood({ tier, articleType, writerTone, sentiment }) {
  if (articleType === 'writer-avatar') {
    if (writerTone) {
      const t = String(writerTone).toLowerCase();
      const hit = MOODS.find(m => t.includes(m));
      if (hit) return hit;
    }
    return 'contemplative';
  }

  // Breaking/major/trending: tier moods are authoritative — don't override
  if (tier && tier !== 'standard' && TIER_MOODS[tier]) {
    return randomPick(TIER_MOODS[tier]) || MOODS[0];
  }

  // Standard-tier or no tier: use content sentiment when available
  if (sentiment && MOODS.includes(sentiment)) {
    return sentiment;
  }

  // Fallback: standard tier pool or full random
  if (tier && TIER_MOODS[tier]) {
    return randomPick(TIER_MOODS[tier]) || MOODS[0];
  }
  return randomPick(MOODS) || MOODS[0];
}

function pickComposition({ articleType }) {
  if (articleType === 'writer-avatar') return AVATAR_COMPOSITION;
  return randomPick(COMPOSITIONS) || COMPOSITIONS[0];
}

/**
 * @param {object} opts
 * @param {string}  opts.concept            Concept text (from getVisualConcept or fallback)
 * @param {string=} opts.category           Article category (ignored for avatars)
 * @param {string=} opts.tier               Story-level tier: breaking|major|trending|standard
 * @param {string=} opts.sentiment          Content sentiment from getVisualConcept: urgent|analytical|contemplative|celebratory|cautionary|curious
 * @param {string|object=} opts.tenantArtDirection  Tenant override
 * @param {string=} opts.articleType        'article' | 'inline' | 'writer-avatar'
 * @param {string=} opts.writerTone         For avatars — optional tone descriptor
 * @param {string=} opts.customNotes        Freeform art-director notes prepended to the prompt (applied after concept, before style).
 * @param {string=} opts.styleOverride      Force a style family name (designer regenerations).
 * @param {string=} opts.moodOverride       Force a mood.
 * @param {string=} opts.compositionOverride Force a composition.
 * @returns {{ prompt: string, style: string, mood: string, composition: string, negativeApplied: string[] }}
 */
function composeImagePrompt({
  concept,
  category,
  tier,
  sentiment,
  tenantArtDirection,
  articleType = 'article',
  writerTone,
  customNotes,
  styleOverride,
  moodOverride,
  compositionOverride,
} = {}) {
  const safeConcept = (concept && String(concept).trim()) ||
    'A dramatic scene representing the story';

  const parsedAdEarly = parseArtDirection(tenantArtDirection);
  const surfaceEarly = articleType === 'writer-avatar' ? 'avatars' : 'thumbnails';
  const customPromptActive = !styleOverride
    && parsedAdEarly
    && parsedAdEarly.customPrompt
    && artDirectionApplies(parsedAdEarly, surfaceEarly);

  if (customPromptActive) {
    const adNotes = parsedAdEarly.notes ? String(parsedAdEarly.notes).trim() : '';
    const concept = safeConcept.replace(/\.+\s*$/, '');
    const customPart = String(parsedAdEarly.customPrompt).replace(/\.+\s*$/, '');
    const prompt = `${concept}. ${customPart}${adNotes ? '. ' + adNotes : ''}${customNotes ? '. ' + customNotes : ''}. ${NEGATIVE_TROPES.join(', ')}.`;
    return {
      prompt,
      style: '__custom__',
      mood: null,
      composition: null,
      customPromptUsed: true,
      negativeApplied: [...NEGATIVE_TROPES],
    };
  }

  const forcedStyle = styleOverride ? getStyleByName(styleOverride) : null;
  const style = forcedStyle || pickStyle({ concept: safeConcept, category, articleType, tenantArtDirection });
  const mood = moodOverride || pickMood({ tier, articleType, writerTone, sentiment });
  const composition = compositionOverride || pickComposition({ articleType });

  const isAvatar = articleType === 'writer-avatar';

  // Avatars use a shorter, avatar-relevant negative list. News-thumbnail
  // tropes (hooded hacker, corporate handshake, etc.) just add noise to a
  // portrait prompt and dilute the more important diptych/text negatives.
  const baseNegatives = isAvatar ? AVATAR_NEGATIVE_TROPES : NEGATIVE_TROPES;
  const negativeApplied = [...baseNegatives];
  if (style.negative) negativeApplied.unshift(style.negative);

  const parsedAd = parseArtDirection(tenantArtDirection);
  const adNotes = parsedAd && parsedAd.notes ? String(parsedAd.notes).trim() : '';
  const mergedNotes = [customNotes, adNotes].filter(Boolean).join('. ').trim();
  const notes = mergedNotes || null;

  // Imagen weights earlier tokens more, and weakly honors negatives. For
  // avatars, lead with strong positive single-image instructions so we
  // don't rely solely on "no diptych" to prevent split panels.
  const avatarPreamble = isAvatar
    ? 'A single portrait illustration showing one subject, centered, head and shoulders. One continuous image, no panels, no split compositions, no collages, no text overlays'
    : null;

  const parts = [
    avatarPreamble,
    safeConcept.replace(/\.+\s*$/, ''),
    isAvatar ? null : 'if any people are depicted, show diverse ethnicities, genders, and ages',
    notes,
    style.prompt,
    composition,
    `${mood} mood`,
    negativeApplied.join(', '),
  ].filter(Boolean);
  const prompt = parts.join('. ') + '.';

  return {
    prompt,
    style: style.name,
    mood,
    composition,
    negativeApplied,
  };
}

module.exports = {
  composeImagePrompt,
  parseArtDirection,
  // exported for tests / debugging
  _internal: { pickStyle, pickMood, pickComposition, hashPick },
};
