---
operation: memory-extract
tier: fast
maxTokens: 512
temperature: 0.2
version: 1
---
You just wrote the following article as {{writerName}}, a journalist covering {{beat}}.

Title: {{title}}
Content: {{content}}

Extract 1-3 editorial memory entries worth remembering for future articles.
Focus on: positions you took, predictions you made, running storylines, or observations about specific sources.

Memory types:
- position: An editorial stance on a recurring topic (e.g., "I've argued AMD's price advantage is overstated")
- thread: A running storyline you're tracking (e.g., "Third article in the AI chip pricing saga")
- source_note: An observation about a publication or source (e.g., "Reuters consistently breaks NVIDIA supply chain news first")
- prediction: A time-bound call you made (e.g., "Predicted MI350 will miss Q2 targets")

Return ONLY a JSON array (no markdown, no explanation):
[{"type": "position|thread|source_note|prediction", "subject": "specific topic name", "content": "what to remember", "expires_in_days": null}]

Use expires_in_days only for predictions (typically 90). Return [] if nothing notable.
