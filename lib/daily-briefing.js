'use strict';
const db        = require('../db');
const { getPool } = require('../db');
const { getAppConfig }  = require('./app-config');
const { loadPrompt }    = require('./prompt-loader');
const { complete: aiComplete, generateVoice } = require('./ai-router');
const { canSpend }      = require('./budget');
const storage           = require('./storage');
const { toSlug }        = require('./utils');

/**
 * Generate today's audio briefing for a tenant.
 *
 * Picks the top 5 articles from the last 24h, writes an anchor-style
 * script via LLM, then converts to speech using the most-active writer's
 * ElevenLabs voice. Idempotent — skips if a 'ready' briefing already exists.
 *
 * @param {number} tenantId
 * @param {{ force?: boolean }} opts  force=true regenerates even if 'ready' exists
 * @returns {Promise<{ ok: boolean, reason?: string, audio_url?: string }>}
 */
async function generateDailyBriefing(tenantId, { force = false } = {}) {
  const appCfg = await getAppConfig(tenantId).catch(() => ({}));
  const tz     = appCfg.newsroom_timezone || 'UTC';

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

  // Idempotency check
  const existing = await db.prepare(
    'SELECT id, status, audio_url FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2'
  ).get(tenantId, todayStr);

  if (existing?.status === 'ready' && !force) {
    return { ok: true, reason: 'already_exists', audio_url: existing.audio_url };
  }

  // Pick top 5 published articles from the last 24h (original/deep-dive only)
  const articlesResult = await getPool().query(`
    SELECT a.id, a.title, a.summary, a.category, w.name AS writer_name, w.beat,
           w.elevenlabs_voice_id, w.tone, w.avatar_url
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1
      AND a.is_published = 1
      AND a.is_archived  = 0
      AND a.content_type IN ('original', 'deep-dive')
      AND a.published_at >= NOW() - INTERVAL '24 hours'
    ORDER BY a.editorial_score DESC NULLS LAST, a.published_at DESC
    LIMIT 5
  `, [tenantId]);

  const articles = articlesResult.rows;
  if (!articles.length) return { ok: false, reason: 'no_articles' };

  // Pick anchor voice — writer with an ElevenLabs voice who has the most articles today
  const voiceWriter = articles.find(a => a.elevenlabs_voice_id);
  if (!voiceWriter) return { ok: false, reason: 'no_voice' };

  // Budget check
  const budgetCheck = await canSpend('audio', tenantId);
  if (!budgetCheck.allowed) return { ok: false, reason: 'budget_exceeded' };

  // Format stories for the prompt
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const storiesText = articles.map((a, i) => {
    const summary = (a.summary || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    return `${i + 1}. ${a.title}\n${summary}`;
  }).join('\n\n');

  // Generate script via LLM
  let script = null;
  try {
    const prompt = loadPrompt('briefing-script');
    const { messages, ...meta } = prompt.render({
      anchorName: voiceWriter.writer_name || 'Your correspondent',
      beats:      voiceWriter.beat || 'AI and technology',
      date:       dateLabel,
      stories:    storiesText,
    });
    const result = await aiComplete({
      ...meta, messages, tenantId,
      skipBudget: false,
      trigger: 'daily-briefing',
    });
    script = result?.text?.trim() || null;
  } catch (err) {
    console.error('[daily-briefing] LLM script generation failed:', err.message);
  }

  if (!script) return { ok: false, reason: 'script_failed' };

  // Upsert pending row before TTS (so we can track status)
  const articleIds = articles.map(a => a.id);
  if (existing) {
    await db.prepare(`
      UPDATE daily_briefings
      SET status = 'pending', script = $1, article_ids = $2, updated_at = NOW()
      WHERE tenant_id = $3 AND briefing_date = $4
    `).run(script, articleIds, tenantId, todayStr);
  } else {
    await db.prepare(`
      INSERT INTO daily_briefings (tenant_id, briefing_date, status, script, article_ids, voice_name, voice_avatar_url)
      VALUES ($1, $2, 'pending', $3, $4, $5, $6)
      ON CONFLICT (tenant_id, briefing_date) DO UPDATE
        SET status = 'pending', script = $3, article_ids = $4, updated_at = NOW()
    `).run(tenantId, todayStr, script, articleIds,
           voiceWriter.writer_name || null,
           voiceWriter.avatar_url  || null);
  }

  // Generate TTS
  let audioUrl = null;
  try {
    const voiceResult = await generateVoice({
      operation:   'audio',
      tenantId,
      text:        script,
      voiceId:     voiceWriter.elevenlabs_voice_id,
      articleSlug: `briefing-${todayStr}`,
      trigger:     'daily-briefing',
      skipBudget:  true, // already checked above
    });

    if (voiceResult?.audio) {
      const filename = `briefing-${tenantId}-${todayStr}.mp3`;
      audioUrl = await storage.upload(voiceResult.audio, 'audio/mpeg', `audio/${filename}`, tenantId);
    }
  } catch (err) {
    console.error('[daily-briefing] TTS failed:', err.message);
  }

  if (!audioUrl) {
    await db.prepare(
      "UPDATE daily_briefings SET status = 'error', updated_at = NOW() WHERE tenant_id = $1 AND briefing_date = $2"
    ).run(tenantId, todayStr);
    return { ok: false, reason: 'tts_failed' };
  }

  await db.prepare(`
    UPDATE daily_briefings
    SET audio_url = $1, status = 'ready', voice_name = $2, voice_avatar_url = $3, updated_at = NOW()
    WHERE tenant_id = $4 AND briefing_date = $5
  `).run(audioUrl, voiceWriter.writer_name || null, voiceWriter.avatar_url || null, tenantId, todayStr);

  console.log(`[daily-briefing] tenant ${tenantId}: briefing ready — ${articles.length} stories, ${script.length} chars`);
  return { ok: true, audio_url: audioUrl, article_count: articles.length };
}

/**
 * Fetch today's ready briefing for a tenant (for API responses).
 * Returns null if none exists or not yet ready.
 */
async function getTodayBriefing(tenantId, tz = 'UTC') {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  return db.prepare(
    "SELECT audio_url, script, voice_name, voice_avatar_url, briefing_date FROM daily_briefings WHERE tenant_id = $1 AND briefing_date = $2 AND status = 'ready'"
  ).get(tenantId, todayStr);
}

module.exports = { generateDailyBriefing, getTodayBriefing };
