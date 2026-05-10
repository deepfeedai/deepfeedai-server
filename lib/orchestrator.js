/**
 * Deep Feed AI — Newsroom Orchestrator
 *
 * Multi-stage pipeline that takes incoming curated articles all the way to
 * published original pieces through a sequence of specialized agent passes:
 *
 *   SCOUT → SKEPTIC → [RESEARCH] → WRITING → REVIEW → PUBLISHED
 *
 * Each stage is persisted in `pipeline_runs`. Human-approval gates pause the
 * pipeline at SKEPTIC (conflicting sources) or REVIEW (low-confidence AI edit).
 * Admins can advance, approve, or reject paused runs via the orchestrator API.
 */

const db             = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { searchAll }  = require('./research');
const { ingestExternalResults } = require('./research/ingest');
const { synthesizeCluster } = require('./synthesis');
const { editorialReview }   = require('./editorial');
const { recordEvent }       = require('./newsroom-events');
const { isFeatureEnabled }  = require('./feature-registry');

// ─── Stage names ────────────────────────────────────────────────────────────
const STAGE = {
  SCOUT:    'scout',
  SKEPTIC:  'skeptic',
  RESEARCH: 'research',
  WRITING:  'writing',
  REVIEW:   'review',
  PAUSED:   'paused',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PUBLISHED: 'published',
  ERROR:    'error',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeJson(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

async function updateRun(id, tenantId, fields) {
  const sets = Object.entries(fields)
    .map(([k, v], i) => `${k} = $${i + 3}`)
    .join(', ');
  const vals = Object.values(fields).map(v =>
    typeof v === 'object' && v !== null ? JSON.stringify(v) : v
  );
  await db.prepare(
    `UPDATE pipeline_runs SET ${sets}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`
  ).run(id, tenantId, ...vals);
}

// ─── Stage 1: Scout ──────────────────────────────────────────────────────────
/**
 * Scan incoming curated articles for the last N hours and use the Trend Scout
 * prompt to surface story opportunities. Creates pipeline_run rows for each.
 * Returns the number of runs created.
 */
async function runScoutPass(tenantId, opts = {}) {
  const lookbackHours = opts.lookbackHours || 12;

  const articles = await db.prepare(`
    SELECT a.id, a.title, a.summary, a.source, a.category, a.created_at
    FROM articles a
    WHERE a.tenant_id = $1
      AND (a.content_type IS NULL OR a.content_type = 'curated')
      AND a.is_archived = 0
      AND a.created_at > NOW() - make_interval(hours => $2)
    ORDER BY a.created_at DESC
    LIMIT 80
  `).all(tenantId, lookbackHours);

  if (articles.length < 3) {
    console.log(`[orchestrator] scout: only ${articles.length} articles, skipping`);
    return 0;
  }

  // Format articles for the prompt
  const articlesText = articles.map(a => {
    const summary = (a.summary || '').replace(/<[^>]+>/g, '').slice(0, 150);
    return `[${a.id}] "${a.title}" (${a.source || 'unknown'}, ${a.category || 'general'}) — ${summary}`;
  }).join('\n');

  let opportunities = [];
  try {
    const p = loadPrompt('trend-scout');
    const { messages, ...meta } = p.render({
      count: String(articles.length),
      articles: articlesText,
    });
    const result = await aiComplete({
      ...meta, messages, tenantId,
      operation: 'trend-scout',
      trigger: 'orchestrator-scout',
      skipBudget: false,
    });

    const raw = result?.text?.trim() || '[]';
    opportunities = JSON.parse(raw.replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
    if (!Array.isArray(opportunities)) opportunities = [];
  } catch (err) {
    console.error('[orchestrator] scout LLM error:', err.message);
    return 0;
  }

  // Deduplicate against recent pipeline runs (same topic within 6h)
  const recentRuns = await db.prepare(`
    SELECT topic FROM pipeline_runs
    WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '6 hours'
  `).all(tenantId);
  const recentTopics = new Set(recentRuns.map(r => (r.topic || '').toLowerCase().trim()));

  let created = 0;
  for (const opp of opportunities.slice(0, 3)) {
    if (!opp.topic || !Array.isArray(opp.article_ids) || opp.article_ids.length < 2) continue;
    if (recentTopics.has(opp.topic.toLowerCase().trim())) {
      console.log(`[orchestrator] scout: skipping duplicate topic "${opp.topic}"`);
      continue;
    }

    const run = await db.prepare(`
      INSERT INTO pipeline_runs
        (tenant_id, status, stage, topic, article_ids, stage_data, created_at, updated_at)
      VALUES ($1, $2, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id
    `).get(
      tenantId,
      STAGE.SKEPTIC,
      opp.topic,
      JSON.stringify(opp.article_ids),
      JSON.stringify({ scout: opp }),
    );

    recentTopics.add(opp.topic.toLowerCase().trim());
    console.log(`[orchestrator] scout: created run #${run.id} — "${opp.topic}"`);
    created++;
  }
  return created;
}

// ─── Stage 2: Skeptic ────────────────────────────────────────────────────────
/**
 * Run the Investigative Skeptic on a pipeline run.
 * Returns the next stage name (or PAUSED/REJECTED) and updated stage_data.
 */
async function runSkepticStage(run, tenantId) {
  const stageData = safeJson(run.stage_data, {});
  const scout = stageData.scout || {};
  const articleIds = safeJson(run.article_ids, []);

  if (!articleIds.length) {
    return { nextStage: STAGE.ERROR, stageData: { ...stageData, skeptic: { error: 'No article IDs' } } };
  }

  // Fetch source article details
  const sources = await db.prepare(`
    SELECT id, title, summary, source, source_url, category
    FROM articles
    WHERE id = ANY($1) AND tenant_id = $2 AND is_archived = 0
  `).all(articleIds, tenantId);

  if (sources.length < 2) {
    return {
      nextStage: STAGE.REJECTED,
      stageData: { ...stageData, skeptic: { error: 'Insufficient sources for verification', sources_found: sources.length } },
      humanGateRequired: false,
      humanGateReason: `Only ${sources.length} source(s) found — story cannot be verified`,
    };
  }

  const sourcesText = sources.map(s => {
    const summary = (s.summary || '').replace(/<[^>]+>/g, '').slice(0, 300);
    return `[${s.id}] SOURCE: ${s.source || 'unknown'}\nTITLE: ${s.title}\nSUMMARY: ${summary}`;
  }).join('\n\n');

  let verification = {};
  try {
    const p = loadPrompt('skeptic-verify');
    const { messages, ...meta } = p.render({
      topic: run.topic || 'Unknown topic',
      angle: scout.angle || 'General coverage',
      sourceCount: String(sources.length),
      sources: sourcesText,
    });
    const result = await aiComplete({
      ...meta, messages, tenantId,
      operation: 'skeptic-verify',
      trigger: 'orchestrator-skeptic',
      skipBudget: true,
    });

    const raw = result?.text?.trim() || '{}';
    verification = JSON.parse(raw.replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
  } catch (err) {
    console.error('[orchestrator] skeptic LLM error:', err.message);
    verification = { verified: true, confidence: 0.5, conflicts: [], gaps: [], research_needed: false };
  }

  const updatedData = { ...stageData, skeptic: verification };

  // Block conditions
  if (verification.verified === false && verification.block_reason) {
    return {
      nextStage: STAGE.REJECTED,
      stageData: updatedData,
      humanGateRequired: false,
      humanGateReason: verification.block_reason,
    };
  }

  // Human gate: conflicting sources or low confidence require admin sign-off
  const hasConflicts = Array.isArray(verification.conflicts) && verification.conflicts.length > 0;
  const lowConfidence = (verification.confidence || 1) < 0.6;
  if (hasConflicts || lowConfidence) {
    const reasons = [];
    if (hasConflicts) reasons.push(`${verification.conflicts.length} conflicting claim(s) detected`);
    if (lowConfidence) reasons.push(`low verification confidence (${Math.round((verification.confidence || 0) * 100)}%)`);
    return {
      nextStage: STAGE.PAUSED,
      stageData: updatedData,
      humanGateRequired: true,
      humanGateReason: reasons.join('; '),
      resumeStage: verification.research_needed ? STAGE.RESEARCH : STAGE.WRITING,
    };
  }

  return {
    nextStage: verification.research_needed ? STAGE.RESEARCH : STAGE.WRITING,
    stageData: updatedData,
    humanGateRequired: false,
  };
}

// ─── Stage 3: Research ───────────────────────────────────────────────────────
/**
 * Run external research to fill gaps identified by the skeptic.
 * Ingests results as curated rows and adds them to the run's article_ids.
 */
async function runResearchStage(run, tenantId) {
  const stageData = safeJson(run.stage_data, {});
  const skeptic = stageData.skeptic || {};
  const queries = skeptic.research_queries || [];
  const gaps = skeptic.gaps || [];

  // Build search queries from skeptic output or fall back to topic
  const searchQueries = queries.length > 0
    ? queries.slice(0, 3)
    : (gaps.slice(0, 2).map(g => g.replace(/^gap[:\s-]*/i, '').trim()).filter(Boolean));

  if (!searchQueries.length) {
    // No gaps to research — skip to writing
    return {
      nextStage: STAGE.WRITING,
      stageData: { ...stageData, research: { skipped: true, reason: 'No research queries' } },
    };
  }

  const ingested = [];
  for (const query of searchQueries) {
    try {
      const { results } = await searchAll(tenantId, query, { count: 5 });
      if (!results.length) continue;

      // Ingest top results as curated articles
      const newIds = await ingestExternalResults(results.slice(0, 3), tenantId, {
        trigger: `orchestrator-research:${run.id}`,
      });
      ingested.push(...newIds);
      console.log(`[orchestrator] research: query "${query}" → ${newIds.length} ingested`);
    } catch (err) {
      console.error('[orchestrator] research error for query:', query, err.message);
    }
  }

  // Merge new article IDs into the run
  const existingIds = safeJson(run.article_ids, []);
  const mergedIds = [...new Set([...existingIds, ...ingested])];

  return {
    nextStage: STAGE.WRITING,
    stageData: {
      ...stageData,
      research: { queries_run: searchQueries, ingested_count: ingested.length, ingested_ids: ingested },
    },
    newArticleIds: mergedIds,
  };
}

// ─── Stage 4: Writing ────────────────────────────────────────────────────────
/**
 * Pick the best writer for this story and call synthesizeCluster().
 */
async function runWritingStage(run, tenantId) {
  const stageData = safeJson(run.stage_data, {});
  const scout = stageData.scout || {};
  const articleIds = safeJson(run.article_ids, []);

  // Fetch source articles
  const sourceArticles = await db.prepare(`
    SELECT * FROM articles
    WHERE id = ANY($1) AND tenant_id = $2 AND is_archived = 0
  `).all(articleIds, tenantId);

  if (sourceArticles.length < 2) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, writing: { error: `Only ${sourceArticles.length} source(s) available` } },
    };
  }

  // Determine category from sources
  const categoryCounts = {};
  for (const a of sourceArticles) {
    if (a.category) categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1;
  }
  const category = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'General';

  // Find best writer for this beat
  let writer = null;

  // Prefer writer_id already on the run (e.g. from a pitch)
  if (run.writer_id) {
    writer = await db.prepare(
      'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2 AND is_active = 1'
    ).get(run.writer_id, tenantId);
  }

  // Otherwise find writer by beat
  if (!writer) {
    writer = await db.prepare(`
      SELECT w.* FROM writers w
      JOIN writer_beats wb ON wb.writer_id = w.id
      JOIN categories c ON c.id = wb.category_id
      WHERE w.tenant_id = $1 AND w.is_active = 1 AND c.name = $2
      ORDER BY w.is_auto DESC, RANDOM()
      LIMIT 1
    `).get(tenantId, category);
  }

  // Last resort: any active auto-writer
  if (!writer) {
    writer = await db.prepare(
      'SELECT * FROM writers WHERE tenant_id = $1 AND is_active = 1 AND is_auto = 1 ORDER BY RANDOM() LIMIT 1'
    ).get(tenantId);
  }

  if (!writer) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, writing: { error: 'No suitable writer found' } },
    };
  }

  // Build cluster object in the format synthesizeCluster expects
  const cluster = {
    topic: run.topic || scout.topic || `${category} Analysis`,
    articles: sourceArticles,
  };

  let article = null;
  try {
    article = await synthesizeCluster(cluster, writer, tenantId);
  } catch (err) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, writing: { error: err.message } },
    };
  }

  if (!article) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, writing: { error: 'synthesizeCluster returned null' } },
    };
  }

  console.log(`[orchestrator] writing: article #${article.id} generated by ${writer.name}`);

  return {
    nextStage: STAGE.REVIEW,
    stageData: { ...stageData, writing: { article_id: article.id, writer_id: writer.id, writer_name: writer.name } },
    articleId: article.id,
    writerId: writer.id,
  };
}

// ─── Stage 5: Review ─────────────────────────────────────────────────────────
/**
 * Run editorial review on the generated article.
 * synthesizeCluster() already runs editorialReview internally, so this stage
 * reads the verdict that was already recorded on the article row and decides
 * whether to advance or pause for human review.
 */
async function runReviewStage(run, tenantId) {
  const stageData = safeJson(run.stage_data, {});
  const articleId = run.article_id || stageData.writing?.article_id;

  if (!articleId) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, review: { error: 'No article_id to review' } },
    };
  }

  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);

  if (!article) {
    return {
      nextStage: STAGE.ERROR,
      stageData: { ...stageData, review: { error: `Article ${articleId} not found` } },
    };
  }

  // If synthesis already published the article, we're done
  if (article.is_published === 1) {
    return {
      nextStage: STAGE.PUBLISHED,
      stageData: { ...stageData, review: { status: 'auto_published_by_synthesis' } },
    };
  }

  // Article is in review queue — run an additional editorial pass
  let verdict = null;
  try {
    verdict = await editorialReview(article, tenantId);
  } catch (err) {
    console.error('[orchestrator] review error:', err.message);
  }

  if (verdict?.publish) {
    const { evaluatePublish } = require('./publish-gate');
    const gate = await evaluatePublish(tenantId).catch(() => ({ action: 'publish' }));

    if (gate.action === 'schedule' || gate.action === 'cap_reached') {
      const scheduleAt = gate.action === 'schedule' ? gate.at : gate.scheduleAt;
      await db.prepare(
        "UPDATE articles SET status = 'scheduled', publish_at = $1 WHERE id = $2 AND tenant_id = $3"
      ).run(scheduleAt.toISOString(), articleId, tenantId);
      const reason = gate.action === 'cap_reached'
        ? `daily cap reached (${gate.count}/${gate.cap})`
        : 'publish_mode=scheduled';
      return {
        nextStage: STAGE.PUBLISHED,
        stageData: { ...stageData, review: { verdict, auto_published: false, scheduled_at: scheduleAt.toISOString(), reason } },
      };
    }

    // publish_mode=continuous and cap not reached — publish immediately
    await db.prepare(
      "UPDATE articles SET is_published = 1, status = 'published', published_at = NOW() WHERE id = $1 AND tenant_id = $2"
    ).run(articleId, tenantId);

    const { onArticlePublished } = require('./post-publish');
    onArticlePublished(articleId, tenantId).catch(() => {});

    return {
      nextStage: STAGE.PUBLISHED,
      stageData: { ...stageData, review: { verdict, auto_published: true } },
    };
  }

  // Editor not satisfied — pause for human review
  return {
    nextStage: STAGE.PAUSED,
    stageData: { ...stageData, review: { verdict, auto_published: false } },
    humanGateRequired: true,
    humanGateReason: verdict
      ? `Editorial review: score ${verdict.score}/10 — ${(verdict.issues || []).join('; ')}`
      : 'Synthesis sent to review queue',
    resumeStage: STAGE.PUBLISHED,
  };
}

// ─── State machine: advance one run one step ─────────────────────────────────
/**
 * Advance a pipeline run by one stage.
 * Returns { advanced: bool, nextStage, error? }
 */
async function advanceRun(runId, tenantId) {
  const run = await db.prepare(
    'SELECT * FROM pipeline_runs WHERE id = $1 AND tenant_id = $2'
  ).get(runId, tenantId);

  if (!run) return { advanced: false, error: 'Run not found' };

  const stage = run.status;

  if ([STAGE.PAUSED, STAGE.APPROVED, STAGE.REJECTED, STAGE.PUBLISHED, STAGE.ERROR].includes(stage)) {
    return { advanced: false, error: `Run is in terminal/gated stage: ${stage}` };
  }

  let result;
  try {
    if (stage === STAGE.SKEPTIC)  result = await runSkepticStage(run, tenantId);
    else if (stage === STAGE.RESEARCH) result = await runResearchStage(run, tenantId);
    else if (stage === STAGE.WRITING)  result = await runWritingStage(run, tenantId);
    else if (stage === STAGE.REVIEW)   result = await runReviewStage(run, tenantId);
    else return { advanced: false, error: `Unknown stage: ${stage}` };
  } catch (err) {
    console.error(`[orchestrator] advanceRun #${runId} error at stage ${stage}:`, err.message);
    await updateRun(runId, tenantId, {
      status: STAGE.ERROR,
      stage: stage,
      error_message: err.message,
      finished_at: new Date().toISOString(),
    });
    return { advanced: true, nextStage: STAGE.ERROR, error: err.message };
  }

  const updates = {
    status: result.nextStage,
    stage: result.nextStage,
    stage_data: result.stageData,
  };
  if (result.humanGateRequired) {
    updates.human_gate_required = true;
    updates.human_gate_reason = result.humanGateReason || null;
    updates.resume_stage = result.resumeStage || null;
  }
  if (result.newArticleIds) {
    updates.article_ids = result.newArticleIds;
  }
  if (result.articleId) updates.article_id = result.articleId;
  if (result.writerId)  updates.writer_id  = result.writerId;

  const isTerminal = [STAGE.PUBLISHED, STAGE.REJECTED, STAGE.ERROR, STAGE.PAUSED].includes(result.nextStage);
  if (isTerminal) updates.finished_at = new Date().toISOString();

  await updateRun(runId, tenantId, updates);

  console.log(`[orchestrator] run #${runId}: ${stage} → ${result.nextStage}`);
  return { advanced: true, nextStage: result.nextStage };
}

// ─── Full orchestration cycle ─────────────────────────────────────────────────
/**
 * Entry point for the cron job.
 * 1. Scout pass — discover new stories
 * 2. Advance all pending runs by one stage each
 */
async function runOrchestrator(tenantId) {
  const enabled = await isFeatureEnabled(tenantId, 'orchestrator_enabled').catch(() => false);
  if (!enabled) return { skipped: 'orchestrator_enabled feature is off' };

  const summary = {
    scout_created: 0,
    advanced: 0,
    paused: 0,
    published: 0,
    errors: 0,
  };

  // 1. Scout pass
  try {
    summary.scout_created = await runScoutPass(tenantId);
  } catch (err) {
    console.error('[orchestrator] scout pass error:', err.message);
  }

  // 2. Advance all active (non-terminal) runs
  const activeRuns = await db.prepare(`
    SELECT id FROM pipeline_runs
    WHERE tenant_id = $1
      AND status NOT IN ('paused','approved','rejected','published','error')
    ORDER BY created_at ASC
    LIMIT 20
  `).all(tenantId);

  for (const { id } of activeRuns) {
    const result = await advanceRun(id, tenantId);
    if (!result.advanced) continue;
    if (result.nextStage === STAGE.PUBLISHED) summary.published++;
    else if (result.nextStage === STAGE.PAUSED) summary.paused++;
    else if (result.nextStage === STAGE.ERROR)  summary.errors++;
    else summary.advanced++;
  }

  console.log(`[orchestrator] cycle done (tenant ${tenantId}):`, summary);
  return summary;
}

// ─── Admin actions ────────────────────────────────────────────────────────────

/**
 * Admin approves a paused run — advance to the resume_stage.
 */
async function approveRun(runId, tenantId, adminNote) {
  const run = await db.prepare(
    'SELECT * FROM pipeline_runs WHERE id = $1 AND tenant_id = $2'
  ).get(runId, tenantId);

  if (!run || run.status !== STAGE.PAUSED) {
    throw new Error(`Run ${runId} is not paused (status: ${run?.status})`);
  }

  const stageData = safeJson(run.stage_data, {});
  const resumeStage = run.resume_stage || STAGE.WRITING;

  await updateRun(runId, tenantId, {
    status: resumeStage,
    stage: resumeStage,
    human_gate_required: false,
    human_gate_reason: null,
    finished_at: null,
    stage_data: { ...stageData, admin_approved: { at: new Date().toISOString(), note: adminNote || null } },
  });

  // Immediately advance the newly unpaused run
  return advanceRun(runId, tenantId);
}

/**
 * Admin rejects a paused run.
 */
async function rejectRun(runId, tenantId, adminNote) {
  const run = await db.prepare(
    'SELECT * FROM pipeline_runs WHERE id = $1 AND tenant_id = $2'
  ).get(runId, tenantId);

  if (!run || run.status !== STAGE.PAUSED) {
    throw new Error(`Run ${runId} is not paused (status: ${run?.status})`);
  }

  const stageData = safeJson(run.stage_data, {});
  await updateRun(runId, tenantId, {
    status: STAGE.REJECTED,
    stage: STAGE.REJECTED,
    human_gate_required: false,
    finished_at: new Date().toISOString(),
    stage_data: { ...stageData, admin_rejected: { at: new Date().toISOString(), note: adminNote || null } },
  });

  // Archive the draft article if one was generated
  if (run.article_id) {
    await db.prepare(
      'UPDATE articles SET is_archived = 1 WHERE id = $1 AND tenant_id = $2 AND is_published = 0'
    ).run(run.article_id, tenantId);
  }

  return { rejected: true };
}

module.exports = {
  STAGE,
  runOrchestrator,
  runScoutPass,
  advanceRun,
  approveRun,
  rejectRun,
};
