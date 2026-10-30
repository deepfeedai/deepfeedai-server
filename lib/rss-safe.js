'use strict';
const dns=require('node:dns').promises,http=require('node:http'),https=require('node:https'),net=require('node:net');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function normalizeUrl(value,{tracking=false}={}){
 if(typeof value!=='string'||value.length>2000)throw fail('Invalid feed address');
 let u;try{u=new URL(value.trim());}catch{throw fail('Invalid feed address');}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw fail('Use an HTTP(S) address without embedded credentials');
 const host=u.hostname.replace(/^\[|\]$/g,'');
 if(host.toLowerCase()==='localhost'||host.toLowerCase().endsWith('.localhost')||(net.isIP(host)&&!isPublicAddress(host)))throw fail('Private or unsupported feed address');
 u.hash='';
 if(tracking)for(const key of [...u.searchParams.keys()])if(/^utm_/i.test(key)||/^(fbclid|gclid)$/i.test(key))u.searchParams.delete(key);
 return u.href;
}
function displayUrl(value){try{const u=new URL(value);return u.origin+(u.pathname!=='/'||u.search?'/…':'/');}catch{return '(invalid address)';}}
function isPublicAddress(address){
 if(net.isIP(address)!==4)return false; // IPv6-only feeds fail closed until equivalent range handling is supported.
 const [a,b]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));
}
async function safeFetchText(value,{lookup=dns.lookup,request,maxBytes=2_000_000,timeout=12000,maxRedirects=3,accept='application/rss+xml, application/atom+xml, application/xml, text/xml'}={}){
 let current=normalizeUrl(value);const deadline=Date.now()+timeout;
 for(let redirect=0;redirect<=maxRedirects;redirect++){
  const u=new URL(current),hostname=u.hostname.replace(/^\[|\]$/g,'');
  let addresses,dnsTimer;try{addresses=await Promise.race([lookup(hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('timeout')),Math.max(1,deadline-Date.now()));})]);}catch{throw fail('Feed hostname could not be resolved',422);}finally{clearTimeout(dnsTimer);}
  if(Date.now()>=deadline)throw fail('Feed download timed out',422);
  if(!Array.isArray(addresses))addresses=[addresses];
  // Reject mixed public/private DNS answers; pin the validated address on the request.
  if(!addresses.length||addresses.some(a=>a.family===4&&!isPublicAddress(a.address))||addresses.some(a=>a.family===6&&/^(::|f[cd]|fe[89ab])/i.test(a.address)))throw fail('Private or unsupported feed address',422);
  const target=addresses.find(a=>isPublicAddress(a.address));if(!target)throw fail('Feed requires a supported public IPv4 address',422);
  const response=await new Promise((resolve,reject)=>{
   let timer;const done=(err,value)=>{clearTimeout(timer);if(err)reject(err);else resolve(value);};
   const send=request||(u.protocol==='https:'?https.request:http.request);
   const req=send(u,{method:'GET',headers:{'User-Agent':'DeepFeedAI RSS Reader','Accept':accept},lookup:(_h,options,cb)=>options?.all?cb(null,[{address:target.address,family:4}]):cb(null,target.address,4)},res=>{
    const status=res.statusCode||0;
    if([301,302,303,307,308].includes(status)){res.destroy();return done(null,{redirect:res.headers.location});}
    if(status<200||status>=300){res.destroy();return done(fail('Feed returned HTTP '+status,422));}
    let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>maxBytes){res.destroy();done(fail('Feed exceeds size limit',422));}else chunks.push(c);});
    res.on('end',()=>done(null,{text:Buffer.concat(chunks).toString('utf8')}));res.on('error',()=>done(fail('Feed download failed',422)));
   });
   const remaining=Math.max(1,deadline-Date.now());
   timer=setTimeout(()=>{done(fail('Feed download timed out',422));req.destroy();},remaining);
   req.setTimeout(remaining,()=>req.destroy());req.on('error',()=>done(fail('Feed download failed or timed out',422)));req.end();
  });
  if(response.text!==undefined)return response.text;
  if(!response.redirect||redirect===maxRedirects)throw fail('Feed redirect limit exceeded',422);
  try{current=normalizeUrl(new URL(response.redirect,current).href);}catch{throw fail('Invalid feed redirect',422);}
 }
}
module.exports={normalizeUrl,displayUrl,isPublicAddress,safeFetchText,fail};
