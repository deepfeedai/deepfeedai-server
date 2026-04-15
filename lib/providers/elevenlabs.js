/**
 * Deep Feed AI — ElevenLabs provider adapter (text-to-speech).
 * Returns audio bytes (MP3) as a Buffer, or base64 string when requested.
 *
 * Matches the shape of the other provider modules (gemini.js, openai.js,
 * imagen.js, dalle.js) so ai-router can dispatch uniformly.
 */
'use strict';

const https = require('https');

const DEFAULT_MODEL = 'eleven_turbo_v2';
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
};

/**
 * Generate speech audio from text.
 *
 * @param {object} opts
 * @param {string} opts.apiKey                 ElevenLabs API key
 * @param {string} opts.voiceId                ElevenLabs voice_id (required)
 * @param {string} opts.text                   Text to synthesize
 * @param {object} [opts.params]               Extra knobs
 * @param {string} [opts.params.model]         Override model (default eleven_turbo_v2)
 * @param {object} [opts.params.voiceSettings] Override voice settings
 * @param {number} [opts.params.timeoutMs=30000]
 * @param {'buffer'|'base64'} [opts.returnFormat='buffer']
 * @returns {Promise<{ audio: Buffer|string, mime: string, characters: number, model: string }>}
 */
async function generate({ apiKey, voiceId, text, params, returnFormat = 'buffer' }) {
  if (!apiKey) throw new Error('elevenlabs: missing API key');
  if (!voiceId) throw new Error('elevenlabs: missing voiceId');
  if (!text || !text.trim()) throw new Error('elevenlabs: missing text');

  const p = params || {};
  const model = p.model || DEFAULT_MODEL;
  const voiceSettings = p.voiceSettings || DEFAULT_VOICE_SETTINGS;
  const timeoutMs = p.timeoutMs || 30000;

  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: voiceSettings,
  });

  const mp3Buf = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => err += c);
        res.on('end', () => reject(new Error(`elevenlabs ${res.statusCode}: ${err.slice(0, 200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('elevenlabs timeout')); });
    req.write(body);
    req.end();
  });

  return {
    audio: returnFormat === 'base64' ? mp3Buf.toString('base64') : mp3Buf,
    mime: 'audio/mpeg',
    characters: text.length,
    model,
  };
}

/**
 * Fetch ElevenLabs subscription info (used by the admin quota panel).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<object>} raw ElevenLabs /v1/user/subscription response
 */
async function getSubscription({ apiKey, timeoutMs = 8000 }) {
  if (!apiKey) throw new Error('elevenlabs: missing API key');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/user/subscription',
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) return reject(new Error(`elevenlabs ${res.statusCode}: ${raw.slice(0, 200)}`));
          resolve(JSON.parse(raw));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('elevenlabs timeout')); });
    req.end();
  });
}

module.exports = { generate, getSubscription, DEFAULT_MODEL, DEFAULT_VOICE_SETTINGS };
