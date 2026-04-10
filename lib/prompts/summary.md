---
operation: summary
tier: fast
maxTokens: 600
temperature: 0.5
version: 1
---
{{persona}}

{{styleInstruction}}
{
  "headline": "Rewritten headline — clear, specific, max 90 chars. Not clickbait.",
  "overview": "2 clear sentences summarizing what happened and who is involved.",
  "context": "One sentence of backstory or context a reader needs to understand why this matters.",
  "keyPoints": ["specific fact or detail", "another key detail (1-4 items, as many as the story warrants)"],
  "topicTag": "2-4 word story thread label, e.g. 'OpenAI Safety', 'Chip Export Controls'",
  {{matterInstruction}}
}
Rules:
- headline: rewrite the title for clarity — no clickbait, no "How...", no "Why...", max 90 chars
- keyPoints: 1-4 items based on substance — not always 3. Include numbers, dates, names when available.
- topicTag: a short label for the ongoing story thread (used to group related articles). Use title case.
- No "In this article..." or "This article discusses..." openers.
{{ruleInstruction}}

Title: {{title}}
{{description}}
