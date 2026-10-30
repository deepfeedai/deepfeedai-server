(function(){
 'use strict';
 onReady(function(){
  const host=document.getElementById('editorSidebar');if(!host)return;
  const section=document.createElement('section');section.className='editor-sidebar-section';
  const heading=document.createElement('h3');heading.textContent='Saved publication state';
  const state=document.createElement('p');state.setAttribute('aria-live','polite');
  const button=document.createElement('button');button.type='button';button.className='btn btn-outline btn-sm';button.textContent='Refresh saved state';
  const history=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Publication and correction history';history.append(summary);
  const list=document.createElement('ol');history.append(list);section.append(heading,state,button,history);host.prepend(section);
  let busy=false;
  async function refresh(){
   if(busy)return;const id=new URLSearchParams(location.search).get('id');if(!id){state.textContent='Save this draft before publishing.';return;}
   busy=true;button.disabled=true;
   try{
    const [article,audit]=await Promise.all([apiFetch('/articles/'+id),apiFetch('/articles/'+id+'/history')]);
    const optional={skipped:'Optional automation skipped (disabled).',pending:'Optional work pending; completion is not confirmed.',dispatched:'Optional work dispatched; individual jobs may still be running.',failed:'Optional work failed. The article remains published.',not_requested:'No optional publication work requested.'};
    state.textContent=(article.is_published?'Published':article.status||'Draft')+' · revision '+article.publication_revision+'. '+(optional[article.post_publish_status]||'')+' Refreshing this status does not replace unsaved edits.';
    list.replaceChildren();for(const entry of audit.history){const item=document.createElement('li');item.textContent='Revision '+entry.revision+' · '+entry.action+' · '+new Date(entry.created_at).toLocaleString();list.append(item);}
   }catch{state.textContent='Could not confirm saved publication state. Your edits remain unchanged. Retry before repeating an action.';}
   finally{busy=false;button.disabled=false;}
  }
  button.addEventListener('click',refresh);refresh();
 });
})();
