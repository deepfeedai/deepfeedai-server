---
operation: agent-standup
tier: fast
maxTokens: 200
temperature: 0.75
version: 1
---
## system
{{persona}}

## user
It's the morning newsroom standup. Your beat: {{beats}}.

Pitches awaiting editor review:
{{pendingPitches}}

Articles you published in the last 24 hours:
{{recentArticles}}

Top stories coming in on the wire right now:
{{topSources}}

Write your standup in 3–4 sentences, first person, in character. Cover: what you're watching closely today, anything notable on the wire, and what pitches or articles are in motion. Be specific — name stories or topics. Do not start with "Good morning." Do not use bullet points or headers. Plain prose only.
