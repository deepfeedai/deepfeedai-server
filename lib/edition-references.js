'use strict';

const crypto = require('node:crypto');
const MAX_REFERENCES = 100;
const sensitive = /(?:token|password|secret|authorization|credential|signature|session|jwt|api[-_]?key|access[-_]?key|^key$|^sig$|^code$|^auth$|^x-amz-)/i;
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function plain(value, max = 1000) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}
function safeReferenceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some(k => sensitive.test(k))) return null;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.includes('=') && [...new URLSearchParams(fragment.replace(/^[^?]*\?/, '').replace(/;/g, '&')).keys()].some(k => sensitive.test(k))) return null;
    return url.href;
  } catch { return null; }
}
function sourceArray(raw) {
  try { const value = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(value) ? value : []; } catch { return []; }
}
function citationNumbers(content) {
  // Exclude inline/fenced code: bracket examples are not asserted source citations.
  const text = String(content || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
  return [...new Set([...text.matchAll(/\[([1-9]\d{0,5})\](?!\()/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}
function captureReferences(raw, content = '', provenance = 'captured-with-article') {
  const sources = sourceArray(raw), warnings = [];
  const references = sources.slice(0, MAX_REFERENCES).map((source, i) => {
    const number = i + 1, object = source && typeof source === 'object' && !Array.isArray(source) ? source : null;
    const id = object?.id ?? (Number.isSafeInteger(source) ? source : null);
    const title = plain(object?.title), publisher = plain(object?.source, 300), url = safeReferenceUrl(object?.source_url);
    let warning = null;
    if (!object || !title) warning = `Source details were not captured for [${number}].`;
    else if (!url) warning = `A safe source URL is unavailable for [${number}].`;
    return { number, article_id: Number.isSafeInteger(id) && id > 0 ? id : null, title, publisher, url, warning };
  });
  if (sources.length > MAX_REFERENCES) warnings.push('Additional source metadata exceeded the edition limit and was not captured.');
  for (const n of citationNumbers(content)) if (!references.some(r => r.number === n && r.title)) warnings.push(`Reference [${n}] has no captured source details.`);
  return { references, reference_warnings: warnings, reference_capture: { version: 1, provenance, source_reference_hash: digest(raw ?? null) } };
}

function preservedSnapshot(snapshot) {
  const copy = { ...snapshot };
  delete copy.references; delete copy.reference_warnings; delete copy.reference_capture;
  return copy;
}
function inspectMatch(edition, item, article) {
  const { text } = require('./editions');
  if (Object.hasOwn(item.snapshot, 'references')) return { eligible: false, reason: 'already-captured' };
  if (!article || article.tenant_id !== edition.tenant_id) return { eligible: false, reason: 'source-unavailable' };
  if (!['original', 'deep-dive'].includes(article.content_type) || article.is_archived || article.is_published !== 1) return { eligible: false, reason: 'source-not-eligible' };
  const body = text(article.full_content) || text(article.content) || text(article.summary);
  if (!body || body !== item.snapshot.content || text(article.title) !== item.snapshot.title) return { eligible: false, reason: 'source-text-changed' };
  if (!item.snapshot.source_updated_at || new Date(item.snapshot.source_updated_at).getTime() !== new Date(article.updated_at).getTime()) return { eligible: false, reason: 'source-version-changed' };
  if (item.snapshot.publication_epoch !== article.publication_epoch) return { eligible: false, reason: 'publication-changed' };
  const metadata = captureReferences(article.source_article_ids, body, 'verified-metadata-backfill');
  if (!metadata.references.length || citationNumbers(body).some(n => !metadata.references.some(r => r.number === n && r.article_id && r.title))) return { eligible: false, reason: 'unresolved-reference-mapping' };
  return { eligible: true, reason: 'matched-text-version-and-reference-order', metadata };
}

async function lockedPlan(client) {
  // Deliberately scoped one-off repair. No route or startup hook calls this helper.
  const edition = (await client.query('SELECT * FROM newspaper_editions WHERE id=1 AND tenant_id=1 FOR UPDATE')).rows[0];
  if (!edition || edition.mode !== 'published' || edition.status !== 'finalized') throw new Error('Expected finalized published-content edition 1 in workspace 1');
  const items = (await client.query("SELECT article_id,position,snapshot,image_mime,octet_length(image_data) image_bytes,encode(sha256(image_data),'hex') image_hash FROM newspaper_edition_articles WHERE edition_id=1 ORDER BY position FOR UPDATE")).rows;
  if (!items.length) throw new Error('Edition 1 is empty');
  const articles = (await client.query('SELECT id,tenant_id,title,full_content,content,summary,source_article_ids,updated_at,updated_at::text updated_epoch,published_at::text publication_epoch,is_published,is_archived,content_type FROM articles WHERE tenant_id=1 AND id=ANY($1::int[]) ORDER BY id FOR SHARE', [items.map(i => i.article_id)])).rows;
  const results = items.map(item => {
    const article = articles.find(a => a.id === item.article_id), match = inspectMatch(edition, item, article);
    return { item, article, match };
  });
  const plan = { version: 1, edition_id: 1, tenant_id: 1, edition_revision: edition.revision,
    edition_hash: digest(edition), items: results.map(({ item, article, match }) => ({
      article_id: item.article_id, position: item.position, eligible: match.eligible, reason: match.reason,
      snapshot_hash: digest(item), source_hash: digest(article ?? null),
      reference_count: match.metadata?.references.length || 0, metadata_hash: match.metadata ? digest(match.metadata) : null,
    })) };
  plan.plan_hash = digest(plan);
  return { edition, results, plan };
}
async function backfillEditionOne(pool, { apply = false, expectedPlan } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { edition, results, plan } = await lockedPlan(client);
    if (!apply) { await client.query('ROLLBACK'); return { ...plan, applied: false }; }
    if (!expectedPlan || expectedPlan.edition_id !== 1 || expectedPlan.tenant_id !== 1 || expectedPlan.edition_revision !== edition.revision || expectedPlan.plan_hash !== plan.plan_hash) throw new Error('Backfill plan changed; rerun dry-run and review before applying');
    const changed = [];
    for (const { item, match } of results) {
      if (!match.eligible) continue;
      await client.query('UPDATE newspaper_edition_articles SET snapshot=snapshot || $2::jsonb WHERE edition_id=1 AND article_id=$1', [item.article_id, JSON.stringify({ ...match.metadata, reference_capture: { ...match.metadata.reference_capture, plan_hash: plan.plan_hash } })]);
      changed.push(item.article_id);
    }
    const after = (await client.query("SELECT article_id,position,snapshot,image_mime,octet_length(image_data) image_bytes,encode(sha256(image_data),'hex') image_hash FROM newspaper_edition_articles WHERE edition_id=1 ORDER BY position")).rows;
    for (const { item } of results) {
      const updated = after.find(i => i.article_id === item.article_id);
      if (!updated || digest({ ...updated, snapshot: preservedSnapshot(updated.snapshot) }) !== digest({ ...item, snapshot: preservedSnapshot(item.snapshot) })) throw new Error('Backfill preservation check failed');
    }
    if (changed.length) await client.query('UPDATE newspaper_editions SET revision=revision+1,updated_at=NOW() WHERE id=1 AND tenant_id=1');
    await client.query('COMMIT');
    return { ...plan, applied: true, changed_article_ids: changed, new_revision: edition.revision + (changed.length ? 1 : 0), preservation_verified: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
module.exports = { MAX_REFERENCES, safeReferenceUrl, citationNumbers, captureReferences, digest, preservedSnapshot, inspectMatch, backfillEditionOne };
