'use strict';
async function initNavigationSchema(pool) {
 await pool.query(`CREATE TABLE IF NOT EXISTS navigation_preferences (
 tenant_id INTEGER NOT NULL, principal TEXT NOT NULL, checklist_version INTEGER NOT NULL,
 dismissed BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tenant_id,principal,checklist_version))`);
}
module.exports={initNavigationSchema};
