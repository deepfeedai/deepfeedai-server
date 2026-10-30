'use strict';
// Disposable browser fixture. startFixture enforces offline providers and its database guard.
const { startFixture } = require('./fixture');
(async () => {
  const f = await startFixture({ port: Number(process.env.PORT) || 4180 });
  f.app.use('/api/pitches', require('../../routes/pitches'));
  const p = f.db.getPool();
  for (const [status, type] of [['draft','original'],['draft','deep-dive'],['review','original'],['scheduled','original'],['published','original']]) {
    await p.query("INSERT INTO articles(tenant_id,title,slug,summary,content_type,status,is_published,publish_at) VALUES(1,$1,$2,'Offline editorial evidence',$3,$4,$5,CASE WHEN $4='scheduled' THEN NOW()+INTERVAL '1 day' ELSE NULL END)", ['Navigation '+status+' '+type,'navigation-'+status+'-'+type,type,status,status==='published'?1:0]);
  }
  await p.query("INSERT INTO sources(tenant_id,name,url,is_active,last_fetch_error) VALUES(1,'Example research feed','https://example.invalid/research.xml',0,'Offline fixture fetch failure')");
  await p.query("INSERT INTO article_pitches(tenant_id,topic,angle_summary,status,is_editor_assignment) VALUES(1,'Reliable evidence','Compare independent sources before drafting','needs_sources',true)");
  await p.query("INSERT INTO story_pitches(tenant_id,writer_id,pitch_type,headline,reasoning,status) VALUES(1,$1,'original','A source-backed writer pitch','Offline editorial fixture','pending')", [f.writerId]);
  const login = (token, page) => '<script>localStorage.setItem("dfa_admin_url",location.origin);localStorage.setItem("dfa_site_url",location.origin);localStorage.setItem("deepfeedai_token",'+JSON.stringify(token)+');location.href='+JSON.stringify(page)+';</script>';
  f.app.get('/__fixture/navigation-login', (req,res) => res.type('html').send(login(f.token,'/overview.html')));
  const viewer = (await p.query("INSERT INTO users(username,password_hash,tenant_id,role,email,is_active) VALUES('navigation-reader','offline-only',1,'viewer','navigation-reader@example.invalid',1) RETURNING id")).rows[0];
  const viewerToken = require('jsonwebtoken').sign({sub:viewer.id,tenantId:1,type:'platform-admin',role:'viewer',permissions:['articles.read']},'offline-acceptance-jwt-not-a-production-credential',{expiresIn:'1h'});
  f.app.get('/__fixture/viewer-login', (req,res) => res.type('html').send(login(viewerToken,'/overview.html')));
  console.log('Offline navigation browser fixture ready; no live content or provider calls.');
})().catch(e => { console.error(e.message); process.exit(1); });
