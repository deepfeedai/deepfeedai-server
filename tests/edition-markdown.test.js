'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {bodyMarkup}=require('../public/edition-print');
test('snapshot Markdown renders adjacent headings and formatted paragraphs',()=>{
 const html=bodyMarkup('# Headline\nIntro **bold** and *italic*, __strong__, _em_, ~~old~~ and `const x = 1`.\n## Next section\nSecond paragraph.');
 assert.equal(html,'<h3>Headline</h3><p>Intro <strong>bold</strong> and <em>italic</em>, <strong>strong</strong>, <em>em</em>, <del>old</del> and <code>const x = 1</code>.</p><h3>Next section</h3><p>Second paragraph.</p>');
 assert.equal(bodyMarkup('Heading\n=======\nBody\n\nOther\n-----\nMore'),'<h3>Heading</h3><p>Body</p><h3>Other</h3><p>More</p>');
});
test('nested emphasis and escaped Markdown preserve literal code and citation markers',()=>{
 const html=bodyMarkup('***both*** **bold *nested*** and *outer **strong** end*. snake_case_name \\*literal\\* `[1] **code**` [1][2] [named][ref].');
 assert.match(html,/<strong><em>both<\/em><\/strong>/);assert.match(html,/<strong>bold <em>nested<\/em><\/strong>/);assert.match(html,/<em>outer <strong>strong<\/strong> end<\/em>/);
 assert.match(html,/snake_case_name \*literal\*/);assert.match(html,/<code>\[1\] \*\*code\*\*<\/code>/);assert.match(html,/\[1\]\[2\] \[named\]\[ref\]/);
});
test('ordered, unordered and nested lists, quotes and fenced code have safe structure',()=>{
 const html=bodyMarkup('3. Third **item**\n4. Fourth\n  - Nested one\n  - Nested two\n\n> Quoted *text*\n> Next line\n\n```js\n<script>alert(1)</script>\n**literal**\n```');
 assert.match(html,/<ol start="3"><li>Third <strong>item<\/strong><\/li><li><p>Fourth<\/p><ul><li>Nested one<\/li><li>Nested two<\/li><\/ul><\/li><\/ol>/);
 assert.match(html,/<blockquote><p>Quoted <em>text<\/em>\nNext line<\/p><\/blockquote>/);
 assert.match(html,/<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;\n\*\*literal\*\*<\/code><\/pre>/);
});
test('only safe explicit HTTP(S) Markdown links become anchors',()=>{
 const html=bodyMarkup('[A **source**](https://example.test/report?q=a&b=c) [Nested](https://example.test/report_(2026)) [Title](https://example.test/ "Report")');
 assert.match(html,/<a href="https:\/\/example.test\/report\?q=a&amp;b=c" rel="noopener noreferrer">A <strong>source<\/strong><\/a>/);
 assert.match(html,/href="https:\/\/example.test\/report_\(2026\)"/);assert.match(html,/>Title<\/a>/);
 for(const target of ['javascript:alert(1)','data:text/html,<script>x</script>','file:///secret','//evil.test','https://user:password@example.test','https://example.test\\@evil.test','https://example.test/\npath','javascript&#58;alert(1)'])assert.doesNotMatch(bodyMarkup('[bad]('+target+')'),/<a\b/,target);
 assert.doesNotMatch(bodyMarkup('![remote image](https://example.test/image.png)'),/<img|<a\b/);
});
test('raw HTML, encoded markup, malformed syntax and unterminated fences never execute',()=>{
 const html=bodyMarkup('<img src=x onerror=alert(1)> &lt;script&gt; \n\n**unterminated [oops](javascript:evil)\n\n```\n</code><script>x</script>');
 assert.doesNotMatch(html,/<script|<img|onerror="|href="javascript/i);assert.match(html,/&lt;img/);assert.match(html,/&amp;lt;script/);assert.match(html,/\*\*unterminated/);assert.match(html,/<pre><code>&lt;\/code&gt;&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
});
test('CRLF Markdown matches LF and large malformed input stays literal and bounded',()=>{
 const text='## Section\n**Text**\n\n- First\n- Second';assert.equal(bodyMarkup(text.replace(/\n/g,'\r\n')),bodyMarkup(text));
 const malformed='['.repeat(20000);assert.equal(bodyMarkup(malformed),'<p>'+malformed+'</p>');assert.equal(bodyMarkup(malformed+']'),'<p>'+malformed+']</p>');assert.equal(bodyMarkup('## C# and F#'),'<h3>C# and F#</h3>');
});
test('saved source metadata renders matching per-article citations and visible printable URLs',()=>{
 const {paperMarkup}=require('../public/edition-print');
 const article=id=>({article_id:id,title:'Report',content:'Evidence [1][3]. Code `[1]`.',references:[{number:1,title:'Source <one>',publisher:'Publisher & Co',url:'https://example.test/report'},{number:3,title:'Source three',publisher:'Journal',url:'https://example.test/third'}]});
 const html=paperMarkup({name:'Issue',mode:'published',status:'finalized',articles:[article(10),article(20)]});
 for(const id of [10,20]) {assert.match(html,new RegExp('href="#edition-ref-'+id+'-1"'));assert.match(html,new RegExp('id="edition-ref-'+id+'-3"'));}
 assert.match(html,/Source &lt;one&gt;/);assert.match(html,/Publisher &amp; Co/);assert.match(html,/>https:\/\/example.test\/report<\/a>/);assert.match(html,/<code>\[1\]<\/code>/);
 assert.doesNotMatch(html,/unavailable/);
});
test('unknown and ambiguous references remain explicit rather than falsely linked or renumbered',()=>{
 const {paperMarkup}=require('../public/edition-print');
 const html=paperMarkup({articles:[{article_id:9,content:'Text [1][2][5].',references:[{number:1,title:null,url:null,warning:'Metadata missing'},{number:2,title:'Duplicate A'},{number:2,title:'Duplicate B'},{number:5,title:'Known source',url:'https://example.test/known'}],reference_warnings:['A historical mapping is missing.']}]});
 assert.doesNotMatch(html,/href="#edition-ref-9-[12]"/);assert.match(html,/href="#edition-ref-9-5"/);assert.match(html,/\[1\]\[2\]/);assert.match(html,/Source details unavailable for \[1\], \[2\]/);assert.match(html,/Ambiguous source number/);assert.match(html,/A historical mapping is missing/);
 const old=paperMarkup({articles:[{article_id:4,content:'Legacy text [1][2].'}]});assert.match(old,/Source details unavailable for \[1\], \[2\]/);assert.doesNotMatch(old,/class="edition-citation"/);
});
test('source footer rejects active, credentialed and token-bearing URLs without printing them',()=>{
 const {paperMarkup}=require('../public/edition-print');
 for(const url of ['javascript:alert(1)','data:text/html,secret','https://u:PRIVATE_SECRET@example.test','https://example.test/?access_token=PRIVATE_SECRET','https://example.test/?X-Amz-Signature=PRIVATE_SECRET','https://example.test/#token=PRIVATE_SECRET','https://example.test/?jwt=PRIVATE_SECRET','https://example.test/?auth=PRIVATE_SECRET','https://example.test/?access_key=PRIVATE_SECRET','https://example.test/#access_token%3DPRIVATE_SECRET']){
 const html=paperMarkup({articles:[{article_id:1,content:'Text [1].',references:[{number:1,title:'Safe title',url,publisher:'<img onerror=alert(1)>',warning:'<script>no</script>'}]}]});assert.doesNotMatch(html,/PRIVATE_SECRET|javascript:|<script|<img|class="edition-source-url"/);assert.match(html,/&lt;script&gt;no/);
 }
 assert.doesNotMatch(bodyMarkup('[token](https://example.test/?api_key=PRIVATE_SECRET)'),/<a\b/);
});
test('Markdown and source styles wrap code and URLs and keep section labels with following content',()=>{
 const fs=require('node:fs'),path=require('node:path'),css=fs.readFileSync(path.join(__dirname,'../public/edition-print.css'),'utf8');
 assert.match(css,/\.edition-body pre\s*\{[^}]*white-space: pre-wrap/);assert.match(css,/\.edition-source-url\s*\{[^}]*overflow-wrap: anywhere/);assert.match(css,/\.edition-category\s*\{[^}]*break-after: avoid/);
 const start=performance.now();const bracket='['.repeat(100000)+']';assert.equal(bodyMarkup(bracket),'<p>'+bracket+'</p>');assert.ok(bodyMarkup('*'.repeat(100000)+'x').endsWith('x</p>'));assert.ok(performance.now()-start<3000,'Malformed input must not hang the preview');
});
test('adversarial unmatched emphasis falls back literally without truncating text',()=>{const text='*a '.repeat(60000),start=performance.now();const html=bodyMarkup(text);assert.equal(html,'<p>'+text.trim()+'</p>');assert.ok(performance.now()-start<3000,'Repeated failed delimiters must remain bounded');});

test('safe source section fragments survive capture and rendering URL validation',()=>{
 const {paperMarkup}=require('../public/edition-print');const html=paperMarkup({mode:'published',status:'finalized',articles:[{article_id:1,content:'Text [1].',references:[{number:1,title:'Methods',url:'https://example.test/report#methods'}]}]});assert.match(html,/href="https:\/\/example.test\/report#methods"/);assert.match(html,/>https:\/\/example.test\/report#methods<\/a>/);
});