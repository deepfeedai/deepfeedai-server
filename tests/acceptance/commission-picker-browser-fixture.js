'use strict';
// Only the guarded disposable acceptance database; no production credentials or AI.
(async()=>{
 const f=await require('./fixture').startFixture({port:Number(process.env.PORT)||4180});
 f.app.use('/api/pitches',require('../../routes/pitches'));
 const p=f.db.getPool(),ids=[];
 for(let i=0;i<32;i++)ids.push((await p.query("INSERT INTO articles(tenant_id,title,source,summary,content_type,topic_tag,created_at,source_url) VALUES(1,$1,$2,$3,'curated',$4,NOW()-($5::int*INTERVAL '1 day'),$6) RETURNING id",['Evidence '+String(i).padStart(2,'0')+' on software security',i%2?'Research Journal':'Security Bulletin','Supporting summary '+i+' about verified security findings.',i%2?'Research':'Security',i%12,'https://example.invalid/evidence/'+i])).rows[0].id);
 const assignments=require('../../lib/editor-assignments');
 await assignments.create({topic:'Source picker browser review',angle_summary:'Compare evidence without generating a draft',request_key:'picker-browser-fixture-first',writer_id:f.writerId,source_article_ids:ids.slice(0,2)},1,f.userId);
 await assignments.create({topic:'Research brief needing evidence',angle_summary:'Choose sources before approval',request_key:'picker-browser-fixture-second',writer_id:f.writerId,source_article_ids:[]},1,f.userId);
 f.app.get('/__fixture/picker-login',(req,res)=>res.type('html').send('<script>localStorage.setItem("dfa_admin_url",location.origin);localStorage.setItem("dfa_site_url",location.origin);localStorage.setItem("deepfeedai_token",'+JSON.stringify(f.token)+');location.href="/pitches.html?tab=commissions";</script>'));
 console.log('Offline commission picker fixture ready.');
})().catch(e=>{console.error(e.message);process.exit(1)});
