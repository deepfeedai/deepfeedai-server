const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../public/newsroom-workflow-page');
const ui=create({},()=>{},{});
test('newsroom destinations reject foreign, script and credential URLs',()=>{
 assert.equal(ui.safeHref('/article-editor.html?id=12'),'/article-editor.html?id=12');
 for(const value of ['javascript:alert(1)','//evil.test/article-editor.html','https://evil.test/x.html','/api/articles/1','/\\evil.test/x.html','/x.html\n'])assert.equal(ui.safeHref(value),null,value);
 assert.equal(ui.safeHref('https://publisher.test/report',true),'https://publisher.test/report');
 assert.equal(ui.safeHref('https://user:secret@publisher.test/report',true),null);
});
test('newsroom action execution only accepts bounded existing transition routes',()=>{
 assert.equal(ui.endpoint({method:'POST',endpoint:'/api/editor-assignments/12/generate'}),'/editor-assignments/12/generate');
 assert.equal(ui.endpoint({method:'POST',endpoint:'/newsroom-workflow/pitch/4/commission'}),'/newsroom-workflow/pitch/4/commission');
 for(const action of [{method:'GET',endpoint:'/editor-assignments/1/generate'},{method:'POST',endpoint:'https://evil.test/editor-assignments/1/generate'},{method:'POST',endpoint:'/newsletter/send'},{method:'POST',endpoint:'/articles/1/publish'},{method:'POST',endpoint:'/editor-assignments/0/generate'}])assert.equal(ui.endpoint(action),null);
});
