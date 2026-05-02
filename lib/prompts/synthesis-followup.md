---
operation: synthesis-followup
tier: balanced
maxTokens: 3000
version: 2
---
## system
{{systemPrompt}}

## user
Write a follow-up article based on new source material. This story already has prior coverage — the reader knows the background. If a story arc was listed in the system prompt above, your job is to ADVANCE that arc, not restart it.

Topic: {{topic}}
Most recent prior article (DO NOT repeat this — build on it): "{{priorTitle}}"

[PRIOR COVERAGE — do not re-report this]:
{{priorContent}}

[NEW SOURCE MATERIAL — report only this]:
{{sourceSummaries}}

Requirements:
- Open with WHAT IS NEW or WHAT HAS CHANGED since the prior coverage. Do not summarize the original story.
- Do NOT re-explain what was already covered. Assume the reader has read the prior piece(s).
- Reference prior reporting naturally where helpful: "Since we reported...", "New details confirm...", "Updating our earlier coverage..."
- When you reference your OWN prior pieces in this thread, use the [@ID] tag (e.g. "as I noted [@123]") so the link gets expanded — never write bare phrases like "[my prior coverage]".
- Add context only when it is essential to understand the new development.
- When referencing new information from a source, cite it inline using [1], [2], etc. Use consecutive single brackets like [1][2][3] — never comma-lists or ranges.
- Close with updated implications or what to watch next.
- Use **bold** to emphasize 1–3 key phrases or statistics. Use sparingly.
- Target: 250–450 words. Concise. The update is the story, not the background.

Respond in exactly this format — no extra commentary:
TITLE: [a headline that signals this is new information — not a restatement of the original story]
EXCERPT: [1-2 sentence update hook — what changed. Max 280 characters.]
PULL_QUOTE: [the single most striking sentence from your article — a concrete finding, a sharp contrast, or a memorable claim. Must appear verbatim in the article body. Max 160 characters.]
TOPIC_TAG: [2–4 title-case words naming the ongoing story — use the SAME tag as the prior coverage so the thread stays grouped. e.g. "OpenAI Board Crisis"]

[your follow-up article text with inline [N] citations and [@ID] back-references]

FOLLOWUPS:
Q1: [what readers most want to know given the new developments]
A1: [answer directly in your voice — 2-3 sentences]
Q2: [what remains unresolved or uncertain]
A2: [answer in your voice — acknowledge uncertainty if present]
