/**
 * Deep Feed AI — middleware/user-jwt.js
 * Verifies public user JWTs (separate from admin JWT_SECRET).
 * Attaches decoded payload to req.user on success.
 *
 * Usage:
 *   const requireUser = require('../middleware/user-jwt');
 *   router.post('/comments', requireUser, handler);
 */

'use strict';

const jwt = require('jsonwebtoken');
const { getSecrets } = require('../lib/secrets');

module.exports = async function requireUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { userJwtSecret } = await getSecrets();

  try {
    req.user = jwt.verify(auth.slice(7), userJwtSecret);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};
