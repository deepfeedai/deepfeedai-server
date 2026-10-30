'use strict';
const {parseStringPromise}=require('xml2js');
const {normalizeUrl,displayUrl,fail}=require('./rss-safe');
const WARNING='Feed addresses may contain private access tokens. Export files contain the selected feed URLs; store them securely. OPML carries names, URLs and folders only; use JSON for platform settings.';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function cleanFolder(value){const parts=String(value||'').split('/').map(p=>p.trim()).filter(Boolean);if(parts.length>8||parts.some(p=>p.length>80)||parts.join('/').length>400)throw fail('Folder path is too long');return parts.join('/');}
async function parseImport({format='urls',content,sources}={}){
 if(Array.isArray(sources)){if(sources.length>500)throw fail('Import limit is 500 sources');return sources;}
 if(typeof content!=='string'||Buffer.byteLength(content)>500000)throw fail('Import must be text no larger than 500 KB');
 if(format==='urls')return content.split(/\r?\n/).map(v=>v.trim()).filter(Boolean).map(url=>({url}));
 if(format==='json'){let data;try{data=JSON.parse(content);}catch{throw fail('Invalid JSON import');}const rows=Array.isArray(data)?data:data.sources;if(!Array.isArray(rows))throw fail('JSON needs a sources array');if(rows.length>500)throw fail('Import limit is 500 sources');return rows;}
 if(format!=='opml')throw fail('Unsupported import format');
 if(/<!DOCTYPE|<!ENTITY/i.test(content))throw fail('OPML entities and document types are not allowed');
 let document;try{document=await parseStringPromise(content,{strict:true,explicitArray:true,trim:true});}catch{throw fail('Malformed OPML');}
 if(!document.opml?.body?.[0])throw fail('Expected an OPML document with a body');
 const items=[];
 function visit(nodes,path=[],depth=0){if(depth>12)throw fail('OPML nesting is too deep');for(const node of nodes||[]){const a=node.$||{},name=a.title||a.text||'';if(a.xmlUrl){items.push({url:a.xmlUrl,name,folder_path:cleanFolder(path.join('/'))});if(items.length>500)throw fail('Import limit is 500 sources');}visit(node.outline,a.xmlUrl?path:[...path,name],depth+1);}}
 visit(document.opml.body[0].outline);if(!items.length)throw fail('No RSS feeds found');return items;
}
function normalizeSource(item){
 if(!item||typeof item!=='object')throw fail('Invalid source entry');
 const url=normalizeUrl(item.url),u=new URL(url);
 const name=String(item.name||u.hostname).trim();if(!name||name.length>200)throw fail('Source name must be 1–200 characters');
 const priority=Number(item.priority??1),max=Number(item.auto_publish_max??50);
 if(!Number.isInteger(priority)||priority<1||priority>100||!Number.isInteger(max)||max<1||max>200)throw fail('Invalid priority or ingest limit');
 if(item.is_active!==undefined&&typeof item.is_active!=='boolean'&&![0,1].includes(item.is_active))throw fail('Invalid active status');
 return {name,url,normalized_url:url,display_url:displayUrl(url),folder_path:cleanFolder(item.folder_path),default_category:item.default_category?String(item.default_category).slice(0,100):null,priority,auto_publish_max:max,is_active:item.is_active===false||item.is_active===0?0:1};
}
function exportSources(rows,format){
 const sources=rows.map(r=>({name:r.name,url:r.url,folder_path:r.folder_path||'',default_category:r.default_category||null,priority:r.priority,is_active:!!r.is_active,auto_publish_max:r.auto_publish_max}));
 if(format==='json')return{content:JSON.stringify({version:1,sources},null,2),mime:'application/json',filename:'rss-sources.json',warning:WARNING};
 if(format==='csv'){const fields=['name','url','folder_path','default_category','priority','is_active','auto_publish_max'];const cell=v=>'"'+String(v??'').replace(/^[=+\-@]/,"'$&").replace(/"/g,'""')+'"';return{content:[fields.join(','),...sources.map(r=>fields.map(f=>cell(r[f])).join(','))].join('\r\n'),mime:'text/csv',filename:'rss-sources.csv',warning:WARNING};}
 if(format!=='opml')throw fail('Unsupported export format');
 const root={folders:new Map(),items:[]};for(const row of sources){let folder=root;for(const name of row.folder_path.split('/').filter(Boolean)){if(!folder.folders.has(name))folder.folders.set(name,{folders:new Map(),items:[]});folder=folder.folders.get(name);}folder.items.push(row);}
 function render(folder){return [...folder.folders].map(([name,child])=>`<outline text="${escape(name)}" title="${escape(name)}">${render(child)}</outline>`).join('')+folder.items.map(r=>`<outline type="rss" text="${escape(r.name)}" title="${escape(r.name)}" xmlUrl="${escape(r.url)}"/>`).join('');}
 return{content:`<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>RSS Sources</title></head><body>${render(root)}</body></opml>`,mime:'text/x-opml',filename:'rss-sources.opml',warning:WARNING};
}
module.exports={parseImport,normalizeSource,exportSources,cleanFolder,WARNING};
