'use strict';
const { imageError, decodePng } = require('../image-errors');
const MODELS = new Set(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
function validate(model, quality = 'medium') {
  if (!MODELS.has(model) || !['low','medium','high'].includes(quality)) throw imageError('IMAGE_CONFIG');
}
async function generate({apiKey, model='gpt-image-2', quality='medium', prompt, aspectRatio='16:9', timeoutMs=180000}) {
  validate(model, quality);
  if (!apiKey) throw imageError('MISSING_KEY');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw imageError('IMAGE_CONFIG');
  const sizes = {'1:1':'1024x1024','16:9':'1536x1024','4:3':'1536x1024','9:16':'1024x1536','3:4':'1024x1536'};
  if (!sizes[aspectRatio]) throw imageError('IMAGE_CONFIG');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,prompt,n:1,size:sizes[aspectRatio],quality,output_format:'png'}), signal:controller.signal,
    });
    // Never echo provider bodies, which may include prompts or credentials.
    if (!res.ok) throw imageError('IMAGE_PROVIDER', res.status === 429);
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    decodePng(b64);
    return {b64,mime:'image/png',usage:data.usage || null};
  } catch(e) {
    if (controller.signal.aborted) throw imageError('IMAGE_TIMEOUT');
    if (e.code) throw e;
    throw imageError('IMAGE_FAILED');
  } finally { clearTimeout(timer); }
}
module.exports = {generate, validate, MODELS};
