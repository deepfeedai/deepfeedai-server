'use strict';
// Real HTTP route acceptance using the explicitly disposable publishing fixture.
// All provider calls are intercepted by fixture.js; no production credentials/data.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startFixture}=require('./fixture');

test('Newsroom v2: canonical journey, explicit paid boundary and recoverable state',
 {skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await startFixture({beforeStatic(app){
  app.use('/api/newsroom-workflow',require('../../routes/newsroom-workflow'));
  app.use('/api/pitches',require('../../routes/pitches'));
 }});
 const request=async(url,body,method=body?'POST':'GET',token=f.token)=>{
  const response=await fetch(f.base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  return{status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
 };
 const detail=async(kind,id,token)=>{const r=await request('/api/newsroom-workflow/'+kind+'/'+id,null,'GET',token===undefined?f.token:token);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const settle=async id=>{for(let n=0;n<160;n++){const r=await detail('assignment',id);if(!['running','uncertain'].includes(r.item.generation.state))return r;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Mocked generation did not settle');};
 try{
  await t.test('private projection is tenant scoped, paginated and read-only',async()=>{
   // Surface SQL failures only in the disposable harness, never production responses.
   await assert.doesNotReject(()=>require('../../lib/newsroom-workflow').list(1,{permissions:['*']},{stage:'discover',limit:1,offset:0}));
   assert.equal((await request('/api/newsroom-workflow',null,'GET',null)).status,401);
   assert.equal((await request('/api/newsroom-workflow/article/'+f.foreignId)).status,404);
   assert.equal((await request('/api/newsroom-workflow/source/'+f.foreignId)).status,404);
   const foreign=await f.db.prepare("INSERT INTO article_pitches(tenant_id,topic,angle_summary,status,is_editor_assignment) VALUES($1,'Private foreign brief','Private evidence','needs_sources',true) RETURNING id").get(f.otherTenantId);
   assert.equal((await request('/api/newsroom-workflow/assignment/'+foreign.id)).status,404);
   assert.equal((await request('/api/newsroom-workflow/not-a-kind/1')).status,404);
   for(const query of ['limit=0','offset=-1','stage=made-up','limit=1000'])assert.equal((await request('/api/newsroom-workflow?'+query)).status,400);
   const first=await request('/api/newsroom-workflow?stage=discover&limit=1&offset=0');
   assert.equal(first.status,200,JSON.stringify(first.body));assert.match(first.cache,/no-store/);assert.equal(first.body.items.length,1);assert.ok(first.body.total>=2);
   const second=await request('/api/newsroom-workflow?stage=discover&limit=1&offset=1');
   assert.equal(second.status,200,JSON.stringify(second.body));assert.notEqual(first.body.items[0].key,second.body.items[0].key);
   assert.ok(first.body.items.every(row=>row.stage==='discover'));
   const source=await detail('source',f.sourceIds[0]);assert.equal(source.item.stage,'discover');assert.ok(source.item.actions.length);
   assert.equal(f.state.calls,0);
  });

  let pitchId,assignmentId,articleId;
  await t.test('source pitch becomes one recoverable commission without generation',async()=>{
   const created=await request('/api/pitches',{source_article_id:f.sourceIds[0],angle_summary:'Explain the independently supported evidence',pitched_by_writer_id:f.writerId});
   assert.equal(created.status,201,JSON.stringify(created.body));
   pitchId=created.body.pitch?.id||created.body.id;assert.ok(pitchId);
   const pitch=await detail('pitch',pitchId);assert.equal(pitch.item.stage,'pitch');
   const bridge='/api/newsroom-workflow/pitch/'+pitchId+'/commission';
   assert.equal((await request(bridge,{},'POST',f.viewerToken)).status,403);
   const results=await Promise.all([request(bridge,{}),request(bridge,{})]);
   assert.ok(results.every(r=>[200,201].includes(r.status)),JSON.stringify(results));
   assert.equal(results[0].body.assignment_id,results[1].body.assignment_id);assignmentId=results[0].body.assignment_id;
   assert.equal((await request(bridge,{})).body.assignment_id,assignmentId);
   const linkedPitch=await detail('pitch',pitchId);
   assert.equal(linkedPitch.item.linked_assignment_id,assignmentId);
   assert.ok(!linkedPitch.item.actions.some(a=>a.id==='commission'&&a.enabled));
   const assignment=await detail('assignment',assignmentId);
   assert.equal(assignment.item.stage,'commission');assert.equal(assignment.item.generation.state,'not_started');
   assert.ok(assignment.item.blockers.some(b=>b.code==='sources'));
   assert.equal(f.state.calls,0);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/approve',{})).status,400);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/sources',{source_article_ids:[f.foreignId]})).status,400);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/sources',{source_article_ids:[f.sourceIds[1]]})).status,200);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/approve',{})).status,200);
   assert.equal(f.state.calls,0,'Approval never invokes a provider');
   const ready=await detail('assignment',assignmentId);
   assert.equal(ready.item.editorial_status,'approved');assert.equal(ready.item.blockers.length,0);
   assert.ok(ready.item.actions.some(a=>a.id==='generate'&&a.enabled&&a.paid));
   const viewer=await detail('assignment',assignmentId,f.viewerToken);
   assert.ok(viewer.item.actions.filter(a=>a.method).every(a=>a.enabled===false));
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/sources/'+f.sourceIds[1],null,'DELETE')).status,200);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/approve',ready.item.actions.find(a=>a.id==='approve').body)).status,409,'Stale action fingerprint cannot approve changed evidence');
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/generate',ready.item.actions.find(a=>a.id==='generate').body)).status,409,'Stale generation descriptor cannot spend against changed evidence');
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/generate',{confirmPaid:true})).status,409,'Changing evidence invalidates old approval');
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/sources',{source_article_ids:[f.sourceIds[1]]})).status,200);
   assert.equal((await request('/api/editor-assignments/'+assignmentId+'/approve',{})).status,200);
  });

  await t.test('generation is explicit, duplicate safe, visible after reload and saves for review',async()=>{
   const generate='/api/editor-assignments/'+assignmentId+'/generate';
   assert.equal((await request(generate,{})).status,400);assert.equal(f.state.calls,0);
   assert.equal((await request(generate,{confirmPaid:true},'POST',f.viewerToken)).status,403);
   f.state.delay=250;
   assert.equal((await request(generate,{confirmPaid:true})).status,202);
   assert.equal((await request(generate,{confirmPaid:true})).status,409);
   const reloaded=await detail('assignment',assignmentId);
   assert.equal(reloaded.item.editorial_status,'approved');assert.equal(reloaded.item.generation.state,'running');
   assert.ok(!reloaded.item.actions.some(a=>a.id==='generate'&&a.enabled));
   const reviewed=await settle(assignmentId);articleId=reviewed.draft?.id;
   assert.ok(articleId);assert.equal(reviewed.item.stage,'review');assert.equal(reviewed.item.generation.state,'succeeded');
   assert.equal(f.state.calls,1);assert.equal((await request(generate,{confirmPaid:true,retryAcknowledged:true})).status,409);
   assert.ok(reviewed.history.length);assert.ok(reviewed.costs.note);
   if(!reviewed.costs.available)assert.equal(reviewed.costs.estimated_usd,null,'Unknown cost must not be presented as zero');
   const article=(await request('/api/articles/'+articleId)).body;
   assert.equal(article.is_published,0);
   assert.equal((await request('/api/article?slug='+article.slug,null,'GET',null)).status,404);
   assert.equal(reviewed.handoffs.length,0,'Unpublished drafts have no public edition handoff');
   const queue=await request('/api/newsroom-workflow?stage=review');
   assert.equal(queue.status,200,JSON.stringify(queue.body));
   assert.ok(queue.body.items.some(row=>row.key==='assignment:'+assignmentId));
   assert.ok(!queue.body.items.some(row=>row.key==='article:'+articleId),'Linked draft is not duplicated in workflow queue');
  });

  await t.test('review, deliberate publication and withdrawal update authoritative workflow',async()=>{
   let article=(await request('/api/articles/'+articleId)).body;
   const oldRevision=article.publication_revision;
   const edited=await request('/api/articles/'+articleId,{title:'Reviewed newsroom workflow article',expected_revision:oldRevision},'PUT');
   assert.equal(edited.status,200,JSON.stringify(edited.body));article=edited.body;
   assert.equal((await request('/api/articles/'+articleId+'/approve',{expected_revision:oldRevision},'PUT')).status,409);
   const published=await request('/api/articles/'+articleId+'/approve',{expected_revision:article.publication_revision},'PUT');
   assert.equal(published.status,200,JSON.stringify(published.body));assert.equal(published.body.is_published,1);
   const repeat=await request('/api/articles/'+articleId+'/publish',{published:true},'PUT');assert.equal(repeat.status,200);assert.equal(repeat.body.is_published,1);
   const visible=await detail('assignment',assignmentId);assert.equal(visible.item.stage,'published');
   assert.ok(visible.handoffs.some(h=>h.id==='edition'));assert.ok(visible.handoffs.every(h=>h.paid===false));
   assert.equal((await request('/api/article?slug='+article.slug,null,'GET',null)).status,200);
   const calls=f.state.calls;
   assert.equal((await request('/api/articles/'+articleId+'/publish',{published:false,expected_revision:repeat.body.publication_revision},'PUT')).status,200);
   const withdrawn=await detail('assignment',assignmentId);assert.notEqual(withdrawn.item.stage,'published');assert.equal(withdrawn.handoffs.length,0);
   assert.equal((await request('/api/article?slug='+article.slug,null,'GET',null)).status,404);
   assert.equal(f.state.calls,calls,'Reads, publication and withdrawal cannot call a provider with automation disabled');
  });

  await t.test('submit for review rejects stale writes, is idempotent and cannot revert publication',async()=>{
   let article=(await request('/api/articles/'+articleId)).body;
   assert.equal(article.status,'draft');
   const descriptor=(await detail('assignment',assignmentId)).item.actions.find(a=>a.id==='submit_review');
   assert.ok(descriptor?.enabled);assert.equal(descriptor.body.expected_revision,article.publication_revision);
   const oldRevision=article.publication_revision;
   const edit=await request('/api/articles/'+articleId,{summary:'A reviewed correction before submission',expected_revision:oldRevision},'PUT');
   assert.equal(edit.status,200);article=edit.body;
   const endpoint='/api/articles/'+articleId+'/submit-review';
   assert.equal((await request(endpoint,{expected_revision:oldRevision},'PUT')).status,409);
   assert.equal((await request(endpoint,{expected_revision:-1},'PUT')).status,400);
   assert.equal((await request(endpoint,{expected_revision:article.publication_revision},'PUT',f.viewerToken)).status,403);
   const simultaneous=await Promise.all([1,2].map(()=>request(endpoint,{expected_revision:article.publication_revision},'PUT')));
   assert.ok(simultaneous.every(r=>r.status===200&&r.body.status==='review'),JSON.stringify(simultaneous));
   assert.equal(simultaneous[0].body.publication_revision,article.publication_revision+1);
   assert.equal(simultaneous[1].body.publication_revision,article.publication_revision+1);
   const history=(await request('/api/articles/'+articleId+'/history')).body.history;
   assert.equal(history.filter(e=>e.action==='submit_review').length,1,'Repeated submission records one transition');
   const returned=await request('/api/articles/'+articleId+'/publish',{published:false},'PUT');
   assert.equal(returned.status,200);assert.equal(returned.body.status,'draft');
   const race=await Promise.all([
    request('/api/articles/'+articleId+'/publish',{published:true},'PUT'),
    request(endpoint,{expected_revision:returned.body.publication_revision},'PUT')
   ]);
   assert.equal(race[0].status,200,JSON.stringify(race));assert.ok([200,409].includes(race[1].status));
   const winner=(await request('/api/articles/'+articleId)).body;
   assert.equal(winner.is_published,1);assert.equal(winner.status,'published','Late review transition must not overwrite publication');
   assert.equal((await request(endpoint,{expected_revision:winner.publication_revision},'PUT')).status,409);
   assert.equal((await request('/api/articles/'+articleId+'/publish',{published:false},'PUT')).status,200);
  });

  await t.test('failed attempt remains approved editorially and requires acknowledged paid retry',async()=>{
   const p=(await request('/api/editor-assignments',{topic:'Recoverable brief',angle_summary:'Verify before retrying',writer_id:f.writerId,source_article_ids:f.sourceIds,request_key:'workflow-failure-'+Date.now()})).body;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/approve',{})).status,200);
   f.state.fail=true;f.state.delay=30;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true})).status,202);
   const failed=await settle(p.id);assert.equal(failed.item.generation.state,'failed');assert.equal(failed.item.editorial_status,'approved');
   assert.ok(failed.item.generation.error);assert.equal(failed.item.generation.retry_requires_acknowledgement,true);
   const calls=f.state.calls;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true})).status,409);assert.equal(f.state.calls,calls);
   f.state.fail=false;f.state.delay=0;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true,retryAcknowledged:true})).status,202);
   const recovered=await settle(p.id);assert.equal(recovered.item.stage,'review');assert.equal(f.state.calls,calls+1);
  });

  await t.test('legacy writer approval cannot hide a paid operation and viewer cannot dismiss',async()=>{
   const row=await f.db.prepare("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,source_article_ids,status) VALUES(1,$1,'original','Recorded writer idea','Verified evidence',$2::jsonb,'pending') RETURNING id").get(f.writerId,JSON.stringify(f.sourceIds));
   const calls=f.state.calls;
   assert.equal((await request('/api/admin/pitches/'+row.id+'/dismiss',{},'POST',f.viewerToken)).status,403);
   const approved=await request('/api/admin/pitches/'+row.id+'/approve',{});
   assert.equal(approved.status,200,JSON.stringify(approved.body));
   assert.equal(f.state.calls,calls,'Legacy approval must not synthesize');
   const workflow=await detail('story_pitch',row.id);assert.equal(workflow.draft,null);
   const bridge=await request('/api/newsroom-workflow/story_pitch/'+row.id+'/commission',{});assert.equal(bridge.status,200,JSON.stringify(bridge.body));assert.ok(bridge.body.assignment_id);
   const commission=await detail('assignment',bridge.body.assignment_id);
   assert.equal(commission.brief.topic,'Recorded writer idea');
   assert.equal(commission.brief.angle_summary,'Verified evidence','Commission retains the actual writer reasoning, not only the headline');
   const before=await f.db.prepare('SELECT * FROM story_pitches WHERE id=$1').get(row.id);
   const migration=require('../../lib/newsroom-workflow-schema');
   await migration.initNewsroomWorkflowSchema(f.db.getPool());await migration.initNewsroomWorkflowSchema(f.db.getPool());
   assert.deepEqual(await f.db.prepare('SELECT * FROM story_pitches WHERE id=$1').get(row.id),before,'Repeated additive migration preserves existing pitch data and does not guess historical links');
   assert.equal(f.state.calls,calls);
  });

  await t.test('feature-disabled commissions fail honestly and reads never reactivate them',async()=>{
   const features=require('../../lib/feature-registry');
   await f.db.prepare("UPDATE tenant_feature_overrides SET value='false' WHERE tenant_id=1 AND feature_key='article_pitches'").run();features.bustFeatureCache(1);
   try{
    const calls=f.state.calls;
    assert.equal((await request('/api/newsroom-workflow/assignment/'+assignmentId)).status,404);
    assert.equal((await request('/api/newsroom-workflow/pitch/'+pitchId+'/commission',{})).status,404);
    const queue=await request('/api/newsroom-workflow');assert.equal(queue.status,200,JSON.stringify(queue.body));
    assert.ok(!queue.body.items.some(row=>['assignment','pitch'].includes(row.kind)));
    assert.equal(f.state.calls,calls);
   }finally{await f.db.prepare("UPDATE tenant_feature_overrides SET value='true' WHERE tenant_id=1 AND feature_key='article_pitches'").run();features.bustFeatureCache(1);}
  });
 }finally{await f.close();}
});
