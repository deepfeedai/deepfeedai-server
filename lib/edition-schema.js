'use strict';

async function initEditionSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS newspaper_editions (
    id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    created_by TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    name TEXT NOT NULL, issue_date DATE NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('published','proof')),
    status TEXT NOT NULL DEFAULT 'working' CHECK(status IN ('working','finalized')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
    revision INTEGER NOT NULL DEFAULT 1, lead_article_id INTEGER,
    settings JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finalized_at TIMESTAMPTZ,
    UNIQUE(tenant_id,created_by,request_id),
    CHECK(visibility != 'public' OR (mode='published' AND status='finalized'))
  )`);
  // No source-article FK: deleting a source must not destroy a private archive.
  await pool.query(`CREATE TABLE IF NOT EXISTS newspaper_edition_articles (
    edition_id INTEGER NOT NULL REFERENCES newspaper_editions(id) ON DELETE CASCADE,
    article_id INTEGER NOT NULL, position INTEGER NOT NULL, snapshot JSONB NOT NULL,
    image_data BYTEA, image_mime TEXT,
    PRIMARY KEY(edition_id,article_id), UNIQUE(edition_id,position),
    CHECK(image_data IS NULL OR octet_length(image_data)<=5242880)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS newspaper_editions_tenant_date ON newspaper_editions(tenant_id,created_at DESC,id DESC)');
  // Additive: legacy finalized snapshots and their revisions remain unchanged.
  await pool.query('ALTER TABLE newspaper_edition_articles ADD COLUMN IF NOT EXISTS portrait_data BYTEA CHECK(portrait_data IS NULL OR octet_length(portrait_data)<=5242880)');
  await pool.query('ALTER TABLE newspaper_edition_articles ADD COLUMN IF NOT EXISTS portrait_mime TEXT');
}
module.exports = { initEditionSchema };
