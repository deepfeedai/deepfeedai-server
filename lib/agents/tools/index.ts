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
    buildFetchArticle(ctx),
    buildListWriterBeats(ctx),
    buildGetWriterMemory(ctx),
    buildCheckRecentColleagueWork(ctx),
  ];

  // Writers and above can write memory
  if (['writer', 'editor', 'analyst'].includes(ctx.writerRole)) {
    baseTools.push(buildUpdateWriterMemory(ctx));
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
        return JSON.stringify({ status: 'tool_unavailable', message: 'Search backend not available.' });
      }
      const results = await findRelevantArticles(ctx.writerId, ctx.tenantId, query, limit || 5);
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
          message: 'No articles found matching this query. This writer has not published anything matching that topic. Do NOT retry with a different query — answer the user honestly that you have not written about this yet.',
          results: [],
        });
      }
      return JSON.stringify({ status: 'ok', results: compact });
    },
    {
      name: 'searchArticles',
      description:
        'REQUIRED when the user asks what you wrote, published, or covered on a topic. ' +
        'Searches the writer\'s own published articles and, when the shared-wire feature is enabled, curated source articles within the writer\'s beats. ' +
        'Call this AT MOST ONCE per user question — if it returns status:"no_results", do NOT retry with different queries; answer honestly that you have not published on that topic. ' +
        'NEVER fabricate article titles, topics, or links.',
      schema: z.object({
        query: z.string().describe('What to search for, in natural language.'),
        limit: z.number().int().min(1).max(10).optional().describe('Max results to return (1-10).'),
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
