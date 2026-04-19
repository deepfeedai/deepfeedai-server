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

function buildPersona(writer) {
  if (writer.role === 'designer') return buildIrisPersona(writer);
  if (writer.role === 'copy-editor') return buildVeraPersona(writer);
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
async function applyProposal(proposal, tenantId) {
  const { proposal_type, article_id } = proposal;
  const articleId = parseInt(article_id, 10) || 0;

  // Standalone thumbnail (no article) — nothing to apply, just acknowledge
  if (proposal_type === 'thumbnail' && !articleId) {
    return { ok: true, text: 'Glad you like it! Attach an article if you\'d like to apply it.' };
  }

  if (!articleId) throw new Error('Invalid article_id');

  const article = await db.prepare('SELECT id, title, image_url FROM articles WHERE id = $1 AND tenant_id = $2').get(articleId, tenantId);
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

  throw new Error(`Unknown proposal_type: ${proposal_type}`);
}

module.exports = { handleWithTools, applyProposal };
