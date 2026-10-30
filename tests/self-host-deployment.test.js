'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('explicit database TLS disable connects to Docker database without TLS', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const db = require('./db');
    const pool = db.getPool();
    require('node:assert/strict').equal(pool.options.ssl, false);
    pool.end();
  `], {cwd:path.join(__dirname,'..'),env:{...process.env,DATABASE_URL:'postgresql://test:dummy@database:5432/test',DATABASE_SSL:'disable'},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});
test('explicit verified database TLS requires certificate verification', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const db = require('./db');
    const pool = db.getPool();
    require('node:assert/strict').equal(pool.options.ssl.rejectUnauthorized, true);
    pool.end();
  `], {cwd:path.join(__dirname,'..'),env:{...process.env,DATABASE_URL:'postgresql://test:dummy@database:5432/test',DATABASE_SSL:'verify-full'},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});
test('disabled automation blocks both scheduled and manual execution before database access',async()=>{
  const previous=process.env.AUTOMATION_ENABLED;
  process.env.AUTOMATION_ENABLED='false';
  try {
    const cron=require('../lib/cron-registry');
    let ran=false;
    cron.registerJob({name:'deployment-test',defaultSchedule:'* * * * *',handler:async()=>{ran=true;}});
    await cron.startAll();
    const result=await cron.runJob('deployment-test',1);
    assert.match(result.skipped,/disabled/);
    assert.equal(ran,false);
  } finally {if(previous===undefined)delete process.env.AUTOMATION_ENABLED;else process.env.AUTOMATION_ENABLED=previous;}
});
