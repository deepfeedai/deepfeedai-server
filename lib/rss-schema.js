'use strict';
async function initRssSchema(pool){
 for(const sql of [
  'ALTER TABLE sources ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ',
  "ALTER TABLE sources ADD COLUMN IF NOT EXISTS folder_path TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE sources ADD COLUMN IF NOT EXISTS normalized_url TEXT',
  'ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_fetch_error TEXT',
  'ALTER TABLE articles ADD COLUMN IF NOT EXISTS source_id INTEGER',
  `CREATE TABLE IF NOT EXISTS rss_identities(tenant_id INTEGER NOT NULL,identity_key TEXT NOT NULL,article_id INTEGER NOT NULL,PRIMARY KEY(tenant_id,identity_key))`,
  `CREATE TABLE IF NOT EXISTS rss_occurrences(tenant_id INTEGER NOT NULL,source_id INTEGER NOT NULL,occurrence_key TEXT NOT NULL,article_id INTEGER NOT NULL,normalized_url TEXT,first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(tenant_id,source_id,occurrence_key))`,
  'ALTER TABLE rss_occurrences ADD COLUMN IF NOT EXISTS original_url TEXT',
  `CREATE TABLE IF NOT EXISTS rss_duplicate_links(tenant_id INTEGER NOT NULL,article_id INTEGER NOT NULL,canonical_article_id INTEGER NOT NULL,created_by INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(tenant_id,article_id),CHECK(article_id<>canonical_article_id))`,
  'CREATE INDEX IF NOT EXISTS rss_occurrences_article ON rss_occurrences(tenant_id,article_id)',
  'CREATE INDEX IF NOT EXISTS rss_duplicates_canonical ON rss_duplicate_links(tenant_id,canonical_article_id)',
  'CREATE INDEX IF NOT EXISTS articles_source_id ON articles(tenant_id,source_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS sources_normalized_identity ON sources(tenant_id,normalized_url) WHERE normalized_url IS NOT NULL',
 ])await pool.query(sql);
 // Add provenance only where the legacy source name identifies exactly one subscription.
 await pool.query(`UPDATE articles a SET source_id=s.id FROM (SELECT tenant_id,name,MIN(id) id FROM sources GROUP BY tenant_id,name HAVING COUNT(*)=1) s WHERE a.tenant_id=s.tenant_id AND a.source=s.name AND a.source_id IS NULL`);
}
module.exports={initRssSchema};
