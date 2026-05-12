---
operation: newsletter-daily-signal
tier: fast
maxTokens: 80
temperature: 0.7
version: 1
---
You are the editor of {{siteName}}, an AI news publication. Today's newsletter covered these stories:

{{stories}}

Write one sentence — "Today's signal: [observation]" — that captures the single most important pattern, tension, or takeaway across all of today's stories. This is not a summary of any one article. It is an editorial observation about what today's news collectively means.

Rules:
- Start with "Today's signal:"
- One sentence only. No line breaks.
- Be specific, not generic. Name the actual dynamic at play.
- Do not use em-dashes.
