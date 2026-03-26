/**
 * Deep Feed AI — /api/banners
 * Banner notification system — global (platform-wide) + tenant-specific banners.
 *
 * Public:  GET /api/banners/active — returns active banners (global + tenant)
 * Admin:   POST/PUT/DELETE /api/banners — tenant banner CRUD
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth: requireAdmin }    = require('../middleware/auth');
const { requirePermission }     = require('../middleware/permissions');
const { asyncHandler }          = require('../lib/utils');
const { logAudit }              = require('../middleware/audit');
const { requireFeature }        = require('../middleware/feature-gate');

// ── In-memory cache ──────────────────────────────────────────────
const _cache = new Map();   // tenantId -> { banners, ts }
const CACHE_TTL = 60 * 1000;

function bustBannerCache(tenantId) {
  if (tenantId == null) {
    // Global banner changed — affects all tenants, clear everything
    _cache.clear();
  } else {
    _cache.delete(tenantId);
  }
}

// ── GET /api/banners/active — public ─────────────────────────────
// Returns active, non-expired banners: global (tenant_id IS NULL) + current tenant.
// Ordered by priority DESC, created_at DESC.
router.get('/active', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;

  // Check cache for tenant-specific result
  const cacheKey = tenantId || 'default';
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.banners);
  }

  const rows = await db.prepare(`
    SELECT id, tenant_id, message, type, link_text, link_url, dismissible, priority,
           starts_at, expires_at, created_at
    FROM banners
    WHERE is_active = true
      AND (starts_at IS NULL OR starts_at <= NOW())
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (tenant_id IS NULL OR tenant_id = $1)
    ORDER BY
      CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END,
      priority DESC,
      created_at DESC
    LIMIT 10
  `).all(tenantId);

  const banners = rows.map(r => ({
    id:          r.id,
    scope:       r.tenant_id == null ? 'global' : 'tenant',
    message:     r.message,
    type:        r.type,
    linkText:    r.link_text,
    linkUrl:     r.link_url,
    dismissible: r.dismissible !== false && r.dismissible !== 0,
    priority:    r.priority,
    startsAt:    r.starts_at,
    expiresAt:   r.expires_at,
    createdAt:   r.created_at,
  }));

  _cache.set(cacheKey, { banners, ts: Date.now() });
  res.json(banners);
}));

// ── POST /api/banners — create tenant banner ─────────────────────
router.post('/', requireAdmin, requirePermission('settings.update'), requireFeature('banners'), asyncHandler(async (req, res) => {
  const { message, type, linkText, linkUrl, dismissible, priority, startsAt, expiresAt } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (linkUrl && !/^(https?:\/\/|\/)/.test(linkUrl)) {
    return res.status(400).json({ error: 'linkUrl must be a relative path or http(s) URL' });
  }

  const row = await db.prepare(`
    INSERT INTO banners (tenant_id, message, type, link_text, link_url, dismissible, priority, starts_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `).get(
    req.tenantId,
    message.trim(),
    type || 'info',
    linkText || null,
    linkUrl || null,
    dismissible !== false,
    priority || 0,
    startsAt || null,
    expiresAt || null
  );

  bustBannerCache(req.tenantId);
  logAudit(req, 'banner.create', 'banners', row.id, { message: message.trim(), type: type || 'info' });
  res.status(201).json(row);
}));

// ── PUT /api/banners/:id — update tenant banner ─────────────────
router.put('/:id', requireAdmin, requirePermission('settings.update'), requireFeature('banners'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message, type, linkText, linkUrl, dismissible, isActive, priority, startsAt, expiresAt } = req.body;

  // Verify ownership
  const existing = await db.prepare('SELECT id FROM banners WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Banner not found' });

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
    WHERE id = $10 AND tenant_id = $11
  `).run(
    message || null, type || null,
    linkText !== undefined ? linkText : null,
    linkUrl !== undefined ? linkUrl : null,
    dismissible !== undefined ? dismissible : null,
    isActive !== undefined ? isActive : null,
    priority !== undefined ? priority : null,
    startsAt !== undefined ? startsAt : null,
    expiresAt !== undefined ? expiresAt : null,
    id, req.tenantId
  );

  bustBannerCache(req.tenantId);
  logAudit(req, 'banner.update', 'banners', parseInt(id), { message, type, isActive });

  const updated = await db.prepare('SELECT * FROM banners WHERE id = $1').get(id);
  res.json(updated);
}));

// ── DELETE /api/banners/:id — delete tenant banner ───────────────
router.delete('/:id', requireAdmin, requirePermission('settings.update'), requireFeature('banners'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT id, message FROM banners WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Banner not found' });

  await db.prepare('DELETE FROM banners WHERE id = $1 AND tenant_id = $2').run(id, req.tenantId);
  bustBannerCache(req.tenantId);
  logAudit(req, 'banner.delete', 'banners', parseInt(id), { message: existing.message });
  res.json({ message: 'Banner deleted' });
}));

// ── GET /api/banners — list all tenant banners (admin) ───────────
router.get('/', requireAdmin, requirePermission('settings.read'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT * FROM banners WHERE tenant_id = $1 ORDER BY created_at DESC
  `).all(req.tenantId);
  res.json(rows);
}));

module.exports = { router, bustBannerCache };
