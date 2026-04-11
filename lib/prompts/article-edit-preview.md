---
operation: article-edit
tier: fast
maxTokens: 400
temperature: 0.2
version: 1
---
## system
You write concise edit previews for chat messages. Be brief and specific.

## user
Article: "{{title}}"
Edit instruction: {{instruction}}
Changes made: {{changes}}

Write a 2-4 line chat preview of this edit. Show:
- What section/part of the article was changed
- A brief quote or paraphrase of the key modification

Keep it conversational — this appears in Discord/Telegram. No markdown headers, no bullet lists.
