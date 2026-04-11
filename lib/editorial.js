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
async function editorialReview(article, tenantId) {
  // Skip if revision cap exceeded — go straight to human review
  if ((article.editorial_revision_count || 0) >= REVISION_CAP) {
    console.log(`[editorial] Article ${article.id} hit revision cap (${REVISION_CAP}), skipping AI review`);
    return { publish: false, score: 0, issues: [`Exceeded ${REVISION_CAP} revision attempts`], suggestion: 'Requires human review' };
  }

  // Skip if recently reviewed (cooldown)
  if (article.last_reviewed_at) {
    const elapsed = Date.now() - new Date(article.last_reviewed_at).getTime();
    if (elapsed < REVIEW_COOLDOWN_MS) {
      console.log(`[editorial] Article ${article.id} reviewed ${Math.round(elapsed / 1000)}s ago, cooldown active`);
      return null; // Skip review, let caller decide
    }
  }

  // Get writer name for the review context
  const writer = await db.prepare('SELECT name FROM writers WHERE id = $1').get(article.writer_id);

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

  const reviewPrompt = loadPrompt('editorial-review');
  const rendered = reviewPrompt.render({
    title: article.title || 'Untitled',
    writerName: writer?.name || 'Unknown',
    category: article.category || 'General',
    sourceCount: String(sourceCount),
    wordCount: String(wordCount),
    content: content.slice(0, 6000), // Cap content to avoid context overflow
  });

  const result = await aiComplete({
    operation: 'editorial-review',
    tenantId,
    messages: rendered.messages,
    temperature: rendered.temperature,
    maxTokens: rendered.maxTokens,
    trigger: 'editorial',
    articleSlug: article.slug,
    writerId: article.writer_id,
  });

  if (!result?.text) {
    console.error(`[editorial] AI review returned no result for article ${article.id}`);
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
  } catch (err) {
    console.error('[editorial] Failed to record newsroom message:', err.message);
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

module.exports = { editorialReview, getEditorAgent };
