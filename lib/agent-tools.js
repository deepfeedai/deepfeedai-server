/**
 * Deep Feed AI — Agent Tool Calling
 * Handles propose→confirm tool flows for system agents (Iris, Vera).
 *
 * Iris (designer)    → generateThumbnail
 * Vera (copy-editor) → proposeHeadline
 *
 * Flow: editor sends message → AI decides to call a tool → preview generated
 * → response includes { type: 'tool_proposal', ... } → UI shows approve/reject
 * → approve POSTs to /api/newsroom-chat/actions/approve
 */
'use strict';

const db             = require('../db');
const { complete: aiComplete, generateImage } = require('./ai-router');
const { getHistory, addTurn }                 = require('./messaging/context');
const { getVisualConcept, buildImagePrompt, storeImage, getArtDirection } = require('./media-helpers');
const { canSpend }   = require('./budget');

// ── Tool definitions (unified schema) ────────────────────────────────────────

const TOOLS_BY_ROLE = {
  designer: [
    {
      name: 'generateThumbnail',
      description:
        'Generate an image — article thumbnail, concept art, illustration, or any visual the editor requests. ' +
        'Always call this when the editor asks to generate, create, design, or draw anything visual.',
      parameters: {
        type: 'object',
        properties: {
          concept: {
            type: 'string',
            description: 'What to depict — visual concept, subject, scene, mood, and composition',
          },
          style_notes: {
            type: 'string',
            description: 'Style guidance, e.g. "cartoon", "photorealistic", "dark and moody" (optional)',
          },
        },
        required: ['concept'],
      },
    },
  ],
  'copy-editor': [
    {
      name: 'proposeHeadline',
      description:
        'Propose a rewritten headline for the article being discussed. ' +
        'Call this when the editor asks you to rewrite, improve, punch up, or optimize the title/headline.',
      parameters: {
        type: 'object',
        properties: {
          new_headline: {
            type: 'string',
            description: 'The proposed new headline',
          },
          rationale: {
            type: 'string',
            description: 'Brief explanation of why this headline is stronger',
          },
        },
        required: ['new_headline', 'rationale'],
      },
    },
  ],
  // Maxwell (editorial director). Enabled when the maxwell_tool_calling feature
  // flag is on; otherwise the legacy <<<PITCH:…>>> string protocol is used.
  editor: [
    {
      name: 'proposePitch',
      description:
        'Recommend assigning a story angle to a named writer from the roster. ' +
        'Call when you have a concrete editorial recommendation for the article(s) in context — ' +
        'not for exploratory responses. Returns a button-gated proposal the editor can approve. ' +
        'Supports multi-source pitches via source_article_ids[].',
      parameters: {
        type: 'object',
        properties: {
          writer_name: { type: 'string', description: 'Exact writer name from the roster' },
          angle_summary: { type: 'string', description: 'One-sentence editorial angle' },
          type: {
            type: 'string',
            enum: ['original','follow_up','roundup','deep_dive','explainer','counter_angle','prediction_check','analysis','breaking'],
            description:
              'Pitch type. Pick based on source count + editorial shape. ' +
              'roundup requires 3+ sources; deep_dive benefits from 2-4; ' +
              'follow_up continues a prior story; original is a single fresh angle. ' +
              'Defaults to original if omitted.',
          },
          source_article_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional list of additional source article IDs when the pitch bundles multiple sources. If omitted, only the currently-attached article is used.',
          },
        },
        required: ['writer_name', 'angle_summary'],
      },
    },
    {
      name: 'proposeApprove',
      description:
        'Propose approving an article for publication. Always button-gated — the editor confirms.',
      parameters: {
        type: 'object',
        properties: {
          article_id: { type: 'integer', description: 'Numeric id of the article to approve' },
        },
        required: ['article_id'],
      },
    },
    {
      name: 'proposeKill',
      description:
        'Propose killing (unpublishing / marking as killed) an article. Destructive — ' +
        'always button-gated with a confirmation prompt.',
      parameters: {
        type: 'object',
        properties: {
          article_id: { type: 'integer' },
          reason: { type: 'string', description: 'Short reason shown on the confirmation card' },
        },
        required: ['article_id', 'reason'],
      },
    },
    {
      name: 'proposeAssignWriter',
      description:
        'Propose reassigning an article to a different writer on the roster.',
      parameters: {
        type: 'object',
        properties: {
          article_id: { type: 'integer' },
          writer_name: { type: 'string', description: 'Exact writer name from the roster' },
        },
        required: ['article_id', 'writer_name'],
      },
    },
    {
      name: 'proposeFeature',
      description:
        'Propose toggling the featured flag on an article (site homepage placement).',
      parameters: {
        type: 'object',
        properties: {
          article_id: { type: 'integer' },
          featured: { type: 'boolean' },
        },
        required: ['article_id', 'featured'],
      },
    },
  ],
};

// ── System prompt builders ────────────────────────────────────────────────────

function buildIrisPersona(writer) {
  return (
    `You are ${writer.name || 'Iris'}, the visual design agent for this newsroom. ` +
    `You can generate any image — article thumbnails, concept art, illustrations, brand assets, anything visual. ` +
    `Whenever an editor asks you to generate, create, or design any image, call the generateThumbnail tool with a concept description. ` +
    `If an article is attached, base the concept on its content. If there is no article, use the editor's description as the concept. ` +
    `Do not explain tool call mechanics or refuse image requests — just call the tool and generate. ` +
    `When just chatting about visual ideas without a generation request, be concise and creative.`
  );
}

function buildVeraPersona(writer) {
  return (
    `You are ${writer.name || 'Vera'}, the copy-editor agent for this newsroom. ` +
    `You specialize in sharp, accurate, SEO-friendly headlines and tightly written copy. ` +
    `When an editor asks you to rewrite, improve, or punch up a headline or title, call the proposeHeadline tool. ` +
    `Keep rationale brief — one or two sentences max. ` +
    `Do not explain tool call mechanics to the editor — just act.`
  );
}

function buildMaxwellPersona(writer) {
  const { PITCH_TYPES } = require('./pitch-types');
  const typeGuide = PITCH_TYPES
    .map(t => `  ${t.key} — ${t.hint}${t.min_sources > 1 ? ` (needs ≥${t.min_sources} sources)` : ''}`)
    .join('\n');
  return (
    `You are ${writer.name || 'Maxwell'}, the editorial director for this newsroom. ` +
    `You do NOT write articles — you evaluate stories, recommend coverage, and direct writers. ` +
    `When you have a concrete editorial decision, call the matching tool: ` +
    `proposePitch (assign a story angle), proposeApprove (publish), proposeKill (unpublish, always requires a reason), ` +
    `proposeAssignWriter (reassign), or proposeFeature (homepage placement). ` +
    `Every tool call is button-gated — the editor sees the proposal and confirms, so don't second-guess whether to call; call whenever the editor's intent is clear. ` +
    `\n\nWhen calling proposePitch, always pass a "type" from this taxonomy:\n${typeGuide}\n` +
    `If the editor supplies or implies a type ("make it a roundup", "follow-up to Priya's piece"), use that. ` +
    `Otherwise infer from the sources attached: 3+ related sources → roundup; a single article building on prior coverage → follow_up; a single fresh source → original. ` +
    `When the editor is exploring or asking for your read without a clear decision, respond conversationally without a tool call.`
  );
}

function buildPersona(writer) {
  if (writer.role === 'designer') return buildIrisPersona(writer);
  if (writer.role === 'copy-editor') return buildVeraPersona(writer);
  if (writer.role === 'editor') return buildMaxwellPersona(writer);
  return `You are ${writer.name}, a system agent for this newsroom.`;
}

// ── Image preview (generate + store, no DB write) ────────────────────────────

/**
 * Generate an image and upload to storage, WITHOUT updating the article DB row.
 * Works with or without an article — when articleId is null, generates from toolArgs.concept.
 * Throws on failure so the caller can surface the real error message.
 * @returns {{ previewUrl: string }}
 */
async function generateImagePreview(articleId, tenantId, toolArgs = {}) {
  // Optional article context
  let article = null;
  let category = '';
  let articleSlug = null;

  if (articleId) {
    article = await db.prepare(
      'SELECT id, title, summary, full_content, category, slug FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(articleId, tenantId);
    if (!article) throw new Error('Article not found — it may have been deleted');
    category = article.category || '';
    articleSlug = article.slug;
  }

  const budgetCheck = await canSpend('thumbnail-render', tenantId);
  if (!budgetCheck.allowed) throw new Error('Image generation budget limit reached for this period');

  // Build visual concept — prefer agent-supplied, fall back to article-based auto-generation
  let visualResult = null;
  if (toolArgs.concept) {
    visualResult = {
      concept: toolArgs.concept,
      style: toolArgs.style_notes || '',
    };
  } else if (article) {
    visualResult = await getVisualConcept(
      article.title,
      article.summary || article.full_content,
      category,
      tenantId,
      'designer',
    );
  } else {
    throw new Error('No concept provided — please describe what you want me to generate');
  }

  const tenantArtDirection = await getArtDirection(tenantId, 'thumbnails');
  const buildOpts = {
    category,
    tier: null,
    tenantArtDirection,
    articleType: 'article',
    customNotes: toolArgs.style_notes || null,
  };
  const titleForPrompt = article?.title || toolArgs.concept || 'concept art';
  const fullPrompt = buildImagePrompt(visualResult, titleForPrompt, buildOpts);

  const imgResult = await generateImage({
    tenantId,
    prompt: fullPrompt,
    operation: 'thumbnail-render',
    aspectRatio: '16:9',
    articleSlug,
    trigger: 'designer-preview',
  });

  const pngBuf = Buffer.from(imgResult.b64, 'base64');
  const randHex = require('crypto').randomBytes(8).toString('hex');
  const filename = `preview-${randHex}-${Date.now()}.png`;
  const previewUrl = await storeImage(pngBuf, filename, tenantId);

  return { previewUrl };
}

// ── Editor proposals (Maxwell) ───────────────────────────────────────────────
// Build a tool_proposal payload for editor tool calls. Returns null if the
// toolCall.name isn't an editor tool. Resolves writer_name → writer_id so the
// apply path doesn't need to repeat the lookup. All payloads are button-gated
// — no DB mutation happens here.
async function _buildEditorProposal(toolCall, articleId, tenantId) {
  const name = toolCall?.name;
  const args = toolCall?.args || {};

  async function resolveWriterId(writerName) {
    if (!writerName || writerName === 'null') return null;
    const row = await db.prepare(
      `SELECT id, name FROM writers WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) AND is_system = false LIMIT 1`
    ).get(tenantId, writerName).catch(() => null);
    return row || null;
  }

  if (name === 'proposePitch') {
    const writer = await resolveWriterId(args.writer_name);
    const { normalisePitchType } = require('./pitch-types');
    const pitchType = normalisePitchType(args.type);
    // source_article_ids[] may include or omit the currently-attached one.
    // Normalise: dedupe, first = primary source, rest = attached.
    const raw = Array.isArray(args.source_article_ids) ? args.source_article_ids : [];
    const ids = [articleId, ...raw].filter(Boolean).map(n => parseInt(n, 10)).filter(Boolean);
    const dedupedIds = [...new Set(ids)];
    const primaryId = dedupedIds[0] || articleId || null;
    const attachedIds = dedupedIds.slice(1);
    return {
      default_preview_text: `Pitch: ${args.angle_summary || '(no angle)'} → ${writer?.name || args.writer_name || 'unassigned'}`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'pitch',
        pitch_type: pitchType,
        article_id: primaryId,
        source_article_ids: dedupedIds,
        attached_article_ids: attachedIds,
        angle_summary: args.angle_summary || '',
        writer_id: writer?.id || null,
        writer_name: writer?.name || args.writer_name || null,
      },
    };
  }

  if (name === 'proposeApprove') {
    const id = parseInt(args.article_id, 10) || articleId;
    return {
      default_preview_text: `Approve article #${id}?`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'approve_article',
        article_id: id,
      },
    };
  }

  if (name === 'proposeKill') {
    const id = parseInt(args.article_id, 10) || articleId;
    return {
      default_preview_text: `Kill article #${id}? Reason: ${args.reason || '(none)'}. This sets status=killed, unpublishes, and archives.`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'kill_article',
        article_id: id,
        reason: args.reason || '',
        destructive: true,
      },
    };
  }

  if (name === 'proposeAssignWriter') {
    const id = parseInt(args.article_id, 10) || articleId;
    const writer = await resolveWriterId(args.writer_name);
    return {
      default_preview_text: `Assign article #${id} to ${writer?.name || args.writer_name || '(unknown writer)'}`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'assign_writer',
        article_id: id,
        writer_id: writer?.id || null,
        writer_name: writer?.name || args.writer_name || null,
      },
    };
  }

  if (name === 'proposeFeature') {
    const id = parseInt(args.article_id, 10) || articleId;
    const featured = !!args.featured;
    return {
      default_preview_text: `${featured ? 'Feature' : 'Unfeature'} article #${id}?`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'feature_article',
        article_id: id,
        featured,
      },
    };
  }

  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle an incoming message for a tool-capable system agent.
 * Returns one of:
 *   { type: 'text', text }
 *   { type: 'tool_proposal', proposal_type, article_id, preview_text, ... }
 *
 * @param {number} tenantId
 * @param {object} writer         Full writer row
 * @param {string} message        Raw (possibly context-enriched) user message
 * @param {string|null} contextKey
 * @param {object} [meta]         { userId, userName }
 * @param {number|null} [articleId]
 */
async function handleWithTools(tenantId, writer, message, contextKey, meta = {}, articleId = null) {
  const tools = TOOLS_BY_ROLE[writer.role] || [];
  const history = contextKey ? await getHistory(contextKey, tenantId, writer.id) : [];
  const persona = buildPersona(writer);

  const messages = [
    { role: 'system', content: persona },
  ];
  if (writer.chat_prompt) {
    messages.push({ role: 'system', content: writer.chat_prompt });
  }
  messages.push(...history);
  messages.push({ role: 'user', content: message });

  let result;
  try {
    result = await aiComplete({
      operation: 'chat',
      tenantId,
      messages,
      temperature: 0.7,
      maxTokens: 800,
      trigger: 'web-chat-tools',
      writerId: writer.id,
      tools: tools.length ? tools : undefined,
    });
  } catch (err) {
    console.error('[agent-tools] aiComplete failed:', err.message);
    return { type: 'text', text: '⚠️ Agent temporarily unavailable.' };
  }

  if (!result) {
    return { type: 'text', text: '(Budget limit reached)' };
  }

  // ── Handle tool calls ────────────────────────────────────────────────────
  if (result.toolCalls?.length) {
    const toolCall = result.toolCalls[0];

    // Designer: generate image preview (works with or without article context)
    if (toolCall.name === 'generateThumbnail') {
      const previewText = result.text
        || (articleId
          ? "Here's the image I created. Approve to apply it to the article, or skip to try a different direction."
          : "Here's the image I generated. Let me know if you'd like any changes.");

      let preview;
      try {
        preview = await generateImagePreview(articleId, tenantId, toolCall.args || {});
      } catch (err) {
        console.error('[agent-tools] generateImagePreview error:', err.message);
        const errText = `I ran into a problem: ${err.message}`;
        if (contextKey) await addTurn(contextKey, message, errText, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
        return { type: 'text', text: errText };
      }

      if (contextKey) await addTurn(contextKey, message, previewText, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
      return {
        type: 'tool_proposal',
        proposal_type: 'thumbnail',
        article_id: articleId || null,
        preview_url: preview.previewUrl,
        preview_text: previewText,
        tool_args: toolCall.args || {},
      };
    }

    // ── Editor (Maxwell) proposals ───────────────────────────────────────
    const editorProposal = await _buildEditorProposal(toolCall, articleId, tenantId);
    if (editorProposal) {
      const previewText = result.text || editorProposal.default_preview_text;
      if (contextKey) await addTurn(contextKey, message, previewText, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
      return { ...editorProposal.proposal, preview_text: previewText };
    }

    // Copy-editor: propose headline
    if (toolCall.name === 'proposeHeadline') {
      const { new_headline, rationale } = toolCall.args || {};
      if (!new_headline) {
        const text = result.text || "I couldn't come up with a headline proposal. Could you share more about what angle you'd like?";
        if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
        return { type: 'text', text };
      }

      const previewText = result.text
        || `Here's a headline I'd suggest — approve to apply it to the article.`;

      if (contextKey) await addTurn(contextKey, message, previewText, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
      return {
        type: 'tool_proposal',
        proposal_type: 'headline',
        article_id: articleId,
        new_headline,
        rationale: rationale || '',
        preview_text: previewText,
      };
    }
  }

  // ── Regular text response ────────────────────────────────────────────────
  const text = result.text || '(no response)';
  if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
  return { type: 'text', text };
}

// ── Apply approved proposals ──────────────────────────────────────────────────

/**
 * Apply an approved tool proposal to the article.
 * Returns { ok, text } on success; throws on error.
 *
 * @param {object} proposal
 * @param {number} tenantId
 */
async function applyProposal(proposal, tenantId, actorUserId = null) {
  const { proposal_type, article_id } = proposal;
  const articleId = parseInt(article_id, 10) || 0;

  // Standalone thumbnail (no article) — nothing to apply, just acknowledge
  if (proposal_type === 'thumbnail' && !articleId) {
    return { ok: true, text: 'Glad you like it! Attach an article if you\'d like to apply it.' };
  }

  // Pitch proposals don't need an article id match — they reference a source
  // article. Handled before the article-required gate below.
  if (proposal_type === 'pitch') {
    const { angle_summary, writer_id } = proposal;
    if (!articleId || !angle_summary) throw new Error('source article and angle_summary required');
    const source = await db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
    if (!source) throw new Error('Source article not found');

    const { normalisePitchType } = require('./pitch-types');
    const pitchType = normalisePitchType(proposal.pitch_type);
    const attachedRaw = Array.isArray(proposal.attached_article_ids)
      ? proposal.attached_article_ids
      : (Array.isArray(proposal.source_article_ids) ? proposal.source_article_ids.slice(1) : []);
    // Verify every attached source belongs to this tenant; drop anything that
    // doesn't. Prevents a manipulated payload from bundling foreign articles.
    let attachedIds = [];
    if (attachedRaw.length) {
      const rows = await db.prepare(
        'SELECT id FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2'
      ).all(attachedRaw.map(n => parseInt(n, 10)).filter(Boolean), tenantId);
      const valid = new Set(rows.map(r => r.id));
      attachedIds = attachedRaw
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n) && n !== articleId && valid.has(n));
    }

    // Pitch-assign writer_id column is called pitched_by_writer_id on this
    // table (confusingly the article_pitches schema predates the rename).
    const row = await db.prepare(`
      INSERT INTO article_pitches
        (tenant_id, source_article_id, attached_article_ids, pitched_by_writer_id, requested_by_editor_id, angle_summary, pitch_type, status)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'proposed')
      RETURNING id
    `).get(
      tenantId, articleId, JSON.stringify(attachedIds),
      writer_id || null, actorUserId, String(angle_summary).slice(0, 2000), pitchType,
    );
    const sourceNote = attachedIds.length ? ` (bundling ${attachedIds.length + 1} sources)` : '';
    return { ok: true, text: `Pitch created (#${row.id})${sourceNote} and queued for writer assignment.`, pitch_id: row.id };
  }

  if (!articleId) throw new Error('Invalid article_id');

  const article = await db.prepare('SELECT id, title, status, image_url FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
  if (!article) throw new Error('Article not found');

  if (proposal_type === 'thumbnail') {
    const { preview_url } = proposal;
    if (!preview_url) throw new Error('No preview URL in proposal');
    await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
      .run(preview_url, articleId, tenantId);
    return { ok: true, text: `Done! The new thumbnail has been applied to "${article.title}".` };
  }

  if (proposal_type === 'headline') {
    const { new_headline } = proposal;
    if (!new_headline) throw new Error('No headline in proposal');
    await db.prepare('UPDATE articles SET title = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
      .run(new_headline, articleId, tenantId);
    return { ok: true, text: `Done! The headline has been updated to: "${new_headline}"` };
  }

  if (proposal_type === 'approve_article') {
    if (article.status !== 'review') {
      return { ok: false, text: `Cannot approve — article is in status '${article.status}', not 'review'.` };
    }
    await db.prepare(`
      UPDATE articles SET status = 'published', is_published = 1, is_archived = 0,
        reviewed_by = $1, reviewed_at = NOW(), published_at = NOW(), updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `).run(actorUserId, articleId, tenantId);
    try {
      const { onArticlePublished } = require('./post-publish');
      onArticlePublished(articleId, tenantId).catch(() => {});
    } catch { /* optional */ }
    return { ok: true, text: `Approved and published: "${article.title}".` };
  }

  if (proposal_type === 'kill_article') {
    if (article.status === 'killed') {
      return { ok: false, text: 'Article is already killed.' };
    }
    await db.prepare(`
      UPDATE articles SET status = 'killed', is_published = 0, is_archived = 1,
        archived_at = COALESCE(archived_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
    `).run(articleId, tenantId);
    return { ok: true, text: `Killed: "${article.title}".` };
  }

  if (proposal_type === 'assign_writer') {
    const { writer_id } = proposal;
    if (!writer_id) throw new Error('writer_id required');
    await db.prepare('UPDATE articles SET writer_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
      .run(writer_id, articleId, tenantId);
    return { ok: true, text: `Assigned "${article.title}" to ${proposal.writer_name || 'writer #' + writer_id}.` };
  }

  if (proposal_type === 'feature_article') {
    const featured = !!proposal.featured;
    await db.prepare('UPDATE articles SET is_featured = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
      .run(featured ? 1 : 0, articleId, tenantId);
    return { ok: true, text: featured ? `Featured: "${article.title}".` : `Unfeatured: "${article.title}".` };
  }

  throw new Error(`Unknown proposal_type: ${proposal_type}`);
}

module.exports = { handleWithTools, applyProposal };
