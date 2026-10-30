'use strict';
async function initReaderSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS reader_item_states (
    tenant_id INTEGER NOT NULL, principal TEXT NOT NULL, article_id INTEGER NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false, is_saved BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(tenant_id,principal,article_id))`);
  await pool.query('CREATE INDEX IF NOT EXISTS reader_item_states_saved ON reader_item_states(tenant_id,principal,is_saved,article_id)');
  await pool.query(`CREATE TABLE IF NOT EXISTS reader_topic_exclusions (
    tenant_id INTEGER NOT NULL, article_id INTEGER NOT NULL, topic_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(tenant_id,article_id,topic_tag))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reader_enrichment_runs (
    tenant_id INTEGER NOT NULL, article_id INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT, attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,article_id))`);
}
module.exports={initReaderSchema};
