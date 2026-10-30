import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const cwd=path.resolve(import.meta.dirname,'..');
try {await fs.access(path.join(cwd,'.env'));throw new Error('Refusing startup test with an existing .env file');} catch(error){if(error.code!=='ENOENT')throw error;}
const env={...process.env,PORT:'19080',NODE_ENV:'test',AUTOMATION_ENABLED:'false',SELF_HOSTED:'true',DEPLOYMENT_MODE:'single',STORAGE_BACKEND:'local',SETTINGS_ENCRYPTION_KEY:'11'.repeat(32),JWT_SECRET:'local-ephemeral-test-only',USER_JWT_SECRET:'local-ephemeral-user-test-only',CRON_SECRET:'local-ephemeral-cron-test-only'};
delete env.DATABASE_URL;delete env.ADMIN_PASSWORD;delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
const child=spawn(process.execPath,['-r','tsx/cjs','server.js'],{cwd,env,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
try{
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch('http://127.0.0.1:19080/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,output);
  assert.equal((await fetch('http://127.0.0.1:19080/ready')).status,503);
  const status=await(await fetch('http://127.0.0.1:19080/api/setup/status')).json();
  assert.equal(status.database,'not_configured');assert.equal(status.mode,'single');
  console.log('Node24 backend startup passed; health200, readiness503 without DB, single-tenant setup status verified. No database or persistent credentials used.');
}finally{child.kill();}
