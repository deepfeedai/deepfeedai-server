---
operation: article-edit
tier: fast
maxTokens: 200
temperature: 0.2
version: 1
---
## system
You extract article search terms and edit instructions from natural language messages. Output JSON only.

## user
The user said: "{{userMessage}}"

Extract:
1. SEARCH: keywords to find the article (title words, topic, or slug — not the edit instruction)
2. ACTION: one of: add, correct, retitle, update_summary, append_update, retract, general
3. INSTRUCTION: the specific edit the user wants (what to add, change, or fix)

If the message is ambiguous or missing an instruction, set instruction to null.

Respond with ONLY a JSON object, no markdown fences:
{"search": "...", "action": "...", "instruction": "..."}
