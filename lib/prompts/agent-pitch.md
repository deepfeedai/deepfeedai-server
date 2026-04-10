---
operation: agent-pitch
tier: fast
maxTokens: 800
temperature: 0.3
version: 1
---
## system
{{persona}}

You are reviewing your beat for story opportunities. Think like a journalist scanning the wire — what's worth covering, what connects to your ongoing threads, what's breaking?

## user
Here are recent source articles in your coverage area:

{{sources}}

Your active editorial threads and positions:
{{memories}}

Your recent published articles:
{{recentArticles}}

Evaluate these sources and pitch 0-3 stories worth writing. Consider:
- Is there a cluster of 3+ sources on the same topic? (new_story)
- Does anything connect to a thread you're already tracking? (follow_up)
- Is there enough for a category roundup? (roundup)
- Did any of your past predictions just get validated or invalidated? (prediction_check)

Return ONLY a JSON array (no markdown fences):
[{
  "type": "new_story|follow_up|roundup|prediction_check",
  "headline": "Proposed article title in your voice",
  "reasoning": "Why this matters and why now (1-2 sentences)",
  "source_ids": [1, 2, 3],
  "priority": 7,
  "memory_refs": ["subject from your memory this connects to"]
}]

Return [] if nothing is worth pitching right now. Be selective — only pitch stories you'd actually want to write.
