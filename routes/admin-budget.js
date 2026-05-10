/**
 * Admin Budget API — daily news budget management.
 * Endpoints for viewing, generating, editing, and acting on Maxwell's editorial plan.
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');
const { generateDailyBudget, todayInTz } = require('../lib/news-budget');
const { getAppConfig } = require('../lib/app-config');
const { recordEvent } = require('../lib/newsroom-events');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch a budget row with all its slots (including writer name joins).
 * Returns null if not found or doesn't belong to tenantId.
 */
async function _getBudgetWithSlots(budgetId, tenantId) {
  const budget = await db.prepare(
    'SELECT * FROM news_budgets WHERE id = $1 AND tenant_id = $2'
  ).get(budgetId, tenantId);
  if (!budget) return null;

  const slots = await getPool().query(`
    SELECT
      nbs.*,
      rw.name  AS recommended_writer_name,
      rw.avatar_url AS recommended_writer_avatar,
      aw.name  AS assigned_writer_name,
      aw.avatar_url AS assigned_writer_avatar
    FROM news_budget_slots nbs
    LEFT JOIN writers rw ON rw.id = nbs.recommended_writer_id
    LEFT JOIN writers aw ON aw.id = nbs.assigned_writer_id
    WHERE nbs.budget_id = $1 AND nbs.tenant_id = $2
    ORDER BY nbs.sort_order ASC, nbs.id ASC
  `, [budgetId, tenantId]);

  return { ...budget, slots: slots.rows };
}

/**
 * Fetch a budget by date for a tenant. Returns the budget row (no slots) or null.
 */
async function _getBudgetByDate(tenantId, dateStr) {
  return db.prepare(
    'SELECT * FROM news_budgets WHERE tenant_id = $1 AND budget_date = $2'
  ).get(tenantId, dateStr);
}

/**
 * Create a story_pitches row from a budget slot.
 * Returns the created pitch row.
 */
async function _createPitchFromSlot(slot, tenantId) {
  const writerId = slot.assigned_writer_id || slot.recommended_writer_id;
  if (!writerId) {
    throw new Error('No writer assigned to slot — cannot create pitch');
  }

  const pitch = await db.prepare(`
    INSERT INTO story_pitches
      (tenant_id, writer_id, pitch_type, headline, reasoning, source_article_ids, target_publish_at, status)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'proposed')
    RETURNING *
  `).get(
    tenantId,
    writerId,
    slot.pitch_type || 'original',
    (slot.headline_suggestion || '').slice(0, 300),
    (slot.rationale || '').slice(0, 500),
    JSON.stringify(
      Array.isArray(slot.source_article_ids)
        ? slot.source_article_ids
        : (typeof slot.source_article_ids === 'string' ? JSON.parse(slot.source_article_ids || '[]') : [])
    ),
    slot.target_publish_at || null,
  );

  return pitch;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/admin/budget/today — return today's budget (no slots — light check)
router.get('/today', auth, asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const today = todayInTz(appCfg.newsroom_timezone || 'UTC');
  const budget = await _getBudgetByDate(req.tenantId, today);
  if (!budget) return res.json({ budget: null });
  const full = await _getBudgetWithSlots(budget.id, req.tenantId);
  res.json({ budget: full });
}));

// POST /api/admin/budget/generate — on-demand generation (idempotent)
// ?force=true deletes today's existing budget and regenerates from scratch
router.post('/generate', auth, asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const today = todayInTz(appCfg.newsroom_timezone || 'UTC');
  const force = req.query.force === 'true';

  const existing = await _getBudgetByDate(req.tenantId, today);
  if (existing) {
    if (!force) {
      const full = await _getBudgetWithSlots(existing.id, req.tenantId);
      return res.json({ budget: full, skipped: true, reason: 'already_exists' });
    }
    // Force: delete budget (slots cascade) so generateDailyBudget can recreate
    await db.prepare('DELETE FROM news_budgets WHERE id = $1 AND tenant_id = $2').run(existing.id, req.tenantId);
  }

  const result = await generateDailyBudget(req.tenantId);
  if (!result?.ok && !result?.budget_id) {
    return res.status(500).json({ error: result?.error || 'Budget generation failed' });
  }

  const budgetId = result.budget_id || result.skipped_id;
  const full = await _getBudgetWithSlots(budgetId, req.tenantId);
  res.json({ budget: full });
}));

// GET /api/admin/budget/actuals — published + scheduled articles for a date with slot linkage
router.get('/actuals', auth, asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const tz = appCfg.newsroom_timezone || 'UTC';
  const dateStr = req.query.date || todayInTz(tz);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
  }

  const [pubResult, schedResult] = await Promise.all([
    getPool().query(`
      SELECT
        a.id, a.title, a.slug, a.is_published, a.published_at, a.content_type,
        a.writer_id, w.name AS writer_name, w.avatar_url AS writer_avatar,
        nbs.id AS slot_id, nbs.priority AS slot_priority
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
      LEFT JOIN news_budget_slots nbs
        ON nbs.spawned_article_id = a.id AND nbs.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.is_published = 1
        AND a.published_at >= $2::date
        AND a.published_at < $2::date + INTERVAL '1 day'
      ORDER BY a.published_at ASC
    `, [req.tenantId, dateStr]),

    getPool().query(`
      SELECT
        a.id, a.title, a.slug, a.is_published, a.publish_at, a.content_type,
        a.writer_id, w.name AS writer_name, w.avatar_url AS writer_avatar,
        nbs.id AS slot_id, nbs.priority AS slot_priority
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
      LEFT JOIN news_budget_slots nbs
        ON nbs.spawned_article_id = a.id AND nbs.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.status = 'scheduled'
        AND a.is_published = 0
        AND a.publish_at >= $2::date
        AND a.publish_at < $2::date + INTERVAL '1 day'
      ORDER BY a.publish_at ASC
    `, [req.tenantId, dateStr]),
  ]);

  const cap    = appCfg.daily_publish_cap != null ? (parseInt(appCfg.daily_publish_cap, 10) || 0) : 6;
  const burst  = parseInt(appCfg.daily_publish_burst, 10) || 0;
  const effectiveCap = cap > 0 ? cap + burst : 0;
  const todayCount   = pubResult.rows.length;

  // Parse drop windows from config (same defaults as frontend)
  let windowList = [
    { label: '7 AM',  hhmm: '07:00' },
    { label: '12 PM', hhmm: '12:00' },
    { label: '6 PM',  hhmm: '18:00' },
  ];
  if (appCfg.drop_windows) {
    try {
      const arr = typeof appCfg.drop_windows === 'string'
        ? JSON.parse(appCfg.drop_windows)
        : appCfg.drop_windows;
      if (Array.isArray(arr) && arr.length) {
        windowList = arr.map(w => typeof w === 'string'
          ? { label: w, hhmm: w }
          : { label: w.label || w.hhmm || String(w), hhmm: w.hhmm || String(w) });
      }
    } catch (_) {}
  }

  const now = new Date();
  const dropWindows = windowList.map(w => {
    const iso = new Date(dateStr + 'T' + w.hhmm + ':00').toISOString();
    return { label: w.label, hhmm: w.hhmm, iso, fired: new Date(iso) < now };
  });

  res.json({
    published:    pubResult.rows,
    scheduled:    schedResult.rows,
    cap: {
      cap,
      burst,
      effective: effectiveCap,
      today:     todayCount,
      remaining: effectiveCap > 0 ? Math.max(0, effectiveCap - todayCount) : null,
    },
    drop_windows: dropWindows,
  });
}));

// GET /api/admin/budget — return budget for a date (defaults to today), with all slots
router.get('/', auth, asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const dateStr = req.query.date || todayInTz(appCfg.newsroom_timezone || 'UTC');

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
  }

  const budget = await _getBudgetByDate(req.tenantId, dateStr);
  if (!budget) return res.json({ budget: null });

  const full = await _getBudgetWithSlots(budget.id, req.tenantId);
  res.json({ budget: full });
}));

// PATCH /api/admin/budget/:id — update budget header (editorial_note, status)
router.patch('/:id', auth, asyncHandler(async (req, res) => {
  const budgetId = parseInt(req.params.id, 10);
  if (!budgetId) return res.status(400).json({ error: 'Invalid budget id' });

  const { editorial_note, status } = req.body;

  const existing = await db.prepare(
    'SELECT id FROM news_budgets WHERE id = $1 AND tenant_id = $2'
  ).get(budgetId, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Budget not found' });

  const allowed = ['draft', 'published'];
  if (status !== undefined && !allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const sets = ['updated_at = NOW()'];
  const params = [budgetId, req.tenantId];

  if (editorial_note !== undefined) {
    params.push(editorial_note);
    sets.push(`editorial_note = $${params.length}`);
  }
  if (status !== undefined) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }

  const budget = await db.prepare(
    `UPDATE news_budgets SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`
  ).get(...params);

  if (status === 'published') {
    recordEvent({
      tenantId: req.tenantId,
      type: 'budget_published',
      actorUserId: req.user?.sub || null,
      payload: { budget_id: budget.id, date: budget.budget_date },
    }).catch(() => {});
  }

  res.json({ budget });
}));

// POST /api/admin/budget/slots/:id/approve — approve a slot and create a pitch
router.post('/slots/:id/approve', auth, asyncHandler(async (req, res) => {
  const slot = await db.prepare(
    'SELECT * FROM news_budget_slots WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  if (slot.status === 'approved' || slot.status === 'auto_promoted') {
    return res.status(400).json({ error: 'Slot is already approved', slot });
  }

  let pitch;
  try {
    pitch = await _createPitchFromSlot(slot, req.tenantId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const updatedSlot = await db.prepare(`
    UPDATE news_budget_slots
    SET status = 'approved', spawned_pitch_id = $3, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `).get(slot.id, req.tenantId, pitch.id);

  // Fire newsroom event so the activity feed picks it up
  recordEvent({
    tenantId: req.tenantId,
    type: 'budget_slot_approved',
    actorUserId: req.user?.sub || null,
    targetPitchId: pitch.id,
    payload: {
      slot_id: slot.id,
      headline: slot.headline_suggestion,
      pitch_id: pitch.id,
    },
  }).catch(() => {});

  res.json({ slot: updatedSlot, pitch });
}));

// POST /api/admin/budget/slots/:id/reject — reject a slot
router.post('/slots/:id/reject', auth, asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const slot = await db.prepare(
    'SELECT id FROM news_budget_slots WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  const params = [req.params.id, req.tenantId];
  let editorialNoteClause = '';
  if (reason !== undefined) {
    params.push(String(reason).slice(0, 500));
    editorialNoteClause = `, editorial_note = $${params.length}`;
  }

  const updatedSlot = await db.prepare(
    `UPDATE news_budget_slots
     SET status = 'rejected'${editorialNoteClause}, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`
  ).get(...params);

  res.json({ slot: updatedSlot });
}));

// POST /api/admin/budget/:budgetId/slots — manually add a slot to a budget
router.post('/:budgetId/slots', auth, asyncHandler(async (req, res) => {
  const budgetId = parseInt(req.params.budgetId, 10);
  if (!budgetId) return res.status(400).json({ error: 'Invalid budget id' });

  const budget = await db.prepare(
    'SELECT id FROM news_budgets WHERE id = $1 AND tenant_id = $2'
  ).get(budgetId, req.tenantId);
  if (!budget) return res.status(404).json({ error: 'Budget not found' });

  const { headline_suggestion, priority = 'standard', rationale = '', assigned_writer_id } = req.body;
  if (!headline_suggestion || !String(headline_suggestion).trim()) {
    return res.status(400).json({ error: 'headline_suggestion is required' });
  }

  const VALID_PRIORITIES = ['lead', 'standard', 'brief', 'hold'];
  if (!VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }

  const slot = await db.prepare(`
    INSERT INTO news_budget_slots
      (tenant_id, budget_id, priority, headline_suggestion, rationale, assigned_writer_id, status, source_article_ids, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', '[]'::jsonb,
      COALESCE((SELECT MAX(sort_order) + 1 FROM news_budget_slots WHERE budget_id = $2 AND tenant_id = $1), 0))
    RETURNING *
  `).get(
    req.tenantId,
    budgetId,
    priority,
    String(headline_suggestion).slice(0, 300),
    String(rationale).slice(0, 1000),
    assigned_writer_id ? parseInt(assigned_writer_id) : null,
  );

  res.json({ slot });
}));

// PATCH /api/admin/budget/slots/:id — edit slot fields
router.patch('/slots/:id', auth, asyncHandler(async (req, res) => {
  const { headline_suggestion, rationale, assigned_writer_id, target_publish_at, priority } = req.body;

  const existing = await db.prepare(
    'SELECT id FROM news_budget_slots WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Slot not found' });

  const sets = ['updated_at = NOW()'];
  const params = [req.params.id, req.tenantId];

  if (headline_suggestion !== undefined) {
    params.push(String(headline_suggestion).slice(0, 500));
    sets.push(`headline_suggestion = $${params.length}`);
  }
  if (rationale !== undefined) {
    params.push(String(rationale).slice(0, 1000));
    sets.push(`rationale = $${params.length}`);
  }
  if (assigned_writer_id !== undefined) {
    params.push(assigned_writer_id ? parseInt(assigned_writer_id) : null);
    sets.push(`assigned_writer_id = $${params.length}`);
  }
  if (target_publish_at !== undefined) {
    params.push(target_publish_at || null);
    sets.push(`target_publish_at = $${params.length}`);
  }
  if (priority !== undefined) {
    const VALID_PRIORITIES = ['lead', 'standard', 'brief', 'hold'];
    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
    }
    params.push(priority);
    sets.push(`priority = $${params.length}`);
  }

  const updatedSlot = await db.prepare(
    `UPDATE news_budget_slots SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`
  ).get(...params);

  res.json({ slot: updatedSlot });
}));

// POST /api/admin/budget/slots/:id/reassign — reassign a slot to a different writer
router.post('/slots/:id/reassign', auth, asyncHandler(async (req, res) => {
  const { writer_id } = req.body;
  if (!writer_id) return res.status(400).json({ error: 'writer_id is required' });

  const slot = await db.prepare(
    'SELECT id FROM news_budget_slots WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  // Validate writer belongs to this tenant
  const writer = await db.prepare(
    'SELECT id FROM writers WHERE id = $1 AND tenant_id = $2'
  ).get(parseInt(writer_id), req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const updatedSlot = await db.prepare(`
    UPDATE news_budget_slots
    SET assigned_writer_id = $3, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `).get(slot.id, req.tenantId, parseInt(writer_id));

  res.json({ slot: updatedSlot });
}));

module.exports = router;
