const {test}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../../db');

test('fresh and repeated initialization preserve pull quotes and stubbed synthesis persists', {skip:!process.env.DATABASE_URL},async()=>{
  const cache=new Map();
  function stub(name,exports){const path=require.resolve('../../'+name);cache.set(path,require.cache[path]);require.cache[path]={id:path,filename:path,loaded:true,exports};}
  const oldFetch=global.fetch;
  let calls=0;
  try {
    await db.init();
    const col=await db.prepare("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='articles' AND column_name='pull_quote'").get();
    assert.equal(col.data_type,'text');
    const slug='synthesis-regression-'+Date.now();
    const writer=await db.prepare("INSERT INTO writers (tenant_id,name,slug) VALUES (1,'Offline regression',$1) RETURNING *").get(slug);
    stub('lib/ai-router',{complete:async opts=>{calls++;assert.equal(opts.operation,'synthesis');assert.equal(opts.maxTokens,4096);return {text:'TITLE: Offline synthesis regression\nEXCERPT: Test summary\nPULL_QUOTE: Preserved quote\nTOPIC_TAG: offline-regression\n'+Array(230).fill('analysis').join(' '),usage:{}};}});
    stub('lib/writer-memory',{getRelevantMemories:async()=>[],extractAndStoreMemories:async()=>{}});
    stub('lib/writer-assign',{buildWriterPrompt:async()=> 'Offline test writer'});
    stub('lib/presence',{setPresence:async()=>{}});
    stub('lib/newsroom-events',{recordEvent:async()=>null});
    stub('lib/headline',{generateAndStoreHeadlines:async()=>{}});
    stub('lib/final-thoughts',{generateFinalThoughts:async()=>{}});
    stub('lib/quality-gate',{getEditorialScore:async()=>({score:0,publish:false})});
    stub('lib/editorial',{editorialReview:async()=>({publish:false})});
    stub('lib/publish-gate',{evaluatePublish:async()=>({action:'publish'})});
    stub('lib/post-publish',{onArticlePublished:async()=>{}});
    stub('lib/media-helpers',{generateAndStoreImage:async()=>null});
    stub('routes/notifications',{createNewArticleNotification:async()=>{}});
    global.fetch=async()=>{throw new Error('Unexpected external request in isolated test');};
    const enginePath=require.resolve('../../lib/synthesis');cache.set(enginePath,require.cache[enginePath]);delete require.cache[enginePath];
    const row=await require('../../lib/synthesis').synthesizeCluster({topic:'Offline regression',articles:[1,2].map(id=>({id,title:'Offline analysis '+id,summary:'Offline source summary',source:'Fixture',category:'Research',created_at:new Date().toISOString()}))},writer,1,{allowAutoFollowup:false});
    assert.equal(calls,1);assert.ok(row.id);
    assert.equal((await db.prepare('SELECT pull_quote FROM articles WHERE id=$1').get(row.id)).pull_quote,'Preserved quote');
    await db.init();
    assert.equal((await db.prepare('SELECT pull_quote FROM articles WHERE id=$1').get(row.id)).pull_quote,'Preserved quote');
    let enrichment=0;
    stub('lib/headline',{generateAndStoreHeadlines:async()=>{enrichment++;throw Error('No automatic enrichment allowed')}});
    const review=await require('../../lib/synthesis').synthesizeCluster({topic:'Assignment review',articles:[1,2].map(id=>({id,title:'Evidence '+id,summary:'Supporting evidence',source:'Fixture',category:'Research',created_at:new Date().toISOString()}))},writer,1,{allowAutoFollowup:false,reviewOnly:true,editorAssignmentId:987654});
    assert.ok(review.id);assert.equal(review.status,'review');assert.equal(review.is_published,0);assert.equal(enrichment,0);
    assert.equal((await db.prepare('SELECT synthesis_meta FROM articles WHERE id=$1').get(review.id)).synthesis_meta.editor_assignment_id,'987654');
    await db.prepare('DELETE FROM articles WHERE id=$1').run(review.id);
    await db.prepare('DELETE FROM articles WHERE id=$1').run(row.id);
    await db.prepare('DELETE FROM writers WHERE id=$1').run(writer.id);
  } finally {
    global.fetch=oldFetch;
    for(const [path,entry] of cache){if(entry)require.cache[path]=entry;else delete require.cache[path];}
    await db.getPool().end();
  }
});
