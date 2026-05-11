'use strict';
const db        = require('../db');
const { getPool } = require('../db');
const { getAppConfig }  = require('./app-config');
const { loadPrompt }    = require('./prompt-loader');
const { complete: aiComplete, generateVoice } = require('./ai-router');
const { canSpend }      = require('./budget');
const storage           = require('./storage');

const EDITION_CONFIG = {
  morning:   { lookbackHours: 14, maxArticles: 3, label: 'Morning Edition',  timeOfDay: 'morning',   context: 'This is the morning briefing. Focus on overnight developments and what to watch today.' },
  afternoon: { lookbackHours:  5, maxArticles: 3, label: 'Afternoon Update', timeOfDay: 'afternoon', context: 'This is the midday update. Highlight what has changed since this morning and any breaking mid-day developments.' },
  evening:   { lookbackHours: 18, maxArticles: 5, label: 'Evening Report',   timeOfDay: 'evening',   context: 'This is the flagship evening report. Cover the full arc of the day — what broke, what developed, and what matters going into tonight.' },
};

/**
 * Generate an audio briefing edition for a tenant.
 *
 * @param {number} tenantId
 * @param {{ force?: boolean, edition?: 'morning'|'afternoon'|'evening' }} opts
 */
async function generateDailyBriefing(tenantId, { force = false, edition = 'evening' } = {}) {
  const cfg = EDITION_CONFIG[edition] || EDITION_CONFIG.evening;
  const appCfg = await getAppConfig(tenantId).catch(() => ({}));
  const tz     = appCfg.newsroom_timezone || 'UTC';

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

  // Idempotency check
  const existing = await db.prepare(
    'SELECT id, status, audio_url FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2 AND edition = $3'
  ).get(tenantId, todayStr, edition);

  if (existing?.status === 'ready' && !force) {
    return { ok: true, reason: 'already_exists', audio_url: existing.audio_url };
  }

  // Top articles from the edition lookback window
  const articlesResult = await getPool().query(`
    SELECT a.id, a.title, a.summary, a.category, w.name AS writer_name, w.beat,
           w.elevenlabs_voice_id, w.tone, w.avatar_url, w.id AS wid
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1
      AND a.is_published = 1
      AND a.is_archived  = 0
      AND a.content_type IN ('original', 'deep-dive')
      AND a.published_at >= NOW() - INTERVAL '${cfg.lookbackHours} hours'
    ORDER BY a.editorial_score DESC NULLS LAST, a.published_at DESC
    LIMIT ${cfg.maxArticles}
  `, [tenantId]);

  const articles = articlesResult.rows;
  if (!articles.length) return { ok: false, reason: 'no_articles' };

  // Anchor voice = writer with most articles in window who has an ElevenLabs voice
  const voiceCountResult = await getPool().query(`
    SELECT w.id, w.name, w.avatar_url, w.beat, w.elevenlabs_voice_id,
           COUNT(*)::int AS article_count
    FROM articles a
    JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1
      AND a.is_published = 1
      AND a.is_archived  = 0
      AND a.content_type IN ('original', 'deep-dive')
      AND a.published_at >= NOW() - INTERVAL '${cfg.lookbackHours} hours'
      AND w.elevenlabs_voice_id IS NOT NULL AND w.elevenlabs_voice_id != ''
    GROUP BY w.id, w.name, w.avatar_url, w.beat, w.elevenlabs_voice_id
    ORDER BY article_count DESC
    LIMIT 1
  `, [tenantId]);

  const anchor = voiceCountResult.rows[0] || articles.find(a => a.elevenlabs_voice_id);
  if (!anchor?.elevenlabs_voice_id) return { ok: false, reason: 'no_voice' };

  // Budget check
  const budgetCheck = await canSpend('audio', tenantId);
  if (!budgetCheck.allowed) return { ok: false, reason: 'budget_exceeded' };

  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long', month: 'long', day: 'numeric',
  });

  // Format each story explicitly so the model can't skip any
  const storiesText = articles.map((a, i) => {
    const summary = (a.summary || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    return `[STORY ${i + 1} OF ${articles.length}]\nHeadline: ${a.title}\nContext: ${summary}`;
  }).join('\n\n');

  // Generate script via LLM
  let script = null;
  try {
    const prompt = loadPrompt('briefing-script');
    const { messages, ...meta } = prompt.render({
      anchorName:     anchor.name || anchor.writer_name || 'Your correspondent',
      beats:          anchor.beat || 'AI and technology',
      date:           dateLabel,
      timeOfDay:      cfg.timeOfDay,
      editionLabel:   cfg.label,
      editionContext: cfg.context,
      stories:        storiesText,
    });
    const result = await aiComplete({
      ...meta, messages, tenantId,
      skipBudget: false,
      trigger: 'daily-briefing',
    });
    script = result?.text?.trim() || null;
  } catch (err) {
    console.error(`[daily-briefing:${edition}] LLM script generation failed:`, err.message);
  }

  if (!script) return { ok: false, reason: 'script_failed' };

  // Upsert pending row before TTS
  const articleIds = articles.map(a => a.id);
  if (existing) {
    await db.prepare(`
      UPDATE daily_briefings
      SET status = 'pending', script = $1, article_ids = $2, updated_at = NOW()
      WHERE tenant_id = $3 AND briefing_date = $4 AND edition = $5
    `).run(script, articleIds, tenantId, todayStr, edition);
  } else {
    await db.prepare(`
      INSERT INTO daily_briefings (tenant_id, briefing_date, edition, status, script, article_ids, voice_name, voice_avatar_url)
      VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
      ON CONFLICT (tenant_id, briefing_date, edition) DO UPDATE
        SET status = 'pending', script = $4, article_ids = $5, updated_at = NOW()
    `).run(tenantId, todayStr, edition, script, articleIds,
           anchor.name || anchor.writer_name || null,
           anchor.avatar_url || null);
  }

  // Generate TTS
  let audioUrl = null;
  try {
    const voiceResult = await generateVoice({
      operation:   'audio',
      tenantId,
      text:        script,
      voiceId:     anchor.elevenlabs_voice_id,
      articleSlug: `briefing-${todayStr}-${edition}`,
      trigger:     'daily-briefing',
      skipBudget:  true,
    });

    if (voiceResult?.audio) {
      const filename = `briefing-${tenantId}-${todayStr}-${edition}.mp3`;
      audioUrl = await storage.upload(voiceResult.audio, 'audio/mpeg', `audio/${filename}`, tenantId);
    }
  } catch (err) {
    console.error(`[daily-briefing:${edition}] TTS failed:`, err.message);
  }

  if (!audioUrl) {
    await db.prepare(
      "UPDATE daily_briefings SET status = 'error', updated_at = NOW() WHERE tenant_id = $1 AND briefing_date = $2 AND edition = $3"
    ).run(tenantId, todayStr, edition);
    return { ok: false, reason: 'tts_failed' };
  }

  const anchorName = anchor.name || anchor.writer_name || null;
  await db.prepare(`
    UPDATE daily_briefings
    SET audio_url = $1, status = 'ready', voice_name = $2, voice_avatar_url = $3, updated_at = NOW()
    WHERE tenant_id = $4 AND briefing_date = $5 AND edition = $6
  `).run(audioUrl, anchorName, anchor.avatar_url || null, tenantId, todayStr, edition);

  console.log(`[daily-briefing:${edition}] tenant ${tenantId}: ready — ${articles.length} stories, ${script.length} chars`);
  return { ok: true, audio_url: audioUrl, article_count: articles.length, edition };
}

/**
 * Fetch all of today's briefings for a tenant (admin UI).
 * Returns an array with one entry per edition, including those not yet generated.
 */
async function getTodayBriefings(tenantId, tz = 'UTC') {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const rows = await getPool().query(
    "SELECT id, edition, status, audio_url, script, voice_name, voice_avatar_url, briefing_date, article_ids, created_at, updated_at FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2 ORDER BY created_at ASC",
    [tenantId, todayStr]
  );
  return rows.rows;
}

/**
 * Fetch the latest ready briefing for a tenant (public API, backwards compat).
 * Returns the evening edition if ready, otherwise the most recently ready edition.
 */
async function getTodayBriefing(tenantId, tz = 'UTC') {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  // Prefer evening, then afternoon, then morning
  const rows = await getPool().query(
    "SELECT audio_url, script, voice_name, voice_avatar_url, briefing_date, edition FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2 AND status = 'ready' ORDER BY CASE edition WHEN 'evening' THEN 0 WHEN 'afternoon' THEN 1 WHEN 'morning' THEN 2 ELSE 3 END LIMIT 1",
    [tenantId, todayStr]
  );
  return rows.rows[0] || null;
}

module.exports = { generateDailyBriefing, getTodayBriefing, getTodayBriefings, EDITION_CONFIG };
