(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ReaderModel=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function safeUrl(value){if(typeof value!=='string'||/[\\\u0000-\u0020]/.test(value))return '';try{const url=new URL(value,'https://reader.invalid');if(!['http:','https:'].includes(url.protocol)||url.username||url.password||value.startsWith('//'))return '';return value.startsWith('/')?value:url.href;}catch{return '';}}
 function plain(value){return String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,'');}
 function query(filters,limit,offset){const params=new URLSearchParams();for(const[key,value]of Object.entries({...filters,limit,offset}))if(value!==''&&value!==null&&value!==undefined)params.set(key,String(value));return params.toString();}
 function createStore(api,changed=()=>{}){
  const s={filters:{view:'all',folder_id:'all',source_id:'',category:'',topic_tag:'',q:'',date:'',sort:'newest',duplicates:'hide'},limit:30,offset:0,total:0,items:[],facets:{folders:[],sources:[],categories:[],counts:{}},detail:null,selected:new Set(),allMatching:false,loading:false,detailLoading:false,busy:false,error:'',detailError:''};
  let listVersion=0,detailVersion=0;
  const emit=()=>changed(s);
  function clearSelection(){s.selected.clear();s.allMatching=false;emit();}
  function selectPage(checked){s.allMatching=false;for(const item of s.items)checked?s.selected.add(item.id):s.selected.delete(item.id);emit();}
  function select(id,checked){if(s.allMatching){s.allMatching=false;s.selected=new Set(s.items.map(i=>i.id));}checked?s.selected.add(id):s.selected.delete(id);emit();}
  function selectAll(){s.selected.clear();s.allMatching=true;emit();}
  function selection(){return s.allMatching?{scope:'all_matching',filters:{...s.filters},confirmAllMatching:true}:{scope:'selected',ids:[...s.selected]};}
  async function load(){const version=++listVersion;s.loading=true;s.error='';emit();try{
   const [data,facets]=await Promise.all([api('/reader/items?'+query(s.filters,s.limit,s.offset)),api('/reader/facets')]);
   if(version!==listVersion)return false;s.items=data.items||[];s.total=Number(data.total)||0;s.hasMore=!!data.hasMore;s.facets=facets;
   if(!s.items.length&&s.offset>0){s.offset=Math.max(0,Math.ceil(s.total/s.limit)-1)*s.limit;return await load();}
   return true;
  }catch(e){if(version===listVersion){s.error=e.message||'Could not load articles.';s.items=[];}return false;}finally{if(version===listVersion){s.loading=false;emit();}}}
  function filter(patch){Object.assign(s.filters,patch);s.offset=0;clearSelection();return load();}
  function page(direction){if(s.loading)return;s.offset=Math.max(0,s.offset+direction*s.limit);clearSelection();return load();}
  async function open(id){const version=++detailVersion;s.detailLoading=true;s.detailError='';s.detail=null;emit();try{const result=await api('/reader/items/'+id);if(version!==detailVersion)return false;s.detail=result.item||result;return true;}catch(e){if(version===detailVersion)s.detailError=e.message||'Could not open article.';return false;}finally{if(version===detailVersion){s.detailLoading=false;emit();}}}
  async function mutate(patch,target){if(s.busy)return false;const payload={...(target||selection()),...patch};if(payload.scope==='selected'&&!payload.ids.length)return false;s.busy=true;s.error='';emit();try{await api('/reader/state',{method:'PUT',body:JSON.stringify(payload)});
   const ids=payload.scope==='selected'?new Set(payload.ids):null;for(const item of s.items)if(!ids||ids.has(item.id))Object.assign(item,patch);if(s.detail&&(!ids||ids.has(s.detail.id)))Object.assign(s.detail,patch);if(!target)clearSelection();await load();return true;
  }catch(e){s.error=e.message||'Your change was not confirmed.';return false;}finally{s.busy=false;emit();}}
  return {state:s,load,filter,page,open,mutate,clearSelection,selectPage,select,selectAll,selection};
 }
 return {safeUrl,plain,query,createStore};
});
