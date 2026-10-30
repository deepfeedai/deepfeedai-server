(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ImageUpdates=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const pending=new Map(),uncertain=new Set();
 function busy(key){return pending.has(key)||uncertain.has(key);}
 function run(key,request,readChanged,options={}){
  if(pending.has(key))return pending.get(key);
  if(uncertain.has(key))return Promise.reject(Error('Previous image request is unresolved. Check the saved image and provider usage before retrying.'));
  const task=Promise.resolve().then(async()=>{try{return await request();}catch(error){
   if(!/fetch|network|timeout|timed out|502|503|504|backend unavailable/i.test(error.message||''))throw error;
   for(let i=0;i<(options.attempts??20);i++){await (options.wait||((ms)=>new Promise(r=>setTimeout(r,ms))))(3000);try{const result=await readChanged();if(result)return result;}catch{}}
   uncertain.add(key);throw Error('Image result is not confirmed. It may still finish and incur charges. Refresh to check the saved image and provider usage before retrying.');
  }finally{pending.delete(key);}});pending.set(key,task);return task;
 }
 return{run,busy};
});
