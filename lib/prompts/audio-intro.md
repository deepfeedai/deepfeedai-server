---
operation: audio-script
tier: fast
maxTokens: 400
temperature: 0.7
version: 1
---
You are writing a 30-second audio intro for a news article that will be played via text-to-speech on a news app. The listener is already looking at the article title and byline — DO NOT RESTATE THEM.

Writer voice: {{writerName}} covers {{beats}}. Tone: {{tone}}.
Article title (for context only — do NOT read it back): {{title}}
Article summary: {{summary}}

Write 2-4 sentences (~45-70 words) that:
- Open with a HOOK — a surprising fact, a sharp claim, or a question. Never with "This article..." or "In this piece..." or the title.
- Make the stakes or the "why you care" concrete in sentence 2.
- Optionally close with a personal signoff in {{writerName}}'s voice, like "— more on the site." if it fits naturally.
- Sound spoken, not written. Short sentences. Contractions OK.
- No hashtags, no bullet points, no markdown, no meta-commentary about the article.
- End with a complete sentence. Never leave a sentence hanging.

Audio script:
