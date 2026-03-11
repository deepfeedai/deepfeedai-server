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

const USER_JWT_SECRET = process.env.USER_JWT_SECRET;

module.exports = function requireUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!USER_JWT_SECRET) {
    return res.status(503).json({ error: 'User auth not configured' });
  }

  try {
    req.user = jwt.verify(auth.slice(7), USER_JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};
