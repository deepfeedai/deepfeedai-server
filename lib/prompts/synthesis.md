---
operation: synthesis
tier: balanced
maxTokens: 4096
version: 2
---
## system
{{systemPrompt}}

## user
Synthesize the following {{articleCount}} related sources published over the last {{timespan}} into an original analytical article. Provide your own analysis and insights connecting the themes. Write in your distinctive voice and style.

Topic area: {{topic}}
{{structuralBrief}}
Sources (cite these inline using the format [1], [2], etc.):
{{sourceSummaries}}

Requirements:
- Open with a strong lede that hooks the reader — a surprising finding, a sharp contrast, or a concrete detail. Do NOT open with generic phrases like "In the rapidly evolving world of..." or "In a significant development..."
- When referencing information from a source, cite it inline using single-source brackets: [1], [2], etc. When multiple sources support the same claim, use CONSECUTIVE single brackets like [1][2][3] — NEVER comma-separated [1, 2, 3] or ranges [1-3]. The reader client only links single-number brackets, so comma-lists render as unclickable plain text.
- Where sources disagree or offer different angles, highlight the contrast.
- Close with a forward-looking "so what" — what this means for the reader and what to watch next.
- Write {{paragraphCount}} paragraphs of analytical prose. No section headers, no bullet points, flowing paragraphs only.
- If you reference your OWN prior article (listed above in "recent coverage"), use the structured tag [@ID] or [@ID|short label]. The server expands this to a proper link. Examples:
    "As I noted last week [@123], the trend is clear."
    "This builds on my [@123|earlier piece] on regional consortia."
  Do NOT write bare phrases like "[my prior coverage]" or "[Raj's earlier piece]" — those are not links.

Respond in exactly this format — no extra commentary:
TITLE: [a specific, compelling, publication-ready headline — not generic, not clickbait]
EXCERPT: [1-2 sentence hook that captures the article's key insight — max 280 characters]

[your article text with inline [1], [2] citations and [@ID] prior-coverage tags]

FOLLOWUPS:
Q1: [a sharp, specific question the reader is now wondering — name a company, person, or technology. Not "What are the implications?" but "Can AMD's MI350 actually compete at this price point?"]
A1: [2-3 sentences answering directly in your voice. Never say "the article states" or "according to the article" — you ARE the writer, speak from your own analysis. Use [N] citations.]
Q2: [a contrarian or "what's being missed" question — the angle no one is talking about yet]
A2: [answer in your voice — offer a take, not a summary]
Q3: [a forward-looking question with a specific timeframe or trigger — not "What's next?" but "Will this survive the next earnings cycle?"]
A3: [answer in your voice — make a call, hedge if needed, but have a point of view]
