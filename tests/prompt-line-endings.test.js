const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const loader=require('../lib/prompt-loader');

test('LF and CRLF prompts retain identical routing metadata and messages',()=>{
  const original=fs.readFileSync;
  try {
    const raw='---\noperation: synthesis\ntier: balanced\nmaxTokens: 4096\nversion: 2\n---\n## system\nWrite clearly.\n\n## user\nTopic: {{topic}}\n';
    const results=[];
    for(const ending of ['\n','\r\n']) {
      fs.readFileSync=(path,...args)=>String(path).endsWith('line-ending-fixture.md')?raw.replace(/\n/g,ending):original(path,...args);
      loader.clearPromptCache();
      results.push(loader.loadPrompt('line-ending-fixture').render({topic:'Offline test'}));
    }
    assert.deepEqual(results[0],results[1]);
    assert.equal(results[0].operation,'synthesis');assert.equal(results[0].maxTokens,4096);
    assert.deepEqual(results[0].messages.map(x=>x.role),['system','user']);
  } finally {fs.readFileSync=original;loader.clearPromptCache();}
});

test('actual synthesis prompts retain operation and token limits',()=>{
  assert.equal(loader.loadPrompt('synthesis').meta.operation,'synthesis');
  assert.equal(loader.loadPrompt('synthesis').meta.maxTokens,4096);
  assert.equal(loader.loadPrompt('synthesis-followup').meta.operation,'synthesis-followup');
  assert.equal(loader.loadPrompt('synthesis-followup').meta.maxTokens,3000);
});
