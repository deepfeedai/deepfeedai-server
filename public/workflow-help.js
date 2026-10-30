(function () {
  'use strict';
  function node(tag, text, cls) { const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n; }
  function boot() {
    const nav=window.WorkflowNav;if(!nav)return;
    const item=nav.resolve(location.pathname+location.search);if(!item||!nav.allowed(item))return;
    const custom=document.querySelector('.nr-topbar-right');
    const host=document.querySelector('.page-body, .page-content, .main-content, .settings-main')||custom;if(!host||document.getElementById('workflowPurpose'))return;
    if(!document.getElementById('workflowStyles')) {const css=document.createElement('link');css.id='workflowStyles';css.rel='stylesheet';css.href='/workflow-navigation.css';document.head.appendChild(css);}
    const wrap=node('section',null,'workflow-purpose');wrap.id='workflowPurpose';wrap.setAttribute('aria-label','Page guidance');
    const copy=node('div',null,'workflow-purpose-copy');copy.append(node('span',item.group,'workflow-eyebrow'),node('p',item.purpose));wrap.append(copy);
    const actions=node('div',null,'workflow-guidance-actions');const help=node('button','Help with this page','btn btn-outline');help.type='button';help.id='workflowHelpButton';help.setAttribute('aria-expanded','false');help.setAttribute('aria-controls','workflowHelpPanel');actions.append(help);
    const candidates=nav.groups().find(g=>g.label===item.group)?.items||[];
    const next=candidates.find(p=>p.href!==item.href&&!p.secondary);
    if(next) {const a=node('a',next.label,'workflow-context-link');a.href=next.href;actions.append(a);}
    wrap.append(actions);
    if(custom&&host===custom){wrap.classList.add('workflow-custom-purpose');copy.hidden=true;const overview=node('a','Overview','workflow-context-link');overview.href='/overview.html';actions.prepend(overview);}
    // Keep page's existing topbar and all actual create/publish controls intact.
    const bar=host.querySelector(':scope > .topbar');if(bar)bar.after(wrap);else host.prepend(wrap);
    const panel=node('section',null,'workflow-help');panel.id='workflowHelpPanel';panel.hidden=true;panel.setAttribute('aria-labelledby','workflowHelpTitle');
    const title=node('h2','Help: '+item.label);title.id='workflowHelpTitle';panel.append(title,node('p',item.purpose));
    const caution=item.caution||nav.resolve(location.pathname)?.caution;
    if(caution)panel.append(node('p',caution,'workflow-caution'));
    panel.append(node('p','These links only navigate. They do not generate, approve, publish, delete, send messages, or retry jobs. Your available actions still depend on permissions and enabled features.'));
    const list=node('ul');candidates.filter(p=>p.href!==item.href).forEach(p=>{const li=node('li');const a=node('a',p.label);a.href=p.href;li.append(a,node('span',' — '+p.purpose));list.append(li);});panel.append(list);
    const intro=node('a','Getting started checklist');intro.href='/overview.html?onboarding=show';panel.append(intro);
    const close=node('button','Close help','btn btn-outline');close.type='button';panel.append(close);if(custom&&host===custom){panel.classList.add('workflow-custom-help');document.body.append(panel);}else wrap.after(panel);
    function set(open){panel.hidden=!open;help.setAttribute('aria-expanded',String(open));if(open){title.tabIndex=-1;title.focus();}else help.focus();}
    help.addEventListener('click',()=>set(panel.hidden));close.addEventListener('click',()=>set(false));panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();set(false);}});
  }
  window.addEventListener('workflow:navigate',function(){
    const panel=document.getElementById('workflowHelpPanel'),wrap=document.getElementById('workflowPurpose');
    const open=panel&&!panel.hidden;const focusOwned=!!(panel?.contains(document.activeElement)||wrap?.contains(document.activeElement));
    panel?.remove();wrap?.remove();boot();
    const replacement=document.getElementById('workflowHelpPanel'),button=document.getElementById('workflowHelpButton');
    if(open&&replacement){replacement.hidden=false;button?.setAttribute('aria-expanded','true');}
    if(focusOwned)button?.focus();
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
