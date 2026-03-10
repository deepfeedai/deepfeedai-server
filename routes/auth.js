const express                   = require('express');
const router                    = express.Router();
const bcrypt                    = require('bcryptjs');
const jwt                       = require('jsonwebtoken');
const rateLimit                 = require('express-rate-limit');
const db                        = require('../db');
const { JWT_SECRET }            = require('../middleware/auth');
const { loginSchema, validate } = require('../lib/schemas');

// Rate limit: max 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true, // only count failures toward the limit
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const body = validate(loginSchema, req.body, res);
  if (!body) return;

  const { username, password } = body;
  const user = await db.prepare('SELECT * FROM users WHERE username = $1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: user.username });
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => res.json({ message: 'Logged out' }));

module.exports = router;
