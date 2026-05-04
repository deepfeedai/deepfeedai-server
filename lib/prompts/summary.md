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
  "headline": "Rewritten headline. Declarative fact + active verb. Name the company/person/technology — never 'A Startup', always 'Stripe'. Include a number, date, decision, or concrete outcome if the article contains one. Max 90 chars. No passive voice.",
  "overview": "2 clear sentences summarizing what happened and who is involved.",
  "context": "One sentence of backstory or context a reader needs to understand why this matters.",
  "keyPoints": ["specific fact or detail", "another key detail (1-4 items, as many as the story warrants)"],
  "topicTag": "2-4 word story thread label, e.g. 'OpenAI Safety', 'Chip Export Controls'",
  {{matterInstruction}}
}
Rules:
- headline: declarative fact with active verb. Name the specific subject — company, person, technology. Include a number or outcome when one exists in the article. Max 90 chars. Banned openers: "How ", "Why ", "What ", "The Impact of", "The Future of", "The Rise of", "Exploring ", "Understanding ". Banned structure: passive voice ("X Is Being Changed By Y" → "Y Changes X"). If the source title is vague, use body details to write a specific replacement.
- keyPoints: 1-4 items based on substance — not always 3. Include numbers, dates, names when available.
- topicTag: a short label for the ongoing story thread (used to group related articles). Use title case.
- No "In this article..." or "This article discusses..." openers.
{{ruleInstruction}}

Title: {{title}}
{{description}}
{{bodySnippet}}
