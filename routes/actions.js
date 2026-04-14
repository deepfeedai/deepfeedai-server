/**
 * Deep Feed AI — /api/actions (PR-B of notifications/actions system)
 *
 * Single cross-channel endpoint. No auth middleware — the signed token IS the
 * auth. Flow:
 *   1. verifyAndBurn(token, source) — throws invalid_token / already_used / expired
 *   2. Feature-flag check (cross_channel_actions) scoped to row.tenant_id
 *   3. Dispatch by action_kind to lib/actions/handlers.js
 *   4. logAudit with actor=row.user_id + source
 */
'use strict';

const express = require('express');
const router  = express.Router();

const { asyncHandler } = require('../lib/utils');
const { verifyAndBurn } = require('../lib/action-tokens');
const { getHandler } = require('../lib/actions/handlers');
const { isFeatureEnabled } = require('../lib/feature-registry');
const { logAudit } = require('../middleware/audit');

// Map handler-thrown errors to HTTP status codes.
function statusFor(err) {
  const m = err && err.message;
  if (m === 'invalid_token') return 404;
  if (m === 'already_used')  return 410;
  if (m === 'expired')       return 410;
  if (m === 'cross_tenant' || m === 'cross_user') return 403;
  if (m && /_not_found$/.test(m)) return 404;
  if (m === 'writer_id_required') return 400;
  return 400;
}

router.post('/:token', asyncHandler(async (req, res) => {
  const raw = req.params.token;
  const source = (req.body && typeof req.body.source === 'string' && req.body.source) || 'web';

  // 1. Verify + burn (atomic single-use enforcement).
  let row;
  try {
    row = await verifyAndBurn(raw, source);
  } catch (err) {
    return res.status(statusFor(err)).json({ error: err.message });
  }

  // 2. Feature flag — scoped to the tenant inside the token.
  const enabled = await isFeatureEnabled(row.tenant_id, 'cross_channel_actions').catch(() => false);
  if (!enabled) {
    return res.status(403).json({ error: 'cross_channel_actions_disabled' });
  }

  // 3. Dispatch.
  const handler = getHandler(row.action_kind);
  if (!handler) {
    return res.status(400).json({ error: `unknown_action_kind:${row.action_kind}` });
  }

  let result;
  try {
    result = await handler(row, req);
  } catch (err) {
    // Audit even on failure so we can see replay/abuse attempts.
    const pseudoReq = {
      user: { sub: row.user_id },
      tenantId: row.tenant_id,
      headers: req.headers,
      ip: req.ip,
    };
    logAudit(pseudoReq, `${row.action_kind}.failed`, row.target_type || 'action',
      row.target_id || row.id,
      { source, error: err.message }).catch(() => {});
    return res.status(statusFor(err)).json({ error: err.message });
  }

  // 4. Audit success.
  const pseudoReq = {
    user: { sub: row.user_id },
    tenantId: row.tenant_id,
    headers: req.headers,
    ip: req.ip,
  };
  logAudit(pseudoReq, row.action_kind, row.target_type || 'action',
    row.target_id || row.id,
    { source, ok: result.ok, via: 'action_token' });

  const status = result.ok ? 200 : 409;
  return res.status(status).json(result);
}));

module.exports = router;
