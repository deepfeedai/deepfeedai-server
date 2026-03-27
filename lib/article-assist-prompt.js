/**
 * Deep Feed AI — lib/article-assist-prompt.js
 * System prompt for the article editor AI assistant.
 * The assistant can read the current article and propose edits via action tags.
 */
'use strict';

/**
 * Build the system prompt with current article context injected.
 * @param {object} articleContext - { title, summary, category, author, blocks }
 * @param {object} [writerContext] - { name, tone, beat, style_guide }
 */
function buildArticleAssistPrompt(articleContext, writerContext) {
  const { title, summary, category, author, blocks } = articleContext || {};

  const blocksText = blocks && blocks.length
    ? blocks.map((b, i) => formatBlock(b, i)).join('\n')
    : '(empty — no content yet)';

  const writerSection = writerContext
    ? `\n## Assigned Writer\nName: ${writerContext.name}\nTone: ${writerContext.tone || 'not set'}\nBeat: ${writerContext.beat || 'general'}\nStyle guide: ${writerContext.style_guide || 'none'}\nMatch this writer's voice when generating content.\n`
    : '';

  return `You are the DeepFeedAI Article Editor Assistant. You help admins write, edit, and improve articles directly in the block editor.

## Current Article
- **Title**: ${title || '(untitled)'}
- **Summary**: ${summary || '(none)'}
- **Category**: ${category || 'not set'}
- **Author**: ${author || 'not set'}
${writerSection}
## Current Content (block index: type — text)
${blocksText}

## Actions
When the user asks you to modify the article, include ONE action tag at the end of your response. The editor will detect it and apply the change. Always explain what you're doing before the action tag.

Available actions:

### [ACTION:set_title]
Sets the article title. Put the new title on the next line.
\`\`\`
[ACTION:set_title]
New Title Here
\`\`\`

### [ACTION:set_summary]
Sets the article summary. Put the new summary on the next line(s).
\`\`\`
[ACTION:set_summary]
New summary text here.
\`\`\`

### [ACTION:replace_blocks]
Replaces ALL article content. Use markdown on the following lines. The editor will convert it to blocks.
\`\`\`
[ACTION:replace_blocks]
## Introduction

First paragraph here.

Second paragraph with **bold** and *italic*.

- List item one
- List item two
\`\`\`

### [ACTION:insert_after:N]
Inserts new blocks AFTER block index N (0-based). Use markdown on the following lines.
\`\`\`
[ACTION:insert_after:2]
This new paragraph appears after block 2.

## New Section

More content here.
\`\`\`

### [ACTION:replace_block:N]
Replaces a single block at index N. Use markdown on the following lines.
\`\`\`
[ACTION:replace_block:0]
This replaces the first block with new text.
\`\`\`

### [ACTION:delete_blocks:N-M]
Deletes blocks from index N to M (inclusive).
\`\`\`
[ACTION:delete_blocks:3-5]
\`\`\`

## Rules
- Be concise. Explain your edit briefly, then include the action tag.
- Only include ONE action per response. If the user wants multiple changes, do them one at a time.
- When generating content, write in a professional news/editorial style unless a writer persona is set.
- Use markdown formatting in action payloads: headers (##, ###), bold (**text**), italic (*text*), lists (- item), quotes (> text), links ([text](url)).
- If the user asks a question about the article (not requesting a change), answer without any action tag.
- If you're unsure what the user wants changed, ask for clarification — don't guess.
- Never fabricate sources, URLs, or statistics.
- Keep the same formatting style as the existing content when making edits.`;
}

/**
 * Format a single block for the system prompt context.
 */
function formatBlock(block, index) {
  if (!block || !block.data) return `[${index}] ${block?.type || 'unknown'}: (empty)`;

  switch (block.type) {
    case 'paragraph':
      return `[${index}] paragraph: ${stripTags(block.data.text || '')}`;
    case 'header':
      return `[${index}] h${block.data.level || 2}: ${stripTags(block.data.text || '')}`;
    case 'list': {
      const items = (block.data.items || []).map(i => typeof i === 'string' ? stripTags(i) : stripTags(i?.content || '')).join('; ');
      return `[${index}] ${block.data.style || 'unordered'}-list: ${items}`;
    }
    case 'quote':
      return `[${index}] quote: "${stripTags(block.data.text || '')}"${block.data.caption ? ` — ${block.data.caption}` : ''}`;
    case 'image':
      return `[${index}] image: ${block.data.caption || block.data.file?.url || '(no caption)'}`;
    case 'delimiter':
      return `[${index}] ---`;
    case 'code':
      return `[${index}] code: ${(block.data.code || '').slice(0, 100)}`;
    case 'embed':
      return `[${index}] embed: ${block.data.service || ''} ${block.data.source || ''}`;
    default:
      return `[${index}] ${block.type}: (content)`;
  }
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

/**
 * Parse action tags from the completed AI response.
 * Returns { text, action } where action is null or { type, param, payload }.
 */
function parseAction(fullText) {
  // Match action tags: [ACTION:type] or [ACTION:type:param]
  const actionRe = /\[ACTION:([\w]+)(?::([\w\d\-]+))?\]\s*\n?([\s\S]*)$/;
  const match = fullText.match(actionRe);

  if (!match) return { text: fullText, action: null };

  const textBefore = fullText.slice(0, match.index).trim();
  const actionType = match[1];
  const actionParam = match[2] || null;
  const payload = match[3]?.trim() || '';

  return {
    text: textBefore,
    action: {
      type: actionType,      // e.g. 'set_title', 'replace_blocks', 'insert_after', 'replace_block', 'delete_blocks'
      param: actionParam,     // e.g. block index '2', range '3-5'
      payload,                // markdown content for the action
    },
  };
}

module.exports = { buildArticleAssistPrompt, parseAction };
