/**
 * Deep Feed AI Admin — GET /api/site-config
 * Public endpoint (no auth) — returns all site_* settings as a JSON object.
 */
const express = require('express');
const router  = express.Router();
const { getSiteConfig } = require('../lib/site-config');
const { asyncHandler }  = require('../lib/utils');

router.get('/', asyncHandler(async (req, res) => {
  const config = await getSiteConfig(req.tenantId);
  res.json(config);
}));

module.exports = router;
