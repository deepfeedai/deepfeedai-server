'use strict';
// Disposable UI fixture only; startFixture enforces the isolated database name.
const {startFixture}=require('./fixture');
(async()=>{
 const f=await startFixture({port:Number(process.env.PORT)||4180});
 const sourceIds=[];
 for(const [name,folder]of [['Research Journal','AI/Research'],['Security Dispatch','Security'],['Engineering Notes','Technology']]){
  const row=await f.db.prepare("INSERT INTO sources(tenant_id,name,url,is_active,folder_path,default_category) VALUES(1,$1,$2,0,$3,'Research') RETURNING id").get(name,'https://example.invalid/'+encodeURIComponent(name)+'/rss?token=fixture-only',folder);sourceIds.push(row.id);
 }
 const folder=await f.db.prepare("INSERT INTO feed_groups(tenant_id,name,color) VALUES(1,'Reading list','#22b8a0') RETURNING id").get();
 const titles=['What a smaller model teaches us about evaluation','A practical guide to tracing software supply chains','New evidence changes the conversation about agent reliability','Researchers compare efficient inference methods','Inside the engineering of trustworthy AI systems','Why source diversity matters in technology reporting'];
 for(let i=0;i<64;i++)await f.db.prepare("INSERT INTO articles(tenant_id,title,summary,full_content,category,source,source_id,source_url,content_type,is_published,group_id,topic_tag,published_at) VALUES(1,$1,$2,$3,'Research',$4,$5,$6,'curated',0,$7,$8,NOW()-($9::text||' hours')::interval)").run(
  titles[i%titles.length]+' — '+(i+1),'A carefully sourced report with practical findings, open questions and ideas for the next editorial assignment.',
  'The research starts with a simple question: how can teams distinguish a promising demonstration from reliable evidence?\n\nThe authors compare several approaches, explain their limitations and publish enough detail for others to reproduce their work. Independent reporting adds useful context rather than repeating the same headline.\n\nFor editors, the next step is to compare the original evidence with other publications, collect sources and choose a clear angle before drafting.',
  ['Research Journal','Security Dispatch','Engineering Notes'][i%3],sourceIds[i%3],'https://example.invalid/article/'+i,i%2===0?folder.id:null,i<6?'reliable-ai-evidence':null,i);
 f.app.get('/__fixture/reader-login',(req,res)=>res.type('html').send('<script>localStorage.setItem("dfa_admin_url",location.origin);localStorage.setItem("dfa_site_url",location.origin);localStorage.setItem("deepfeedai_token",'+JSON.stringify(f.token)+');localStorage.setItem("deepfeedai_user",JSON.stringify({role:"owner",permissions:["*"]}));location.href="/feed-inbox.html";</script>'));
 console.log('Disposable Reader browser fixture ready; RSS sources paused and providers stubbed.');
})().catch(e=>{console.error(e.message);process.exit(1)});
