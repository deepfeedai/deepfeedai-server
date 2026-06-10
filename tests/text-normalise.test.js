/**
 * Plain-text normalisation tests for article metadata.
 *   node --test tests/text-normalise.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cleanInlineMarkdownText } = require('../lib/utils');

test('removes markdown emphasis from generated article titles', () => {
  const input = 'AAA Game Studios Embrace AI Tools as *Tomb Raider*, *Crazy Taxi* Confirm GenAI Use';
  const expected = 'AAA Game Studios Embrace AI Tools as Tomb Raider, Crazy Taxi Confirm GenAI Use';
  assert.equal(cleanInlineMarkdownText(input), expected);
});

test('removes markdown emphasis from generated excerpts', () => {
  const input = '"It\'s happening, folks! AAA giants are officially integrating Generative AI into their workflows, with *Tomb Raider* and *Crazy Taxi* leading the charge."';
  const expected = '"It\'s happening, folks! AAA giants are officially integrating Generative AI into their workflows, with Tomb Raider and Crazy Taxi leading the charge."';
  assert.equal(cleanInlineMarkdownText(input), expected);
});

test('turns markdown links and inline code into plain reader text', () => {
  const input = 'See [prior coverage](https://example.com/article/a) and `Claude Fable 5` for context.';
  assert.equal(cleanInlineMarkdownText(input), 'See prior coverage and Claude Fable 5 for context.');
});

test('decodes entities, strips HTML, and preserves apostrophes', () => {
  const input = '<strong>Anthropic&apos;s</strong> &quot;guardrails&quot; aren&apos;t optional';
  assert.equal(cleanInlineMarkdownText(input), 'Anthropic\'s "guardrails" aren\'t optional');
});
