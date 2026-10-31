'use strict';
async function initNewsroomWorkflowSchema(pool){
 // Older writer-pitch handlers referenced this link, but fresh schemas never
 // created it. Do not guess historical article associations during migration.
 await pool.query('ALTER TABLE story_pitches ADD COLUMN IF NOT EXISTS spawned_article_id INTEGER');
 await pool.query('CREATE INDEX IF NOT EXISTS story_pitches_article_link ON story_pitches(tenant_id,spawned_article_id) WHERE spawned_article_id IS NOT NULL');
}
module.exports={initNewsroomWorkflowSchema};
