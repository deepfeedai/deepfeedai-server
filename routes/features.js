/**
 * Deep Feed AI — /api/features
 * Public endpoint returning resolved feature flags for the current tenant.
 * No admin auth required — uses tenant middleware to resolve tenantId.
 */
const express = require('express');
const router  = express.Router();
const { asyncHandler } = require('../lib/utils');
const { getFlatFeatures } = require('../lib/feature-registry');

// GET /api/features — flat key→value map for the current tenant
router.get('/', asyncHandler(async (req, res) => {
  const features = await getFlatFeatures(req.tenantId);
  res.json(features);
}));

module.exports = router;
