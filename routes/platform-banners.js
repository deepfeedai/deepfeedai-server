/**
 * Deep Feed AI — /api/platform/banners
 * Platform-level (global) banner management — platform admins only.
 * Global banners have tenant_id = NULL and are shown to ALL tenants.
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth: requireAdmin }      = require('../middleware/auth');
const { requirePlatformAdmin }    = require('../middleware/permissions');
const { asyncHandler }            = require('../lib/utils');
const { logAudit }                = require('../middleware/audit');
const { bustBannerCache }         = require('./banners');

// ── GET /api/platform/banners — list all global banners ──────────
router.get('/', requireAdmin, requirePlatformAdmin, asyncHandler(async (_req, res) => {
  const rows = await db.prepare(`
    SELECT * FROM banners WHERE tenant_id IS NULL ORDER BY created_at DESC
  `).all();
  res.json(rows);
}));

// ── POST /api/platform/banners — create global banner ────────────
router.post('/', requireAdmin, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const { message, type, linkText, linkUrl, dismissible, priority, startsAt, expiresAt } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (linkUrl && !/^(https?:\/\/|\/)/.test(linkUrl)) {
    return res.status(400).json({ error: 'linkUrl must be a relative path or http(s) URL' });
  }

  const row = await db.prepare(`
    INSERT INTO banners (tenant_id, message, type, link_text, link_url, dismissible, priority, starts_at, expires_at)
    VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `).get(
    message.trim(),
    type || 'info',
    linkText || null,
    linkUrl || null,
    dismissible !== false,
    priority || 0,
    startsAt || null,
    expiresAt || null
  );

  bustBannerCache(null); // bust all caches since global affects everyone
  logAudit(req, 'banner.global.create', 'banners', row.id, { message: message.trim(), type: type || 'info' });
  res.status(201).json(row);
}));

// ── PUT /api/platform/banners/:id — update global banner ─────────
router.put('/:id', requireAdmin, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message, type, linkText, linkUrl, dismissible, isActive, priority, startsAt, expiresAt } = req.body;

  const existing = await db.prepare('SELECT id FROM banners WHERE id = $1 AND tenant_id IS NULL').get(id);
  if (!existing) return res.status(404).json({ error: 'Global banner not found' });

  await db.prepare(`
    UPDATE banners SET
      message     = COALESCE($1, message),
      type        = COALESCE($2, type),
      link_text   = $3,
      link_url    = $4,
      dismissible = COALESCE($5, dismissible),
      is_active   = COALESCE($6, is_active),
      priority    = COALESCE($7, priority),
      starts_at   = $8,
      expires_at  = $9
    WHERE id = $10 AND tenant_id IS NULL
  `).run(
    message || null, type || null,
    linkText !== undefined ? linkText : null,
    linkUrl !== undefined ? linkUrl : null,
    dismissible !== undefined ? dismissible : null,
    isActive !== undefined ? isActive : null,
    priority !== undefined ? priority : null,
    startsAt !== undefined ? startsAt : null,
    expiresAt !== undefined ? expiresAt : null,
    id
  );

  bustBannerCache(null);
  logAudit(req, 'banner.global.update', 'banners', parseInt(id), { message, type, isActive });

  const updated = await db.prepare('SELECT * FROM banners WHERE id = $1').get(id);
  res.json(updated);
}));

// ── DELETE /api/platform/banners/:id — delete global banner ──────
router.delete('/:id', requireAdmin, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT id, message FROM banners WHERE id = $1 AND tenant_id IS NULL').get(id);
  if (!existing) return res.status(404).json({ error: 'Global banner not found' });

  await db.prepare('DELETE FROM banners WHERE id = $1 AND tenant_id IS NULL').run(id);
  bustBannerCache(null);
  logAudit(req, 'banner.global.delete', 'banners', parseInt(id), { message: existing.message });
  res.json({ message: 'Global banner deleted' });
}));

module.exports = router;
