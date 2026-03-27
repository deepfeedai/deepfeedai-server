/**
 * Deep Feed AI — Feature Gate Middleware
 * Express middleware to check if a feature is enabled for the current tenant.
 */
'use strict';

const { isFeatureEnabled } = require('../lib/feature-registry');

/**
 * Middleware factory: returns 403 if the feature is not enabled for req.tenantId.
 * @param {string} featureKey — feature key from feature_definitions
 */
function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const enabled = await isFeatureEnabled(req.tenantId, featureKey);
      if (!enabled) {
        return res.status(403).json({
          error: 'Feature not available on your plan',
          feature: featureKey,
          upgrade: true,
        });
      }
      next();
    } catch (err) {
      // On error, fail closed — do not expose gated features during DB outage
      console.error(`[feature-gate] Error checking feature '${featureKey}':`, err.message);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  };
}

module.exports = { requireFeature };
