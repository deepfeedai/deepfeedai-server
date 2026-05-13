/**
 * Admin Budget API — daily news budget management.
 * Endpoints for viewing, generating, editing, and acting on Maxwell's editorial plan.
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { generateDailyBudget, todayInTz } = require('../lib/news-budget');
const { getAppConfig } = require('../lib/app-config');
const { recordEvent, emitPitchProposed } = require('../lib/newsroom-events');

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
      rw.name        AS recommended_writer_name,
      rw.avatar_url  AS recommended_writer_avatar,
      aw.name        AS assigned_writer_name,
      aw.avatar_url  AS assigned_writer_avatar,
      sp.id          AS pitch_id,
      sp.status      AS pitch_status,
      a.id           AS article_id,
      a.title        AS article_title,
      a.slug         AS article_slug,
      a.is_published AS article_is_published,
      a.status       AS article_status
    FROM news_budget_slots nbs
    LEFT JOIN writers rw       ON rw.id = nbs.recommended_writer_id
    LEFT JOIN writers aw       ON aw.id = nbs.assigned_writer_id
    LEFT JOIN story_pitches sp ON sp.id = nbs.spawned_pitch_id  AND sp.tenant_id = nbs.tenant_id
    LEFT JOIN articles a       ON a.id  = nbs.spawned_article_id AND a.tenant_id  = nbs.tenant_id
    WHERE nbs.budget_id = $1 AND nbs.tenant_id = $2
    ORDER BY nbs.sort_order ASC, nbs.id ASC
  `, [budgetId, tenantId]);

  // Annotate each slot with whether its sources are wire/curated so the UI
  // can show a badge before the editor approves.
  const rows = slots.rows;
  const allIds = [];
  rows.forEach(s => {
    const ids = Array.isArray(s.source_article_ids)
      ? s.source_article_ids
      : (typeof s.source_article_ids === 'string' ? JSON.parse(s.source_article_ids || '[]') : []);
    ids.forEach(id => { if (id) allIds.push(Number(id)); });
  });

  let sourceTypeMap = {};
  if (allIds.length) {
    const srcRes = await getPool().query(
      'SELECT id, content_type FROM articles WHERE id = ANY($1) AND tenant_id = $2',
      [allIds, tenantId]
    );
    srcRes.rows.forEach(r => { sourceTypeMap[r.id] = r.content_type; });
  }

  const annotated = rows.map(s => {
    const ids = Array.isArray(s.source_article_ids)
      ? s.source_article_ids
      : (typeof s.source_article_ids === 'string' ? JSON.parse(s.source_article_ids || '[]') : []);
    const hasWire = ids.some(id => {
      const ct = sourceTypeMap[Number(id)];
      return !ct || ct === 'curated' || ct === 'wire';
    });
    return { ...s, has_wire_sources: hasWire };
  });

  return { ...budget, slots: annotated };
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
router.get('/today', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const today = todayInTz(appCfg.newsroom_timezone || 'UTC');
  const budget = await _getBudgetByDate(req.tenantId, today);
  if (!budget) return res.json({ budget: null });
  const full = await _getBudgetWithSlots(budget.id, req.tenantId);
  res.json({ budget: full });
}));

// POST /api/admin/budget/generate — on-demand generation (idempotent)
// ?force=true regenerates the runsheet but preserves approved/rejected slots
router.post('/generate', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const today = todayInTz(appCfg.newsroom_timezone || 'UTC');
  const force = req.query.force === 'true';

  const existing = await _getBudgetByDate(req.tenantId, today);
  if (existing) {
    if (!force) {
      const full = await _getBudgetWithSlots(existing.id, req.tenantId);
      return res.json({ budget: full, skipped: true, reason: 'already_exists' });
    }
    // Preserve non-pending slots so approved/rejected decisions survive the regen
    const preserved = await db.prepare(`
      SELECT priority, pitch_type, topic_tag, headline_suggestion, rationale,
             assigned_writer_id, recommended_writer_id, target_publish_at,
             source_article_ids, sort_order, status, spawned_article_id
      FROM news_budget_slots
      WHERE budget_id = $1 AND tenant_id = $2 AND status NOT IN ('pending')
    `).all(existing.id, req.tenantId);

    // Delete budget (slots cascade)
    await db.prepare('DELETE FROM news_budgets WHERE id = $1 AND tenant_id = $2').run(existing.id, req.tenantId);

    const result = await generateDailyBudget(req.tenantId);
    if (!result?.ok && !result?.budget_id) {
      return res.status(500).json({ error: result?.error || 'Budget generation failed' });
    }

    // Re-insert preserved slots into the new budget
    const newBudgetId = result.budget_id;
    for (const s of preserved) {
      await db.prepare(`
        INSERT INTO news_budget_slots
          (budget_id, tenant_id, priority, pitch_type, topic_tag, headline_suggestion,
           rationale, assigned_writer_id, recommended_writer_id, target_publish_at,
           source_article_ids, sort_order, status, spawned_article_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
      `).run(
        newBudgetId, req.tenantId,
        s.priority, s.pitch_type, s.topic_tag, s.headline_suggestion,
        s.rationale, s.assigned_writer_id, s.recommended_writer_id,
        s.target_publish_at,
        typeof s.source_article_ids === 'string' ? s.source_article_ids : JSON.stringify(s.source_article_ids || []),
        s.sort_order, s.status, s.spawned_article_id,
      );
    }

    const full = await _getBudgetWithSlots(newBudgetId, req.tenantId);
    return res.json({ budget: full });
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
router.get('/actuals', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const tz = appCfg.newsroom_timezone || 'UTC';
  const dateStr = req.query.date || todayInTz(tz);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
  }

  const [pubResult, schedResult, deepDiveResult] = await Promise.all([
    // Published originals for the selected calendar day
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
        AND a.content_type = 'original'
        AND a.published_at >= $2::date
        AND a.published_at < $2::date + INTERVAL '1 day'
      ORDER BY a.published_at ASC
    `, [req.tenantId, dateStr]),

    // Scheduled originals for the selected calendar day
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
        AND a.content_type = 'original'
        AND a.publish_at >= $2::date
        AND a.publish_at < $2::date + INTERVAL '1 day'
      ORDER BY a.publish_at ASC
    `, [req.tenantId, dateStr]),

    // Deep dives published in the last 7 days — shown independently of the daily plan
    getPool().query(`
      SELECT
        a.id, a.title, a.slug, a.is_published, a.published_at, a.content_type,
        a.writer_id, a.category,
        w.name AS writer_name, w.avatar_url AS writer_avatar
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.is_published = 1
        AND a.content_type = 'deep-dive'
        AND a.published_at >= NOW() - INTERVAL '7 days'
      ORDER BY a.published_at DESC
    `, [req.tenantId]),
  ]);

  const cap    = appCfg.daily_publish_cap != null ? (parseInt(appCfg.daily_publish_cap, 10) || 0) : 6;
  const burst  = parseInt(appCfg.daily_publish_burst, 10) || 0;
  const effectiveCap = cap > 0 ? cap + burst : 0;
  // Count deep dives published on the selected calendar day using the newsroom timezone
  // (not UTC) so late-night articles don't bleed into the next day's cap.
  const todayDeepDiveCount = deepDiveResult.rows.filter(a => {
    if (!a.published_at) return false;
    const d = a.published_at instanceof Date ? a.published_at : new Date(a.published_at);
    return d.toLocaleDateString('en-CA', { timeZone: tz }) === dateStr;
  }).length;
  const todayCount = pubResult.rows.length + todayDeepDiveCount;

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
    deep_dives:   deepDiveResult.rows,
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
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
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
router.patch('/:id', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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
router.post('/slots/:id/approve', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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
  emitPitchProposed(pitch, req.tenantId).catch(() => {});

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
router.post('/slots/:id/reject', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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
router.post('/:budgetId/slots', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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
router.patch('/slots/:id', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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
router.post('/slots/:id/reassign', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
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

// POST /api/admin/budget/briefing/generate — manually trigger an edition
router.post('/briefing/generate', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const { generateDailyBriefing, EDITION_CONFIG } = require('../lib/daily-briefing');
  const force   = req.body?.force === true;
  const edition = EDITION_CONFIG[req.body?.edition] ? req.body.edition : 'evening';
  const date    = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : undefined;
  const result  = await generateDailyBriefing(req.tenantId, { force, edition, date });
  if (!result.ok && result.reason !== 'already_exists') {
    // User-fixable conditions → 422; system failures → 500
    const userFixable = ['no_articles', 'no_voice', 'budget_exceeded'];
    const status = userFixable.includes(result.reason) ? 422 : 500;
    return res.status(status).json({ error: result.reason || 'generation_failed' });
  }
  res.json(result);
}));

// GET /api/admin/budget/briefing — today's all-edition briefing status for the admin UI
router.get('/briefing', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { getAppConfig: _cfg } = require('../lib/app-config');
  const { getTodayBriefings }  = require('../lib/daily-briefing');
  const appCfg = await _cfg(req.tenantId).catch(() => ({}));
  const tz = appCfg.newsroom_timezone || 'UTC';
  const dateParam = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
  const briefings = await getTodayBriefings(req.tenantId, tz, dateParam);
  // Include site_url so the admin can construct shareable public links
  const siteUrlRow = await db.prepare("SELECT value FROM settings WHERE tenant_id = $1 AND key = 'site_url'").get(req.tenantId);
  res.json({ briefings, site_url: siteUrlRow?.value || null });
}));

// DELETE /api/admin/budget/briefing/:edition — delete a briefing so it can be regenerated
router.delete('/briefing/:edition', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const { edition } = req.params;
  if (!['morning', 'afternoon', 'evening'].includes(edition)) {
    return res.status(400).json({ error: 'Invalid edition' });
  }
  const { getAppConfig: _cfg } = require('../lib/app-config');
  const appCfg = await _cfg(req.tenantId).catch(() => ({}));
  const tz = appCfg.newsroom_timezone || 'UTC';
  const dateParam = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toLocaleDateString('en-CA', { timeZone: tz });

  const result = await getPool().query(
    'DELETE FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2 AND edition = $3 RETURNING id',
    [req.tenantId, dateParam, edition]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Briefing not found' });
  res.json({ ok: true });
}));

// ── Briefing thumbnail helpers ────────────────────────────────────────────────
const multer = require('multer');
const THUMB_ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const thumbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, THUMB_ALLOWED_MIMES.has(file.mimetype)),
});

function resolveEditionDate(req, tz) {
  return req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

// POST /api/admin/budget/briefing/:edition/thumbnail/upload — manual image upload
router.post('/briefing/:edition/thumbnail/upload',
  auth, requirePermission('articles.write'),
  thumbUpload.single('thumbnail'),
  asyncHandler(async (req, res) => {
    const { edition } = req.params;
    if (!['morning', 'afternoon', 'evening'].includes(edition)) {
      return res.status(400).json({ error: 'Invalid edition' });
    }
    if (!req.file) return res.status(400).json({ error: 'No image file provided (PNG, JPEG, WebP; max 10MB)' });

    const fileType = require('file-type');
    const detected = await fileType.fromBuffer(req.file.buffer);
    if (!detected || !THUMB_ALLOWED_MIMES.has(detected.mime)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }
    req.file.mimetype = detected.mime;

    const storage = require('../lib/storage');
    const crypto  = require('crypto');
    const ext = storage.extFromMime(req.file.mimetype);
    const filename = `briefing-thumb-${crypto.randomBytes(8).toString('hex')}-${Date.now()}.${ext}`;
    const imageUrl = await storage.upload(req.file.buffer, req.file.mimetype, `images/${filename}`, req.tenantId);

    const appCfg = await getAppConfig(req.tenantId).catch(() => ({}));
    const tz = appCfg.newsroom_timezone || 'UTC';
    const dateParam = resolveEditionDate(req, tz);

    const result = await getPool().query(
      `UPDATE daily_briefings SET thumbnail_url = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND briefing_date = $3 AND edition = $4 RETURNING id`,
      [imageUrl, req.tenantId, dateParam, edition]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Briefing not found' });
    res.json({ ok: true, thumbnail_url: imageUrl });
  })
);

// POST /api/admin/budget/briefing/:edition/thumbnail/generate — AI-generate a thumbnail
router.post('/briefing/:edition/thumbnail/generate',
  auth, requirePermission('articles.write'),
  asyncHandler(async (req, res) => {
    const { edition } = req.params;
    if (!['morning', 'afternoon', 'evening'].includes(edition)) {
      return res.status(400).json({ error: 'Invalid edition' });
    }

    const appCfg = await getAppConfig(req.tenantId).catch(() => ({}));
    const tz = appCfg.newsroom_timezone || 'UTC';
    const dateParam = resolveEditionDate(req, tz);

    const row = await db.prepare(
      `SELECT id, script, edition FROM daily_briefings
       WHERE tenant_id = $1 AND briefing_date = $2 AND edition = $3 AND status = 'ready'`
    ).get(req.tenantId, dateParam, edition);
    if (!row) return res.status(404).json({ error: 'Briefing not found or not ready' });

    const { getVisualConcept, buildImagePrompt, storeImage, getArtDirection } = require('../lib/media-helpers');
    const { generateImage } = require('../lib/ai-router');
    const crypto = require('crypto');

    const EDITION_LABELS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
    const edLabel = EDITION_LABELS[edition] || edition;
    const scriptSnippet = (row.script || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const title = `${edLabel} AI News Briefing — ${dateParam}`;

    const visualResult = await getVisualConcept(title, scriptSnippet, 'News', req.tenantId, 'admin');
    const tenantArtDirection = await getArtDirection(req.tenantId, 'thumbnails');
    const fullPrompt = buildImagePrompt(visualResult, title, {
      category: 'News',
      tier: 'standard',
      tenantArtDirection,
      articleType: 'article',
    });

    let b64;
    try {
      const result = await generateImage({
        tenantId: req.tenantId,
        prompt: fullPrompt,
        operation: 'thumbnail-render',
        aspectRatio: '16:9',
        trigger: 'admin',
      });
      b64 = result.b64;
    } catch (err) {
      return res.status(500).json({ error: 'Image generation failed', detail: err.message });
    }

    const pngBuf  = Buffer.from(b64, 'base64');
    const filename = `briefing-thumb-${crypto.randomBytes(8).toString('hex')}-${Date.now()}.png`;
    const imageUrl = await storeImage(pngBuf, filename, req.tenantId);

    await getPool().query(
      `UPDATE daily_briefings SET thumbnail_url = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND briefing_date = $3 AND edition = $4`,
      [imageUrl, req.tenantId, dateParam, edition]
    );
    res.json({ ok: true, thumbnail_url: imageUrl });
  })
);

// DELETE /api/admin/budget/briefing/:edition/thumbnail — remove thumbnail
router.delete('/briefing/:edition/thumbnail',
  auth, requirePermission('articles.write'),
  asyncHandler(async (req, res) => {
    const { edition } = req.params;
    if (!['morning', 'afternoon', 'evening'].includes(edition)) {
      return res.status(400).json({ error: 'Invalid edition' });
    }
    const appCfg = await getAppConfig(req.tenantId).catch(() => ({}));
    const tz = appCfg.newsroom_timezone || 'UTC';
    const dateParam = resolveEditionDate(req, tz);

    const result = await getPool().query(
      `UPDATE daily_briefings SET thumbnail_url = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND briefing_date = $2 AND edition = $3 RETURNING id`,
      [req.tenantId, dateParam, edition]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Briefing not found' });
    res.json({ ok: true });
  })
);

// PATCH /api/admin/budget/briefing/:edition/youtube — set or clear a YouTube Shorts URL
router.patch('/briefing/:edition/youtube',
  auth, requirePermission('articles.write'),
  asyncHandler(async (req, res) => {
    const { edition } = req.params;
    if (!['morning', 'afternoon', 'evening'].includes(edition)) {
      return res.status(400).json({ error: 'Invalid edition' });
    }
    const appCfg = await getAppConfig(req.tenantId).catch(() => ({}));
    const tz = appCfg.newsroom_timezone || 'UTC';
    const dateParam = resolveEditionDate(req, tz);

    // Accept null/empty to clear, or a YouTube URL
    const raw = req.body.youtube_url ?? null;
    let youtubeUrl = null;
    if (raw) {
      youtubeUrl = String(raw).trim();
      if (!youtubeUrl.includes('youtube.com') && !youtubeUrl.includes('youtu.be')) {
        return res.status(400).json({ error: 'Must be a YouTube URL' });
      }
    }

    const result = await getPool().query(
      `UPDATE daily_briefings SET youtube_url = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND briefing_date = $3 AND edition = $4 RETURNING id`,
      [youtubeUrl, req.tenantId, dateParam, edition]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Briefing not found' });
    res.json({ ok: true, youtube_url: youtubeUrl });
  })
);

module.exports = router;
