/**
 * Prompt Loader — reads .md prompt files from lib/prompts/, parses frontmatter,
 * splits system/user messages, and interpolates {{variables}}.
 */
const fs   = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const cache = new Map();

/**
 * Parse simple YAML-like frontmatter (scalar fields only).
 * Returns { meta, body } where body is everything after the closing ---.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    // Coerce numeric values
    const num = Number(val);
    meta[key] = isNaN(num) || val.trim() === '' ? val.trim() : num;
  }
  return { meta, body: match[2] };
}

/**
 * Split prompt body into system and user messages.
 * Uses ## system / ## user markdown headings. If no headings, entire body is user message.
 */
function splitMessages(body) {
  const systemMatch = body.match(/^## system\s*\n([\s\S]*?)(?=^## user\s*$)/m);
  const userMatch   = body.match(/^## user\s*\n([\s\S]*)$/m);

  if (systemMatch && userMatch) {
    return [
      { role: 'system', content: systemMatch[1].trim() },
      { role: 'user',   content: userMatch[1].trim() },
    ];
  }
  // No section headings — entire body is user message
  return [{ role: 'user', content: body.trim() }];
}

/**
 * Interpolate {{variable}} placeholders. Throws on unresolved variables.
 */
function interpolate(template, vars, promptName) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (vars[key] === undefined || vars[key] === null) {
      throw new Error(`Prompt "${promptName}": missing variable "{{${key}}}"`);
    }
    return String(vars[key]);
  });
}

/**
 * Load and cache a prompt by name (filename without .md extension).
 * Returns { meta, render(vars) }.
 */
function loadPrompt(name) {
  if (cache.has(name)) return cache.get(name);

  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const messageTemplates = splitMessages(body);

  const prompt = {
    meta,
    render(vars = {}) {
      const messages = messageTemplates.map(msg => ({
        role: msg.role,
        content: interpolate(msg.content, vars, name),
      }));
      return { messages, ...meta };
    },
  };

  cache.set(name, prompt);
  return prompt;
}

/** Clear the cache (for testing). */
function clearPromptCache() {
  cache.clear();
}

module.exports = { loadPrompt, clearPromptCache };
