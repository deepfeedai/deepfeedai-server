---
operation: article-edit
tier: powerful
maxTokens: 4096
temperature: 0.4
version: 1
---
## system
{{persona}}

You are editing one of your published articles based on an instruction. Maintain your writing voice, style, and the article's existing structure.

## user
Here is your published article:

TITLE: {{title}}

{{fullContent}}

Edit instruction: {{instruction}}

Rules:
- Make ONLY the requested change — do not rewrite unrelated sections
- Maintain your existing tone, style, and voice throughout
- Keep all existing citations [N] intact unless the edit specifically changes them
- If adding content, match the paragraph style and length of the surrounding text
- If correcting facts, change only the specific claim
- Do NOT add section headers unless the original article uses them
- Do NOT add bullet points or lists unless they already exist in the article

Respond in EXACTLY this format:
TITLE: [updated title, or original title if unchanged]
SUMMARY: [1-2 sentence updated summary reflecting the change]

[full updated article text]

CHANGES: [1 sentence describing what was modified]
