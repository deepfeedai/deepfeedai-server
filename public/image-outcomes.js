(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ImageOutcomes=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function summarize(results) {
    const generated=results.filter(r=>r.status==='ready').length;
    const skipped=results.filter(r=>r.status==='skipped').length;
    const failed=results.length-generated-skipped;
    const failures=results.filter(r=>r.status!=='ready').map(r=>Number.isSafeInteger(r.id)?'Article '+r.id:Number.isSafeInteger(r.position)?'Position '+(r.position+1):'Image');
    return {generated,failed,skipped,hasIssues:failed+skipped>0,text:`Images: ${generated} generated, ${failed} failed, ${skipped} skipped.`+(failures.length?' Check image settings and provider access for '+failures.join(', ')+'. Previous images were retained.':'')};
  }
  return {summarize};
});
