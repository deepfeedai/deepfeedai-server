/**
 * Editorial Review — AI editor that evaluates articles before publishing.
 * Sits between the heuristic quality gate and auto-publish in the synthesis pipeline.
 *
 * Safeguards:
 * - 2 revision cap per article (then goes to human review queue)
 * - 10-minute cooldown between reviews
 * - Fast-tier AI call (~$0.001 per review)
 * - One-way directives only — no agent-to-agent conversation loops
 */
const db = require('../db');
const { complete: aiComplete } = require('./ai-router');
const { loadPrompt } = require('./prompt-loader');
const { runCopyEdit, getCopyEditorAgent } = require('./copy-editor');

const REVISION_CAP = 2;
const REVIEW_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run AI editorial review on an article.
 * Returns { publish, score, issues, suggestion } or null if review is skipped.
 *
 * @param {object} article - Article row from DB (must have title, full_content, category, writer_id)
 * @param {number} tenantId
 * @returns {Promise<{ publish: boolean, score: number, issues: string[], suggestion: string|null } | null>}
 */
async function editorialReview(article, tenantId, { force = false } = {}) {
  // Skip if revision cap exceeded — go straight to human review
  if ((article.editorial_revision_count || 0) >= REVISION_CAP) {
    console.log(`[editorial] Article ${article.id} hit revision cap (${REVISION_CAP}), skipping AI review`);
    return { publish: false, score: 0, issues: [`Exceeded ${REVISION_CAP} revision attempts`], suggestion: 'Requires human review' };
  }

  // Skip if recently reviewed (cooldown) — bypassed when triggered by an explicit editor rewrite
  if (!force && article.last_reviewed_at) {
    const elapsed = Date.now() - new Date(article.last_reviewed_at).getTime();
    if (elapsed < REVIEW_COOLDOWN_MS) {
      console.log(`[editorial] Article ${article.id} reviewed ${Math.round(elapsed / 1000)}s ago, cooldown active`);
      return null; // Skip review, let caller decide
    }
  }

  // Get writer name for the review context
  const writer = await db.prepare('SELECT name FROM writers WHERE id = $1').get(article.writer_id);

  require('./newsroom-events').recordEvent({
    tenantId, type: 'editorial_review',
    actorWriterId: article.writer_id || null,
    targetArticleId: article.id,
    isPublic: true,
    headline: 'Story under editorial review — publishing decision soon',
    payload: { article_id: article.id },
  }).catch(() => {});

  const content = article.full_content || article.summary || '';
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // Parse source count
  let sourceCount = 0;
  try {
    const raw = typeof article.source_article_ids === 'string'
      ? JSON.parse(article.source_article_ids || '[]')
      : (article.source_article_ids || []);
    sourceCount = Array.isArray(raw) ? raw.length : 0;
  } catch {}

  // Run Vera's copy-editing pass first (non-blocking — Maxwell still runs if Vera fails)
  let copyEditResult = null;
  try {
    copyEditResult = await runCopyEdit(article, tenantId);
  } catch (err) {
    console.warn(`[editorial] Vera copy-edit pass failed (non-fatal):`, err.message);
  }

  // Build Vera's notes for Maxwell's context (empty string if Vera didn't run)
  let veraNotes = '';
  if (copyEditResult) {
    veraNotes = `\n\nCopy desk notes from Vera (verdict: ${copyEditResult.verdict}):\n`
      + `- Headline: ${copyEditResult.headline_verdict}`
      + (copyEditResult.headline_suggestion ? ` → suggested: "${copyEditResult.headline_suggestion}"` : '') + '\n'
      + `- Lede: ${copyEditResult.lede_verdict}`
      + (copyEditResult.lede_note ? ` — ${copyEditResult.lede_note}` : '') + '\n'
      + (copyEditResult.corrections.length
          ? `- ${copyEditResult.corrections.length} correction(s): ${copyEditResult.corrections.map(c => `"${c.original}" → "${c.suggested}" (${c.reason})`).join('; ')}\n`
          : '- No corrections needed\n')
      + (copyEditResult.style_notes.length ? `- Style: ${copyEditResult.style_notes.join('; ')}\n` : '');
  }

  const reviewPrompt = loadPrompt('editorial-review');
  const rendered = reviewPrompt.render({
    title: article.title || 'Untitled',
    writerName: writer?.name || 'Unknown',
    category: article.category || 'General',
    sourceCount: String(sourceCount),
    wordCount: String(wordCount),
    content: content.slice(0, 6000) + veraNotes, // Append Vera's notes to Maxwell's context
  });

  // Try editorial review — prefer gemini for reliable JSON output, fall back to tenant default
  let result;
  try {
    result = await aiComplete({
      operation: 'editorial-review',
      tenantId,
      messages: rendered.messages,
      temperature: rendered.temperature,
      maxTokens: rendered.maxTokens,
      trigger: 'editorial',
      articleSlug: article.slug,
      writerId: article.writer_id,
      skipBudget: false,
      providerOverride: 'gemini',
    });
  } catch (geminiErr) {
    console.warn(`[editorial] Gemini failed, trying tenant default: ${geminiErr.message}`);
    result = await aiComplete({
      operation: 'editorial-review',
      tenantId,
      messages: rendered.messages,
      temperature: rendered.temperature,
      maxTokens: rendered.maxTokens,
      trigger: 'editorial',
      articleSlug: article.slug,
      writerId: article.writer_id,
      skipBudget: false,
    });
  }

  if (!result?.text) {
    console.error(`[editorial] AI review returned no result for article ${article.id} — possible provider/key issue`);
    // Log provider resolution for debugging
    try {
      const { resolveProvider } = require('./ai-router');
      if (resolveProvider) {
        const resolved = await resolveProvider('editorial-review', tenantId);
        console.error(`[editorial] Resolved provider: ${resolved?.provider}/${resolved?.model} key=${!!resolved?.apiKey}`);
      }
    } catch {}
    return null;
  }

  // Parse the verdict
  let verdict;
  try {
    verdict = JSON.parse(result.text.replace(/```json?\s*|```/g, '').trim());
  } catch {
    console.error(`[editorial] Failed to parse verdict for article ${article.id}:`, result.text.slice(0, 200));
    return null;
  }

  // Normalize
  const normalized = {
    publish: !!verdict.publish,
    score: Math.max(1, Math.min(10, parseInt(verdict.score) || 5)),
    issues: Array.isArray(verdict.issues) ? verdict.issues : [],
    suggestion: verdict.suggestion || null,
  };

  // Update article with verdict
  await db.prepare(`
    UPDATE articles SET
      editor_verdict = $1,
      last_reviewed_at = NOW(),
      editorial_revision_count = COALESCE(editorial_revision_count, 0) + 1
    WHERE id = $2 AND tenant_id = $3
  `).run(JSON.stringify(normalized), article.id, tenantId);

  // Record as newsroom message
  try {
    const { recordNewsroomMessage } = require('./messaging');
    const editorAgent = await getEditorAgent(tenantId);
    const editorId = editorAgent?.id || null;
    const messageContent = normalized.publish
      ? `Approved "${article.title}" (score: ${normalized.score}/10)`
      : `Flagged "${article.title}" (score: ${normalized.score}/10): ${normalized.issues.join('; ')}`;

    await recordNewsroomMessage(tenantId, editorId, article.writer_id, 'editorial-review', messageContent, {
      articleId: article.id,
      verdict: normalized,
    });

    // Send to editor's messaging channel (Discord/Telegram/Slack)
    if (editorId && !normalized.publish) {
      const { sendMessage } = require('./messaging');
      const channelMsg = `Editorial Review — Article #${article.id}\n\n`
        + `"${article.title}"\n`
        + `Score: ${normalized.score}/10\n\n`
        + `Issues:\n${normalized.issues.map(i => '- ' + i).join('\n')}`
        + (normalized.suggestion ? `\n\nSuggestion: ${normalized.suggestion}` : '')
        + `\n\nReply "approve ${article.id}" or "reject ${article.id}"`;
      sendMessage(tenantId, editorId, channelMsg).catch(() => {});
    }
  } catch (err) {
    console.error('[editorial] Failed to record newsroom message:', err.message);
  }

  // PR-C: fire `review_needed` notification to every editor when the AI editor
  // falls below the auto-publish threshold (i.e. verdict.publish === false).
  // Fire-and-forget; flags (notifications_center / cross_channel_actions)
  // gate whether anything actually goes out.
  if (!normalized.publish) {
    (async () => {
      try {
        const { notify } = require('./notifications');
        const editors = await db.prepare(`
          SELECT id FROM users
          WHERE tenant_id = $1
            AND is_active = 1
            AND role IN ('owner', 'admin', 'editor', 'superadmin')
        `).all(tenantId);
        for (const ed of editors) {
          notify({
            tenantId,
            userId: ed.id,
            kind:   'review_needed',
            title:  'Review needed',
            body:   `"${article.title}" flagged — score ${normalized.score}/10`,
            payload: {
              article_id: article.id,
              title:      article.title,
              score:      normalized.score,
              issues:     normalized.issues,
              suggestion: normalized.suggestion,
            },
            actionable: [
              { label: 'Publish', actionKind: 'article.publish', targetId: article.id, targetType: 'article' },
              { label: 'Revise',  actionKind: 'article.revise',  targetId: article.id, targetType: 'article' },
              { label: 'Kill',    actionKind: 'article.kill',    targetId: article.id, targetType: 'article' },
            ],
          }).catch(err => console.error('[editorial] notify review_needed failed:', err.message));
        }
      } catch (err) {
        console.error('[editorial] review_needed fanout failed:', err.message);
      }
    })();
  }

  console.log(`[editorial] Article ${article.id} "${article.title}": publish=${normalized.publish} score=${normalized.score} issues=${normalized.issues.length}`);

  return normalized;
}

/**
 * Get or create the system editor agent for a tenant.
 * Returns the editor writer record, creating one if it doesn't exist.
 */
async function getEditorAgent(tenantId) {
  // Check for existing editor
  let editor = await db.prepare(
    "SELECT * FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
  ).get(tenantId);

  if (editor) return editor;

  // Seed a default editor agent
  try {
    editor = await db.prepare(`
      INSERT INTO writers (tenant_id, name, slug, bio, role, is_system, tone, chat_prompt, is_auto)
      VALUES ($1, 'Maxwell', 'maxwell-editor', 'Senior editorial reviewer. Evaluates articles for completeness, source attribution, and publication readiness.', 'editor', true, 'analytical', 'You''re a sharp, experienced editor who values clarity and substance over volume. You give direct feedback — no hedging, no sugar-coating. When an article has problems, you say exactly what''s wrong and how to fix it. You respect your writers but hold them to high standards.', false)
      RETURNING *
    `).get(tenantId);
    console.log(`[editorial] Created default editor agent "Maxwell" for tenant ${tenantId}`);
  } catch (err) {
    console.error('[editorial] Failed to seed editor agent:', err.message);
  }

  return editor;
}

/**
 * Ensure the system graphic designer agent "Iris" exists for the tenant.
 * Idempotent — returns the existing designer if any, otherwise creates one.
 * Avatar is generated lazily in the background via the shared composer
 * (uses `editorial-illustration` by default or the tenant's art_direction).
 */
async function ensureDesignerSeeded(tenantId) {
  if (!tenantId) return null;

  // Skip if a designer already exists
  const existing = await db.prepare(
    "SELECT * FROM writers WHERE tenant_id = $1 AND role = 'designer' LIMIT 1"
  ).get(tenantId);
  if (existing) {
    console.log('[seed] designer:', { tenantId, designerId: existing.id, action: 'existing', role: existing.role });
    return existing;
  }

  let designer = null;
  try {
    designer = await db.prepare(`
      INSERT INTO writers (tenant_id, name, slug, bio, role, is_system, tone, chat_prompt, is_auto)
      VALUES ($1, 'Iris', 'iris-designer',
              'Newsroom art director. Maintains visual brand coherence across thumbnails and writer avatars via 8 style families.',
              'designer', true, 'curatorial',
              'You''re a sharp visual editor who thinks in mood, composition, and palette. You notice when the feed looks same-y. You propose style pivots, never unilaterally change brand direction. You push back on cliches and advocate for deliberate visual choices. You do NOT publish articles or approve pitches — your lane is images only.',
              false)
      RETURNING *
    `).get(tenantId);
    console.log(`[designer] Created graphic designer agent "Iris" for tenant ${tenantId}`);
    console.log('[seed] designer:', { tenantId, designerId: designer?.id, action: 'created', role: designer?.role });
  } catch (err) {
    console.error('[designer] Failed to seed designer agent:', err.message);
    return null;
  }

  // Generate avatar in the background via the shared composer path.
  if (designer && designer.id) {
    setImmediate(() => {
      try {
        const { regenerateWriterAvatarImage } = require('./media-helpers');
        regenerateWriterAvatarImage(designer.id, tenantId, {
          styleOverride: 'editorial-illustration',
        }).catch(err => console.warn('[designer] avatar gen failed:', err.message));
      } catch (err) {
        console.warn('[designer] avatar gen dispatch failed:', err.message);
      }
    });
  }

  return designer;
}

module.exports = { editorialReview, getEditorAgent, ensureDesignerSeeded, getCopyEditorAgent };
