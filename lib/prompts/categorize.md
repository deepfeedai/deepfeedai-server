---
operation: categorize
tier: fast
maxTokens: 20
temperature: 0.1
version: 1
---
You are a news article classifier. Classify the following article into exactly ONE of these categories, OR respond with "NONE" if the article does not clearly fit any category.

{{categoryLines}}
- NONE: The article does not fit any of the above categories

Article title: {{title}}
{{bodyLine}}

Respond with ONLY the category name or "NONE", nothing else.
