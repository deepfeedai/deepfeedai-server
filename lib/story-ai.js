'use strict';
const db = require('../db');
const { invalid } = require('./story-publication');

async function initStoryAiSchema(pool) {
  await pool.query('ALTER TABLE story_timelines ADD COLUMN IF NOT EXISTS summary_article_ids INTEGER[]');
  await pool.query(`CREATE TABLE IF NOT EXISTS story_ai_runs (
    id BIGSERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
    story_id INTEGER NOT NULL REFERENCES story_timelines(id) ON DELETE CASCADE,
    request_key VARCHAR(100) NOT NULL, state TEXT NOT NULL,
    message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
    UNIQUE(tenant_id, request_key)
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS story_ai_one_running
    ON story_ai_runs(tenant_id,story_id) WHERE state='running'`);
}

const fields = 'id, story_id, state, message, created_at, finished_at';
async function latest(tenantId, storyId) {
  let job = await db.prepare(`SELECT ${fields} FROM story_ai_runs WHERE tenant_id=$1 AND story_id=$2
    ORDER BY id DESC LIMIT 1`).get(tenantId,storyId);
  if(job?.state==='running') {
    const client=await db.getPool().connect();
    let locked=false;
    try {
      const {rows:[lock]}=await client.query('SELECT pg_try_advisory_lock(73413,$1) AS locked',[storyId]);
      locked=lock.locked;
      if(locked) {
        const {rows:[updated]}=await client.query(`UPDATE story_ai_runs SET state='failed',
          message='Interrupted request; charges may already have occurred. Acknowledge before retrying.',finished_at=NOW()
          WHERE id=$1 AND tenant_id=$2 AND state='running' RETURNING ${fields}`,[job.id,tenantId]);
        if(updated)job=updated;
      }
    } finally {
      if(locked)await client.query('SELECT pg_advisory_unlock(73413,$1)',[storyId]);
      client.release();
    }
  }
  return job;
}

// Hold a session advisory lock across the provider call. A process crash releases
// it; a later explicit retry can then acknowledge the ambiguous previous outcome.
async function start(tenantId, storyId, options = {}, generate) {
  if(options.confirmPaid !== true) throw invalid('Confirm the paid AI action');
  if(typeof options.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(options.requestKey)) {
    throw invalid('A stable request key is required');
  }
  const client = await db.getPool().connect();
  let locked = false;
  let tenantLocked = false;
  const unlock = async () => {
    if(tenantLocked) await client.query('SELECT pg_advisory_unlock(73414,$1)',[tenantId]);
    if(locked) await client.query('SELECT pg_advisory_unlock(73413,$1)',[storyId]);
    client.release(); locked=false; tenantLocked=false;
  };
  try {
    const {rows:[story]} = await client.query('SELECT id FROM story_timelines WHERE id=$1 AND tenant_id=$2',[storyId,tenantId]);
    if(!story) throw invalid('Story not found',404);
    const {rows:[lock]} = await client.query('SELECT pg_try_advisory_lock(73413,$1) AS locked',[storyId]);
    locked=lock.locked;
    if(!locked) throw invalid('Story AI is already running; check its status before retrying',409);
    const {rows:[tenantLock]}=await client.query('SELECT pg_try_advisory_lock(73414,$1) AS locked',[tenantId]);
    tenantLocked=tenantLock.locked;
    if(!tenantLocked) throw invalid('Another story is generating in this workspace; wait for it to finish',429);
    const {rows:[previous]} = await client.query(`SELECT ${fields} FROM story_ai_runs WHERE tenant_id=$1 AND request_key=$2`,[tenantId,options.requestKey]);
    if(previous) {
      if(previous.story_id !== storyId) throw invalid('Request key already used for another story',409);
      await unlock(); return {job:previous,run:null};
    }
    await client.query(`UPDATE story_ai_runs SET state='failed',message='Interrupted request; provider cost may already have occurred. Acknowledge before retrying.',finished_at=NOW()
      WHERE tenant_id=$1 AND story_id=$2 AND state='running'`,[tenantId,storyId]);
    const {rows:[last]} = await client.query(`SELECT ${fields} FROM story_ai_runs WHERE tenant_id=$1 AND story_id=$2 ORDER BY id DESC LIMIT 1`,[tenantId,storyId]);
    if(last?.state === 'failed' && options.retryAcknowledged !== true) throw invalid('Acknowledge the previous failure before retrying; charges may already have occurred',409);
    if(last?.state === 'ready' && Date.now()-new Date(last.finished_at).getTime()<60000) throw invalid('Wait one minute before generating again',429);
    const {rows:[job]} = await client.query(`INSERT INTO story_ai_runs(tenant_id,story_id,request_key,state,message)
      VALUES($1,$2,$3,'running','Generating name and summary') RETURNING ${fields}`,[tenantId,storyId,options.requestKey]);
    let ran=false;
    return {job,run:async()=>{
      if(ran)return; ran=true;
      try {
        const fn=generate || require('./story-timelines').generateStoryNameAndSummary;
        const result=await fn(storyId,tenantId);
        const state=result?.state === 'skipped' ? 'skipped' : 'ready';
        // Only controlled messages may be persisted or shown to the browser.
        const message=state==='ready'?'Name and summary updated':
          result?.message==='Budget limit reached'?'Budget limit reached':'No eligible changes; check published articles';
        await client.query('UPDATE story_ai_runs SET state=$1,message=$2,finished_at=NOW() WHERE id=$3 AND tenant_id=$4',[state,message,job.id,tenantId]);
      } catch {
        await client.query(`UPDATE story_ai_runs SET state='failed',message='Generation failed. Check provider availability and budget. Charges may already have occurred; acknowledge before retrying.',finished_at=NOW() WHERE id=$1 AND tenant_id=$2`,[job.id,tenantId]);
      } finally { await unlock(); }
    }};
  } catch(error) { await unlock(); throw error; }
}
module.exports={initStoryAiSchema,latest,start};
