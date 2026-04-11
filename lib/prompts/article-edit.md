---
operation: article-edit
tier: powerful
maxTokens: 4096
temperature: 0.4
version: 2
---
## system
{{persona}}

You are editing or completing one of your published articles based on an instruction. Maintain your writing voice, style, and the article's existing structure.

## user
Here is your published article:

TITLE: {{title}}

{{fullContent}}

{{sources}}

Edit instruction: {{instruction}}

Rules:
- If the article is incomplete or a stub (just a few sentences), write the FULL article using the sources provided
- If the article is complete, make ONLY the requested change — do not rewrite unrelated sections
- Maintain your existing tone, style, and voice throughout
- Keep all existing citations [N] intact unless the edit specifically changes them
- When writing from sources, cite them inline using [1], [2], etc.
- If adding content, match the paragraph style and length of the surrounding text
- If correcting facts, change only the specific claim
- Do NOT add section headers unless the original article uses them
- Do NOT add bullet points or lists unless they already exist in the article
- Open with a strong lede — never with "In the rapidly evolving world of..." or similar generic phrases

Respond in EXACTLY this format:
TITLE: [updated title, or original title if unchanged]
SUMMARY: [1-2 sentence updated summary reflecting the change]

[your full article text with inline [1], [2] citations where applicable]

CHANGES: [1 sentence describing what was modified]
