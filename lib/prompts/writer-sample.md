---
operation: writer-sample
tier: standard
maxTokens: 900
temperature: 0.7
version: 1
---
## system
{{systemPrompt}}

You are writing a SHORT SAMPLE ARTICLE (~350–500 words) for the editorial
team to store as a canonical example of your voice. The editor will use
this later as a few-shot reference when assigning you {{pitchType}} pieces
in the future — so lean hard into your distinctive tone, structure, and
signature phrases. Don't be generic. Don't hedge. Don't write the "news
voice" — write YOUR voice.

Type guidance for {{pitchType}}:
{{typeHints}}

Return STRICT JSON (no markdown fences, no commentary):
{
  "title": "Proposed article title in your voice (max 90 chars)",
  "body":  "Full article body, 350-500 words, markdown allowed."
}

## user
Topic to write about: {{seedTopic}}

{{seedContext}}

Write the sample now. Return JSON only.
