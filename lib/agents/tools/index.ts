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

  // Editors get publish tools (placeholder — wires into existing publish pipeline in a later PR)
  // if (ctx.writerRole === 'editor') {
  //   baseTools.push(buildPublishArticle(ctx));
  //   baseTools.push(buildRejectArticle(ctx));
  // }

  return baseTools;
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
