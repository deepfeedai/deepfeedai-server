'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {captureContributor,contributorsFor}=require('../lib/edition-contributors');
const clean=v=>String(v||'');
const writer={profile_id:10,writer_name:'Avery',writer_bio:'Configured biography',writer_role:'writer',writer_beat:'Research',writer_has_prompt:true,is_auto:false};
test('only positively configured personas receive AI label; free authors and scheduling do not establish identity',()=>{
 assert.equal(captureContributor({author:'Human author'},clean,{}),null);
 assert.equal(captureContributor({...writer,profile_id:null},clean,{}),null);
 assert.equal(captureContributor(writer,clean,{}).kind,'ai_persona');
 const c=captureContributor({...writer,writer_has_prompt:false,is_auto:true,system_prompt:'must never copy',private_key:'secret'},clean,{});
 assert.equal(c.kind,'unclassified');assert.equal(c.contribution,'Assigned writer for this article');assert.equal(c.system_prompt,undefined);assert.equal(c.private_key,undefined);
 assert.ok(!/generated|reviewed|verified/i.test(c.contribution));
});
test('bounded public profile snapshot and portrait version identity are deterministic',()=>{
 const a=captureContributor(writer,clean,{image_data:Buffer.from('a')});
 assert.deepEqual(a,captureContributor(writer,clean,{image_data:Buffer.from('a')}));
 assert.notEqual(a.profile_version,captureContributor(writer,clean,{image_data:Buffer.from('b')}).profile_version);
 assert.notEqual(a.profile_version,captureContributor({...writer,writer_bio:'Changed'},clean,{image_data:Buffer.from('a')}).profile_version);
 assert.equal(captureContributor({...writer,writer_bio:'x'.repeat(4000)},clean,{}).bio.length,3000);
});
test('contributors deduplicate stable IDs, retain capture differences, and never combine names alone',()=>{
 const a=captureContributor(writer,clean,{}),b=captureContributor({...writer,writer_bio:'New profile'},clean,{}),c=captureContributor({...writer,profile_id:11},clean,{});
 const result=contributorsFor([{article_id:1,contributor:a},{article_id:2,contributor:a},{article_id:3,contributor:b},{article_id:4,contributor:c},{article_id:5}]);
 assert.equal(result.length,2);assert.equal(result[0].article_count,3);assert.equal(result[0].profile_versions_differ,true);assert.deepEqual(result[0].versions.map(v=>v.article_ids),[[1,2],[3]]);assert.equal(result[1].article_count,1);
});
