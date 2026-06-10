'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { getAppConfig } = require('../lib/app-config');
const { todayInTz } = require('../lib/news-budget');
const {
  runEditorialIntelligence,
  listEditorialIntelligence,
  setBriefStatus,
  promoteBriefToRunsheetSlot,
} = require('../lib/editorial-intelligence');

function dateForReq(req, fallbackTz = 'UTC') {
  const raw = req.query.date || req.body?.date;
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return String(raw);
  return todayInTz(fallbackTz);
}

// GET /api/admin/editorial-intelligence/candidates?date=YYYY-MM-DD
router.get('/candidates', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const cfg = await getAppConfig(req.tenantId).catch(() => ({}));
  const date = dateForReq(req, cfg.newsroom_timezone || 'UTC');
  const result = await listEditorialIntelligence(req.tenantId, { date });
  res.json(result);
}));

// POST /api/admin/editorial-intelligence/run
router.post('/run', requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const cfg = await getAppConfig(req.tenantId).catch(() => ({}));
  const date = dateForReq(req, cfg.newsroom_timezone || 'UTC');
  const result = await runEditorialIntelligence(req.tenantId, {
    date,
    lookbackHours: req.body?.lookbackHours,
    limit: req.body?.limit,
  });
  res.json(result);
}));

// POST /api/admin/editorial-intelligence/briefs/:id/approve
router.post('/briefs/:id/approve', requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const brief = await setBriefStatus(req.params.id, req.tenantId, 'approved');
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  res.json({ brief });
}));

// POST /api/admin/editorial-intelligence/briefs/:id/reject
router.post('/briefs/:id/reject', requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const brief = await setBriefStatus(req.params.id, req.tenantId, 'rejected');
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  res.json({ brief });
}));

// POST /api/admin/editorial-intelligence/briefs/:id/add-to-runsheet
router.post('/briefs/:id/add-to-runsheet', requirePermission('articles.create'), asyncHandler(async (req, res) => {
  try {
    const result = await promoteBriefToRunsheetSlot(req.params.id, req.body?.budget_id || null, req.tenantId, {
      date: req.body?.date,
      allowProposed: req.body?.allow_proposed === true,
    });
    if (!result) return res.status(404).json({ error: 'Brief or budget not found' });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

module.exports = router;
