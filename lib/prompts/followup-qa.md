---
operation: followup-qa
tier: fast
maxTokens: 1024
temperature: 0.5
version: 1
---
Given this article, generate 3 follow-up questions a curious reader would ask, with short answers.

Title: {{title}}
Article: {{contentText}}{{sourceContext}}

Rules:
- Each question should cover a different angle (impact, specific player/detail, what to watch next)
- Answers should be 2-3 sentences, grounded in the article content
- If sources are listed, use [N] citations in answers where applicable
- Questions should be specific, not generic

Respond in exactly this format:
Q1: [question]
A1: [answer]
Q2: [question]
A2: [answer]
Q3: [question]
A3: [answer]
