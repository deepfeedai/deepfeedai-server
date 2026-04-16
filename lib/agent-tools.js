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
        'Generate a new thumbnail/header image for the article being discussed. ' +
        'Call this when the editor asks you to create, regenerate, update, or improve the article image or thumbnail.',
      parameters: {
        type: 'object',
        properties: {
          concept: {
            type: 'string',
            description: 'Visual concept for the image — what to depict, mood, and composition',
          },
          style_notes: {
            type: 'string',
            description: 'Additional style or mood guidance (optional)',
          },
        },
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
    `You specialize in creating compelling, on-brand thumbnails and images for news articles. ` +
    `When an editor asks you to create or update an article image, call the generateThumbnail tool. ` +
    `When just chatting about visual concepts, be concise and creative. ` +
    `Do not explain tool call mechanics to the editor — just act.`
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
 * Generate a thumbnail image and upload to storage, WITHOUT updating the article DB row.
 * Returns { previewUrl } or null on failure.
 */
async function generateImagePreview(articleId, tenantId, toolArgs = {}) {
  try {
    const article = await db.prepare(
      'SELECT id, title, summary, full_content, category, slug, story_level FROM articles WHERE id = $1 AND tenant_id = $2'
    ).get(articleId, tenantId);
    if (!article) return null;

    const budgetCheck = await canSpend('thumbnail-render', tenantId);
    if (!budgetCheck.allowed) return null;

    const category = article.category || '';
    const customNotes = toolArgs.style_notes || toolArgs.concept || null;

    // Use the agent-supplied concept if provided, otherwise auto-generate
    let visualResult = null;
    if (toolArgs.concept) {
      visualResult = { concept: toolArgs.concept, style: toolArgs.style_notes || '' };
    } else {
      visualResult = await getVisualConcept(
        article.title,
        article.summary || article.full_content,
        category,
        tenantId,
        'designer',
      );
    }

    const tenantArtDirection = await getArtDirection(tenantId, 'thumbnails');
    const buildOpts = {
      category,
      tier: null,
      tenantArtDirection,
      articleType: 'article',
      customNotes,
    };
    const fullPrompt = buildImagePrompt(visualResult, article.title, buildOpts);

    let b64;
    const imgResult = await generateImage({
      tenantId,
      prompt: fullPrompt,
      operation: 'thumbnail-render',
      aspectRatio: '16:9',
      articleSlug: article.slug,
      trigger: 'designer-preview',
    });
    b64 = imgResult.b64;

    const pngBuf = Buffer.from(b64, 'base64');
    const randHex = require('crypto').randomBytes(8).toString('hex');
    const filename = `preview-${randHex}-${Date.now()}.png`;
    const previewUrl = await storeImage(pngBuf, filename, tenantId);

    return { previewUrl };
  } catch (err) {
    console.error('[agent-tools] generateImagePreview failed:', err.message);
    return null;
  }
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

    // Designer: generate thumbnail preview
    if (toolCall.name === 'generateThumbnail') {
      if (!articleId) {
        const text = "I'd love to generate a thumbnail, but I need an article to be attached as context first. Use the 📎 button to select one.";
        if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id });
        return { type: 'text', text };
      }

      const previewText = result.text
        || "I've created a thumbnail concept. Take a look — approve it to apply it to the article, or skip to try something else.";

      // Generate the image preview (non-blocking if slow — still awaited for URL)
      const preview = await generateImagePreview(articleId, tenantId, toolCall.args || {});
      if (!preview) {
        const errText = "I ran into a problem generating the image. Check your image provider settings and try again.";
        if (contextKey) await addTurn(contextKey, message, errText, { tenantId, writerId: writer.id });
        return { type: 'text', text: errText };
      }

      if (contextKey) await addTurn(contextKey, message, previewText, { tenantId, writerId: writer.id });
      return {
        type: 'tool_proposal',
        proposal_type: 'thumbnail',
        article_id: articleId,
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
        if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id });
        return { type: 'text', text };
      }

      const previewText = result.text
        || `Here's a headline I'd suggest — approve to apply it to the article.`;

      if (contextKey) await addTurn(contextKey, message, previewText, { tenantId, writerId: writer.id });
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
  if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id });
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
  const articleId = parseInt(article_id, 10);
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
