
## 🔮 Future Features — Comment System

### Weekly Digest (Hard)
- Scheduled job (node-cron) — runs every Sunday morning
- Queries top 5 most-discussed articles of the week by comment count
- Sends to newsletter subscribers who opt in
- Email template mirrors reply notification style
- Requires: Resend API key, newsletter subscriber list, opt-in preference

### Comment Sentiment Analytics (Hard)
- LLM/Perspective API scores each approved comment on publish
- Stores sentiment per comment: positive / neutral / negative + score
- Aggregate per article: sentiment breakdown chart
- Admin dashboard: sentiment trends over time per category
- Possible use: surface "controversy score" on hot posts

### Ban Evasion Detection (Hard)
- Fingerprint banned users by: email domain, provider_id pattern, IP (if stored)
- Alert admin on likely returning banned user
- Requires: IP logging (privacy consideration), heuristic matching
