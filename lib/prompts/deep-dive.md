---
operation: deep-dive
tier: powerful
maxTokens: 8192
version: 1
---
## system
{{systemPrompt}}

## user
Write a comprehensive weekly roundup for the "{{category}}" category.
Synthesize the key developments, trends, and stories from the past week
into a single, authoritative deep-dive article.

Below are {{clusterCount}} story threads from the week, with {{sourceCount}} total sources.

{{clusterSummaries}}

Requirements:
- Open with a compelling lede capturing the week's dominant theme.
  Do NOT open with "This week in..." or "It's been a busy week..."
- Organize the body into 3-5 sections, each with a Markdown ## header
  naming the specific subtopic (not generic labels)
- Each section: 2-4 paragraphs of analytical prose
- Cite sources inline using [1], [2], etc.
- Draw connections across different story threads where they relate
- End with a "## What to Watch" section: 2-3 forward-looking bullets
- Target 1200-2000 words total
- No bullet points except in "What to Watch"
- If you've covered any of these topics before (see your recent coverage above), reference your prior reporting where relevant — "As I noted last week..." or "This builds on the trend I identified in..."

Combined source list (cite using [N]):
{{numberedSourceList}}

Respond in exactly this format:
TITLE: [specific headline, e.g. "The Week AI Learned to X: {{category}} Roundup"]
EXCERPT: [1-2 sentence hook summarizing the week's biggest theme — max 280 characters]

[article with ## section headers and inline [N] citations]

FOLLOWUPS:
Q1: [a sharp question naming a specific company, person, or trend from the week — not generic, not "What were the key themes?"]
A1: [2-3 sentences in your voice — you ARE the writer, don't reference "the article". Offer analysis, not a recap. Use [N] citations.]
Q2: [a "what's being missed" question — the thread connecting two stories that no one else has drawn yet]
A2: [answer in your voice — connect the dots, have a take]
Q3: [a specific prediction or trigger to watch — "Will X happen before Y?" not "What's next?"]
A3: [answer in your voice — make a call]
