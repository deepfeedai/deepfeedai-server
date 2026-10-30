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
const { getPool }    = require('../db');
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
        'Sources are optional when saving a research assignment. Without two sources, save as Needs sources; drafting requires real sources and a separate paid action.',
      parameters: {
        type: 'object',
        properties: {
          writer_name: { type: 'string', description: 'Exact writer name from the roster' },
          topic: { type: 'string', description: 'Concise research assignment topic' },
          angle_summary: { type: 'string', description: 'One-sentence editorial angle' },
          type: {
            type: 'string',
            enum: ['original','follow_up','thread_update','roundup','deep_dive','explainer','counter_angle','prediction_check','analysis','breaking'],
            description:
              'Pitch type. Pick based on source count + editorial shape. ' +
              'roundup requires 3+ sources; deep_dive benefits from 2-4; ' +
              'follow_up continues a prior story; thread_update advances an active story thread (auto-links to prior coverage on the same topic_tag); ' +
              'original is a single fresh angle. ' +
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



    // ── Read / query tools (no proposal — fetch data and summarise) ──────────
    {
      name: 'getNewsroomStats',
      description:
        'Get a live snapshot of newsroom metrics: pending story pitches, open commissions, ' +
        'review queue depth, articles published today and this week, research intake in the last 24h. ' +
        'Call when the editor asks for a newsroom overview, pipeline status, or "what\'s going on".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'listPendingPitches',
      description:
        'List pitches currently waiting for action — both story pitches from writer agents ' +
        'and editor-commissioned article pitches. Call when asked about the pitch pipeline, ' +
        'pending pitches, what needs review, or pitch activity.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max pitches to return per type (default 8)' },
        },
        required: [],
      },
    },
    {
      name: 'listReviewQueue',
      description:
        'List articles currently sitting in the editorial review queue. ' +
        'Call when asked what is stuck in review, awaiting approval, or needs editorial attention.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'listRecentArticles',
      description:
        'List recently published original articles, optionally filtered by time period. ' +
        'Call when asked to walk through published output, summarise coverage, or review articles from a period.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'this_week', 'last_week'],
            description: 'Time period (default: this_week)',
          },
          limit: { type: 'number', description: 'Max articles (default 10)' },
        },
        required: [],
      },
    },
    {
      name: 'listResearchIntake',
      description:
        'List recently ingested research sources from the feed inbox (curated/RSS articles). ' +
        'Call when asked about research intake, source activity, what came in recently, or pitch opportunities.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max sources (default 15)' },
        },
        required: [],
      },
    },
    {
      name: 'listFeedInboxGroups',
      description:
        'List all named inbox folders/groups with their article counts and ungrouped count. ' +
        'Call when the editor asks about folders, groups, how sources are organised, or wants a summary of the inbox.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'searchFeedInbox',
      description:
        'Search the feed inbox for sources matching a keyword, category, or folder. ' +
        'Call when the editor mentions specific topics, asks "what sources do we have on X", ' +
        '"find me something about Y", or wants to explore sources before pitching.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search in title and summary' },
          category: { type: 'string', description: 'Filter by category name (optional)' },
          group_id: { type: 'number', description: 'Filter by folder id (optional)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: [],
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



    `\n\nYou have two types of tools:\n` +
    `READ tools (call these to look up live data before answering):\n` +
    `  getNewsroomStats — pipeline counts, published today/week, research intake\n` +
    `  listPendingPitches — pitches waiting for action\n` +
    `  listReviewQueue — articles stuck in editorial review\n` +
    `  listRecentArticles — recently published originals (filter by period)\n` +
    `  listResearchIntake — recently ingested sources from the feed inbox\n` +
    `  listFeedInboxGroups — inbox folders with article counts\n` +
    `  searchFeedInbox — search inbox sources by keyword, category, or folder\n` +
    `Always call the appropriate read tool when asked about newsroom data. Never say you cannot access data — use the tools.\n` +
    `\nACTION tools (button-gated proposals the editor must confirm before anything executes):\n` +
    `  proposePitch — recommend a story angle from an attached source; editor confirms before the pitch is created\n` +
    `  proposeApprove — approve and publish an article; call when editor says "approve", "publish it", "give it the green light", "looks good — go"\n` +
    `  proposeKill — archive/remove an article; call when editor says "kill it", "pull this", "this is dead", "archive it"; always include a brief reason field\n` +
    `  proposeAssignWriter — reassign an article to a different writer; call when editor says "give this to [name]", "swap the writer", "reassign to [name]"\n` +
    `  proposeFeature — feature or unfeature an article on the homepage; call when editor says "feature this", "make it the lead", "put it on the homepage" or "unfeature", "remove from homepage"\n` +
    `\nFor any ACTION tool: only call it when an article is attached (context_article_id is set). ` +
    `If no article context is present, ask the editor which article they mean before calling.\n` +
    `\nWhen the editor asks "what can I do?", "suggest actions", "what actions can I take", "what are my options?", or "help me with this" ` +
    `and an article is attached — assess the article's state (draft vs review vs published, featured vs unfeatured) ` +
    `and proactively call the most relevant action tool rather than giving a text-only answer.\n` +

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
    if(typeof args.angle_summary!=='string'||!args.angle_summary.trim())throw new Error('Provide an editorial angle before creating an assignment.');
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
    // Fetch titles for all sources so the proposal card can list them.
    // Tenant-scoped — rejected ids (cross-tenant or deleted) drop out.
    let source_titles = [];
    if (dedupedIds.length) {
      try {
        const rows = await db.prepare(
          'SELECT id, title FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2'
        ).all(dedupedIds, tenantId);
        const m = new Map(rows.map(r => [r.id, r.title]));
        source_titles = dedupedIds.map(id => ({ id, title: m.get(id) || null })).filter(x => x.title);
      } catch { /* optional */ }
    }
    return {
      default_preview_text: `Pitch: ${args.angle_summary || '(no angle)'} → ${writer?.name || args.writer_name || 'unassigned'}`,
      proposal: {
        type: 'tool_proposal',
        proposal_type: 'pitch',
        request_key: require('node:crypto').randomUUID(),
        topic: String(args.topic||args.angle_summary).slice(0,200),
        pitch_type: pitchType,
        article_id: primaryId,
        source_article_ids: dedupedIds,
        attached_article_ids: attachedIds,
        source_titles: source_titles,
        angle_summary: args.angle_summary || '',
        writer_id: writer?.id || null,
        writer_name: writer?.name || args.writer_name || null,
      },
    };
  }

  if (name === 'proposeApprove') {
    const id = parseInt(args.article_id, 10) || articleId;

    if (!id || id <= 0) throw new Error('article_id required for proposeApprove');

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

    if (!id || id <= 0) throw new Error('article_id required for proposeKill');

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

    if (!id || id <= 0) throw new Error('article_id required for proposeAssignWriter');

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

    if (!id || id <= 0) throw new Error('article_id required for proposeFeature');

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

const QUERY_TOOLS = new Set(['getNewsroomStats', 'listPendingPitches', 'listReviewQueue', 'listRecentArticles', 'listResearchIntake', 'listFeedInboxGroups', 'searchFeedInbox']);

async function executeQueryTool(name, args, tenantId) {
  const pool = getPool();
  const tid = tenantId;
  const limit = Math.min(Number(args.limit) || 10, 30);

  switch (name) {
    case 'getNewsroomStats': {
      const [pitchRow, commRow, reviewRow, todayRow, weekRow, intakeRow] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS cnt FROM story_pitches WHERE tenant_id=$1 AND status='pending'`, [tid]),
        pool.query(`SELECT COUNT(*)::int AS cnt FROM article_pitches WHERE tenant_id=$1 AND status IN ('proposed','approved')`, [tid]),
        pool.query(`SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id=$1 AND status='review' AND is_archived=0`, [tid]),
        pool.query(`SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id=$1 AND is_published=1 AND published_at >= NOW()-INTERVAL '1 day'`, [tid]),
        pool.query(`SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id=$1 AND is_published=1 AND published_at >= NOW()-INTERVAL '7 days'`, [tid]),
        pool.query(`SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id=$1 AND content_type='curated' AND created_at >= NOW()-INTERVAL '24 hours'`, [tid]),
      ]);
      return {
        pending_story_pitches: pitchRow.rows[0].cnt,
        open_commissions: commRow.rows[0].cnt,
        in_review_queue: reviewRow.rows[0].cnt,
        published_today: todayRow.rows[0].cnt,
        published_this_week: weekRow.rows[0].cnt,
        research_intake_24h: intakeRow.rows[0].cnt,
      };
    }
    case 'listPendingPitches': {
      const half = Math.max(Math.floor(limit / 2), 5);
      const [storyRows, commRows] = await Promise.all([
        pool.query(
          `SELECT sp.id, sp.headline, w.name AS writer_name, sp.pitch_type, sp.priority, sp.created_at
           FROM story_pitches sp LEFT JOIN writers w ON w.id=sp.writer_id AND w.tenant_id=$1
           WHERE sp.tenant_id=$1 AND sp.status='pending'
           ORDER BY sp.priority DESC, sp.created_at DESC LIMIT $2`,
          [tid, half]
        ),
        pool.query(
          `SELECT ap.id, ap.angle_summary, ap.status, ap.pitch_type, w.name AS writer_name,
                  a.title AS source_title, ap.created_at
           FROM article_pitches ap
           LEFT JOIN writers w ON w.id=ap.pitched_by_writer_id AND w.tenant_id=$1
           LEFT JOIN articles a ON a.id=ap.source_article_id AND a.tenant_id=$1
           WHERE ap.tenant_id=$1 AND ap.status IN ('proposed','approved')
           ORDER BY ap.created_at DESC LIMIT $2`,
          [tid, half]
        ),
      ]);
      return {
        story_pitches: storyRows.rows.map(r => ({ id: r.id, headline: r.headline, writer: r.writer_name, type: r.pitch_type, priority: r.priority, created_at: r.created_at })),
        commissions: commRows.rows.map(r => ({ id: r.id, angle: r.angle_summary, source: r.source_title, status: r.status, writer: r.writer_name, type: r.pitch_type, created_at: r.created_at })),
      };
    }
    case 'listReviewQueue': {
      const rows = await pool.query(
        `SELECT a.id, a.title, w.name AS writer_name, a.category, a.created_at
         FROM articles a LEFT JOIN writers w ON w.id=a.writer_id AND w.tenant_id=$1
         WHERE a.tenant_id=$1 AND a.status='review' AND a.is_archived=0
         ORDER BY a.created_at ASC LIMIT 20`,
        [tid]
      );
      return { articles: rows.rows.map(r => ({ id: r.id, title: r.title, writer: r.writer_name, category: r.category, waiting_since: r.created_at })) };
    }
    case 'listRecentArticles': {
      const period = ['today', 'this_week', 'last_week'].includes(args.period) ? args.period : 'this_week';
      const days = period === 'today' ? 1 : period === 'last_week' ? 14 : 7;
      const rows = await pool.query(
        `SELECT a.id, a.title, w.name AS writer_name, a.published_at, a.category, a.content_type
         FROM articles a LEFT JOIN writers w ON w.id=a.writer_id AND w.tenant_id=$1
         WHERE a.tenant_id=$1 AND a.is_published=1
           AND a.content_type IN ('original','deep-dive')
           AND a.published_at >= NOW() - ($3 * INTERVAL '1 day')
         ORDER BY a.published_at DESC LIMIT $2`,
        [tid, limit, days]
      );
      return { period, articles: rows.rows.map(r => ({ id: r.id, title: r.title, writer: r.writer_name, category: r.category, published_at: r.published_at })) };
    }
    case 'listResearchIntake': {
      const rows = await pool.query(
        `SELECT a.id, a.title, a.source_url, a.category, a.created_at
         FROM articles a
         WHERE a.tenant_id=$1 AND a.content_type='curated'
         ORDER BY a.created_at DESC LIMIT $2`,
        [tid, limit]
      );
      return { sources: rows.rows.map(r => ({ id: r.id, title: r.title, url: r.source_url, category: r.category, ingested_at: r.created_at })) };
    }
    case 'listFeedInboxGroups': {
      const [groupRows, ungrpRow] = await Promise.all([
        pool.query(
          `SELECT g.id, g.name, g.color, COUNT(a.id)::int AS article_count
           FROM feed_groups g
           LEFT JOIN articles a ON a.group_id = g.id AND a.tenant_id = g.tenant_id AND a.is_archived = 0
           WHERE g.tenant_id = $1
           GROUP BY g.id ORDER BY g.name ASC`,
          [tid]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS cnt FROM articles
           WHERE tenant_id=$1 AND group_id IS NULL AND (content_type IS NULL OR content_type='curated') AND is_archived=0`,
          [tid]
        ),
      ]);
      return {
        groups: groupRows.rows.map(r => ({ id: r.id, name: r.name, color: r.color, article_count: r.article_count })),
        ungrouped_count: ungrpRow.rows[0].cnt,
      };
    }
    case 'searchFeedInbox': {
      const q = args.query ? String(args.query).slice(0, 200) : null;
      let sql = `SELECT a.id, a.title, a.source, a.category, a.editorial_score, a.created_at,
                        fg.name AS group_name
                 FROM articles a
                 LEFT JOIN feed_groups fg ON fg.id = a.group_id AND fg.tenant_id = a.tenant_id
                 WHERE a.tenant_id=$1 AND (a.content_type IS NULL OR a.content_type='curated') AND a.is_archived=0`;
      const sqlParams = [tid];
      if (q) {
        sqlParams.push(`%${q}%`);
        sql += ` AND (LOWER(a.title) LIKE LOWER($${sqlParams.length}) OR LOWER(a.summary) LIKE LOWER($${sqlParams.length}))`;
      }
      if (args.category) {
        sqlParams.push(args.category);
        sql += ` AND a.category = $${sqlParams.length}`;
      }
      if (args.group_id) {
        sqlParams.push(args.group_id);
        sql += ` AND a.group_id = $${sqlParams.length}`;
      }
      sqlParams.push(limit);
      sql += ` ORDER BY a.created_at DESC LIMIT $${sqlParams.length}`;
      const rows = await pool.query(sql, sqlParams);
      return { sources: rows.rows.map(r => ({ id: r.id, title: r.title, source: r.source, category: r.category, score: r.editorial_score, folder: r.group_name, ingested_at: r.created_at })) };
    }
    default:
      return { error: 'Unknown query tool' };
  }
}

async function handleWithTools(tenantId, writer, message, contextKey, meta = {}, articleId = null) {
  const tools = TOOLS_BY_ROLE[writer.role] || [];
  const history = contextKey ? await getHistory(contextKey, tenantId, writer.id) : [];
  const persona = buildPersona(writer);

  // Strip legacy <<<PITCH:>>> role-reminder injected by newsroom-chat.js —
  // Maxwell uses the proposePitch tool on this path, not the string protocol.
  const cleanMessage = message.replace(/\[ROLE REMINDER[\s\S]*?\](?:\s*$)?/m, '').trim();

  const messages = [
    { role: 'system', content: persona },
  ];
  if (writer.chat_prompt) {
    messages.push({ role: 'system', content: writer.chat_prompt });
  }
  messages.push(...history);
  messages.push({ role: 'user', content: cleanMessage });

  let result;
  try {
    result = await aiComplete({
      operation: 'chat',
      tenantId,
      messages,
      temperature: 0.7,
      maxTokens: 2000,
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

    // ── Read / query tools: fetch data then let Maxwell summarise naturally ──
    if (QUERY_TOOLS.has(toolCall.name)) {
      let data;
      try {
        data = await executeQueryTool(toolCall.name, toolCall.args || {}, tenantId);
      } catch (err) {
        console.error('[agent-tools] query tool error:', err.message);
        data = { error: err.message };
      }

      const summaryMessages = [
        ...messages,
        { role: 'assistant', content: result.text || 'Let me pull that up.' },
        { role: 'user', content: `[Data from ${toolCall.name}]\n${JSON.stringify(data, null, 2)}\n\nAnswer the editor's question using this data. Be direct and editorial — don't mention tool names or raw JSON.` },
      ];
      const summary = await aiComplete({
        operation: 'chat', tenantId, messages: summaryMessages,
        temperature: 0.5, maxTokens: 900, trigger: 'web-chat-tools', writerId: writer.id,
      }).catch(() => null);

      const text = summary?.text || JSON.stringify(data);
      if (contextKey) await addTurn(contextKey, message, text, { tenantId, writerId: writer.id, contextArticleId: articleId || meta.contextArticleId || null });
      return { type: 'text', text };
    }

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


  // Strip any legacy <<<PITCH:>>> blocks Maxwell may still hallucinate — on
  // this path he should use the proposePitch tool instead.
  const rawText = result.text || '';
  const hadPitchBlock = /<<<PITCH:[\s\S]*?>>>/.test(rawText);
  const stripped = rawText.replace(/<<<PITCH:[\s\S]*?>>>/g, '').trim();
  const text = stripped || (hadPitchBlock ? 'Pitch proposal submitted.' : '(no response)');


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
    const ids=[proposal.article_id,...(proposal.source_article_ids||[]),...(proposal.attached_article_ids||[])].filter(Boolean);
    const row=await require('./editor-assignments').create({...proposal,source_article_ids:[...new Set(ids)]},tenantId,actorUserId);
    return {ok:true,pitch_id:row.id,status:row.status,text:'Assignment saved. Attach sources, approve, then explicitly generate a paid draft in Commissions.'};
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
