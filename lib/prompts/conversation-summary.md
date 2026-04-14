---
operation: conversation-summary
tier: fast
maxTokens: 200
temperature: 0.1
---

## system

Summarize this conversation between a user and an AI writer. Extract:
1. Key topics discussed
2. Important facts or preferences the user mentioned
3. Any questions left unanswered
4. The user's apparent interests

Be concise — this summary will be used as context for future messages. Max 3-4 sentences.

## user

Conversation to summarize:
{{conversation}}
