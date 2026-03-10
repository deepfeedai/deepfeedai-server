/**
 * Deep Feed AI Admin — lib/categorize.js
 * Score-based category detection for AI news articles.
 * Single source of truth — imported by routes/fetch.js (server-side RSS ingestion).
 * The frontend (app.js) mirrors this logic client-side for live API articles.
 *
 * Categories: LLMs | Image AI | Research | Tools | Business | Policy | CyberSecurity | Industry (default)
 */

/**
 * Detect the most likely category for an RSS feed item.
 * @param {object} item - RSS item with title, categories, contentSnippet, content fields.
 * @returns {string} Category name.
 */
function detectCategory(item) {
  const raw  = [
    item.title           || '',
    (item.categories || []).join(' '),
    item.contentSnippet  || '',
    item.content         || '',
  ].join(' ');
  const text = raw.toLowerCase();

  const scores = {
    'LLMs':          0,
    'Image AI':      0,
    'Research':      0,
    'Tools':         0,
    'Business':      0,
    'Policy':        0,
    'CyberSecurity': 0,
  };

  // ── LLMs / Language Models ──────────────────────────────────────
  if (/\b(gpt-?[34o]|gpt-?5|gpt-?4\.?[05]|o1|o3|o4-?mini)\b/.test(text))                                   scores.LLMs += 4;
  if (/\b(claude|sonnet|opus|haiku|gemini|llama-?[23]?|mistral|mixtral|falcon|phi-?\d|qwen|deepseek|grok|command-?r|palmyra|jamba|nova\b|titan\b)\b/.test(text)) scores.LLMs += 3;
  if (/\b(llm|llms|large language model|language model|foundation model|base model)\b/.test(text))           scores.LLMs += 3;
  if (/\b(multimodal model|vision language|text generation|context window|system prompt|prompt engineering)\b/.test(text)) scores.LLMs += 2;
  if (/\b(few-?shot|zero-?shot|chain.of.thought|retrieval.augmented|rag|tokenizer|token limit)\b/.test(text)) scores.LLMs += 2;
  if (/\b(openai|anthropic|cohere|ai21|mistral ai|together ai|perplexity|xai|inflection)\b/.test(text))      scores.LLMs += 1;

  // ── Image / Video / Audio Generation ───────────────────────────
  if (/\b(midjourney|dall-?e|stable.?diffusion|stability.?ai|ideogram|firefly|leonardo|flux)\b/.test(text)) scores['Image AI'] += 4;
  if (/\b(sora|runway|kling|pika|gen-?[23]|veo|lumiere|cogvideo)\b/.test(text))                              scores['Image AI'] += 4;
  if (/\b(text.to.image|text.to.video|image.generation|video.generation|image.synthesis)\b/.test(text))      scores['Image AI'] += 3;
  if (/\b(diffusion.model|latent.diffusion|generative.image|ai.art|ai.generated.image)\b/.test(text))        scores['Image AI'] += 3;
  if (/\b(text.to.speech|speech.synthesis|voice.clone|tts|audio.generation|music.generation|suno|udio)\b/.test(text)) scores['Image AI'] += 3;
  if (/\b(generate|generated|generative)\b/.test(text) && /\b(image|video|art|visual|photo|picture|music|audio|voice)\b/.test(text)) scores['Image AI'] += 2;
  if (/\b(deepfake|synthetic.media|ai.video|ai.image|ai.art)\b/.test(text))                                  scores['Image AI'] += 2;

  // ── Research / Academic ─────────────────────────────────────────
  if (/\b(arxiv|neurips|icml|iclr|acl|emnlp|cvpr|iccv|naacl|nips)\b/.test(text))                            scores.Research += 4;
  if (/\b(preprint|research paper|new paper|paper proposes|paper introduces|we propose|we present)\b/.test(text)) scores.Research += 4;
  if (/\b(dataset|benchmark suite|evaluation framework|evals|ablation|hyperparameter|perplexity)\b/.test(text)) scores.Research += 3;
  if (/\b(alignment|interpretability|mechanistic|scaling.?law|emergent.?abilit|red.team|adversarial|robustness)\b/.test(text)) scores.Research += 3;
  if (/\b(pretraining|fine.?tuning|rlhf|reward.model|constitutional.ai|ai.safety|ai.risk)\b/.test(text))    scores.Research += 3;
  if (/\b(researchers?|scientists?|published|findings|results|experiment|hallucin|university|mit|stanford|deepmind.research|google.brain|openai.research)\b/.test(text)) scores.Research += 2;
  if (/\b(study|analysis|survey|review|evaluation|measured|showed.that|found.that)\b/.test(text))            scores.Research += 1;

  // ── Tools / Products / Apps ─────────────────────────────────────
  if (/\b(github.?copilot|cursor.?ai|codeium|tabnine|codex|devin|replit|aider|continue\.?dev)\b/.test(text)) scores.Tools += 4;
  if (/\b(mcp|model.context.protocol|function.calling|ai.agent|agentic|multi.?agent|autonomous.agent)\b/.test(text)) scores.Tools += 3;
  if (/\b(chatbot|ai.assistant|virtual.assistant|copilot|plugin|extension|integration|workflow.automation)\b/.test(text)) scores.Tools += 3;
  if (/\b(now.available|product.launch|generally.available|ga.release|public.beta|open.beta|rolling.out)\b/.test(text)) scores.Tools += 3;
  if (/\b(sdk|api.launch|no.?code|low.?code|zapier|make\.com|n8n|automation.platform)\b/.test(text))        scores.Tools += 3;
  if (/\b(app|platform|software|tool|feature|release|version|v\d+\.\d+|upgrade|update)\b/.test(text))       scores.Tools += 1;

  // ── Business / Industry ─────────────────────────────────────────
  if (/\b(series [abcde]|seed.round|venture.round|funding.round|raised.?\$|secures.?\$)\b/.test(text))       scores.Business += 4;
  if (/\b(acqui|merger|ipo|valuation|unicorn|decacorn|spac)\b/.test(text))                                   scores.Business += 4;
  if (/\b(funding|investment|investor|venture.capital|andreessen|sequoia|a16z|softbank|tiger.global)\b/.test(text)) scores.Business += 3;
  if (/\b(revenue|earnings|profit|loss|quarterly|fiscal|market.share|stock|share.price)\b/.test(text))       scores.Business += 3;
  if (/\b(ceo|cto|coo|cfo|founder|co-founder|president|executive|board|leadership)\b/.test(text))           scores.Business += 2;
  if (/\b(layoff|laid.off|job.cut|reorg|restructur|downsiz|firing|resign)\b/.test(text))                     scores.Business += 3;
  if (/\b(partnership|deal|contract|agreement|collaboration|strategic|expansion|growth)\b/.test(text))       scores.Business += 2;
  if (/\b(nvidia|microsoft|google|amazon|apple|meta|ibm|samsung|intel|amd|qualcomm)\b/.test(text))          scores.Business += 1;
  if (/\b(startup|company|firm|corporation|enterprise)\b/.test(text))                                        scores.Business += 1;

  // ── Policy / Regulation / Ethics / Safety ───────────────────────
  if (/\b(eu.ai.act|ai.act|executive.order|ai.regulation|ai.bill|ai.law|ai.legislation)\b/.test(text))      scores.Policy += 4;
  if (/\b(lawsuit|sued|litigation|court.ruling|judge|verdict|settlement|ftc|doj|congress|senate|parliament)\b/.test(text)) scores.Policy += 4;
  if (/\b(regulation|regulat|legislat|policy|govern|compliance|gdpr|ccpa|biometric)\b/.test(text))          scores.Policy += 3;
  if (/\b(copyright|intellectual.property|fair.use|training.data.lawsuit|scraping.lawsuit)\b/.test(text))   scores.Policy += 3;
  if (/\b(ai.safety|alignment|existential.risk|x-?risk|responsible.ai|ai.ethics|bias|fairness|transparency)\b/.test(text)) scores.Policy += 3;
  if (/\b(misinformation|disinformation|deepfake.detect|election|propaganda|manipulation)\b/.test(text))    scores.Policy += 3;
  if (/\b(pentagon|dod|military|national.security|surveillance|privacy|data.privacy)\b/.test(text))         scores.Policy += 2;
  if (/\b(ban|restrict|prohibit|censor|limit|guardrail|safeguard|red.line)\b/.test(text))                   scores.Policy += 2;

  // ── CyberSecurity ────────────────────────────────────────────────
  if (/\b(cyberattack|cyber.attack|ransomware|malware|phishing|zero.day|exploit|vulnerability|cve-\d)\b/.test(text)) scores.CyberSecurity += 4;
  if (/\b(ai.security|llm.security|prompt.injection|jailbreak|adversarial.attack|model.theft|model.extract)\b/.test(text)) scores.CyberSecurity += 4;
  if (/\b(hacker|hacking|breach|data.breach|intrusion|threat.actor|apt\b|nation.state)\b/.test(text))       scores.CyberSecurity += 3;
  if (/\b(cybersecurity|infosec|soc\b|siem|threat.intel|penetration.test|red.team.security)\b/.test(text)) scores.CyberSecurity += 3;
  if (/\b(ai.powered.attack|ai.generated.phishing|deepfake.fraud|voice.clone.fraud)\b/.test(text))          scores.CyberSecurity += 3;
  if (/\b(secure|security|defend|defense|protect|encrypt|authentication|identity.theft)\b/.test(text))      scores.CyberSecurity += 1;

  // Pick the highest scoring category; fall back to 'Industry'
  let best = 'Industry';
  let bestScore = 1; // minimum threshold to beat Industry
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

module.exports = { detectCategory };
