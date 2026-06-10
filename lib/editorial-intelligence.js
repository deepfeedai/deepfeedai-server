'use strict';

const db = require('../db');
const { clusterArticles } = require('./synthesis');
const { getAppConfig } = require('./app-config');
const { todayInTz, localDateTimeToUtc } = require('./news-budget');

const VALID_PITCH_TYPES = new Set(['breaking', 'analysis', 'deep_dive', 'follow_up', 'roundup', 'explainer', 'forecast']);
const VALID_PRIORITIES = new Set(['lead', 'standard', 'brief', 'hold']);

function safeJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function toDateString(date, tz = 'UTC') {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) return String(date);
  return todayInTz(tz);
}

function slugify(val) {
  return String(val || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'story';
}

function parseSourceIds(raw) {
  const arr = Array.isArray(raw) ? raw : safeJson(raw, []);
  return [...new Set((arr || []).map(v => {
    if (v && typeof v === 'object') return Number(v.id);
    return Number(v);
  }).filter(n => Number.isInteger(n) && n > 0))];
}

function significantWords(text) {
  const stop = new Set(['about', 'after', 'again', 'against', 'amid', 'among', 'from', 'have', 'into', 'more', 'over', 'said', 'says', 'that', 'their', 'this', 'with', 'will', 'would', 'could', 'should', 'your', 'they', 'them', 'than', 'then', 'when', 'where', 'what', 'which']);
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w));
}

function overlapScore(a, b) {
  const aw = new Set(significantWords(a));
  const bw = new Set(significantWords(b));
  if (!aw.size || !bw.size) return 0;
  let hit = 0;
  aw.forEach(w => { if (bw.has(w)) hit++; });
  return hit / Math.max(aw.size, bw.size);
}

function firstSentence(text, fallback = '') {
  const clean = String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  const m = clean.match(/^(.{40,220}?[.!?])\s/);
  return (m ? m[1] : clean.slice(0, 220)).trim();
}

function deriveTopicTag(topic, category) {
  return slugify(topic || category || 'story-focus');
}

function sourceDiversity(articles) {
  return new Set((articles || []).map(a => a.source || a.publication || '').filter(Boolean)).size;
}

function sourceSignature(sourceIds) {
  const ids = parseSourceIds(sourceIds).sort((a, b) => a - b);
  return ids.length ? ids.join(':') : '';
}

function newestDate(articles) {
  const dates = (articles || [])
    .map(a => new Date(a.published_at || a.created_at || 0))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => b - a);
  return dates[0] || null;
}

function pickHeadline(candidate) {
  const articles = candidate.articles || [];
  const lead = articles[0];
  if (lead?.generated_title) return lead.generated_title.slice(0, 220);
  if (lead?.title) return lead.title.slice(0, 220);
  return String(candidate.title || candidate.topic || 'Story opportunity').slice(0, 220);
}

function pickPitchType(candidate, scoreComponents = {}) {
  if (candidate.candidate_type === 'thread_update') return 'follow_up';
  if ((candidate.articles || []).length >= 5 && sourceDiversity(candidate.articles) >= 4) return 'roundup';
  if (scoreComponents.velocity >= 12 && scoreComponents.freshness >= 12) return 'breaking';
  if (scoreComponents.thread_connection >= 8) return 'follow_up';
  if ((candidate.articles || []).length <= 2) return 'explainer';
  return 'analysis';
}

function priorityFromScore(score) {
  if (score >= 75) return 'lead';
  if (score >= 52) return 'standard';
  if (score >= 34) return 'brief';
  return 'hold';
}

function targetWindowForPriority(priority) {
  if (priority === 'lead') return '08:00-10:00';
  if (priority === 'standard') return '12:00-14:00';
  if (priority === 'brief') return '18:00-19:00';
  return null;
}

function scoreNovelty(candidate, recentOriginals) {
  const ids = new Set(parseSourceIds(candidate.source_article_ids));
  let penalty = 0;
  for (const article of recentOriginals || []) {
    const originalIds = parseSourceIds(article.source_article_ids);
    const overlap = originalIds.filter(id => ids.has(id)).length;
    if (ids.size && overlap / ids.size >= 0.5) penalty = Math.max(penalty, 13);
    penalty = Math.max(penalty, Math.round(overlapScore(candidate.title, article.title) * 12));
  }
  return Math.max(0, 15 - penalty);
}

function chooseWriter(candidate, writers) {
  const category = (candidate.category || candidate.articles?.[0]?.category || '').toLowerCase();
  const autoWriters = (writers || []).filter(w => w.is_auto !== false);
  const matching = autoWriters.find(w => (w.beats || []).some(b => String(b).toLowerCase() === category));
  return matching || autoWriters[0] || (writers || [])[0] || null;
}

function buildCandidateFromArticles({ type, title, articles, topicTag, thread }) {
  const ordered = [...articles].sort((a, b) => new Date(b.created_at || b.published_at || 0) - new Date(a.created_at || a.published_at || 0));
  const ids = ordered.map(a => Number(a.id)).filter(Boolean);
  const category = ordered[0]?.category || 'General';
  const topic = title || ordered[0]?.topic_tag || `${category} - ${ordered[0]?.title || 'Story'}`;
  return {
    candidate_type: type,
    candidate_key: `${type}:${slugify(topic)}:${ids.slice(0, 8).sort((a, b) => a - b).join('-')}`,
    topic_tag: topicTag || deriveTopicTag(topic, category),
    title: topic,
    summary: firstSentence(ordered[0]?.summary, ordered[0]?.title || topic),
    category,
    source_article_ids: ids,
    articles: ordered,
    thread: thread || null,
  };
}

async function gatherStorySignals(tenantId, opts = {}) {
  const cfg = await getAppConfig(tenantId).catch(() => ({}));
  const date = toDateString(opts.date, cfg.newsroom_timezone || 'UTC');
  const lookbackHours = Math.max(6, Math.min(parseInt(opts.lookbackHours, 10) || 48, 168));

  const [articles, recentOriginals, threads, writers] = await Promise.all([
    db.prepare(`
      SELECT id, title, generated_title, summary, source, source_url, category, topic_tag, created_at, published_at
      FROM articles
      WHERE tenant_id = $1
        AND (content_type IS NULL OR content_type = 'curated')
        AND (is_archived = 0 OR is_archived IS NULL)
        AND created_at > NOW() - make_interval(hours => $2)
      ORDER BY created_at DESC
      LIMIT 160
    `).all(tenantId, lookbackHours),
    db.prepare(`
      SELECT id, title, topic_tag, source_article_ids, published_at, created_at
      FROM articles
      WHERE tenant_id = $1
        AND content_type IN ('original', 'deep-dive')
        AND (is_published = 1 OR status IN ('published', 'scheduled', 'draft', 'review'))
        AND created_at > NOW() - INTERVAL '14 days'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(tenantId),
    db.prepare(`
      SELECT topic_tag, name, summary, article_count, source_count, owner_writer_id, last_update_at
      FROM story_threads
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY last_update_at DESC
      LIMIT 50
    `).all(tenantId),
    db.prepare(`
      SELECT w.id, w.name, w.is_auto,
             COALESCE(json_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL), '[]'::json) AS beats
      FROM writers w
      LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = w.tenant_id
      LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = w.tenant_id
      WHERE w.tenant_id = $1
      GROUP BY w.id, w.name, w.is_auto
      ORDER BY w.is_auto DESC, w.id ASC
    `).all(tenantId),
  ]);

  return {
    tenantId,
    date,
    lookbackHours,
    articles,
    recentOriginals,
    threads,
    writers: writers.map(w => ({ ...w, beats: safeJson(w.beats, []) })),
  };
}

function scoreStoryCandidates(signals) {
  const candidates = [];
  const seenKeys = new Set();
  const seenSourceSets = new Set();
  const clusters = clusterArticles(signals.articles || [], 2);
  const rememberCandidate = (candidate) => {
    const sig = sourceSignature(candidate.source_article_ids);
    if (seenKeys.has(candidate.candidate_key) || (sig && seenSourceSets.has(sig))) return false;
    seenKeys.add(candidate.candidate_key);
    if (sig) seenSourceSets.add(sig);
    candidates.push(candidate);
    return true;
  };

  for (const cluster of clusters) {
    const candidate = buildCandidateFromArticles({
      type: 'cluster',
      title: cluster.topic,
      articles: cluster.articles,
      topicTag: cluster._topicTag || null,
    });
    rememberCandidate(candidate);
  }

  const byTopic = {};
  for (const article of signals.articles || []) {
    const key = article.topic_tag || article.category;
    if (!key || key === 'Uncategorized') continue;
    (byTopic[key] = byTopic[key] || []).push(article);
  }
  Object.entries(byTopic).forEach(([topic, articles]) => {
    if (articles.length < 2) return;
    const candidate = buildCandidateFromArticles({
      type: 'topic_momentum',
      title: topic,
      articles,
      topicTag: slugify(topic),
    });
    rememberCandidate(candidate);
  });

  for (const thread of signals.threads || []) {
    const related = (signals.articles || []).filter(a => a.topic_tag && a.topic_tag === thread.topic_tag);
    if (!related.length) continue;
    const candidate = buildCandidateFromArticles({
      type: 'thread_update',
      title: thread.name || thread.topic_tag,
      articles: related,
      topicTag: thread.topic_tag,
      thread,
    });
    rememberCandidate(candidate);
  }

  return candidates.map(candidate => {
    const articles = candidate.articles || [];
    const newest = newestDate(articles);
    const ageHours = newest ? (Date.now() - newest.getTime()) / 36e5 : 168;
    const recent6h = articles.filter(a => {
      const d = new Date(a.created_at || a.published_at || 0);
      return !isNaN(d.getTime()) && (Date.now() - d.getTime()) / 36e5 <= 6;
    }).length;
    const writer = chooseWriter(candidate, signals.writers);
    const components = {
      source_density: Math.min(20, articles.length * 5),
      source_diversity: Math.min(20, sourceDiversity(articles) * 7),
      freshness: Math.max(0, Math.round(15 - Math.min(15, ageHours / 4))),
      velocity: Math.min(15, recent6h * 5),
      novelty: scoreNovelty(candidate, signals.recentOriginals),
      thread_connection: candidate.thread ? 10 : ((signals.threads || []).some(t => t.topic_tag === candidate.topic_tag) ? 7 : 0),
      writer_fit: writer ? 8 + ((writer.beats || []).includes(candidate.category) ? 2 : 0) : 0,
    };
    const score = Math.max(0, Math.min(100, Object.values(components).reduce((sum, n) => sum + n, 0)));
    const pitchType = pickPitchType(candidate, components);
    const priority = priorityFromScore(score);
    return {
      ...candidate,
      score,
      score_components: components,
      recommended_writer_id: writer?.id || null,
      recommended_writer_name: writer?.name || null,
      pitch_type: VALID_PITCH_TYPES.has(pitchType) ? pitchType : 'analysis',
      priority: VALID_PRIORITIES.has(priority) ? priority : 'standard',
      target_publish_window: targetWindowForPriority(priority),
      signal: {
        newest_at: newest ? newest.toISOString() : null,
        source_count: articles.length,
        distinct_sources: sourceDiversity(articles),
        category: candidate.category || null,
        editorial_value: pitchType,
        thread: candidate.thread ? { topic_tag: candidate.thread.topic_tag, name: candidate.thread.name } : null,
      },
    };
  }).sort((a, b) => b.score - a.score);
}

function validateSourceIds(sourceIds, allowedIds) {
  const allowed = new Set((allowedIds || []).map(Number));
  const ids = parseSourceIds(sourceIds);
  const invented = ids.filter(id => !allowed.has(id));
  if (invented.length) throw new Error(`Story brief referenced unavailable source IDs: ${invented.join(', ')}`);
  return ids;
}

function draftBriefFromCandidate(candidate) {
  const sourceIds = parseSourceIds(candidate.source_article_ids);
  const headline = pickHeadline(candidate);
  const sourceCount = sourceIds.length;
  const distinct = candidate.signal?.distinct_sources || sourceDiversity(candidate.articles || []);
  const leadSummary = firstSentence(candidate.articles?.[0]?.summary, candidate.summary || headline);
  const angle = candidate.candidate_type === 'thread_update'
    ? `Update the existing ${candidate.title} thread with what changed, what remains unresolved, and why readers should care now.`
    : `Explain the concrete development behind ${candidate.title}, using the source bundle to separate new facts from repeated coverage.`;
  const whyNow = `${sourceCount} source${sourceCount === 1 ? '' : 's'} from ${distinct || sourceCount} distinct outlet${(distinct || sourceCount) === 1 ? '' : 's'} are converging on this now.`;
  const audienceValue = candidate.pitch_type === 'breaking'
    ? 'Give readers the fast, verified version before the story gets flattened into generic coverage.'
    : 'Give readers a clear, specific angle that turns scattered source coverage into one useful original article.';
  return {
    headline,
    angle,
    why_now: whyNow,
    audience_value: audienceValue,
    evidence: (candidate.articles || []).slice(0, 8).map(a => ({
      id: a.id,
      title: a.generated_title || a.title,
      source: a.source || null,
      summary: firstSentence(a.summary, ''),
    })),
    source_article_ids: sourceIds,
    recommended_writer_id: candidate.recommended_writer_id || null,
    pitch_type: candidate.pitch_type || 'analysis',
    priority: candidate.priority || 'standard',
    target_publish_window: candidate.target_publish_window || null,
    planning_date: candidate.planning_date,
  };
}

async function persistCandidate(candidate, tenantId, date) {
  const row = await db.prepare(`
    INSERT INTO editorial_story_candidates
      (tenant_id, planning_date, candidate_key, candidate_type, topic_tag, title, summary,
       source_article_ids, signal, score, score_components, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, 'proposed')
    ON CONFLICT (tenant_id, planning_date, candidate_key)
    DO UPDATE SET
      candidate_type = EXCLUDED.candidate_type,
      topic_tag = EXCLUDED.topic_tag,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      source_article_ids = EXCLUDED.source_article_ids,
      signal = EXCLUDED.signal,
      score = EXCLUDED.score,
      score_components = EXCLUDED.score_components,
      updated_at = NOW()
    RETURNING *
  `).get(
    tenantId,
    date,
    candidate.candidate_key,
    candidate.candidate_type,
    candidate.topic_tag,
    candidate.title,
    candidate.summary || null,
    JSON.stringify(parseSourceIds(candidate.source_article_ids)),
    JSON.stringify(candidate.signal || {}),
    candidate.score || 0,
    JSON.stringify(candidate.score_components || {}),
  );
  return { ...candidate, ...row, articles: candidate.articles };
}

async function persistBrief(candidate, tenantId, date) {
  const existing = await db.prepare(
    'SELECT * FROM editorial_story_briefs WHERE tenant_id = $1 AND candidate_id = $2'
  ).get(tenantId, candidate.id);
  if (existing) return normalizeBrief(existing);

  const allowedIds = (candidate.articles || []).map(a => a.id);
  const brief = draftBriefFromCandidate({ ...candidate, planning_date: date });
  const sourceIds = validateSourceIds(brief.source_article_ids, allowedIds);
  const row = await db.prepare(`
    INSERT INTO editorial_story_briefs
      (tenant_id, candidate_id, planning_date, headline, angle, why_now, audience_value,
       evidence, source_article_ids, recommended_writer_id, pitch_type, priority, target_publish_window, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, 'proposed')
    RETURNING *
  `).get(
    tenantId,
    candidate.id,
    date,
    brief.headline,
    brief.angle,
    brief.why_now,
    brief.audience_value,
    JSON.stringify(brief.evidence || []),
    JSON.stringify(sourceIds),
    brief.recommended_writer_id,
    brief.pitch_type,
    brief.priority,
    brief.target_publish_window,
  );
  await db.prepare(
    "UPDATE editorial_story_candidates SET status = 'briefed', updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status = 'proposed'"
  ).run(candidate.id, tenantId);
  return normalizeBrief(row);
}

function normalizeCandidate(row) {
  if (!row) return null;
  return {
    ...row,
    source_article_ids: parseSourceIds(row.source_article_ids),
    signal: safeJson(row.signal, {}),
    score_components: safeJson(row.score_components, {}),
    score: Number(row.score || 0),
  };
}

function normalizeBrief(row) {
  if (!row) return null;
  return {
    ...row,
    evidence: safeJson(row.evidence, []),
    source_article_ids: parseSourceIds(row.source_article_ids),
  };
}

async function generateStoryBriefs(candidates, tenantId, opts = {}) {
  const date = opts.date || todayInTz(opts.timezone || 'UTC');
  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 12, 30));
  const persisted = [];
  const briefs = [];
  for (const candidate of candidates.slice(0, limit)) {
    const saved = await persistCandidate(candidate, tenantId, date);
    persisted.push(normalizeCandidate(saved));
    briefs.push(await persistBrief(saved, tenantId, date));
  }
  return { candidates: persisted, briefs };
}

async function runEditorialIntelligence(tenantId, opts = {}) {
  const signals = await gatherStorySignals(tenantId, opts);
  const scored = scoreStoryCandidates(signals);
  const result = await generateStoryBriefs(scored, tenantId, { date: signals.date, limit: opts.limit || 12 });
  return {
    ok: true,
    date: signals.date,
    lookbackHours: signals.lookbackHours,
    signal_counts: {
      articles: signals.articles.length,
      threads: signals.threads.length,
      writers: signals.writers.length,
      candidates: scored.length,
    },
    ...result,
  };
}

async function listEditorialIntelligence(tenantId, opts = {}) {
  const cfg = await getAppConfig(tenantId).catch(() => ({}));
  const date = toDateString(opts.date, cfg.newsroom_timezone || 'UTC');
  const rows = await db.prepare(`
    SELECT c.*,
      b.id AS brief_id, b.headline, b.angle, b.why_now, b.audience_value, b.evidence,
      b.source_article_ids AS brief_source_article_ids,
      b.recommended_writer_id, b.pitch_type, b.priority, b.target_publish_window,
      b.status AS brief_status, b.added_budget_slot_id,
      w.name AS recommended_writer_name,
      COALESCE((
        SELECT json_agg(json_build_object('id', a.id, 'title', COALESCE(a.generated_title, a.title), 'source', a.source, 'category', a.category))
        FROM articles a
        WHERE a.id = ANY(ARRAY(SELECT value::int FROM jsonb_array_elements_text(c.source_article_ids) AS v(value)))
          AND a.tenant_id = c.tenant_id
      ), '[]'::json) AS source_articles
    FROM editorial_story_candidates c
    LEFT JOIN editorial_story_briefs b ON b.candidate_id = c.id AND b.tenant_id = c.tenant_id
    LEFT JOIN writers w ON w.id = b.recommended_writer_id AND w.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1 AND c.planning_date = $2
    ORDER BY c.score DESC, c.updated_at DESC
  `).all(tenantId, date);

  return {
    date,
    candidates: rows.map(row => ({
      ...normalizeCandidate(row),
      source_articles: safeJson(row.source_articles, []),
      brief: row.brief_id ? normalizeBrief({
        id: row.brief_id,
        tenant_id: row.tenant_id,
        candidate_id: row.id,
        planning_date: row.planning_date,
        headline: row.headline,
        angle: row.angle,
        why_now: row.why_now,
        audience_value: row.audience_value,
        evidence: row.evidence,
        source_article_ids: row.brief_source_article_ids,
        recommended_writer_id: row.recommended_writer_id,
        recommended_writer_name: row.recommended_writer_name,
        pitch_type: row.pitch_type,
        priority: row.priority,
        target_publish_window: row.target_publish_window,
        status: row.brief_status,
        added_budget_slot_id: row.added_budget_slot_id,
      }) : null,
    })),
  };
}

async function getBrief(briefId, tenantId) {
  const row = await db.prepare(`
    SELECT b.*, c.topic_tag, c.title AS candidate_title
    FROM editorial_story_briefs b
    LEFT JOIN editorial_story_candidates c ON c.id = b.candidate_id AND c.tenant_id = b.tenant_id
    WHERE b.id = $1 AND b.tenant_id = $2
  `).get(briefId, tenantId);
  return row ? normalizeBrief(row) : null;
}

async function setBriefStatus(briefId, tenantId, status) {
  if (!['approved', 'rejected', 'proposed'].includes(status)) throw new Error('Invalid brief status');
  const stamp = status === 'approved' ? ', approved_at = NOW(), rejected_at = NULL'
    : status === 'rejected' ? ', rejected_at = NOW(), approved_at = NULL'
      : ', approved_at = NULL, rejected_at = NULL';
  const brief = await db.prepare(`
    UPDATE editorial_story_briefs
    SET status = $3${stamp}, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `).get(briefId, tenantId, status);
  if (!brief) return null;
  await db.prepare(`
    UPDATE editorial_story_candidates
    SET status = $3, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(brief.candidate_id, tenantId, status === 'approved' ? 'approved' : status === 'rejected' ? 'dismissed' : 'briefed');
  return normalizeBrief(brief);
}

async function ensureBudgetForDate(tenantId, date, writerId = null) {
  let budget = await db.prepare(
    'SELECT * FROM news_budgets WHERE tenant_id = $1 AND budget_date = $2'
  ).get(tenantId, date);
  if (budget) return budget;
  budget = await db.prepare(`
    INSERT INTO news_budgets (tenant_id, budget_date, status, editorial_note, coverage_gaps, beat_alerts, created_by_writer_id)
    VALUES ($1, $2, 'draft', 'Editorial Intelligence planning board', '[]'::jsonb, '[]'::jsonb, $3)
    RETURNING *
  `).get(tenantId, date, writerId);
  return budget;
}

async function promoteBriefToRunsheetSlot(briefId, budgetId, tenantId, opts = {}) {
  const brief = await getBrief(briefId, tenantId);
  if (!brief) return null;
  if (brief.added_budget_slot_id) {
    const slot = await db.prepare(
      'SELECT * FROM news_budget_slots WHERE id = $1 AND tenant_id = $2'
    ).get(brief.added_budget_slot_id, tenantId);
    if (slot) {
      const budget = await db.prepare(
        'SELECT * FROM news_budgets WHERE id = $1 AND tenant_id = $2'
      ).get(slot.budget_id, tenantId);
      return { budget, slot, brief };
    }
  }
  if (brief.status !== 'approved' && !opts.allowProposed) {
    const err = new Error('Brief must be approved before adding to runsheet');
    err.status = 409;
    throw err;
  }

  let budget = null;
  if (budgetId) {
    budget = await db.prepare(
      'SELECT * FROM news_budgets WHERE id = $1 AND tenant_id = $2'
    ).get(budgetId, tenantId);
  }
  const cfg = await getAppConfig(tenantId).catch(() => ({}));
  const date = toDateString(opts.date || brief.planning_date, cfg.newsroom_timezone || 'UTC');
  if (!budget) budget = await ensureBudgetForDate(tenantId, date, null);
  if (!budget) return null;

  let targetPublishAt = null;
  const start = brief.target_publish_window ? String(brief.target_publish_window).split('-')[0] : null;
  if (start && /^\d{2}:\d{2}$/.test(start)) {
    targetPublishAt = localDateTimeToUtc(String(budget.budget_date).slice(0, 10), start, cfg.newsroom_timezone || 'UTC').toISOString();
  }

  const rationale = [
    brief.angle && `Angle: ${brief.angle}`,
    brief.why_now && `Why now: ${brief.why_now}`,
    brief.audience_value && `Audience value: ${brief.audience_value}`,
  ].filter(Boolean).join('\n');

  const slot = await db.prepare(`
    INSERT INTO news_budget_slots
      (tenant_id, budget_id, story_brief_id, priority, pitch_type, topic_tag, headline_suggestion,
       rationale, recommended_writer_id, target_publish_at, source_article_ids, status, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending',
      COALESCE((SELECT MAX(sort_order) + 1 FROM news_budget_slots WHERE tenant_id = $1 AND budget_id = $2), 0))
    RETURNING *
  `).get(
    tenantId,
    budget.id,
    brief.id,
    brief.priority || 'standard',
    brief.pitch_type || 'analysis',
    brief.topic_tag || null,
    brief.headline,
    rationale.slice(0, 1000) || brief.why_now || null,
    brief.recommended_writer_id || null,
    targetPublishAt,
    JSON.stringify(parseSourceIds(brief.source_article_ids)),
  );

  await db.prepare(`
    UPDATE editorial_story_briefs
    SET status = 'added_to_runsheet', added_budget_slot_id = $3, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(brief.id, tenantId, slot.id);
  await db.prepare(`
    UPDATE editorial_story_candidates
    SET status = 'planned', updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(brief.candidate_id, tenantId);

  return { budget, slot, brief: { ...brief, status: 'added_to_runsheet', added_budget_slot_id: slot.id } };
}

async function getBriefsForBudgetGeneration(tenantId, date, limit = 8) {
  const rows = await db.prepare(`
    SELECT b.*, c.topic_tag, c.score, c.signal, w.name AS recommended_writer_name
    FROM editorial_story_briefs b
    LEFT JOIN editorial_story_candidates c ON c.id = b.candidate_id AND c.tenant_id = b.tenant_id
    LEFT JOIN writers w ON w.id = b.recommended_writer_id AND w.tenant_id = b.tenant_id
    WHERE b.tenant_id = $1
      AND b.planning_date = $2
      AND b.status IN ('approved', 'proposed')
    ORDER BY
      CASE WHEN b.status = 'approved' THEN 0 ELSE 1 END,
      c.score DESC NULLS LAST,
      b.created_at DESC
    LIMIT $3
  `).all(tenantId, date, limit);
  return rows.map(r => ({
    ...normalizeBrief(r),
    topic_tag: r.topic_tag,
    score: Number(r.score || 0),
    signal: safeJson(r.signal, {}),
    recommended_writer_name: r.recommended_writer_name || null,
  }));
}

module.exports = {
  gatherStorySignals,
  scoreStoryCandidates,
  generateStoryBriefs,
  runEditorialIntelligence,
  listEditorialIntelligence,
  getBrief,
  setBriefStatus,
  promoteBriefToRunsheetSlot,
  getBriefsForBudgetGeneration,
  validateSourceIds,
  draftBriefFromCandidate,
  normalizeCandidate,
  normalizeBrief,
};
