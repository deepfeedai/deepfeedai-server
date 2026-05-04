'use strict';

const db = require('../db');
const { complete } = require('./ai-router');

const MAX_ARTICLE_CHARS = 3000;
const MAX_WORDS = 90;

function buildPrompt(article, writer) {
  const name       = writer.name || 'Journalist';
  const bio        = writer.bio ? `Bio: ${writer.bio}` : '';
  const tone       = writer.tone ? `Tone: ${writer.tone}` : '';
  const beatAngle  = writer.beat_angle ? `Perspective: ${writer.beat_angle}` : '';
  const contrarian = writer.contrarian_level != null
    ? `Contrarian level: ${Math.round(writer.contrarian_level * 10)}/10 (0=neutral, 10=strongly opinionated)`
    : '';

  const excerpt = (article.full_content || article.summary || '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_ARTICLE_CHARS);

  return [
    `You are ${name}.`,
    bio, tone, beatAngle, contrarian,
    '',
    'You just finished writing the following article:',
    '---',
    excerpt,
    '---',
    '',
    `Write your personal "Final Thoughts" on this story in 2–3 sentences (maximum ${MAX_WORDS} words).`,
    'Rules:',
    '- Do NOT summarise the article — the reader already read it.',
    '- Give your genuine perspective: what this means, what concerns you, what excites you, or what to watch next.',
    '- Be direct and specific. Stay true to your voice and contrarian level.',
    '- Output only the final thoughts text. No heading, no label, no attribution.',
  ].filter(Boolean).join('\n');
}

/**
 * Generate and persist final_thoughts for an article.
 * Returns the generated text, or throws on failure.
 */
async function generateFinalThoughts(article, writer, tenantId) {
  const prompt = buildPrompt(article, writer);

  const result = await complete({
    operation:   'synthesis',
    tenantId,
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.75,
    maxTokens:   200,
    trigger:     'auto',
    writerId:    writer.id || null,
    articleSlug: article.slug || null,
  });

  const text = (result.content || result.text || '').trim();
  if (!text) throw new Error('AI returned empty final thoughts');

  await db.prepare(
    'UPDATE articles SET final_thoughts = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(text, article.id, tenantId);

  return text;
}

/**
 * Regenerate final_thoughts for an already-saved article by ID.
 * Fetches article + writer from DB, calls generateFinalThoughts.
 */
async function regenerateFinalThoughts(articleId, tenantId) {
  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);
  if (!article) throw new Error('Article not found');

  let writer = { name: article.source || 'Staff', id: null };
  if (article.writer_id) {
    const w = await db.prepare(
      'SELECT * FROM writers WHERE id = $1 AND tenant_id = $2'
    ).get(article.writer_id, tenantId);
    if (w) writer = w;
  }

  return generateFinalThoughts(article, writer, tenantId);
}

module.exports = { generateFinalThoughts, regenerateFinalThoughts };
