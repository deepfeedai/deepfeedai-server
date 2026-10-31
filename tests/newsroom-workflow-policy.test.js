'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const workflow=require('../lib/newsroom-workflow');
const owner={permissions:['*']},viewer={permissions:['articles.read']};
const row={id:8,status:'proposed',source_article_id:1,attached_article_ids:[2],pitched_by_writer_id:3,topic:'Fixture',draft_attempt:0};
const sources=[{id:1,eligible:true},{id:2,eligible:true}],writer={id:3,role:'writer'};
test('workflow prerequisites explain missing or unavailable sources and writer',()=>{
 assert.deepEqual(workflow.assignmentPrerequisites(row,sources,writer),[]);
 assert.deepEqual(workflow.assignmentPrerequisites(row,[{id:1,eligible:false}],null).map(x=>x.code),['sources','unavailable_source','writer']);
 const item=workflow.project('assignment',row,{sources:[],writer:null,user:owner});
 assert.equal(item.primary_action.id,'sources');assert.equal(item.actions.find(x=>x.id==='approve').enabled,false);
});
test('workflow separates approved editorial state from uncertain and failed generation',()=>{
 const failed=workflow.project('assignment',{...row,status:'failed',draft_attempt:1},{sources,writer,user:owner});
 assert.equal(failed.editorial_status,'approved');assert.equal(failed.stage,'commission');assert.equal(failed.generation.state,'failed');assert.equal(failed.primary_action.paid,true);assert.equal(failed.primary_action.body.retryAcknowledged,true);
 const running=workflow.project('assignment',{...row,status:'drafting',draft_started_at:new Date().toISOString()},{sources,writer,user:owner});assert.equal(running.generation.state,'running');assert.equal(running.actions.find(x=>x.id==='generate').enabled,false);
 const stale=workflow.project('assignment',{...row,status:'drafting',draft_started_at:'2000-01-01'},{sources,writer,user:owner});assert.equal(stale.generation.state,'uncertain');assert.equal(stale.actions.find(x=>x.id==='generate').body.retryAcknowledged,true);
});
test('current article state overrides historical pitch status without fabricating job state',()=>{
 const article={id:4,status:'draft',is_published:0,is_archived:0,publication_revision:7};
 const item=workflow.project('assignment',{...row,status:'published',spawned_article_id:4},{article,sources,writer,user:owner});assert.equal(item.stage,'draft');assert.equal(item.editorial_status,'draft');assert.equal(item.actions.find(x=>x.id==='submit_review').body.expected_revision,7);
 assert.equal(workflow.project('story_pitch',row,{user:owner}).generation.state,'not_tracked');
});
test('workflow permission and feature capabilities never enable unauthorized mutations',()=>{
 assert.ok(workflow.project('assignment',row,{sources,writer,user:viewer}).actions.every(a=>!a.enabled));
 const item=workflow.project('story_pitch',row,{user:owner,commissionEnabled:false});assert.equal(item.actions[0].enabled,false);assert.match(item.actions[0].reason,/not enabled/);
});
test('workflow view token rejects stale source/writer/state decisions',()=>{
 const token=workflow.fingerprint(row);workflow.assertCurrent(row,token);workflow.assertCurrent(row,undefined);
 assert.throws(()=>workflow.assertCurrent({...row,attached_article_ids:[2,4]},token),e=>e.status===409);
 assert.throws(()=>workflow.assertCurrent({...row,pitched_by_writer_id:6},token),e=>e.status===409);
 assert.equal(workflow.project('assignment',row,{sources,writer,user:owner}).actions.find(x=>x.id==='approve').body.expected_state,token);
});
test('recorded costs distinguish zero from unknown and partial estimates',()=>{
 assert.equal(workflow.costProjection({requests:2,priced_requests:0,estimated_usd:null}).estimated_usd,null);
 assert.equal(workflow.costProjection({requests:2,priced_requests:0,estimated_usd:null}).available,false);
 const partial=workflow.costProjection({requests:2,priced_requests:1,estimated_usd:'0.02'});assert.equal(partial.estimated_usd,0.02);assert.match(partial.note,/Partial estimate/);
 assert.equal(workflow.costProjection({requests:1,priced_requests:1,estimated_usd:'0'}).estimated_usd,0);
});
test('story pitch reasoning changes invalidate a viewed bridge decision',()=>{
 const pitch={...row,headline:'Distinct headline',reasoning:'Original investigative rationale'};
 assert.throws(()=>workflow.assertCurrent({...pitch,reasoning:'Different rationale'},workflow.fingerprint(pitch)),e=>e.status===409);
});
