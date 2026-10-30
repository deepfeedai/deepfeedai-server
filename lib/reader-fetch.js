'use strict';
const {safeFetchText}=require('./rss-safe');
const {decodeEntities}=require('./utils');
function extractText(html) {
  if(typeof html!=='string')return null;
  let cleaned=html.replace(/<(script|style|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  const body=cleaned.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i);
  if(body)cleaned=body[1];
  const text=decodeEntities(cleaned.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().slice(0,5000);
  return text.length>=100?text:null;
}
async function scrapeText(url,tenantId,transport={}) {
  // Use the same pinned, redirect-validated transport as feed ingestion. Never
  // fall back to the legacy scraper when an address is blocked or unavailable.
  return extractText(await safeFetchText(url,{...transport,maxBytes:200000,timeout:6000,maxRedirects:3,accept:'text/html,application/xhtml+xml'}));
}
module.exports={extractText,scrapeText};
