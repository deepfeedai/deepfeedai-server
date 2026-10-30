'use strict';
const MESSAGES = {
  RETIRED_IMAGE_MODEL: 'DALL-E 3 is retired. Select OpenAI GPT Image and a supported model in Settings > Image Provider. No provider was changed automatically.',
  IMAGE_CONFIG: 'Unsupported image model or quality. Review Settings > Image Provider.',
  MISSING_KEY: 'The selected image provider needs its API key configured in Settings.',
  BUDGET_EXCEEDED: 'Image generation skipped: budget limit reached.',
  IMAGE_FEATURE: 'Image generation is not enabled for this newsroom.',
  IMAGE_STORAGE: 'Image generation skipped: storage limit reached.',
  IMAGE_CONFLICT: 'The image changed during generation. Refresh before trying again.',
  IMAGE_TIMEOUT: 'Image request timed out. It may have incurred a charge; check provider usage before retrying.',
  IMAGE_PROVIDER: 'The image provider rejected the request. Check model access, billing and provider status.',
  IMAGE_INVALID: 'The image provider returned invalid or oversized PNG data.',
  IMAGE_FAILED: 'Image generation or saving failed. The previous image was retained.',
};
function imageError(code, retryable = false) { const e = new Error(MESSAGES[code] || MESSAGES.IMAGE_FAILED); e.code = code; e.retryable = retryable; return e; }
function publicImageError(e) { const code = Object.hasOwn(MESSAGES, e?.code) ? e.code : 'IMAGE_FAILED'; return { code, error: MESSAGES[code] }; }
function decodePng(b64) {
  if (typeof b64 !== 'string' || !b64.length || b64.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw imageError('IMAGE_INVALID');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > 20 * 1024 * 1024 || buf.length < 33 || buf.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || buf.readUInt32BE(8)!==13 || buf.toString('ascii',12,16)!=='IHDR' || !buf.readUInt32BE(16) || !buf.readUInt32BE(20) || buf.readUInt32BE(16)>8192 || buf.readUInt32BE(20)>8192) throw imageError('IMAGE_INVALID');
  return buf;
}
module.exports = { imageError, publicImageError, decodePng };
