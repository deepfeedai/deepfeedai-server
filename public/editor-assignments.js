(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const can=p=>typeof hasPermission!=='function'||hasPermission(p);
 const safeUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
 let records=[],writers=[],version=0;const busy=new Set();
 const host=()=>document.getElementById('editorAssignments');
 function action(name,label,attrs=''){return '<button type="button" class="btn '+(['writer','approve','generate'].includes(name)?'btn-primary':'btn-outline')+' btn-sm" data-assignment-action="'+name+'" '+attrs+'>'+label+'</button>';}
 function render(){
  host().innerHTML='<h3>Editor assignments</h3><p class="text-muted">Attach supporting evidence to a research brief, approve the assignment, then explicitly generate a paid draft for human review.</p>'+records.map(p=>{
   const attached=Array.isArray(p.attached_sources)?p.attached_sources:[],state=p.display_status||p.status;
   const editable=['needs_sources','proposed','approved','failed'].includes(state)&&!p.spawned_article_id;
   const update=editable&&can('articles.update'),writerEdit=update&&can('writers.read');
   const min=Number(p.requirements?.minimum),max=Number(p.requirements?.maximum);
   const requirements=Number.isSafeInteger(min)&&Number.isSafeInteger(max)?'Requires '+min+' supporting sources; maximum '+max+'.':'Source requirements unavailable; refresh before approval.';
   const cards=attached.map(source=>{
    const url=safeUrl(source.url),date=new Date(source.created_at),valid=source.created_at&&Number.isFinite(date.getTime());
    return '<li class="assignment-source-card"><div><strong>'+esc(source.title||'Source unavailable')+'</strong><p class="text-muted">'+esc(source.publisher||'Publisher unavailable')+(valid?' &middot; '+esc(date.toLocaleDateString()):'')+'</p>'+(source.unavailable||source.eligible===false?'<p role="status">This source is unavailable or no longer eligible. Remove it and choose supporting evidence.</p>':'')+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Preview source (opens new tab)</a>':'<span class="text-muted">Preview unavailable</span>')+'</div>'+(update?action('remove-source','Remove','data-source-id="'+Number(source.id)+'" aria-label="Remove '+esc(source.title||'unavailable source')+'"'):'')+'</li>';
   }).join('');
   return '<div class="review-card assignment-card" data-assignment="'+p.id+'"><h4>'+esc(p.topic||p.angle_summary)+'</h4><p><a class="btn btn-outline btn-sm" href="/newsroom-workflow.html?kind=assignment&id='+Number(p.id)+'">Open commission workspace</a></p><p>'+esc(p.angle_summary)+'</p><p><strong>'+esc(state.replaceAll('_',' '))+'</strong> &middot; '+attached.length+' attached sources &middot; '+esc(p.writer_name||'Needs writer')+'</p>'+(p.draft_error?'<p role="alert">'+esc(p.draft_error)+'</p>':'')+(p.spawned_article_id?'<div class="assignment-actions"><a class="btn btn-outline" href="/article-editor.html?id='+Number(p.spawned_article_id)+'">Open draft / review</a></div>':'')+'<section aria-label="Attached supporting sources"><p>'+esc(requirements)+'</p><ul class="assignment-source-cards">'+(cards||'<li class="text-muted">No sources attached yet.</li>')+'</ul>'+(update?'<div class="assignment-actions" role="group" aria-label="Source actions">'+action('add-sources','Add sources','aria-haspopup="dialog"')+'</div>':'')+'</section>'+(writerEdit?'<details class="assignment-edit"><summary>Writer details</summary><p class="text-muted">Save or cancel writer changes before adding or removing sources.</p><div class="assignment-fields"><label>Writer<select class="form-control assignment-writer"><option value="">Select writer</option>'+writers.map(w=>'<option value="'+w.id+'" '+(p.pitched_by_writer_id===w.id?'selected':'')+'>'+esc(w.name)+'</option>').join('')+'</select></label></div><div class="assignment-actions" role="group" aria-label="Writer editing actions">'+action('writer','Save writer')+' '+action('cancel','Cancel')+'</div></details>':'')+'<div class="assignment-actions assignment-workflow-actions" role="group" aria-label="Assignment workflow actions">'+(state==='proposed'&&can('articles.update')?action('approve','Approve assignment (no generation)'):'')+(['approved','failed'].includes(state)&&can('articles.create')?action('generate',state==='failed'?'Retry draft (paid)':'Generate draft (paid)'):'')+(state==='drafting'?'<p>Drafting. Keep this page open for status. Do not submit another paid request.</p>'+(can('articles.create')?action('recover','Check interrupted draft / retry'):''):'')+'</div></div>';
  }).join('')+(records.length?'':'<p>No editor assignments yet.</p>');
 }
 async function load(){
  if(!host()||host().querySelector('details[open]'))return;
  const request=++version;
  try{
   const [data,agents]=await Promise.all([apiFetch('/editor-assignments'),can('writers.read')?apiFetch('/admin/writers'):Promise.resolve([])]);
   if(request!==version||host().querySelector('details[open]'))return;
   records=data.assignments||[];writers=(Array.isArray(agents)?agents:[]).filter(w=>w.role==='writer');render();
  }catch(e){if(request===version&&!host().querySelector('details[open]'))host().innerHTML='<p role="alert">Could not load editor assignments. Retry to check their current state.</p><button type="button" data-assignment-action="reload">Retry loading</button>';}
 }
 document.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-assignment-action]');if(!btn)return;
  const actionName=btn.dataset.assignmentAction;if(actionName==='reload'){await load();return;}
  const card=btn.closest('[data-assignment]');if(!card)return;
  const id=Number(card.dataset.assignment),p=records.find(p=>p.id===id);if(!p||busy.has(id))return;
  const details=card.querySelector('details');
  if(actionName==='cancel'){const select=card.querySelector('.assignment-writer');if(select)select.value=String(p.pitched_by_writer_id||'');if(details)details.open=false;await load();return;}
  if(['add-sources','remove-source','approve','generate','recover'].includes(actionName)&&host().querySelector('details[open]')){showAlert('Save or cancel writer changes before changing sources or assignment state.','info');return;}
  const permission=['generate','recover'].includes(actionName)?'articles.create':'articles.update';
  if(!can(permission)||(actionName==='writer'&&!can('writers.read')))return;
  if(actionName==='add-sources'){
   if(!window.CommissionSourcePicker?.open){showAlert('Source picker is unavailable. Refresh the page and try again.','error');return;}
   window.CommissionSourcePicker.open({assignmentId:id,api:apiFetch,onAdded:()=>load(),returnFocus:btn});return;
  }
  if(actionName==='remove-source'&&!confirm('Remove this source from the assignment? The original article and citations elsewhere are preserved.'))return;
  if(['generate','recover'].includes(actionName)&&!confirm('Generate one draft using your configured AI provider? This can incur charges. '+(actionName==='recover'||p.status==='failed'?'Check saved drafts and provider usage first; an interrupted request may already have been charged.':'')))return;
  busy.add(id);++version;
  const originalLabel=btn.textContent;
  const controls=Array.from(card.querySelectorAll?card.querySelectorAll('button, select'):[btn]).map(control=>[control,!!control.disabled]);
  controls.forEach(([control])=>{control.disabled=true;});
  card.setAttribute?.('aria-busy','true');
  btn.textContent=actionName==='writer'?'Saving...':actionName==='remove-source'?'Removing...':actionName==='approve'?'Approving...':'Starting draft...';
  try{
   let url='/editor-assignments/'+id+'/'+actionName,method='POST',body={};
   if(actionName==='writer'){method='PUT';body={writer_id:Number(card.querySelector('.assignment-writer').value)||null};}
   else if(actionName==='remove-source'){method='DELETE';url='/editor-assignments/'+id+'/sources/'+Number(btn.dataset.sourceId);}
   else if(actionName==='generate'||actionName==='recover'){url='/editor-assignments/'+id+'/generate';body={confirmPaid:true,retryAcknowledged:p.status==='failed'||actionName==='recover'};}
   else if(actionName!=='approve')return;
   await apiFetch(url,{method,body:JSON.stringify(body)});if(details)details.open=false;await load();
  }catch(err){showAlert(err.message,'error');}finally{busy.delete(id);controls.forEach(([control,wasDisabled])=>{control.disabled=wasDisabled;});btn.textContent=originalLabel;card.removeAttribute?.('aria-busy');}
 });
 window.loadEditorAssignments=load;load();setInterval(()=>{if(host()?.offsetParent!==null&&records.some(p=>p.status==='drafting'))load()},5000);
})();
