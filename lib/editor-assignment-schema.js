'use strict';
async function initAssignmentSchema(p) {
 await p.query(`ALTER TABLE article_pitches ALTER COLUMN source_article_id DROP NOT NULL`);
 for(const col of ["is_editor_assignment BOOLEAN NOT NULL DEFAULT false","topic TEXT","assignment_category TEXT","request_key TEXT","draft_error TEXT","draft_started_at TIMESTAMPTZ","draft_attempt INTEGER NOT NULL DEFAULT 0"]) await p.query('ALTER TABLE article_pitches ADD COLUMN IF NOT EXISTS '+col);
 await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS editor_assignment_request ON article_pitches(tenant_id,request_key) WHERE is_editor_assignment=true AND request_key IS NOT NULL`);
 await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS article_editor_assignment ON articles(tenant_id,(synthesis_meta->>'editor_assignment_id')) WHERE synthesis_meta ? 'editor_assignment_id'`);
}
module.exports={initAssignmentSchema};
