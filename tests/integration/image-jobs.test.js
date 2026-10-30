const {test}=require('node:test');const assert=require('node:assert/strict');const db=require('../../db');
test('fresh/repeated jobs initialization, tenant isolation, retry exhaustion and stale recovery',{skip:!process.env.DATABASE_URL},async()=>{
 try{
  await db.init();const {initJobSchema}=require('../../lib/jobs/schema');const p=db.getPool();await initJobSchema(p);
  const {enqueueJob,failJob}=require('../../lib/jobs/queue');const {pollJob,recoverStaleJobs}=require('../../lib/jobs/worker');
  const key='offline-image-'+Date.now();
  const a=await enqueueJob({tenantId:1,type:'generate_image',payload:{articleId:-1},idempotencyKey:key,maxAttempts:2});
  const b=await enqueueJob({tenantId:1,type:'generate_image',idempotencyKey:key});assert.equal(a.job.id,b.job.id);
  await initJobSchema(p);assert.equal((await p.query('SELECT id FROM jobs WHERE id=$1',[a.job.id])).rowCount,1);
  assert.equal(await pollJob({tenantId:999999,types:['generate_image']}),null);
  const claimed=await pollJob({tenantId:1,types:['generate_image']});assert.equal(claimed.id,a.job.id);
  await failJob({jobId:a.job.id,tenantId:1,errorMessage:'offline',attempts:0,maxAttempts:2});
  let row=(await p.query('SELECT * FROM jobs WHERE id=$1',[a.job.id])).rows[0];assert.equal(row.status,'pending');assert.equal(row.attempts,1);
  await failJob({jobId:a.job.id,tenantId:1,errorMessage:'offline',attempts:1,maxAttempts:2});
  assert.equal((await p.query('SELECT status FROM jobs WHERE id=$1',[a.job.id])).rows[0].status,'failed');
  await failJob({jobId:a.job.id,tenantId:1,errorMessage:'ambiguous paid timeout',attempts:0,maxAttempts:5,retryable:false});
  assert.equal((await p.query('SELECT status FROM jobs WHERE id=$1',[a.job.id])).rows[0].status,'failed');
  await p.query("UPDATE jobs SET status='running',attempts=1,run_at=NOW()-INTERVAL '1 hour',stale_after_minutes=1 WHERE id=$1",[a.job.id]);
  await recoverStaleJobs();row=(await p.query('SELECT * FROM jobs WHERE id=$1',[a.job.id])).rows[0];assert.equal(row.status,'failed');assert.equal(row.attempts,2);
  await p.query("UPDATE jobs SET status='running',attempts=0,max_attempts=5,run_at=NOW()-INTERVAL '1 hour' WHERE id=$1",[a.job.id]);
  await recoverStaleJobs();assert.equal((await p.query('SELECT status FROM jobs WHERE id=$1',[a.job.id])).rows[0].status,'failed');
  await p.query('DELETE FROM jobs WHERE id=$1',[a.job.id]);
  // Real PostgreSQL CAS + isolated local media, without any provider calls.
  process.env.STORAGE_BACKEND='local';
  const storage=require('../../lib/storage');
  const {replaceImage}=require('../../lib/image-persistence');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0sAAAAASUVORK5CYII=';
  const oldUrl=await storage.upload(Buffer.from(png,'base64'),'image/png','images/offline-old.png',1);
  const article=await db.prepare("INSERT INTO articles (tenant_id,title,image_url) VALUES (1,'Offline image regression',$1) RETURNING id").get(oldUrl);
  const url=await replaceImage({table:'articles',id:article.id,tenantId:1,oldUrl,b64:png});
  assert.equal((await db.prepare('SELECT image_url FROM articles WHERE id=$1').get(article.id)).image_url,url);
  await assert.rejects(replaceImage({table:'articles',id:article.id,tenantId:1,oldUrl,b64:png}),{code:'IMAGE_CONFLICT'});
  assert.equal((await db.prepare('SELECT image_url FROM articles WHERE id=$1').get(article.id)).image_url,url);
  await db.prepare('DELETE FROM articles WHERE id=$1').run(article.id);
  await storage.remove(url.split('/media/tenants/1/')[1],1);
 }finally{await db.getPool().end();}
});
