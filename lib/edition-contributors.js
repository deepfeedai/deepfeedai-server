'use strict';
const crypto=require('node:crypto');

// Only fields deliberately projected by sourceRows may enter an edition.
function captureContributor(article,clean,portrait) {
  if(!Number.isSafeInteger(article.profile_id)||!article.writer_name)return null;
  const value={writer_id:article.profile_id,name:clean(article.writer_name).slice(0,200),
    kind:article.writer_has_prompt===true?'ai_persona':'unclassified',
    role:clean(article.writer_role).slice(0,120),focus:clean(article.writer_beat).slice(0,500),
    bio:clean(article.writer_bio).slice(0,3000),
    contribution:'Assigned writer for this article',
    portrait_notice:portrait.image_notice||null};
  // Include portrait bytes in version identity: same name does not imply same capture.
  value.profile_version=crypto.createHash('sha256').update(JSON.stringify(value)).update(portrait.image_data||Buffer.alloc(0)).digest('hex');
  return value;
}

function contributorsFor(articles) {
  const byWriter=new Map();
  for(const article of articles){
    const c=article.contributor;if(!c?.writer_id)continue;
    let writer=byWriter.get(c.writer_id);
    if(!writer){writer={writer_id:c.writer_id,article_ids:[],versions:[]};byWriter.set(c.writer_id,writer);}
    writer.article_ids.push(article.article_id);
    let version=writer.versions.find(v=>v.profile_version===c.profile_version);
    if(!version){version={...c,portrait_path:article.portrait_path,article_ids:[]};writer.versions.push(version);}
    version.article_ids.push(article.article_id);
  }
  return [...byWriter.values()].map(w=>({...w,article_count:w.article_ids.length,profile_versions_differ:w.versions.length>1}));
}
module.exports={captureContributor,contributorsFor};
