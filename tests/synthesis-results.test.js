const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classifyError,summarize,render}=require('../public/synthesis-results');

test('storage/provider errors expose actionable categories without raw secrets',()=>{
  assert.equal(classifyError({code:'42703',message:'secret'}).code,'storage');
  const result=classifyError(new Error('OpenAI API error 401: Bearer sk-test-private-value <script>'));
  assert.equal(result.code,'provider');assert.doesNotMatch(result.message,/Bearer|sk-test|script/);
  assert.equal(classifyError(new Error('unknown secret')).code,'failed');
});
test('mixed success and failure retains generated count and per-cluster reason',()=>{
  const result=summarize([{writerId:4,generated:1,errorDetails:[{clusterIndex:1,code:'storage'}]}],2);
  assert.equal(result.generated,1);assert.equal(result.hasIssues,true);
  assert.match(result.details[0],/Writer 4: Cluster 2: Article storage/);
  assert.match(result.title,/Generated 1.*2 selected/);
});
test('cooldown, budget, dedup and watchlist skips remain visible',()=>{
  const result=summarize([
    {skipped:'Cooldown: last synthesis 2h ago (use ?force=true to override)'},
    {skipped:'Writer budget reached (2/2 today)'},
    {skippedDedup:2,skippedBlocked:1}
  ],4);
  assert.equal(result.details.length,4);assert.match(result.details.join(' '),/cooldown.*budget.*duplicates.*watchlist/);
});
test('unknown/old-backend errors and hostile fields cannot expose raw payloads',()=>{
  const payload='<img src=x onerror=alert(1)> Bearer sk-test-private-value';
  const result=summarize([{writerId:payload,error:payload,errors:[payload],skipped:payload,errorDetails:[{clusterIndex:payload,code:payload,message:payload}]}],1);
  assert.doesNotMatch(JSON.stringify(result),/onerror|Bearer|sk-test|<img/);
});
test('a budget exhausted mid-run reports skipped work alongside successful articles',()=>{
  const result=summarize([{generated:1,skippedBudget:2}],3);
  assert.equal(result.generated,1);assert.match(result.details[0],/2 cluster.*budget/);
  assert.equal(result.hasIssues,true);
});
test('render uses text nodes and shows persistent mixed-result detail',()=>{
  class Element {
    constructor(doc){this.ownerDocument=doc;this.children=[];this.hidden=true;this.text='';}
    set textContent(value){this.text=value;}
    set innerHTML(value){throw new Error('Unsafe HTML rendering');}
    replaceChildren(){this.children=[];}
    appendChild(child){this.children.push(child);}
  }
  const doc={createElement:()=>new Element(doc)};const el=new Element(doc);
  const summary=summarize([{generated:1,errors:['secret']}],2);render(el,summary);
  assert.equal(el.hidden,false);assert.equal(el.children[0].text,summary.title);
  assert.equal(el.children[1].children[0].text,summary.details[0]);
});
