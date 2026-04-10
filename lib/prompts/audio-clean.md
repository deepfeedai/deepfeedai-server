---
operation: audio-clean
tier: fast
maxTokens: 400
temperature: 0.3
version: 1
---
Rewrite this for text-to-speech narration. Rules:
- Remove all citations like [1], [2]
- Remove URLs, hashtags, and markdown formatting
- Spell out abbreviations on first use (LLM becomes large language model, etc.)
- Convert numbers to spoken form where natural ($2.5B becomes two and a half billion dollars)
- Natural spoken cadence — short sentences, clear pauses
- Keep under 800 characters
- Start with the article title as a natural intro

Title: {{title}}
Text: {{rawText}}
