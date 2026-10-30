'use strict';
// Offline, disposable browser diagnosis. Never mounted in production.
const fs=require('node:fs'),path=require('node:path');
const publicRoot=path.resolve(__dirname,'../../public');
const instrumentation=`<script>
function samplePaint(phase){const main=document.querySelector('.page-body'),help=document.getElementById('workflowPurpose'),group=document.querySelector('.workflow-group');console.info('paint-check '+JSON.stringify({phase,at:Math.round(performance.now()),canvas:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor,help:!!help,contentY:main?.getBoundingClientRect().top,groupBackground:group?getComputedStyle(group).backgroundColor:null}));}
document.addEventListener('DOMContentLoaded',()=>{samplePaint('dom-ready');requestAnimationFrame(()=>samplePaint('first-frame'));setTimeout(()=>samplePaint('250ms'),250);setTimeout(()=>samplePaint('settled'),1500);});
</script>`;
(async()=>{
 const f=await require('./fixture').startFixture({port:Number(process.env.PORT)||4180,beforeStatic(app){
  app.get('/workflow-navigation.css',(req,res)=>setTimeout(()=>res.sendFile(path.join(publicRoot,'workflow-navigation.css')),1000));
  app.get(['/overview.html','/sources.html'],(req,res)=>res.type('html').send(fs.readFileSync(path.join(publicRoot,path.basename(req.path)),'utf8').replace(/<head>/i,'<head>'+instrumentation)));
 }});
 f.app.get('/__fixture/paint-login',(req,res)=>res.type('html').send('<script>localStorage.setItem("deepfeedai_token",'+JSON.stringify(f.token)+');localStorage.setItem("nr_skin",'+JSON.stringify(req.query.skin==='daylight'?'daylight':'ink')+');location.href="/overview.html";</script>'));
 console.log('Offline paint fixture ready; workflow CSS intentionally delayed one second.');
})().catch(e=>{console.error(e.message);process.exit(1)});
