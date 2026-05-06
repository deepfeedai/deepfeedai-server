/**
 * Deep Feed AI — /api/waitlist
 * Public waitlist signup + platform-admin management endpoints.
 */
const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const { asyncHandler }        = require('../lib/utils');
const { auth }                = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/permissions');
const { sendWaitlistOpenEmail } = require('../lib/notify');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Please try again later.' },
});

// POST /api/waitlist — join waitlist (public)
router.post('/', waitlistLimiter, asyncHandler(async (req, res) => {
  const { email, name, source } = req.body || {};

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  const clean = email.toLowerCase().trim();
  const safeName = name ? String(name).replace(/<[^>]*>/g, '').trim().slice(0, 100) : null;
  const safeSource = ['signup', 'product', 'docs', 'blog'].includes(source) ? source : 'signup';

  await db.prepare(`
    INSERT INTO waitlist (email, name, source)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO NOTHING
  `).run(clean, safeName, safeSource);

  res.json({ status: 'ok', message: "You're on the list! We'll let you know as soon as signups open." });
}));

// GET /api/waitlist — list entries, platform admin only
router.get('/', auth, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, email, name, source, created_at, notified_at, converted_at
    FROM waitlist
    ORDER BY created_at DESC
  `).all();

  const pending = rows.filter(r => !r.notified_at).length;
  res.json({ waitlist: rows, total: rows.length, pending });
}));

// POST /api/waitlist/notify — email all un-notified entries, platform admin only
router.post('/notify', auth, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const pending = await db.prepare(`
    SELECT id, email, name FROM waitlist
    WHERE notified_at IS NULL
    ORDER BY created_at ASC
  `).all();

  if (pending.length === 0) {
    return res.json({ sent: 0, total: 0, message: 'No pending entries to notify.' });
  }

  let sent = 0;
  const errors = [];

  for (const entry of pending) {
    try {
      await sendWaitlistOpenEmail({ toEmail: entry.email, toName: entry.name });
      await db.prepare('UPDATE waitlist SET notified_at = NOW() WHERE id = $1').run(entry.id);
      sent++;
    } catch (err) {
      errors.push({ email: entry.email, error: err.message });
      console.error('[Waitlist notify]', entry.email, err.message);
    }
  }

  res.json({ sent, total: pending.length, errors: errors.length ? errors : undefined });
}));

// DELETE /api/waitlist/:id — remove an entry, platform admin only
router.delete('/:id', auth, requirePlatformAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  await db.prepare('DELETE FROM waitlist WHERE id = $1').run(id);
  res.json({ status: 'ok' });
}));

module.exports = router;
