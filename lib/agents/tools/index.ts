/**
 * Chat-agent tool manifest.
 *
 * Every tool handler is bound to { tenantId, writerId, userId } via CLOSURE
 * at graph-build time. The LLM cannot see or pass these — they're out of
 * reach of prompt injection. This is the core tenant-isolation guarantee for
 * the LangGraph agent pilot.
 *
 * Tools are gated by writer role: writers get read-only + memory writes;
 * editors additionally get publish/reject; analysts get forecast generation.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// CJS requires for existing JS modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db: any = require('../../../db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const messaging: any = require('../../messaging');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const writerMemory: any = require('../../writer-memory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const featureRegistry: any = require('../../feature-registry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const research: any = require('../../research');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const presence: any = require('../../presence');

/** Context passed to every tool via closure — NEVER via LLM args. */
export interface ToolContext {
  tenantId: number;
  writerId: number;
  writerRole: string;
  userId?: string | null;
  userName?: string | null;
  platform?: string;
}

const TRUNCATE = 2000;
const truncate = (s: string) => (s?.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…[truncated]' : s);

/** Build the tool set appropriate for this writer's role. */
export function buildTools(ctx: ToolContext) {
  const baseTools = [
    buildSearchArticles(ctx),
    buildListArticlesInBeat(ctx),
    buildFetchArticle(ctx),
    buildGetArticleSources(ctx),
    buildListWriterBeats(ctx),
    buildGetWriterMemory(ctx),
    buildCheckRecentColleagueWork(ctx),
  ];

  // Writers and above can write memory + pitch counter-angles + research the web
  if (['writer', 'editor', 'analyst'].includes(ctx.writerRole)) {
    baseTools.push(buildUpdateWriterMemory(ctx));
    baseTools.push(buildProposeAngle(ctx));
    baseTools.push(buildEnrichSources(ctx));
  }

  // Editors can additionally ingest external research as curated articles
  if (ctx.writerRole === 'editor') {
    baseTools.push(buildIngestExternalAsCurated(ctx));
    // Editor-commissioned-stories flow (gated — tool closures still check the flag
    // at call time so a stale tool binding cannot bypass a disabled tenant).
    baseTools.push(buildDraftEditorBrief(ctx));
    baseTools.push(buildFindBestWriterForTopic(ctx));
    baseTools.push(buildVetAndIngestWithConfirmation(ctx));
  }

  // Editors get publish tools (placeholder — wires into existing publish pipeline in a later PR)
  // if (ctx.writerRole === 'editor') {
  //   baseTools.push(buildPublishArticle(ctx));
  //   baseTools.push(buildRejectArticle(ctx));
  // }

  // Designer tools — available to designers (primary) AND editors (so editors
  // can regenerate without switching chats). Each tool additionally re-checks
  // the graphic_designer feature flag at call time so a stale tool binding
  // cannot bypass a disabled tenant.
  if (ctx.writerRole === 'designer' || ctx.writerRole === 'editor') {
    baseTools.push(buildSetTenantStyleGuide(ctx));
    baseTools.push(buildReviewRecentThumbnails(ctx));
    baseTools.push(buildRegenerateThumbnail(ctx));
    baseTools.push(buildRegenerateWriterAvatar(ctx));
    baseTools.push(buildProposeStylePivot(ctx));
    baseTools.push(buildBatchRegenerateWeakThumbnails(ctx));
  }

  return baseTools;
}

// ── Designer helpers ─────────────────────────────────────────────────

/** Check the designer daily regen budget. Returns { allowed, used, cap }. */
async function checkDesignerBudget(tenantId: number) {
  let cap = 20;
  try {
    const feats = await featureRegistry.getAllFeatures(tenantId);
    const raw = feats.designer_daily_regen_limit;
    const parsed = parseInt(String(raw ?? 20), 10);
    if (Number.isFinite(parsed) && parsed > 0) cap = parsed;
  } catch { /* use default */ }

  const row = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM audit_log
    WHERE tenant_id = $1
      AND action LIKE 'designer.regenerate_%'
      AND created_at > NOW() - INTERVAL '24 hours'
  `).get(tenantId);
  const used = row?.cnt || 0;
  return { allowed: used < cap, used, cap };
}

/** Write a plain audit entry (no Express req) for designer actions. */
async function designerAudit(tenantId: number, writerId: number, action: string, resource: string, resourceId: string | null, details: any) {
  try {
    await db.prepare(`
      INSERT INTO audit_log (tenant_id, user_id, user_email, action, resource, resource_id, details, created_at)
      VALUES ($1, NULL, $2, $3, $4, $5, $6, NOW())
    `).run(tenantId, `writer#${writerId}`, action, resource, resourceId, JSON.stringify(details || {}));
  } catch (err: any) {
    console.warn('[designer] audit write failed:', err?.message);
  }
}

const STYLE_FAMILIES_LIST = [
  'editorial-illustration',
  'documentary-photo',
  'noir',
  'minimalist-vector',
  'isometric-tech',
  'vintage-print',
  'cinematic-poster',
  'mixed-media',
];

async function designerEnabled(tenantId: number): Promise<boolean> {
  return featureRegistry.isFeatureEnabled(tenantId, 'graphic_designer').catch(() => false);
}

function buildSetTenantStyleGuide(ctx: ToolContext) {
  return tool(
    async ({ family, notes }: { family: string; notes?: string }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled for this newsroom.' });
      }
      if (!STYLE_FAMILIES_LIST.includes(family)) {
        return JSON.stringify({ status: 'error', message: `Unknown style family "${family}". Must be one of: ${STYLE_FAMILIES_LIST.join(', ')}.` });
      }
      const trimmedNotes = notes ? String(notes).slice(0, 2000) : null;
      const value = JSON.stringify({ style: family, notes: trimmedNotes || undefined });
      try {
        await db.prepare(`
          INSERT INTO settings (tenant_id, key, value)
          VALUES ($1, 'art_direction', $2)
          ON CONFLICT (tenant_id, key)
          DO UPDATE SET value = $2
        `).run(ctx.tenantId, value);
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Failed to save style guide: ${err?.message || 'unknown'}` });
      }
      await designerAudit(ctx.tenantId, ctx.writerId, 'designer.set_style_guide', 'settings', 'art_direction', { family, notes: trimmedNotes });
      return JSON.stringify({ status: 'ok', family, notes: trimmedNotes, message: `Tenant style guide set to "${family}".` });
    },
    {
      name: 'setTenantStyleGuide',
      description:
        'Designer/editor-only. Set the tenant-wide art direction: one of the 8 style families applied to new thumbnails and avatars by default. ' +
        'Optional `notes` are prepended to subsequent image prompts. Prefer proposeStylePivot for significant brand changes — setTenantStyleGuide is unilateral.',
      schema: z.object({
        family: z.enum([
          'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
          'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
        ]).describe('Style family name.'),
        notes: z.string().max(2000).optional().describe('Freeform notes prepended to image prompts.'),
      }),
    },
  );
}

function buildReviewRecentThumbnails(ctx: ToolContext) {
  return tool(
    async ({ days, limit }: { days?: number; limit?: number }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled.' });
      }
      const d = Math.min(Math.max(days ?? 7, 1), 90);
      const cap = Math.min(Math.max(limit ?? 20, 1), 50);
      const rows = await db.prepare(`
        SELECT id, COALESCE(generated_title, title) AS title, category, image_url,
               synthesis_meta, published_at
        FROM articles
        WHERE tenant_id = $1
          AND is_published = 1
          AND image_url IS NOT NULL
          AND published_at > NOW() - make_interval(days => $2)
        ORDER BY published_at DESC
        LIMIT $3
      `).all(ctx.tenantId, d, cap);
      const results = (rows || []).map((r: any) => {
        let imageMeta: any = null;
        try {
          const sm = typeof r.synthesis_meta === 'string' ? JSON.parse(r.synthesis_meta) : r.synthesis_meta;
          if (sm && sm.image) imageMeta = sm.image;
        } catch { /* ignore */ }
        return {
          id: r.id,
          title: r.title,
          category: r.category,
          image_url: r.image_url,
          style_family: imageMeta?.style || null,
          mood: imageMeta?.mood || null,
          composition: imageMeta?.composition || null,
          published_at: r.published_at,
        };
      });
      return JSON.stringify({ status: 'ok', lookback_days: d, count: results.length, results });
    },
    {
      name: 'reviewRecentThumbnails',
      description:
        'Designer/editor-only. Review recently published thumbnails with their style family / mood / composition (when recorded). ' +
        'Use this first to assess visual coherence before proposing pivots or regenerating.',
      schema: z.object({
        days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
      }),
    },
  );
}

function buildRegenerateThumbnail(ctx: ToolContext) {
  return tool(
    async ({ articleId, styleOverride, compositionOverride, moodOverride, reason }: {
      articleId: number; styleOverride?: string; compositionOverride?: string; moodOverride?: string; reason: string;
    }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled.' });
      }
      if (!articleId) return JSON.stringify({ status: 'error', message: 'articleId is required.' });
      if (!reason || String(reason).trim().length < 5) {
        return JSON.stringify({ status: 'error', message: 'reason (>= 5 chars) is required — explain why you are regenerating.' });
      }
      if (styleOverride && !STYLE_FAMILIES_LIST.includes(styleOverride)) {
        return JSON.stringify({ status: 'error', message: `Unknown style family "${styleOverride}".` });
      }

      const article = await db.prepare(
        'SELECT id, tenant_id, title FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(articleId, ctx.tenantId);
      if (!article) return JSON.stringify({ status: 'error', message: `Article ${articleId} not found in this newsroom.` });

      const budget = await checkDesignerBudget(ctx.tenantId);
      if (!budget.allowed) {
        return JSON.stringify({
          status: 'quota_exceeded',
          message: `Daily regeneration budget reached (${budget.used}/${budget.cap}). Try again tomorrow.`,
        });
      }

      // Fire-and-forget regeneration
      await designerAudit(ctx.tenantId, ctx.writerId, 'designer.regenerate_thumbnail', 'article', String(articleId), {
        reason, styleOverride, compositionOverride, moodOverride,
      });
      setImmediate(() => {
        const { regenerateArticleImage } = require('../../media-helpers');
        regenerateArticleImage(articleId, ctx.tenantId, {
          styleOverride, compositionOverride, moodOverride,
        })
          .then((url: string | null) => {
            // Notify editor on completion (best effort — requires notifications_center flag).
            try {
              const { notify } = require('../../notifications');
              db.prepare(`SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner','admin','editor','superadmin')`)
                .all(ctx.tenantId)
                .then((eds: any[]) => {
                  for (const ed of eds) {
                    notify({
                      tenantId: ctx.tenantId, userId: ed.id,
                      kind: 'designer_action',
                      title: url ? 'Thumbnail regenerated' : 'Thumbnail regeneration failed',
                      body: url
                        ? `Iris regenerated the thumbnail for "${article.title}". Reason: ${reason}`
                        : `Iris attempted to regenerate "${article.title}" but the image call failed.`,
                      payload: { article_id: articleId, reason, style: styleOverride || null, new_image_url: url || null },
                    }).catch(() => {});
                  }
                }).catch(() => {});
            } catch { /* ignore */ }
          })
          .catch((err: any) => console.error('[designer] regenerateArticleImage failed:', err?.message));
      });

      return JSON.stringify({
        status: 'queued',
        article_id: articleId,
        message: `Thumbnail regeneration queued for "${article.title}". Image generation takes 3-10s; the editor will be notified on completion.`,
        budget: { used: budget.used + 1, cap: budget.cap },
      });
    },
    {
      name: 'regenerateThumbnail',
      description:
        'Designer/editor-only. Regenerate an article thumbnail with optional style/mood/composition overrides. ' +
        'Runs asynchronously — returns immediately with status: queued. Counts against the daily regen budget. ' +
        '`reason` is required and recorded in audit. Status: queued | quota_exceeded | tool_unavailable | error.',
      schema: z.object({
        articleId: z.number().int(),
        styleOverride: z.enum([
          'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
          'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
        ]).optional(),
        compositionOverride: z.string().max(200).optional(),
        moodOverride: z.string().max(100).optional(),
        reason: z.string().min(5).max(500).describe('Why this image needs regenerating.'),
      }),
    },
  );
}

function buildRegenerateWriterAvatar(ctx: ToolContext) {
  return tool(
    async ({ writerId, styleOverride, reason }: { writerId: number; styleOverride?: string; reason: string }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled.' });
      }
      if (!writerId) return JSON.stringify({ status: 'error', message: 'writerId is required.' });
      if (!reason || String(reason).trim().length < 5) {
        return JSON.stringify({ status: 'error', message: 'reason (>= 5 chars) is required.' });
      }
      if (styleOverride && !STYLE_FAMILIES_LIST.includes(styleOverride)) {
        return JSON.stringify({ status: 'error', message: `Unknown style family "${styleOverride}".` });
      }

      const writer = await db.prepare(
        'SELECT id, tenant_id, name FROM writers WHERE id = $1 AND tenant_id = $2'
      ).get(writerId, ctx.tenantId);
      if (!writer) return JSON.stringify({ status: 'error', message: `Writer ${writerId} not found in this newsroom.` });

      const budget = await checkDesignerBudget(ctx.tenantId);
      if (!budget.allowed) {
        return JSON.stringify({
          status: 'quota_exceeded',
          message: `Daily regeneration budget reached (${budget.used}/${budget.cap}).`,
        });
      }

      await designerAudit(ctx.tenantId, ctx.writerId, 'designer.regenerate_avatar', 'writer', String(writerId), {
        reason, styleOverride,
      });
      setImmediate(() => {
        const { regenerateWriterAvatarImage } = require('../../media-helpers');
        regenerateWriterAvatarImage(writerId, ctx.tenantId, { styleOverride })
          .then((url: string | null) => {
            try {
              const { notify } = require('../../notifications');
              db.prepare(`SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner','admin','editor','superadmin')`)
                .all(ctx.tenantId)
                .then((eds: any[]) => {
                  for (const ed of eds) {
                    notify({
                      tenantId: ctx.tenantId, userId: ed.id,
                      kind: 'designer_action',
                      title: url ? 'Writer avatar regenerated' : 'Avatar regeneration failed',
                      body: url
                        ? `Iris regenerated ${writer.name}'s avatar. Reason: ${reason}`
                        : `Iris attempted to regenerate ${writer.name}'s avatar but the call failed.`,
                      payload: { writer_id: writerId, reason, style: styleOverride || null, new_avatar_url: url || null },
                    }).catch(() => {});
                  }
                }).catch(() => {});
            } catch { /* ignore */ }
          })
          .catch((err: any) => console.error('[designer] regenerateWriterAvatarImage failed:', err?.message));
      });

      return JSON.stringify({
        status: 'queued',
        writer_id: writerId,
        message: `Avatar regeneration queued for ${writer.name}.`,
        budget: { used: budget.used + 1, cap: budget.cap },
      });
    },
    {
      name: 'regenerateWriterAvatar',
      description:
        'Designer/editor-only. Regenerate a writer avatar with optional style override. Async; counts against the daily regen budget. ' +
        '`reason` required. Status: queued | quota_exceeded | tool_unavailable | error.',
      schema: z.object({
        writerId: z.number().int(),
        styleOverride: z.enum([
          'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
          'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
        ]).optional(),
        reason: z.string().min(5).max(500),
      }),
    },
  );
}

function buildProposeStylePivot(ctx: ToolContext) {
  return tool(
    async ({ family, reasoning }: { family: string; reasoning: string }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled.' });
      }
      if (!STYLE_FAMILIES_LIST.includes(family)) {
        return JSON.stringify({ status: 'error', message: `Unknown style family "${family}".` });
      }
      if (!reasoning || String(reasoning).trim().length < 10) {
        return JSON.stringify({ status: 'error', message: 'reasoning (>= 10 chars) required — explain why the pivot is needed.' });
      }

      // Find an editor to notify.
      let editorUserId: number | null = null;
      try {
        const row = await db.prepare(`
          SELECT id FROM users
          WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner','admin','editor','superadmin')
          ORDER BY id ASC LIMIT 1
        `).get(ctx.tenantId);
        if (row?.id) editorUserId = row.id;
      } catch { /* ignore */ }

      if (!editorUserId) {
        return JSON.stringify({ status: 'error', message: 'No editor user available to receive the style pivot proposal.' });
      }

      try {
        const { notify } = require('../../notifications');
        await notify({
          tenantId: ctx.tenantId,
          userId: editorUserId,
          kind: 'style_pivot_proposed',
          title: `Style pivot proposed: ${family}`,
          body: `Iris is proposing a style pivot to "${family}".\n\nReasoning: ${reasoning}`,
          payload: { family, reasoning },
          actionable: [
            { label: 'Approve pivot', actionKind: 'style_pivot.approve', targetId: null, targetType: 'style_pivot', payload: { family, notes: reasoning }, style: 'primary' },
            { label: 'Reject',        actionKind: 'style_pivot.reject',  targetId: null, targetType: 'style_pivot', payload: { family } },
          ],
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Failed to dispatch proposal: ${err?.message || 'unknown'}` });
      }

      await designerAudit(ctx.tenantId, ctx.writerId, 'designer.style_pivot_proposed', 'settings', 'art_direction', {
        family, reasoning,
      });

      return JSON.stringify({
        status: 'awaiting_approval',
        family,
        message: `Style pivot proposed to the editor. Nothing changes until they tap [Approve pivot].`,
      });
    },
    {
      name: 'proposeStylePivot',
      description:
        'Designer/editor-only. Propose a tenant-wide style pivot. Sends an actionable notification to the editor with [Approve pivot] / [Reject] buttons. ' +
        'Does NOT change the tenant setting until the editor approves. Status: awaiting_approval | tool_unavailable | error.',
      schema: z.object({
        family: z.enum([
          'editorial-illustration', 'documentary-photo', 'noir', 'minimalist-vector',
          'isometric-tech', 'vintage-print', 'cinematic-poster', 'mixed-media',
        ]),
        reasoning: z.string().min(10).max(2000),
      }),
    },
  );
}

function buildBatchRegenerateWeakThumbnails(ctx: ToolContext) {
  return tool(
    async ({ articleIds, reason }: { articleIds: number[]; reason: string }) => {
      if (!(await designerEnabled(ctx.tenantId))) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Graphic designer agent is not enabled.' });
      }
      if (!Array.isArray(articleIds) || !articleIds.length) {
        return JSON.stringify({ status: 'error', message: 'articleIds must be a non-empty array.' });
      }
      if (!reason || String(reason).trim().length < 5) {
        return JSON.stringify({ status: 'error', message: 'reason (>= 5 chars) required.' });
      }
      const ids = articleIds.slice(0, 20).map(Number).filter(n => Number.isFinite(n) && n > 0);
      if (!ids.length) return JSON.stringify({ status: 'error', message: 'No valid article ids provided.' });

      // Cross-tenant guard: only accept ids belonging to this tenant.
      const validRows = await db.prepare(
        'SELECT id FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2'
      ).all(ids, ctx.tenantId);
      const validIds = new Set((validRows || []).map((r: any) => r.id));
      const accepted = ids.filter(id => validIds.has(id));
      if (!accepted.length) {
        return JSON.stringify({ status: 'error', message: 'None of the article ids belong to this newsroom.' });
      }

      const budget = await checkDesignerBudget(ctx.tenantId);
      const remaining = budget.cap - budget.used;
      if (remaining <= 0) {
        return JSON.stringify({
          status: 'quota_exceeded',
          message: `Daily regeneration budget reached (${budget.used}/${budget.cap}).`,
        });
      }
      const toQueue = accepted.slice(0, remaining);

      for (const aid of toQueue) {
        await designerAudit(ctx.tenantId, ctx.writerId, 'designer.regenerate_thumbnail', 'article', String(aid), {
          reason, batch: true,
        });
        setImmediate(() => {
          const { regenerateArticleImage } = require('../../media-helpers');
          regenerateArticleImage(aid, ctx.tenantId, {})
            .catch((err: any) => console.error(`[designer] batch regen article ${aid} failed:`, err?.message));
        });
      }

      return JSON.stringify({
        status: 'queued',
        queued_ids: toQueue,
        skipped_count: ids.length - toQueue.length,
        budget: { used: budget.used + toQueue.length, cap: budget.cap },
        message: `Queued ${toQueue.length} thumbnail regeneration${toQueue.length === 1 ? '' : 's'}.`,
      });
    },
    {
      name: 'batchRegenerateWeakThumbnails',
      description:
        'Designer/editor-only. Queue thumbnail regeneration for up to 20 articles at once. Honors the daily regen budget — extras are dropped. ' +
        'Status: queued | quota_exceeded | tool_unavailable | error.',
      schema: z.object({
        articleIds: z.array(z.number().int()).min(1).max(20),
        reason: z.string().min(5).max(500),
      }),
    },
  );
}

// ── Individual tools ─────────────────────────────────────────────────

function buildSearchArticles(ctx: ToolContext) {
  return tool(
    async ({ query, limit }: { query: string; limit?: number }) => {
      const { findRelevantArticles } = messaging;
      if (typeof findRelevantArticles !== 'function') {
        return JSON.stringify({
          status: 'tool_unavailable',
          message: 'Search backend is not wired up. Answer honestly that search is not available right now; do NOT invent articles.',
        });
      }
      let results: any[] = [];
      try {
        results = await findRelevantArticles(ctx.writerId, ctx.tenantId, query, '', limit || 5);
      } catch (err: any) {
        return JSON.stringify({
          status: 'error',
          message: `Search failed: ${err?.message || 'unknown error'}. Tell the user search is unavailable right now. Do NOT retry and do NOT invent articles.`,
        });
      }
      const compact = (results || []).slice(0, limit || 5).map((r: any) => ({
        id: r.id,
        title: r.generated_title || r.title,
        slug: r.slug,
        snippet: truncate(r.snippet || ''),
        similarity: r.similarity,
      }));
      if (compact.length === 0) {
        return JSON.stringify({
          status: 'no_results',
          message: 'The query ran successfully but matched zero articles. This writer has not published anything matching that topic, and no curated sources in the writer\'s beats matched either. Do NOT retry with a different query. Answer the user honestly: you have not written about this yet. Do NOT say search is "down" — it ran and returned no results.',
          results: [],
        });
      }
      return JSON.stringify({ status: 'ok', results: compact });
    },
    {
      name: 'searchArticles',
      description:
        'Search by topic/meaning. Use when the user asks what you wrote or covered on a SPECIFIC topic. ' +
        'Searches the writer\'s own published articles and, when shared-wire is enabled, curated source articles within the writer\'s beats. ' +
        'Call at most ONCE per question. Response has status: ok | no_results | error | tool_unavailable. ' +
        'If status=no_results, the query succeeded — do NOT say search is "down"; answer that you have not covered this. ' +
        'If status=error or tool_unavailable, tell the user search is not working right now. ' +
        'NEVER fabricate article titles, topics, or links. ' +
        'For broad "what\'s in your beat" questions with NO specific topic, prefer listArticlesInBeat instead.',
      schema: z.object({
        query: z.string().describe('What to search for, in natural language.'),
        limit: z.number().int().min(1).max(10).optional().describe('Max results to return (1-10).'),
      }),
    },
  );
}

function buildListArticlesInBeat(ctx: ToolContext) {
  return tool(
    async ({ days, limit, includeCurated }: { days?: number; limit?: number; includeCurated?: boolean }) => {
      const lookbackDays = Math.min(Math.max(days ?? 30, 1), 365);
      const cap = Math.min(Math.max(limit ?? 10, 1), 25);
      try {
        const rows = await db.prepare(`
          SELECT id, COALESCE(generated_title, title) AS title, slug, category,
                 content_type, source,
                 COALESCE(tldr_overview, LEFT(summary, 150)) AS snippet,
                 published_at
          FROM articles
          WHERE tenant_id = $1
            AND is_published = 1
            AND published_at > NOW() - make_interval(days => $3)
            AND (
              (content_type IN ('original','deep-dive') AND writer_id = $2)
              ${includeCurated === false ? '' : `OR (
                (content_type IS NULL OR content_type = 'curated')
                AND category IN (
                  SELECT c.name FROM writer_beats wb
                  JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
                  WHERE wb.writer_id = $2 AND wb.tenant_id = $1
                )
              )`}
            )
          ORDER BY published_at DESC
          LIMIT $4
        `).all(ctx.tenantId, ctx.writerId, lookbackDays, cap);
        if (!rows.length) {
          return JSON.stringify({
            status: 'no_results',
            message: `No articles in your beats in the last ${lookbackDays} days.`,
            results: [],
          });
        }
        return JSON.stringify({
          status: 'ok',
          lookback_days: lookbackDays,
          results: rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            slug: r.slug,
            category: r.category,
            content_type: r.content_type || 'curated',
            source: r.source,
            snippet: truncate(r.snippet || ''),
            published_at: r.published_at,
          })),
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Lookup failed: ${err?.message || 'unknown'}` });
      }
    },
    {
      name: 'listArticlesInBeat',
      description:
        'Browse recent articles in the writer\'s beats — useful when the user asks a broad "what\'s in your beat?" or "what articles do you have?" question without a specific topic. ' +
        'Returns both the writer\'s own originals AND curated source articles in the writer\'s beat categories (when shared-wire allows). ' +
        'Prefer this over searchArticles when there is no specific topic to search for. Default lookback is 30 days.',
      schema: z.object({
        days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 30).'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10, max 25).'),
        includeCurated: z.boolean().optional().describe('Include curated sources in addition to originals (default true).'),
      }),
    },
  );
}

function buildFetchArticle(ctx: ToolContext) {
  return tool(
    async ({ id, slug }: { id?: number; slug?: string }) => {
      if (!id && !slug) return JSON.stringify({ error: 'id or slug required' });
      let row: any;
      if (id) {
        row = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(id, ctx.tenantId);
      } else {
        row = await db.prepare('SELECT * FROM articles WHERE slug = $1 AND tenant_id = $2').get(slug, ctx.tenantId);
      }
      if (!row) return JSON.stringify({ error: 'not found' });
      return JSON.stringify({
        id: row.id,
        title: row.generated_title || row.title,
        original_title: row.title,
        slug: row.slug,
        category: row.category,
        summary: truncate(row.tldr_overview || row.summary || ''),
        content: truncate(row.full_content || ''),
        source: row.source,
        source_url: row.source_url,
        published_at: row.published_at,
      });
    },
    {
      name: 'fetchArticle',
      description:
        'Fetch the full details of a single article by id or slug. Returns title, summary, content (truncated to ~2000 chars), source, category.',
      schema: z.object({
        id: z.number().int().optional().describe('Article id from searchArticles results.'),
        slug: z.string().optional().describe('Article slug (url-safe identifier).'),
      }),
    },
  );
}

function buildGetArticleSources(ctx: ToolContext) {
  return tool(
    async ({ id, slug }: { id?: number; slug?: string }) => {
      if (!id && !slug) return JSON.stringify({ error: 'id or slug required' });
      let row: any;
      if (id) {
        row = await db.prepare(
          'SELECT id, title, source, source_url, content_type, source_article_ids FROM articles WHERE id = $1 AND tenant_id = $2'
        ).get(id, ctx.tenantId);
      } else {
        row = await db.prepare(
          'SELECT id, title, source, source_url, content_type, source_article_ids FROM articles WHERE slug = $1 AND tenant_id = $2'
        ).get(slug, ctx.tenantId);
      }
      if (!row) return JSON.stringify({ error: 'not found' });

      // Curated article: its own source IS the citation
      if (row.content_type == null || row.content_type === 'curated') {
        if (!row.source && !row.source_url) {
          return JSON.stringify({ status: 'no_sources', message: 'This article has no recorded source.' });
        }
        return JSON.stringify({
          status: 'ok',
          article_type: 'curated',
          sources: [{ source: row.source, source_url: row.source_url }],
        });
      }

      // Original / deep-dive: resolve source_article_ids → curated rows
      const ids = Array.isArray(row.source_article_ids) ? row.source_article_ids : [];
      if (!ids.length) {
        return JSON.stringify({
          status: 'no_sources',
          message: 'This article has no recorded source articles.',
          article_type: row.content_type,
        });
      }
      const sources = await db.prepare(`
        SELECT id, title, source AS publisher, source_url, published_at
        FROM articles
        WHERE id = ANY($1::int[]) AND tenant_id = $2
        ORDER BY published_at DESC NULLS LAST
      `).all(ids, ctx.tenantId);
      return JSON.stringify({
        status: 'ok',
        article_type: row.content_type,
        sources: sources.map((s: any) => ({
          id: s.id,
          title: s.title,
          publisher: s.publisher,
          url: s.source_url,
          published_at: s.published_at,
        })),
      });
    },
    {
      name: 'getArticleSources',
      description:
        'REQUIRED whenever the user asks where information came from, what sources you used, what publishers are reporting on something, or where to verify a specific figure. ' +
        'Returns the actual curated source articles (publisher name + URL) behind one of your originals, or the single source of a curated item. ' +
        'Do NOT guess publisher names or invent citations — call this tool. ' +
        'Status values: ok (sources array populated) | no_sources (article has no recorded sources — tell the user honestly) | error.',
      schema: z.object({
        id: z.number().int().optional().describe('Article id (from searchArticles or listArticlesInBeat results).'),
        slug: z.string().optional().describe('Article slug.'),
      }),
    },
  );
}

function buildListWriterBeats(ctx: ToolContext) {
  return tool(
    async () => {
      const rows = await db.prepare(`
        SELECT c.id, c.name, c.description FROM writer_beats wb
        JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
        WHERE wb.writer_id = $1 AND wb.tenant_id = $2
        ORDER BY c.name
      `).all(ctx.writerId, ctx.tenantId);
      return JSON.stringify(rows);
    },
    {
      name: 'listWriterBeats',
      description:
        'List the categories (beats) this writer covers. Useful when the user asks what you cover or wants to check if a topic is in your wheelhouse.',
      schema: z.object({}),
    },
  );
}

function buildGetWriterMemory(ctx: ToolContext) {
  return tool(
    async ({ query, limit }: { query?: string; limit?: number }) => {
      const { getRelevantMemories } = writerMemory;
      const mems = await getRelevantMemories(ctx.writerId, ctx.tenantId, query || '', limit || 5);
      return JSON.stringify((mems || []).map((m: any) => ({
        subject: m.subject,
        content: truncate(m.content || ''),
        thread_id: m.thread_id,
      })));
    },
    {
      name: 'getWriterMemory',
      description:
        'Retrieve editorial memories — established positions, ongoing storylines, facts the writer has learned. Use before responding if the topic touches on something you might have an established view on.',
      schema: z.object({
        query: z.string().optional().describe('Filter memories by topic (optional; empty = recent).'),
        limit: z.number().int().min(1).max(10).optional(),
      }),
    },
  );
}

function buildUpdateWriterMemory(ctx: ToolContext) {
  return tool(
    async ({ subject, content, threadId }: { subject: string; content: string; threadId?: string }) => {
      const { recordWriterMemory } = writerMemory;
      if (typeof recordWriterMemory !== 'function') {
        return JSON.stringify({ error: 'memory writes unavailable' });
      }
      try {
        await recordWriterMemory(ctx.writerId, ctx.tenantId, {
          subject,
          content: content.slice(0, 2000),
          thread_id: threadId || null,
        });
        return JSON.stringify({ ok: true });
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'failed' });
      }
    },
    {
      name: 'updateWriterMemory',
      description:
        'Record a new editorial memory when the user teaches the writer something worth remembering long-term — a preference, a stance, a recurring topic thread. Use sparingly; only for things that should persist across conversations.',
      schema: z.object({
        subject: z.string().min(3).max(200).describe('Short subject line for this memory.'),
        content: z.string().min(5).max(2000).describe('The memory content itself.'),
        threadId: z.string().optional().describe('Optional thread id to link related memories.'),
      }),
    },
  );
}

function buildProposeAngle(ctx: ToolContext) {
  return tool(
    async ({ sourceArticleId, angleSummary }: { sourceArticleId: number; angleSummary: string }) => {
      // Feature gate — silently no-op when pitches aren't enabled, so persona
      // nudges that mention this tool don't trigger errors on tenants that
      // haven't opted in yet.
      const enabled = await featureRegistry.isFeatureEnabled(ctx.tenantId, 'article_pitches').catch(() => false);
      if (!enabled) {
        return JSON.stringify({
          status: 'tool_unavailable',
          message: 'Counter-angle pitches are not enabled for this newsroom. Tell the user this is something the editor would need to turn on.',
        });
      }
      if (!sourceArticleId || !angleSummary || angleSummary.trim().length < 10) {
        return JSON.stringify({ status: 'error', message: 'sourceArticleId and a substantive angleSummary (10+ chars) are required.' });
      }
      // Verify source belongs to this tenant
      const source = await db.prepare(
        'SELECT id, COALESCE(generated_title, title) AS title, content_type, writer_id FROM articles WHERE id = $1 AND tenant_id = $2'
      ).get(sourceArticleId, ctx.tenantId);
      if (!source) {
        return JSON.stringify({ status: 'error', message: `Article ${sourceArticleId} not found in this newsroom.` });
      }
      // Curated articles are the intended pitch target. Pitching against another
      // writer's original is allowed but unusual — surface it without blocking.
      const isOwnSource = source.writer_id === ctx.writerId;

      // Don't allow duplicate open pitches from the same writer on the same source
      const existing = await db.prepare(`
        SELECT id FROM article_pitches
        WHERE tenant_id = $1 AND source_article_id = $2 AND pitched_by_writer_id = $3 AND status = 'proposed'
      `).get(ctx.tenantId, sourceArticleId, ctx.writerId);
      if (existing) {
        return JSON.stringify({
          status: 'duplicate',
          message: `You already have an open pitch on \"${source.title}\" awaiting editor review.`,
          pitch_id: existing.id,
        });
      }

      const row = await db.prepare(`
        INSERT INTO article_pitches
          (tenant_id, source_article_id, pitched_by_writer_id, angle_summary, status)
        VALUES ($1, $2, $3, $4, 'proposed')
        RETURNING id
      `).get(ctx.tenantId, sourceArticleId, ctx.writerId, angleSummary.trim().slice(0, 2000));

      return JSON.stringify({
        status: 'ok',
        pitch_id: row.id,
        source_title: source.title,
        is_own_source: isOwnSource,
        message: `Pitch submitted on \"${source.title}\". Editor will review and approve or reject.`,
      });
    },
    {
      name: 'proposeAngle',
      description:
        'Propose a counter-angle on a source article that another writer leads (or to add a second take on your own source). ' +
        'Use when you spot a story your beat would cover differently — e.g., Marcus owns a security breach but you see the regulatory angle. ' +
        'Submits a pitch to the editor; nothing publishes automatically. Status values: ok | duplicate | tool_unavailable | error. ' +
        'Use sparingly — one strong pitch beats five weak ones.',
      schema: z.object({
        sourceArticleId: z.number().int().describe('Article id of the curated source you want to pitch against (from searchArticles, listArticlesInBeat, or fetchArticle results).'),
        angleSummary: z.string().min(10).max(2000).describe('1–3 sentences describing your specific angle and why it matters.'),
      }),
    },
  );
}

function buildEnrichSources(ctx: ToolContext) {
  return tool(
    async ({ topic, sources, count }: { topic: string; sources?: string[]; count?: number }) => {
      const enabled = await featureRegistry.isFeatureEnabled(ctx.tenantId, 'agent_web_research').catch(() => false);
      if (!enabled) {
        return JSON.stringify({
          status: 'tool_unavailable',
          message: 'Web research is not enabled for this newsroom. Tell the user the editor would need to turn it on.',
        });
      }
      if (!topic || topic.trim().length < 4) {
        return JSON.stringify({ status: 'error', message: 'Topic must be at least 4 characters.' });
      }
      presence.setPresence(ctx.writerId, ctx.tenantId, 'researching').catch(() => {});
      const r = await research.searchAll(ctx.tenantId, topic, {
        sources: Array.isArray(sources) ? sources : undefined,
        count: count || 8,
      });
      if (r.errors.some((e: any) => e.reason === 'daily_cap_reached')) {
        return JSON.stringify({
          status: 'quota_exceeded',
          message: `Daily search quota reached (${r.quota_used}/${r.quota_cap}). Tell the user research is rate-limited until tomorrow.`,
        });
      }
      if (!r.results.length) {
        return JSON.stringify({
          status: 'no_results',
          message: `No external coverage found for "${topic}". Errors: ${JSON.stringify(r.errors)}`,
          results: [],
        });
      }
      return JSON.stringify({
        status: 'ok',
        topic,
        quota: { used: r.quota_used, cap: r.quota_cap },
        results: r.results.slice(0, count || 8).map((x: any) => ({
          source: x.source,
          url: x.url,
          title: x.title,
          publisher: x.publisher,
          published: x.published,
          score: x.score,
          comments: x.comments,
          snippet: truncate(x.snippet || ''),
        })),
      });
    },
    {
      name: 'enrichSources',
      description:
        'Search the external web (Brave news + Hacker News + Reddit) for fresh coverage of a topic. ' +
        'Use when the user asks about a topic the newsroom hasn\'t covered, or when you need more sources to back up a story. ' +
        'Returns RANKED CANDIDATES — does NOT publish or ingest anything. To ingest selected results as curated articles, the editor must explicitly call ingestExternalAsCurated (separate tool, may not be available to you). ' +
        'Always tag results as external when discussing them — never blur with newsroom-curated material. ' +
        'Status: ok | no_results | quota_exceeded | tool_unavailable | error.',
      schema: z.object({
        topic: z.string().min(4).describe('Topic to research, in natural language.'),
        sources: z.array(z.enum(['brave', 'hackernews', 'reddit'])).optional().describe('Subset of backends. Default: all three.'),
        count: z.number().int().min(1).max(15).optional().describe('Max combined results to return (default 8).'),
      }),
    },
  );
}

function buildIngestExternalAsCurated(ctx: ToolContext) {
  return tool(
    async ({ results, pitchId }: { results: any[]; pitchId?: number }) => {
      const enabled = await featureRegistry.isFeatureEnabled(ctx.tenantId, 'agent_web_research').catch(() => false);
      if (!enabled) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Web research is not enabled.' });
      }
      if (!Array.isArray(results) || !results.length) {
        return JSON.stringify({ status: 'error', message: 'results must be a non-empty array of search-result objects.' });
      }

      const { toSlug } = require('../../utils');
      const { detectCategory } = require('../../categorize');
      const { generateEmbedding, isPgvectorAvailable } = require('../../embeddings');
      const pgvector = await isPgvectorAvailable().catch(() => false);

      // Reuse cap logic by reading feature
      const feats = await featureRegistry.getAllFeatures(ctx.tenantId);
      const cap = parseInt(feats.external_research_daily_cap, 10) || 50;
      const usedRow = await db.prepare(`
        SELECT COUNT(*)::int AS cnt FROM articles
        WHERE tenant_id = $1 AND ingest_source = 'enrichment'
          AND created_at > NOW() - INTERVAL '24 hours'
      `).get(ctx.tenantId);
      const used = usedRow?.cnt || 0;
      const remaining = Math.max(0, cap - used);
      if (remaining <= 0) {
        return JSON.stringify({ status: 'quota_exceeded', message: `Daily ingest cap reached (${used}/${cap}).` });
      }

      const ingested: any[] = [];
      const skipped: any[] = [];
      for (const item of results.slice(0, remaining)) {
        if (!item.url || !item.title) { skipped.push({ url: item.url, reason: 'missing url or title' }); continue; }
        const dup = await db.prepare(
          'SELECT id FROM articles WHERE tenant_id = $1 AND source_url = $2 LIMIT 1'
        ).get(ctx.tenantId, item.url);
        if (dup) { skipped.push({ url: item.url, reason: 'duplicate', existing_id: dup.id }); continue; }

        const title = String(item.title).slice(0, 500);
        const summary = String(item.snippet || '').slice(0, 1000);
        const publisher = String(item.publisher || item.source || 'Unknown').slice(0, 200);
        const slug = toSlug(title) || `enrich-${Date.now()}`;
        let category = 'General';
        try { category = await detectCategory({ title, contentSnippet: summary }, { tenantId: ctx.tenantId }) || 'General'; } catch {}

        const inserted = await db.prepare(`
          INSERT INTO articles
            (tenant_id, title, slug, summary, source, source_url, category, content_type, ingest_source, is_published, status, published_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'curated', 'enrichment', 1, 'published', NOW(), NOW(), NOW())
          RETURNING id
        `).get(ctx.tenantId, title, slug, summary, publisher, item.url, category);

        if (inserted) {
          ingested.push({ id: inserted.id, title, url: item.url });
          if (pgvector) {
            generateEmbedding(ctx.tenantId, `${title}\n\n${summary}`)
              .then((v: number[]) => db.prepare('UPDATE articles SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3')
                .run(JSON.stringify(v), inserted.id, ctx.tenantId))
              .catch(() => {});
          }
        }
      }

      if (pitchId && ingested.length) {
        try {
          await db.prepare(`
            UPDATE article_pitches
            SET decision_note = COALESCE(decision_note, '') || E'\\n[enrichment]: attached articles ' || $1
            WHERE id = $2 AND tenant_id = $3
          `).run(ingested.map((i: any) => i.id).join(','), pitchId, ctx.tenantId);
        } catch { /* non-fatal */ }
      }

      return JSON.stringify({
        status: 'ok',
        ingested,
        skipped,
        daily_cap: cap,
        daily_used: used + ingested.length,
      });
    },
    {
      name: 'ingestExternalAsCurated',
      description:
        'Editor-only. Ingest selected external search results (from enrichSources) as curated articles in the newsroom. ' +
        'Use AFTER calling enrichSources and reviewing the candidates — pass the chosen result objects in. ' +
        'Optionally attach to a pitch via pitchId so they show up in synthesis context. ' +
        'Returns ingested[] (new article ids) and skipped[] (duplicates / invalid). Status: ok | quota_exceeded | tool_unavailable | error.',
      schema: z.object({
        results: z.array(z.any()).min(1).describe('Array of result objects from enrichSources (must include url + title at minimum).'),
        pitchId: z.number().int().optional().describe('Optional: attach ingested articles to this pitch.'),
      }),
    },
  );
}

// ── Editor-commissioned-stories tools ────────────────────────────────
//
// These are bundled with the editor-agent tool set and additionally check
// the `editor_commissioned_stories` feature flag at call time. When disabled,
// they return `status: "tool_unavailable"` — which makes it safe to include
// them unconditionally from the graph-builder side.

function buildDraftEditorBrief(ctx: ToolContext) {
  return tool(
    async ({ topic }: { topic: string }) => {
      const enabled = await featureRegistry
        .isFeatureEnabled(ctx.tenantId, 'editor_commissioned_stories')
        .catch(() => false);
      if (!enabled) {
        return JSON.stringify({
          status: 'tool_unavailable',
          message: 'Editor-commissioned stories are not enabled for this newsroom.',
        });
      }
      const t = String(topic || '').trim();
      if (t.length < 4) return JSON.stringify({ status: 'error', message: 'Topic must be at least 4 characters.' });

      // ── Novelty check: cosine similarity against recent articles ──
      let noveltyHits: any[] = [];
      let noveltyCount = 0;
      try {
        const { generateEmbedding, isPgvectorAvailable } = require('../../embeddings');
        if (await isPgvectorAvailable().catch(() => false)) {
          const vec = await generateEmbedding(ctx.tenantId, t);
          if (Array.isArray(vec)) {
            const rows = await db.prepare(`
              SELECT id, COALESCE(generated_title, title) AS title, published_at,
                     1 - (embedding <=> $1::vector) AS similarity
              FROM articles
              WHERE tenant_id = $2
                AND is_published = 1
                AND embedding IS NOT NULL
                AND published_at > NOW() - INTERVAL '14 days'
              ORDER BY embedding <=> $1::vector
              LIMIT 10
            `).all(JSON.stringify(vec), ctx.tenantId);
            noveltyHits = (rows || [])
              .filter((r: any) => Number(r.similarity) > 0.75)
              .map((r: any) => ({ id: r.id, title: r.title, published_at: r.published_at, similarity: Number(r.similarity) }));
            noveltyCount = noveltyHits.length;
          }
        }
      } catch (err: any) {
        // Novelty check degrades gracefully — brief still returns, with a note.
        console.warn('[tools:draftEditorBrief] novelty check failed:', err?.message);
      }

      // ── Beat suggestion: top categories for this tenant ──
      // Ideal: project topic embedding onto beat centroids. That pattern does
      // not yet exist; fall back to the top 3 most-used tenant categories.
      let beats: string[] = [];
      try {
        const rows = await db.prepare(`
          SELECT name FROM categories
          WHERE tenant_id = $1
          ORDER BY sort_order ASC NULLS LAST, name ASC
          LIMIT 3
        `).all(ctx.tenantId);
        beats = (rows || []).map((r: any) => r.name);
      } catch { /* non-fatal */ }

      return JSON.stringify({
        status: 'ok',
        topic: t,
        beats,
        novelty: {
          hit_count: noveltyCount,
          recent_matches: noveltyHits.slice(0, 5),
        },
      });
    },
    {
      name: 'draftEditorBrief',
      description:
        'Editor-only. Drafts a research brief for a topic the editor wants commissioned. ' +
        'Returns the canonical topic string, suggested beats (tenant categories), and a novelty check ' +
        '(recent articles — last 14 days — with cosine similarity > 0.75 on title+topic embedding). ' +
        'If hit_count > 0, warn the editor the topic may already be covered before proceeding. ' +
        'Status: ok | tool_unavailable | error.',
      schema: z.object({
        topic: z.string().min(4).describe('The story topic, in natural language.'),
      }),
    },
  );
}

function buildFindBestWriterForTopic(ctx: ToolContext) {
  return tool(
    async ({ topic, beats }: { topic: string; beats?: string[] }) => {
      const enabled = await featureRegistry
        .isFeatureEnabled(ctx.tenantId, 'editor_commissioned_stories')
        .catch(() => false);
      if (!enabled) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Editor-commissioned stories are not enabled.' });
      }
      const t = String(topic || '').trim();
      if (t.length < 4) return JSON.stringify({ status: 'error', message: 'Topic must be at least 4 characters.' });

      const { findBestWriter } = require('../../writer-assign');
      // Use the best-guess beat as article.category so beat scoring kicks in.
      const category = Array.isArray(beats) && beats.length ? beats[0] : null;
      const pseudoArticle = { title: t, summary: '', category };

      // Pre-fetch the full auto-writer list so we can enrich with load + recent score.
      const writers = await db.prepare(`
        SELECT w.*, array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) AS beat_names
        FROM writers w
        LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = $1
        LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
        WHERE w.is_auto = true AND w.tenant_id = $1
        GROUP BY w.id
      `).all(ctx.tenantId);

      const primary = await findBestWriter(pseudoArticle, ctx.tenantId, writers);

      // Enrich each candidate with current load + recent avg score.
      const ranked: any[] = [];
      for (const w of writers) {
        if (!w || !w.id) continue;
        let current_load = 0;
        let recent_avg_score: number | null = null;
        try {
          const loadRow = await db.prepare(`
            SELECT COUNT(*)::int AS cnt FROM articles
            WHERE writer_id = $1 AND tenant_id = $2
              AND created_at > NOW() - INTERVAL '7 days'
          `).get(w.id, ctx.tenantId);
          current_load = loadRow?.cnt || 0;
        } catch { /* ignore */ }
        try {
          const scoreRow = await db.prepare(`
            SELECT AVG(editorial_score)::float AS avg_score FROM articles
            WHERE writer_id = $1 AND tenant_id = $2
              AND editorial_score IS NOT NULL
              AND published_at > NOW() - INTERVAL '30 days'
          `).get(w.id, ctx.tenantId);
          recent_avg_score = scoreRow?.avg_score != null ? Number(scoreRow.avg_score) : null;
        } catch { /* ignore — editorial_score column may not exist */ }

        // Quick match score: +3 if beat matches, +1 per keyword hit in topic
        const beatNames = (w.beat_names || []).map((b: string) => (b || '').toLowerCase());
        let match_score = 0;
        if (category && beatNames.includes(String(category).toLowerCase())) match_score += 3;
        const tLower = t.toLowerCase();
        const keywords = Array.isArray(w.keywords) ? w.keywords : [];
        for (const kw of keywords) if (tLower.includes(String(kw || '').toLowerCase())) match_score += 1;

        ranked.push({
          writer_id: w.id,
          name: w.name,
          beats: w.beat_names || [],
          match_score,
          current_load,
          recent_avg_score,
          is_primary: primary && primary.id === w.id,
        });
      }
      ranked.sort((a, b) => {
        if (b.match_score !== a.match_score) return b.match_score - a.match_score;
        return a.current_load - b.current_load;
      });

      return JSON.stringify({
        status: 'ok',
        topic: t,
        beats: beats || [],
        recommended_writer_id: primary?.id || (ranked[0]?.writer_id ?? null),
        candidates: ranked.slice(0, 8),
      });
    },
    {
      name: 'findBestWriterForTopic',
      description:
        'Editor-only. Ranks the newsroom\'s auto-writers for a commissioned topic, exposing beat match, ' +
        'current load (last 7 days), and recent avg editorial score (last 30 days, where tracked). ' +
        'Use this to choose who to assign the resulting pitch to. ' +
        'Status: ok | tool_unavailable | error.',
      schema: z.object({
        topic: z.string().min(4).describe('The story topic.'),
        beats: z.array(z.string()).optional().describe('Candidate beats (category names) from draftEditorBrief.'),
      }),
    },
  );
}

function buildVetAndIngestWithConfirmation(ctx: ToolContext) {
  return tool(
    async ({ sources, pitch_hint, writer_id, brief_topic }: {
      sources: any[];
      pitch_hint: string;
      writer_id?: number;
      brief_topic?: string;
    }) => {
      const enabled = await featureRegistry
        .isFeatureEnabled(ctx.tenantId, 'editor_commissioned_stories')
        .catch(() => false);
      if (!enabled) {
        return JSON.stringify({ status: 'tool_unavailable', message: 'Editor-commissioned stories are not enabled.' });
      }
      if (!Array.isArray(sources) || !sources.length) {
        return JSON.stringify({ status: 'error', message: 'sources must be a non-empty array.' });
      }
      const angle = String(pitch_hint || '').trim();
      if (angle.length < 10) {
        return JSON.stringify({ status: 'error', message: 'pitch_hint must be at least 10 characters — describe the angle.' });
      }

      // 1. Vet the sources (dedupe + credibility + recency).
      const { vetSources } = require('../../research/vet');
      const vetted = await vetSources(sources, { tenantId: ctx.tenantId, maxResults: 4 });
      if (!vetted.length) {
        return JSON.stringify({ status: 'no_vetted_sources', message: 'Vetting removed every candidate (duplicates or near-duplicates).' });
      }

      // 2. Resolve the editor user id for the notification recipient. In the
      //    LangGraph chat-agent, userId is a string (oauth sub) when present.
      //    Only dispatch when we have a concrete editor to notify.
      let editorUserId: number | null = null;
      if (ctx.userId) {
        try {
          const parsed = parseInt(String(ctx.userId), 10);
          if (Number.isFinite(parsed) && parsed > 0) editorUserId = parsed;
        } catch { /* ignore */ }
      }
      if (!editorUserId) {
        // Fall back to the first owner/admin/editor so the confirmation still
        // surfaces — better than silently swallowing the flow.
        try {
          const row = await db.prepare(`
            SELECT id FROM users
            WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner','admin','editor')
            ORDER BY id ASC LIMIT 1
          `).get(ctx.tenantId);
          if (row?.id) editorUserId = row.id;
        } catch { /* ignore */ }
      }

      if (!editorUserId) {
        return JSON.stringify({
          status: 'error',
          message: 'No editor user available to receive the confirmation notification.',
        });
      }

      // 3. Resolve writer name for the preview body, if any.
      let writerName: string | null = null;
      if (writer_id) {
        try {
          const w = await db.prepare(
            'SELECT name FROM writers WHERE id = $1 AND tenant_id = $2'
          ).get(writer_id, ctx.tenantId);
          writerName = w?.name || null;
        } catch { /* ignore */ }
      }

      // 4. Build the confirmation notification with inline action buttons.
      //    The action payload carries the full vetted source list so the
      //    handler can complete ingest + pitch creation without re-running the LLM.
      const jobId = `eb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const topicForPayload = String(brief_topic || '').slice(0, 500);
      const actionPayload = {
        sources: vetted.map((s: any) => ({
          url: s.url, title: s.title, publisher: s.publisher, source: s.source,
          snippet: s.snippet, published: s.published,
        })),
        writer_id: writer_id || null,
        angle,
        brief_topic: topicForPayload,
        requested_by_editor_id: editorUserId,
        job_id: jobId,
      };

      const body =
        `Proposed pitch: ${angle}\n` +
        (writerName ? `Assignee: ${writerName}\n` : 'Assignee: (unassigned)\n') +
        `Vetted sources (${vetted.length}):\n` +
        vetted.map((s: any, i: number) => `  ${i + 1}. ${s.title} — ${s.publisher || s.source || 'unknown'}`).join('\n');

      try {
        const { notify } = require('../../notifications');
        await notify({
          tenantId: ctx.tenantId,
          userId: editorUserId,
          kind: 'enrichment_ready',
          title: topicForPayload ? `Commission: ${topicForPayload}` : 'Editor brief ready for confirmation',
          body,
          payload: {
            job_id: jobId,
            brief_topic: topicForPayload,
            vetted_count: vetted.length,
            writer_id: writer_id || null,
            writer_name: writerName,
          },
          actionable: [
            { label: 'Ingest + pitch', actionKind: 'editor_brief.ingest_and_pitch', targetId: null, targetType: 'editor_brief', payload: actionPayload, style: 'primary' },
            { label: 'Preview sources', actionKind: 'notification.dismiss',        targetId: null, targetType: 'editor_brief', payload: { job_id: jobId, preview: true } },
            { label: 'Cancel',          actionKind: 'editor_brief.cancel',          targetId: null, targetType: 'editor_brief', payload: { job_id: jobId, brief_topic: topicForPayload } },
          ],
        });
      } catch (err: any) {
        return JSON.stringify({
          status: 'error',
          message: `Failed to dispatch confirmation: ${err?.message || 'unknown'}`,
        });
      }

      return JSON.stringify({
        status: 'awaiting_confirmation',
        job_id: jobId,
        notified_user_id: editorUserId,
        vetted_count: vetted.length,
        message:
          `Sent confirmation to the editor with ${vetted.length} vetted source${vetted.length === 1 ? '' : 's'}. ` +
          'Nothing has been ingested yet — the editor must tap "Ingest + pitch" to complete. ' +
          'Do NOT call ingestExternalAsCurated directly; that confirmation gate is the whole point.',
        vetted: vetted.map((s: any) => ({
          title: s.title,
          url: s.url,
          publisher: s.publisher || s.source,
          vet_score: s.vet_score,
        })),
      });
    },
    {
      name: 'vetAndIngestWithConfirmation',
      description:
        'Editor-only. The gated multi-stage version of ingestExternalAsCurated for commissioned stories. ' +
        'Vets candidate sources (dedupe + near-duplicate title filter + credibility + recency), then sends ' +
        'the editor an actionable notification [Ingest + pitch] [Preview sources] [Cancel]. ' +
        'Does NOT ingest anything synchronously — returns a job_id and status: awaiting_confirmation. ' +
        'Use this after draftEditorBrief + enrichSources + findBestWriterForTopic. ' +
        'Do NOT call ingestExternalAsCurated directly during a commissioned-story flow — the button is the gate. ' +
        'Status: awaiting_confirmation | no_vetted_sources | tool_unavailable | error.',
      schema: z.object({
        sources: z.array(z.any()).min(1).describe('Raw candidate results from enrichSources.'),
        pitch_hint: z.string().min(10).max(2000).describe('Draft angle for the resulting pitch (1–3 sentences).'),
        writer_id: z.number().int().optional().describe('Recommended writer id from findBestWriterForTopic.'),
        brief_topic: z.string().optional().describe('The canonical topic string from draftEditorBrief.'),
      }),
    },
  );
}

function buildCheckRecentColleagueWork(ctx: ToolContext) {
  return tool(
    async ({ category, hours }: { category?: string; hours?: number }) => {
      const lookback = Math.min(hours || 48, 720);
      let sql = `
        SELECT COALESCE(a.generated_title, a.title) AS title, a.slug, a.published_at, w.name AS writer_name, a.category
        FROM articles a
        JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1
          AND a.writer_id != $2
          AND a.content_type IN ('original', 'deep-dive')
          AND a.is_published = 1
          AND a.published_at > NOW() - make_interval(hours => $3)
      `;
      const params: any[] = [ctx.tenantId, ctx.writerId, lookback];
      if (category) {
        sql += ' AND a.category = $4';
        params.push(category);
      }
      sql += ' ORDER BY a.published_at DESC LIMIT 20';
      const rows = await db.prepare(sql).all(...params);
      return JSON.stringify(rows);
    },
    {
      name: 'checkRecentColleagueWork',
      description:
        'Check what OTHER writers in the newsroom have published recently. Use to avoid duplicating coverage or to reference a colleague\'s piece.',
      schema: z.object({
        category: z.string().optional().describe('Filter by category name.'),
        hours: z.number().int().min(1).max(720).optional().describe('Lookback window in hours (default 48).'),
      }),
    },
  );
}
