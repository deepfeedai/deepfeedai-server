/**
 * Deep Feed AI Admin — middleware/auth.js
 * Central JWT authentication middleware.
 * All protected routes import this instead of duplicating auth logic.
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

/**
 * Express middleware — verifies the Bearer token in Authorization header.
 * Attaches decoded payload to req.user on success.
 */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { auth, JWT_SECRET };
