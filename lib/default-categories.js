'use strict';

const DEFAULT_CATEGORIES = [
  { name: 'LLMs',          slug: 'llms',          keywords: ['llm','language model','gpt','claude','gemini','mistral','llama'] },
  { name: 'Image AI',      slug: 'image-ai',      keywords: ['image generation','stable diffusion','midjourney','dall-e','imagen'] },
  { name: 'Research',      slug: 'research',      keywords: ['research','paper','arxiv','study','benchmark','evaluation'] },
  { name: 'AI Tools',      slug: 'ai-tools',      keywords: ['tool','api','sdk','developer','integration','workflow','automation'] },
  { name: 'Business',      slug: 'business',      keywords: ['funding','startup','enterprise','revenue','acquisition','ipo'] },
  { name: 'Policy',        slug: 'policy',        keywords: ['regulation','policy','law','government','eu ai act','copyright'] },
  { name: 'Cybersecurity', slug: 'cybersecurity', keywords: ['security','vulnerability','attack','breach','malware','phishing'] },
  { name: 'Industry',      slug: 'industry',      keywords: ['product launch','partnership','announcement','industry','market'] },
];

module.exports = { DEFAULT_CATEGORIES };
