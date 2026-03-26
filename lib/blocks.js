/**
 * Deep Feed AI — lib/blocks.js
 * Block ↔ markdown conversion utilities for the block-based article editor.
 */

const ALLOWED_BLOCK_TYPES = new Set([
  'paragraph', 'header', 'list', 'quote', 'image', 'delimiter', 'code', 'embed',
]);

/**
 * Validate block structure. Returns { valid, errors }.
 */
function validateBlocks(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['content_blocks must be an object'] };
  }
  if (!Array.isArray(data.blocks)) {
    return { valid: false, errors: ['content_blocks.blocks must be an array'] };
  }
  if (data.blocks.length > 500) {
    return { valid: false, errors: ['Too many blocks (max 500)'] };
  }
  for (let i = 0; i < data.blocks.length; i++) {
    const b = data.blocks[i];
    if (!b || typeof b !== 'object') {
      errors.push(`Block ${i}: must be an object`);
      continue;
    }
    if (!ALLOWED_BLOCK_TYPES.has(b.type)) {
      errors.push(`Block ${i}: unknown type "${b.type}"`);
    }
    if (!b.data || typeof b.data !== 'object') {
      errors.push(`Block ${i}: missing data`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Strip HTML tags from a string (for plain text extraction).
 */
function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '');
}

/**
 * Convert Editor.js block JSON → markdown string.
 */
function blocksToMarkdown(data) {
  if (!data || !Array.isArray(data.blocks)) return '';

  const parts = [];
  for (const block of data.blocks) {
    switch (block.type) {
      case 'paragraph':
        parts.push(htmlToMd(block.data.text || ''));
        break;
      case 'header': {
        const level = block.data.level || 2;
        const prefix = '#'.repeat(Math.min(level, 6));
        parts.push(`${prefix} ${stripHtml(block.data.text || '')}`);
        break;
      }
      case 'list': {
        const items = block.data.items || [];
        const ordered = block.data.style === 'ordered';
        const listLines = items.map((item, i) => {
          const prefix = ordered ? `${i + 1}.` : '-';
          return `${prefix} ${htmlToMd(typeof item === 'string' ? item : (item.content || ''))}`;
        });
        parts.push(listLines.join('\n'));
        break;
      }
      case 'quote': {
        const text = stripHtml(block.data.text || '');
        const caption = stripHtml(block.data.caption || '');
        parts.push(`> ${text}${caption ? `\n> — ${caption}` : ''}`);
        break;
      }
      case 'image': {
        const alt = block.data.caption || block.data.alt || '';
        const url = block.data.file?.url || block.data.url || '';
        parts.push(`![${stripHtml(alt)}](${url})`);
        break;
      }
      case 'code':
        parts.push('```\n' + (block.data.code || '') + '\n```');
        break;
      case 'delimiter':
        parts.push('---');
        break;
      case 'embed': {
        const src = block.data.embed || block.data.source || '';
        parts.push(src);
        break;
      }
      default:
        if (block.data && block.data.text) {
          parts.push(stripHtml(block.data.text));
        }
    }
  }
  return parts.join('\n\n');
}

/**
 * Convert simple HTML inline formatting to markdown.
 */
function htmlToMd(html) {
  return (html || '')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

/**
 * Parse existing markdown/plain-text into Editor.js block JSON.
 * Used for lazy migration when editing old articles.
 */
function markdownToBlocks(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { version: '1.0', blocks: [] };
  }

  const blocks = [];
  // Split on double newlines to get paragraphs, but respect markdown structures
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) { i++; continue; }

    // Header: ## or ###
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      blocks.push({
        id: genId(),
        type: 'header',
        data: { text: mdToHtml(headerMatch[2].trim()), level: headerMatch[1].length }
      });
      i++;
      continue;
    }

    // Delimiter: ---
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ id: genId(), type: 'delimiter', data: {} });
      i++;
      continue;
    }

    // Code block: ```
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        id: genId(),
        type: 'code',
        data: { code: codeLines.join('\n') }
      });
      i++; // skip closing ```
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const full = quoteLines.join('\n');
      const captionMatch = full.match(/^(.+)\n— (.+)$/s);
      if (captionMatch) {
        blocks.push({
          id: genId(),
          type: 'quote',
          data: { text: mdToHtml(captionMatch[1].trim()), caption: captionMatch[2].trim() }
        });
      } else {
        blocks.push({
          id: genId(),
          type: 'quote',
          data: { text: mdToHtml(full.trim()), caption: '' }
        });
      }
      continue;
    }

    // List: - item or * item or 1. item
    if (/^(\d+\.\s|[-*]\s)/.test(line)) {
      const items = [];
      const ordered = /^\d+\./.test(line);
      while (i < lines.length && /^(\d+\.\s|[-*]\s)/.test(lines[i])) {
        items.push(mdToHtml(lines[i].replace(/^(\d+\.\s|[-*]\s)/, '').trim()));
        i++;
      }
      blocks.push({
        id: genId(),
        type: 'list',
        data: { style: ordered ? 'ordered' : 'unordered', items }
      });
      continue;
    }

    // Image: ![alt](url)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      blocks.push({
        id: genId(),
        type: 'image',
        data: { url: imgMatch[2], caption: imgMatch[1], file: { url: imgMatch[2] } }
      });
      i++;
      continue;
    }

    // Regular paragraph — collect lines until empty line
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^#{1,6}\s/) && !lines[i].startsWith('> ') && !lines[i].startsWith('```') && !/^-{3,}$/.test(lines[i].trim()) && !/^(\d+\.\s|[-*]\s)/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({
        id: genId(),
        type: 'paragraph',
        data: { text: mdToHtml(paraLines.join(' ')) }
      });
    }
  }

  return { version: '1.0', blocks };
}

/**
 * Convert markdown inline formatting to HTML (for Editor.js which uses HTML inline).
 */
function mdToHtml(md) {
  return (md || '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      // Only allow safe URL protocols
      if (/^(https?:\/\/|\/[^/])/.test(href)) return `<a href="${href}">${text}</a>`;
      return text;
    });
}

/**
 * Extract plain text from blocks (for search indexing, word counts).
 */
function extractPlainText(data) {
  if (!data || !Array.isArray(data.blocks)) return '';
  return data.blocks.map(b => {
    if (!b.data) return '';
    if (b.type === 'code') return b.data.code || '';
    return stripHtml(b.data.text || b.data.caption || '');
  }).filter(Boolean).join(' ');
}

/** Generate a short random ID for blocks. */
function genId() {
  return Math.random().toString(36).slice(2, 12);
}

module.exports = { validateBlocks, blocksToMarkdown, markdownToBlocks, extractPlainText };
