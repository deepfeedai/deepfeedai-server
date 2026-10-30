'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('./fixture');
test('actual publishing APIs: assignment to reviewed draft and reader',{skip:process.env.PUBLISHING_ACCEPTANCE!=='1'},async t=>{
 const f=await startFixture();
 const request=async(url,body,method=body?'POST':'GET',auth=true)=>{const r=await fetch(f.base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+f.token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
  assert.equal((await request('/api/editor-assignments',null,'GET',false)).status,401);
  assert.equal((await request('/api/articles/'+f.foreignId)).status,404);
  assert.equal((await request('/api/article?slug='+f.foreignSlug,null,'GET',false)).status,404);
  const input={topic:'Evidence-based publishing',angle_summary:'Explain verified findings',writer_id:f.writerId,category:'Research',request_key:'publishing-acceptance-'+Date.now()};
  const created=await request('/api/editor-assignments',input);assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;
  assert.equal(created.body.status,'needs_sources');assert.equal(f.state.calls,0);
  assert.equal((await request('/api/editor-assignments',input)).body.id,id);
  assert.equal((await request('/api/editor-assignments',{...input,topic:'Conflicting brief'})).status,409);
  const denied=await fetch(f.base+'/api/editor-assignments',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.viewerToken},body:JSON.stringify({...input,request_key:input.request_key+'-denied'})});assert.equal(denied.status,403);
  assert.equal((await request('/api/editor-assignments/'+id+'/approve',{})).status,400);
  assert.equal((await request('/api/editor-assignments/'+id+'/sources',{source_article_ids:[f.foreignId],writer_id:f.writerId},'PUT')).status,400);
  assert.equal((await request('/api/editor-assignments/'+id+'/sources',{source_article_ids:f.sourceIds,writer_id:f.writerId},'PUT')).status,200);
  assert.equal((await request('/api/editor-assignments/'+id+'/approve',{})).status,200);assert.equal(f.state.calls,0);
  f.state.delay=200;
  const started=await request('/api/editor-assignments/'+id+'/generate',{confirmPaid:true});assert.equal(started.status,202,JSON.stringify(started.body));
  assert.equal((await request('/api/editor-assignments/'+id+'/generate',{confirmPaid:true})).status,409);
  let assignment;for(let n=0;n<100;n++){assignment=(await request('/api/editor-assignments')).body.assignments.find(p=>p.id===id);if(assignment.status!=='drafting')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(assignment.status,'review',JSON.stringify(assignment));assert.ok(assignment.spawned_article_id);assert.equal(f.state.calls,1);
  let article=(await request('/api/articles/'+assignment.spawned_article_id)).body;
  assert.equal(article.is_published,0);assert.equal((await request('/api/article?slug='+article.slug,null,'GET',false)).status,404);
  await t.test('publish is explicit and duplicate-safe',async()=>{
   assert.equal((await request('/api/articles/'+article.id+'/publish',{},'PUT')).status,400);
   const first=await request('/api/articles/'+article.id+'/publish',{published:true},'PUT');assert.equal(first.status,200,JSON.stringify(first.body));
   const repeated=await request('/api/articles/'+article.id+'/publish',{published:true},'PUT');assert.equal(repeated.status,200);
   assert.equal(repeated.body.is_published,1,'Repeated Publish must not unpublish');
   assert.equal(repeated.body.post_publish_status,'skipped');
   article=repeated.body;
  });
  await t.test('public article and feed show persisted content without editorial metadata',async()=>{
   const publicArticle=await request('/api/article?slug='+article.slug,null,'GET',false);
   assert.equal(publicArticle.status,200);assert.equal(publicArticle.body.title,article.title);
   assert.equal(publicArticle.body.synthesis_meta.editor_assignment_id,undefined);
   const feed=await request('/api/news?originals_only=1',null,'GET',false);
   assert.equal(feed.status,200);assert.ok(feed.body.items.some(a=>a.id===article.id));
   const item=feed.body.items.find(a=>a.id===article.id);assert.equal(item.editorial_score,undefined);assert.equal(item.synthesis_meta.editor_assignment_id,undefined);
   const developing=await request('/api/news?feed=developing',null,'GET',false);
   assert.ok(!developing.body.items.some(a=>f.sourceIds.includes(a.id)),'Unpublished inbox material is not a public developing feed');
  });
  await t.test('correction keeps URL; stale edits conflict; failed validation is atomic',async()=>{
   await f.db.prepare("UPDATE articles SET generated_title='Stale generated headline' WHERE id=$1").run(article.id);
   const prior=article;
   const updated=await request('/api/articles/'+article.id,{title:'Corrected verified title',summary:'Correction verified',expected_revision:article.publication_revision},'PUT');
   assert.equal(updated.status,200,JSON.stringify(updated.body));article=updated.body;
   assert.equal(article.slug,prior.slug);assert.equal(article.publication_revision,prior.publication_revision+1);
   assert.equal(article.generated_title,null);
   assert.equal((await request('/api/articles/'+article.id,{title:'Stale overwrite',expected_revision:prior.publication_revision},'PUT')).status,409);
   assert.equal((await request('/api/articles/'+article.id,{category:'Nonexistent category',expected_revision:article.publication_revision},'PUT')).status,400);
   assert.equal((await request('/api/articles/'+article.id)).body.category,'Research');
   assert.equal((await request('/api/article?slug='+article.slug,null,'GET',false)).body.title,article.title);
   const audit=await request('/api/articles/'+article.id+'/history');assert.ok(audit.body.history.some(h=>h.action==='correction'));
   assert.equal((await request('/api/articles/'+article.id+'/history',null,'GET',false)).status,401);
  });
  await t.test('unpublish removes public detail, feed, search and related content',async()=>{
   const story=await request('/api/story-timelines',{name:'Offline publishing story',articleIds:[article.id]});
   assert.equal(story.status,201,JSON.stringify(story.body));
   await request('/api/article/related?slug='+article.slug,null,'GET',false);
   const changes=await Promise.all([1,2].map(()=>request('/api/articles/'+article.id+'/publish',{published:false,expected_revision:article.publication_revision},'PUT')));
   assert.ok(changes.every(r=>r.status===200&&r.body.is_published===0));
   for(const suffix of ['', '/related'])assert.equal((await request('/api/article'+suffix+'?slug='+article.slug,null,'GET',false)).status,404);
   for(const query of ['originals_only=1','search=Corrected','category=Research']){
    const result=await request('/api/news?'+query,null,'GET',false);assert.equal(result.status,200);assert.ok(!result.body.items.some(a=>a.id===article.id));
   }
   const timeline=await request('/api/news/stories/'+story.body.story.slug,null,'GET',false);
   assert.equal(timeline.status,200);assert.ok(!JSON.stringify(timeline.body).includes('Corrected verified title'));
  });
  await t.test('upload is staged until Save, cancel leaves old pointer, failed image replacement retains it',async()=>{
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9kAAAAASUVORK5CYII=','base64');
   const upload=async()=>{const form=new FormData();form.append('image',new Blob([png],{type:'image/png'}),'offline.png');const response=await fetch(f.base+'/api/media/upload',{method:'POST',headers:{Authorization:'Bearer '+f.token},body:form});assert.equal(response.status,200);return response.json();};
   const first=await upload();const before=(await request('/api/articles/'+article.id)).body;
   assert.equal(before.image_url,null,'Upload alone must not attach');
   const saved=await request('/api/articles/'+article.id,{image_url:first.imageUrl,expected_revision:before.publication_revision},'PUT');assert.equal(saved.status,200);
   await upload(); // Cancel: intentionally no Save request.
   assert.equal((await request('/api/articles/'+article.id)).body.image_url,first.imageUrl);
   const bytes=await fetch(f.base+first.imageUrl);assert.equal(bytes.status,200);assert.match(bytes.headers.get('content-type'),/image\/png/);
   const failed=await request('/api/media/generate-image',{articleId:article.id});assert.ok(failed.status>=400);
   assert.equal((await request('/api/articles/'+article.id)).body.image_url,first.imageUrl);
  });
  await t.test('failed and slow generation survives status reload without duplicate inference',async()=>{
   const body={...input,request_key:input.request_key+'-failure',source_article_ids:f.sourceIds};
   const p=(await request('/api/editor-assignments',body)).body;
   await request('/api/editor-assignments/'+p.id+'/approve',{});
   f.state.fail=true;f.state.delay=100;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true})).status,202);
   const pending=await request('/api/editor-assignments/'+p.id);assert.equal(pending.body.status,'drafting');
   let status;for(let n=0;n<100;n++){status=(await request('/api/editor-assignments/'+p.id)).body;if(status.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
   assert.equal(status.status,'failed');assert.ok(status.draft_error);assert.equal(status.spawned_article_id,null);
   const calls=f.state.calls;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true})).status,409);assert.equal(f.state.calls,calls);
   f.state.fail=false;f.state.delay=0;
   assert.equal((await request('/api/editor-assignments/'+p.id+'/generate',{confirmPaid:true,retryAcknowledged:true})).status,202);
   for(let n=0;n<100;n++){status=(await request('/api/editor-assignments/'+p.id)).body;if(status.status==='review')break;await new Promise(r=>setTimeout(r,50));}
   assert.equal(status.status,'review');assert.equal(f.state.calls,calls+1);
  });
  await t.test('publication migration is repeatable and keeps history',async()=>{
   const migration=require('../../lib/publication');await migration.initPublicationSchema(f.db.getPool());await migration.initPublicationSchema(f.db.getPool());
   assert.ok((await request('/api/articles/'+article.id+'/history')).body.history.length>=3);
  });
  await t.test('unpublish cancels a scheduled draft; public reads never call AI',async()=>{
   await f.db.prepare("UPDATE articles SET status='scheduled',publish_at=NOW()+INTERVAL '1 day' WHERE id=$1").run(article.id);
   const result=await request('/api/articles/'+article.id+'/publish',{published:false},'PUT');
   assert.equal(result.status,200);assert.equal(result.body.status,'draft');assert.equal(result.body.publish_at,null);
   const calls=f.state.calls;
   const brief=await request('/api/news/topic-pulse/offline-publishing/brief',null,'GET',false);
   assert.equal(brief.status,200);assert.equal(brief.body.status,'not_generated');assert.equal(f.state.calls,calls);
  });
 }finally{await f.close();}
});
