/**
 * Newsroom user preferences — skin, font, pinned pages.
 * Scoped to (user_id, tenant_id) so each admin user has their own prefs per tenant.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');

const VALID_SKINS = new Set(['ink', 'daylight', 'wire', 'broadsheet', 'tabloid']);
const VALID_FONTS = new Set(['system', 'newsprint', 'modern', 'terminal', 'classic']);

// GET /api/newsroom-prefs — return current user's prefs (defaults if none saved)
router.get('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No user identity in token' });

  const row = await db.prepare(
    'SELECT skin, font, pinned FROM newsroom_prefs WHERE user_id = $1 AND tenant_id = $2'
  ).get(userId, req.tenantId);

  if (!row) {
    return res.json({ skin: 'ink', font: 'system', pinned: [] });
  }

  const pinned = Array.isArray(row.pinned)
    ? row.pinned
    : (typeof row.pinned === 'string' ? JSON.parse(row.pinned || '[]') : []);

  res.json({ skin: row.skin || 'ink', font: row.font || 'system', pinned });
}));

// PUT /api/newsroom-prefs — upsert prefs (partial updates supported)
router.put('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No user identity in token' });

  const { skin, font, pinned } = req.body;

  if (skin !== undefined && !VALID_SKINS.has(skin)) {
    return res.status(400).json({ error: `skin must be one of: ${[...VALID_SKINS].join(', ')}` });
  }
  if (font !== undefined && !VALID_FONTS.has(font)) {
    return res.status(400).json({ error: `font must be one of: ${[...VALID_FONTS].join(', ')}` });
  }
  if (pinned !== undefined && !Array.isArray(pinned)) {
    return res.status(400).json({ error: 'pinned must be an array' });
  }

  const skinVal   = skin   !== undefined ? skin   : null;
  const fontVal   = font   !== undefined ? font   : null;
  const pinnedVal = pinned !== undefined ? JSON.stringify(pinned) : null;

  // UPSERT: insert defaults on first use, then update only the provided fields
  const row = await db.prepare(`
    INSERT INTO newsroom_prefs (user_id, tenant_id, skin, font, pinned)
    VALUES ($1, $2,
      COALESCE($3, 'ink'),
      COALESCE($4, 'system'),
      COALESCE($5::jsonb, '[]'::jsonb)
    )
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET
      skin       = COALESCE($3, newsroom_prefs.skin),
      font       = COALESCE($4, newsroom_prefs.font),
      pinned     = COALESCE($5::jsonb, newsroom_prefs.pinned),
      updated_at = NOW()
    RETURNING skin, font, pinned
  `).get(userId, req.tenantId, skinVal, fontVal, pinnedVal);

  const pinnedOut = Array.isArray(row.pinned)
    ? row.pinned
    : (typeof row.pinned === 'string' ? JSON.parse(row.pinned || '[]') : []);

  res.json({ skin: row.skin, font: row.font, pinned: pinnedOut });
}));

module.exports = router;
