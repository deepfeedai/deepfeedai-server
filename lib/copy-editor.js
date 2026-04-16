/**
 * Vera — Copy Editor agent.
 * Runs a structured copy-editing pass on an article before it reaches Maxwell's
 * editorial review. Returns structured suggestions (corrections, headline notes,
 * lede assessment) that are stored on the article and surfaced in the editorial UI.
 *
 * Safeguards:
 * - Non-blocking: any error falls through silently; Maxwell review still runs
 * - Feature-flagged: copy_editor_enabled must be true for the tenant
 * - Writer voice preservation: writer's chat_prompt / tone passed as context
 * - Max 8 corrections returned; model instructed to be conservative
 * - Skips articles already copy-edited in the last 30 minutes (cooldown)
 */
'use strict';

const db           = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { isFeatureEnabled } = require('./feature-registry');

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Run a copy-editing pass on an article.
 * Returns the structured result or null if skipped/errored.
 *
 * @param {object} article — DB row (needs title, full_content, writer_id, category)
 * @param {number} tenantId
 * @returns {Promise<CopyEditResult|null>}
 *
 * @typedef {object} CopyEditResult
 * @property {'clean'|'minor_edits'|'major_edits'} verdict
 * @property {'strong'|'weak'|'misleading'} headline_verdict
 * @property {string|null} headline_suggestion
 * @property {'strong'|'weak'|'buried'} lede_verdict
 * @property {string|null} lede_note
 * @property {string} reading_level
 * @property {Array<{original:string,suggested:string,reason:string}>} corrections
 * @property {string[]} style_notes
 * @property {string} summary
 */
async function runCopyEdit(article, tenantId) {
  try {
    const enabled = await isFeatureEnabled(tenantId, 'copy_editor_enabled').catch(() => false);
    if (!enabled) return null;

    // Cooldown guard
    if (article.copy_edited_at) {
      const elapsed = Date.now() - new Date(article.copy_edited_at).getTime();
      if (elapsed < COOLDOWN_MS) return null;
    }

    const content = article.full_content || article.summary || '';
    if (!content.trim()) return null;

    // Fetch writer voice context — chat_prompt captures persona; tone captures style
    const writer = await db.prepare(
      'SELECT name, tone, chat_prompt FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(article.writer_id, tenantId).catch(() => null);

    const writerName  = writer?.name || 'Unknown';
    const writerVoice = [writer?.tone, writer?.chat_prompt]
      .filter(Boolean).join(' — ').slice(0, 600) || 'No style guide set.';

    const wordCount = content.split(/\s+/).filter(Boolean).length;

    const p = loadPrompt('copy-editor');
    const { messages, ...meta } = p.render({
      writerName,
      writerVoice,
      title:     article.title || 'Untitled',
      wordCount: String(wordCount),
      category:  article.category || 'General',
      content:   content.slice(0, 8000),
    });

    const result = await aiComplete({
      ...meta, messages, tenantId,
      trigger:   'copy-editor',
      articleSlug: article.slug,
      writerId:    article.writer_id,
      skipBudget:  true,
    });

    if (!result?.text) return null;

    let parsed;
    try {
      parsed = JSON.parse(result.text.replace(/```json?\s*|```/g, '').trim());
    } catch {
      console.warn(`[copy-editor] JSON parse failed for article ${article.id}:`, result.text.slice(0, 200));
      return null;
    }

    // Normalise and validate
    const VALID_VERDICTS    = new Set(['clean', 'minor_edits', 'major_edits']);
    const VALID_HL_VERDICTS = new Set(['strong', 'weak', 'misleading']);
    const VALID_LEDE        = new Set(['strong', 'weak', 'buried']);

    const normalized = {
      verdict:             VALID_VERDICTS.has(parsed.verdict)       ? parsed.verdict       : 'minor_edits',
      headline_verdict:    VALID_HL_VERDICTS.has(parsed.headline_verdict) ? parsed.headline_verdict : 'strong',
      headline_suggestion: parsed.headline_suggestion || null,
      lede_verdict:        VALID_LEDE.has(parsed.lede_verdict)      ? parsed.lede_verdict  : 'strong',
      lede_note:           parsed.lede_note || null,
      reading_level:       parsed.reading_level || null,
      corrections:         Array.isArray(parsed.corrections)
        ? parsed.corrections.slice(0, 8).filter(c => c.original && c.suggested && c.reason)
        : [],
      style_notes:         Array.isArray(parsed.style_notes) ? parsed.style_notes.slice(0, 3) : [],
      summary:             parsed.summary || '',
    };

    // Persist to article row
    await db.prepare(`
      UPDATE articles
      SET copy_edit_result = $1, copy_edited_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `).run(JSON.stringify(normalized), article.id, tenantId);

    console.log(`[copy-editor] Article ${article.id} "${article.title}": verdict=${normalized.verdict} corrections=${normalized.corrections.length}`);

    return normalized;

  } catch (err) {
    console.warn(`[copy-editor] Non-fatal error on article ${article.id}:`, err.message);
    return null;
  }
}

/**
 * Get the seeded Vera agent for a tenant, creating her if she doesn't exist.
 * Vera has role='copy-editor', is_system=true — excluded from the public writers page.
 *
 * @param {number} tenantId
 * @returns {Promise<object|null>}
 */
async function getCopyEditorAgent(tenantId) {
  let vera = await db.prepare(
    "SELECT * FROM writers WHERE tenant_id = $1 AND role = 'copy-editor' AND is_system = true LIMIT 1"
  ).get(tenantId).catch(() => null);

  if (vera) return vera;

  try {
    vera = await db.prepare(`
      INSERT INTO writers (tenant_id, name, slug, bio, role, is_system, tone, chat_prompt, is_auto)
      VALUES ($1, 'Vera', 'vera-copy-editor',
        'Copy desk agent. Reviews articles for grammar, spelling, headline quality, lede strength, and AP style consistency before they reach the editorial gate.',
        'copy-editor', true, 'precise',
        'You are Vera, a meticulous copy editor. You have a sharp eye for errors and inconsistencies but always preserve the writer''s voice — your job is to polish, not rewrite. You are direct: you say exactly what''s wrong and how to fix it. You take AP style seriously but know when a house style exception is intentional.',
        false)
      RETURNING *
    `).get(tenantId);
    console.log(`[copy-editor] Seeded Vera for tenant ${tenantId}`);
  } catch (err) {
    console.error('[copy-editor] Failed to seed Vera:', err.message);
  }

  return vera;
}

module.exports = { runCopyEdit, getCopyEditorAgent };
