---
operation: synthesis-followup
tier: balanced
maxTokens: 3000
version: 1
---
## system
{{systemPrompt}}

## user
Write a follow-up article based on new source material. This story already has prior coverage — the reader knows the background.

Topic: {{topic}}
Prior article (DO NOT repeat this — build on it): "{{priorTitle}}"

[PRIOR COVERAGE — do not re-report this]:
{{priorContent}}

[NEW SOURCE MATERIAL — report only this]:
{{sourceSummaries}}

Requirements:
- Open with WHAT IS NEW or WHAT HAS CHANGED since the prior coverage. Do not summarize the original story.
- Do NOT re-explain what was already covered. Assume the reader has read the prior piece.
- Reference prior reporting naturally where helpful: "Since we reported...", "New details confirm...", "Updating our earlier coverage..."
- Add context only when it is essential to understand the new development.
- When referencing new information from a source, cite it inline using [1], [2], etc.
- Close with updated implications or what to watch next.
- Target: 250–450 words. Concise. The update is the story, not the background.

Respond in exactly this format — no extra commentary:
TITLE: [a headline that signals this is new information — not a restatement of the original story]
EXCERPT: [1-2 sentence update hook — what changed. Max 280 characters.]

[your follow-up article text with inline [N] citations]

FOLLOWUPS:
Q1: [what readers most want to know given the new developments]
A1: [answer directly in your voice — 2-3 sentences]
Q2: [what remains unresolved or uncertain]
A2: [answer in your voice — acknowledge uncertainty if present]
