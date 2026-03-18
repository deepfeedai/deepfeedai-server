/**
 * Deep Feed AI Admin — GET /api/thumbnail
 * Generates an AI thumbnail for a given article title + category
 * using Google Gemini Imagen. Results cached in Postgres (7-day TTL).
 * Public endpoint — no auth required.
 *
 * Query params:
 *   title    — article headline
 *   category — LLMs | Image AI | Research | Tools | Industry
 *
 * Returns: { image: "<base64>", mimeType: "image/png" }
 *
 * Env var required: GEMINI_API_KEY
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { logUsage } = require('../lib/ai-usage');
const { getGeminiKey } = require('../lib/gemini-config');

const GEMINI_IMAGE_MODEL = 'gemini-2.0-flash-exp-image-generation';
const GEMINI_IMAGE_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
const CACHE_TTL_DAYS     = 7;

function cacheKey(title, category) {
  return `${title}-${category}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
}

async function getCached(key, tenantId) {
  const result = await getPool().query(
    `SELECT payload FROM thumbnail_cache
     WHERE tenant_id = $1 AND cache_key = $2
       AND created_at > NOW() - INTERVAL '7 days'`,
    [tenantId, key]
  );
  return result.rows[0]?.payload || null;
}

async function setCached(key, payload, tenantId) {
  await getPool().query(
    `INSERT INTO thumbnail_cache (tenant_id, cache_key, payload, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, cache_key) DO UPDATE SET payload = $3, created_at = NOW()`,
    [tenantId, key, payload]
  );
  // Prune oldest beyond 500 rows
  await getPool().query(
    `DELETE FROM thumbnail_cache
     WHERE tenant_id = $1 AND cache_key NOT IN (
       SELECT cache_key FROM thumbnail_cache WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500
     )`,
    [tenantId]
  );
}

router.get('/', asyncHandler(async (req, res) => {
  const apiKey = await getGeminiKey(req.tenantId);
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });

  const { title = '', category = 'Industry' } = req.query;
  if (!title) return res.status(400).json({ error: 'title query param required.' });

  const key = cacheKey(title, category);

  // Serve from cache if available
  const cached = await getCached(key, req.tenantId);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json(cached);
  }

  const prompt = buildPrompt(title, category);
  const _start = Date.now();

  const upstream = await fetch(`${GEMINI_IMAGE_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: { response_modalities: ['IMAGE', 'TEXT'] },
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    console.error('[thumbnail] Gemini error:', err);
    logUsage({ provider: 'gemini', model: GEMINI_IMAGE_MODEL, operation: 'thumbnail-render', trigger: 'page-load', imageCount: 0, durationMs: Date.now() - _start, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
    return res.status(upstream.status).json({ error: 'Image generation failed.' });
  }

  const data  = await upstream.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const img   = parts.find(p => p.inlineData);

  if (!img?.inlineData?.data) {
    console.error('[thumbnail] No image in Gemini response');
    logUsage({ provider: 'gemini', model: GEMINI_IMAGE_MODEL, operation: 'thumbnail-render', trigger: 'page-load', imageCount: 0, durationMs: Date.now() - _start, success: false, error: 'No image in response', tenantId: req.tenantId }).catch(() => {});
    return res.status(502).json({ error: 'No image returned from Gemini.' });
  }

  logUsage({ provider: 'gemini', model: GEMINI_IMAGE_MODEL, operation: 'thumbnail-render', trigger: 'page-load', imageCount: 1, durationMs: Date.now() - _start, tenantId: req.tenantId }).catch(() => {});
  const result = { image: img.inlineData.data, mimeType: img.inlineData.mimeType || 'image/png' };
  await setCached(key, result, req.tenantId);

  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).json(result);
}));

function buildPrompt(title, category) {
  const subject = extractSubject(title);
  const style   = categoryStyle(category);
  return [
    'Cinematic editorial tech news thumbnail.',
    'Photorealistic, dramatic lighting, ultra high quality.',
    'No text, no words, no letters, no logos, no UI elements. 16:9 wide format.',
    `\nVisual subject: ${subject}`,
    `Art direction: ${style}`,
  ].join(' ');
}

function extractSubject(title) {
  const t = title.toLowerCase();

  const companies = [
    [/openai/,       'a glowing geometric AI brain with neural interface reflections, futuristic'],
    [/anthropic/,    'a luminous ordered neural structure radiating safety and precision'],
    [/deepmind|google brain/, 'a chess piece sculpted from neurons, scientific and precise'],
    [/google/,       'multicolored data streams converging into a singular point of intelligence'],
    [/meta\b/,       'an infinite interconnected social graph glowing in cool blue light'],
    [/microsoft/,    'a sleek holographic AI interface, Windows-blue aurora, corporate power'],
    [/nvidia/,       'extreme close-up of a gleaming GPU chip, blazing green computation trails'],
    [/apple/,        'a minimalist silver device emanating warm intelligence light, clean space'],
    [/amazon|aws/,   'a vast server hall lit amber, AI consciousness awakening in the racks'],
    [/mistral/,      'a swirling wind of data tokens transforming into structured intelligence'],
    [/samsung/,      'a premium device surrounded by AI feature auras, Seoul cityscape backdrop'],
    [/tesla|waymo|self.driving|autonomous/, 'a sleek self-driving car navigating a rain-slicked city at night, AI vision overlays'],
    [/ibm/,          'a classic blue mainframe evolving into a quantum hologram'],
    [/palantir/,     'a surveillance grid of glowing data nodes, analytical precision'],
    [/xai|grok/,     'a rebellious neural spark cutting through digital noise, electric white'],
  ];
  for (const [re, metaphor] of companies) {
    if (re.test(t)) return metaphor;
  }

  const models = [
    [/gpt-?[4-9o]|gpt-?5|o[1-4]\b/, 'a towering pillar of flowing language tokens dissolving into meaning, electric blue'],
    [/claude/,       'a calm luminous AI assistant radiating thoughtful amber light'],
    [/gemini/,       'twin stars of AI intelligence orbiting in a cosmic data nebula'],
    [/llama/,        'a majestic digital creature built of neural mesh roaming open data plains'],
    [/midjourney/,   'a paintbrush stroke morphing into a photorealistic AI masterpiece, vibrant'],
    [/dall.?e/,      'a surrealist canvas where imagination and machine vision collide'],
    [/stable.?diff/, 'swirling latent space diffusion particles coalescing into a sharp image'],
    [/sora/,         'a cinematic film reel dissolving into AI-generated video frames'],
    [/copilot/,      'a glowing ghostly AI co-pilot guiding human hands through a complex workflow'],
    [/devin/,        'an autonomous robotic developer working alone at a glowing terminal at night'],
  ];
  for (const [re, metaphor] of models) {
    if (re.test(t)) return metaphor;
  }

  const topics = [
    [/chip|gpu|semiconductor|hardware/, 'extreme macro of a glowing semiconductor wafer, billions of transistors visible'],
    [/robot|humanoid/,                  'a sophisticated humanoid robot in contemplative pose, photorealistic studio lighting'],
    [/regulat|law|policy|congress|senate|eu ai/, 'scales of justice balanced with a circuit board, dramatic government building backdrop'],
    [/funding|billion|invest|ipo|valuat/, 'golden data points erupting upward like a financial chart, dramatic cinematic light'],
    [/layoff|cut|fired|job/,            'empty glowing desks with fading digital employee avatars'],
    [/paper|research|study|arxiv|benchmark|dataset/, 'floating holographic equations and data charts in a dark scientific void'],
    [/agent|agentic|automat/,           'multiple ghostly AI agents collaborating across a vast digital task board'],
    [/security|hack|breach|cyber/,      'a shield of light defending a glowing network from crimson intrusion vectors'],
    [/open.?source/,                    'a glowing network of open hands freely sharing streams of luminous code'],
    [/copyright|lawsuit|legal/,         'a gavel striking a glowing circuit board, dramatic courtroom chiaroscuro lighting'],
    [/image.gen|text.to.image/,         'where a paintbrush stroke seamlessly becomes photorealistic AI-generated art'],
    [/acqui|merger/,                    'two glowing corporate towers merging into a single taller structure'],
    [/agi|superintelligence/,           'a blindingly bright singularity point with expanding rings of AI consciousness'],
    [/climate|energy|power/,            'green data centers powered by wind turbines under a dramatic sky'],
    [/health|medical|drug/,             'AI neural network overlaid on a human body scan, medical precision and hope'],
  ];
  for (const [re, metaphor] of topics) {
    if (re.test(t)) return metaphor;
  }

  return `a dramatic cinematic scene representing this tech news story: "${title.replace(/[^a-zA-Z0-9 .,!?'-]/g, '').slice(0, 80)}"`;
}

function categoryStyle(category) {
  const styles = {
    'LLMs':     'Electric blue and deep violet palette. Neural network aesthetics. Flowing language and thought streams. Futuristic yet intellectual.',
    'Image AI': 'Vibrant saturated colors. Creative energy. Where digital meets artistic. Painterly yet technological. Colorful and expressive.',
    'Research': 'Cool blue laboratory tones. Scientific precision. Data visualizations in space. Academic gravitas. Holographic charts.',
    'Tools':    'Dark mode developer aesthetic. Glowing cyan or green accents. Clean, productive, powerful. Code and automation energy.',
    'Industry': 'Corporate power. Golden hour or dramatic dusk lighting. Architecture, scale, ambition. Cinematic wide establishing shots.',
  };
  return styles[category] || styles['Industry'];
}

module.exports = router;
