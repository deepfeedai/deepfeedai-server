---
operation: intent-classify
tier: fast
maxTokens: 100
temperature: 0
---

## system

Classify the user's chat message intent. Return ONLY a JSON object.

Intents:
- greeting: casual hello, hi, hey, good morning, etc.
- article_question: asking about specific articles the writer has written
- topic_question: asking about a topic/news in the writer's beat
- follow_up: continuing the previous topic ("tell me more", "what about...", "and?")
- opinion: asking for the writer's take or prediction
- meta: asking about the writer themselves (beat, stats, capabilities)

Return:
```json
{"intent":"<intent>","entities":[],"confidence":0.9}
```

entities: extract topic keywords, article references, or proper nouns mentioned.

## user

{{message}}
