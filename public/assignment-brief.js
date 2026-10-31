(function () {
 'use strict';
 // Preserve the separate deployed button module while adding interrupted-attempt acknowledgement.
 const originalFetch=window.apiFetch;
 window.apiFetch=async function(url,options){
  if(/^\/editor-assignments\/\d+\/generate$/.test(url)&&options?.body){
   const body=JSON.parse(options.body);
   if(body.confirmPaid===true&&!body.retryAcknowledged){
    const state=await originalFetch(url.replace(/\/generate$/,''));
    if(state.draft_attempt>0){
     if(!confirm('A previous attempt may already have incurred a charge. Check provider usage and saved drafts before retrying. Continue with another paid attempt?'))throw Error('Retry cancelled. No generation request was sent.');
     options={...options,body:JSON.stringify({...body,retryAcknowledged:true})};
    }
   }
  }
  return originalFetch(url,options);
 };
 onReady(async function () {
  const host=document.getElementById('editorAssignments');if(!host)return;
  const panel=document.createElement('details');panel.className='review-card';panel.id='assignmentBrief';
  panel.innerHTML='<summary>New editor assignment</summary><form><p>Save a research brief without calling AI. Add sources and approve it before choosing paid draft generation.</p><label>Topic<input class="form-control" name="topic" required maxlength="200"></label><label>Angle<textarea class="form-control" name="angle" required maxlength="2000"></textarea></label><label>Category<select class="form-control" name="category" required><option value="">Select category</option></select></label><label>Writer<select class="form-control" name="writer" required><option value="">Select writer</option></select></label><div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px"><button class="btn btn-primary" type="submit">Save brief (no generation)</button><button class="btn btn-outline" type="button" data-cancel>Cancel</button></div><p role="status" aria-live="polite"></p></form>';
  host.before(panel);
  const form=panel.querySelector('form'),status=panel.querySelector('[role=status]'),save=form.querySelector('[type=submit]');
  let key=crypto.randomUUID(),busy=false;
  const rawSources=new URLSearchParams(location.search).get('source_ids')||'';
  const parsedSources=rawSources.split(',').map(Number);
  const sourceSelectionValid=!rawSources||(/^[1-9]\d*(,[1-9]\d*){0,19}$/.test(rawSources)&&parsedSources.every(Number.isSafeInteger));
  const sourceIds=sourceSelectionValid&&rawSources?[...new Set(parsedSources)]:[];
  if(sourceIds.length){panel.open=true;status.textContent=sourceIds.length+' selected source(s) will be attached after server validation. Saving does not generate a draft.';}
  else if(rawSources){status.textContent='Source selection is invalid. Return to Reader and select sources again.';save.disabled=true;}
  try {
   const [categories,writers]=await Promise.all([apiFetch('/categories'),apiFetch('/admin/writers')]);
   for(const category of categories){const option=new Option(category.name,category.name);form.elements.category.add(option);}
   for(const writer of writers.filter(w=>w.role==='writer'))form.elements.writer.add(new Option(writer.name,writer.id));
  }catch{status.textContent='Could not load categories and writers. Reload before creating an assignment.';save.disabled=true;}
  form.querySelector('[data-cancel]').addEventListener('click',()=>{if(busy)return;form.reset();panel.open=false;status.textContent='';key=crypto.randomUUID();});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy||!sourceSelectionValid||!form.reportValidity())return;busy=true;save.disabled=true;status.textContent='Saving brief…';
   try {
    const saved=await apiFetch('/editor-assignments',{method:'POST',body:JSON.stringify({topic:form.elements.topic.value,angle_summary:form.elements.angle.value,category:form.elements.category.value,writer_id:Number(form.elements.writer.value),source_article_ids:sourceIds,request_key:key})});
    form.reset();key=crypto.randomUUID();status.textContent='Brief saved. No AI generation was requested. ';const next=document.createElement('a');next.className='btn btn-outline btn-sm';next.textContent='Open saved commission';next.href=Number.isSafeInteger(Number(saved.id))&&Number(saved.id)>0?'/newsroom-workflow.html?kind=assignment&id='+Number(saved.id):'/newsroom-workflow.html?stage=commission';status.append(next);await window.loadEditorAssignments?.();
   }catch(error){status.textContent='Save was not confirmed. Your brief remains here. Retry uses the same request ID to avoid duplicates. '+error.message;}
   finally{busy=false;save.disabled=false;}
  });
 });
})();
