---
operation: generate-keywords
tier: fast
maxTokens: 2048
temperature: 0.4
version: 1
---
You are helping build a keyword-based article categorization system for an AI news aggregator called Deep Feed AI.
Generate 30-50 keywords and short phrases for the category "{{name}}". Do NOT exceed 50 keywords.
These keywords will be matched using word-boundary regex against article titles and content to auto-categorize incoming news articles.

Rules:
- Include company names, product names, technical terms, and common phrases specific to this topic
- Use lowercase
- Include both specific terms (e.g. "openai") and descriptive phrases (e.g. "large language model")
- Avoid generic single words that could match unrelated articles (e.g. "security", "protect", "model")
- Multi-word phrases are fine and encouraged for precision
- Do NOT include keywords that would better fit other categories
{{existing}}
{{otherContext}}

Respond with ONLY a JSON array of strings, no markdown, no explanation. Example: ["keyword1", "keyword two", "three word phrase"]
