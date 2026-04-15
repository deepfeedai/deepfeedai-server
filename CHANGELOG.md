# Changelog

All notable changes to Deep Feed AI Admin are documented here.

---

## Unreleased

### Added

- feat(settings): Chat Agent Engine selector (single-shot vs langgraph) in admin Settings UI. Required for LangGraph-dependent features (editor-commissioned stories, Graphic Designer agent) without SQL.
- feat(designer): generateStandaloneImage tool — Iris can now directly generate images from freeform concepts (profile photos, reference mockups, concept art) with style/composition/mood/aspect overrides. Counts against daily regen budget. Persona updated to surface the capability.

### Fixed

- fix(providers): strip JSON Schema keywords Gemini function-calling rejects (additionalProperties, $schema, default). Unblocks LangGraph tool use on Gemini-chat tenants — was silently falling back to single-shot on every tool-bound conversation.
- fix(designer): tightened Iris persona to generate images immediately instead of asking clarifying questions; hard rule against "I can't generate images"; repair migration upgrades any legacy Iris writer to role='designer'.
- fix(security): atomic action-token burn (closes double-approve race), idempotency guards on article.publish/revise/kill handlers, slug collision prevention in editor-commissioned ingest, Telegram webhook secret-token verification, synchronous cohort-sibling burn to preserve single-use guarantee across channels.
- fix(notifications): legacy PUT /articles/:id/approve + /reject now fire article_published + article_revision_requested events; editorial-review role query expanded to include superadmin + is_admin; added diagnostic log in notify() to surface silent failures.
- fix(editorial): optimistic UI on pitch approve/reject/assign — card removes immediately on click, re-inserts on error; Pitches tab now polls every 15s while visible so cross-channel actions reflect without manual refresh.

### Added

- feat(newsroom): Graphic Designer agent ("Iris") — auto-art-directs thumbnails + writer avatars via 8 style families. New tools: setTenantStyleGuide, reviewRecentThumbnails, regenerateThumbnail, regenerateWriterAvatar, proposeStylePivot (button-gated), batchRegenerateWeakThumbnails. New role='designer', hidden from public /writers, included in admin role filter. Daily regeneration budget guard. Feature flag graphic_designer (default off).
- feat(admin): mobile-usable high-value pages — Editorial, Pitches, Notifications, Feed Inbox, Activity Feed. Tables stack as cards under 768px, tab bars scroll horizontally with snap, action buttons go full-width on narrow viewports. "Approve from bed" flow is now actually usable on a phone.
- feat(admin): mobile primitives — responsive breakpoints, touch-friendly button sizing, bottom-sheet modals under 600px, off-canvas sidebar drawer with hamburger toggle, table horizontal-scroll affordances, iOS-zoom-safe form inputs. Foundation for mobile-friendly admin.
- feat(media): image prompt style system — 8 style families (editorial-illustration, documentary-photo, noir, minimalist-vector, isometric-tech, vintage-print, cinematic-poster, mixed-media); category-aware rotation with deterministic jitter; mood library tied to story tier; composition variety; shared negative prompt banning stock tropes; unified between article thumbnails + writer avatars. Tenant-level art_direction setting overrides rotation. Creativity target: 6-7/10 (was 3/10).
- chore(ai-router): embeddings now route through ai-router (was parallel resolver); deleted legacy lib/gemini-config.js (superseded by ai-key-resolver).
- feat(ai-router): voice provider abstraction (ElevenLabs wrapped behind lib/providers/elevenlabs.js) — audio + voice-chat now honor per-tenant provider overrides; visual-concept pre-pass also routed through ai-router (was Gemini-locked). Closes the last BYOK bypasses in the media pipeline.
- feat(feed): originals-only public feed with story-level tiers, decay, and perspective grouping; admin articles list gains importance column + manual override; breaking-story dispatch gated through notifications/actions system.
- feat(admin): hide editor-role writers (Maxwell) from public site; admin Writers page gains role filter + grouping; admin users can set their own avatar + display name, rendered in newsroom chat.
- **feat(newsroom-chat):** chat now shows writer avatar + per-writer accent color (stored on writer, auto-generated fallback). New `writers.accent_color` column (nullable); `lib/writer-colors.js` hashes writer id into a 12-hue palette when no override is set. Admin writer settings gains a color picker + "Reset to auto". Chat bubbles use `color-mix` for a soft accent tint and the username renders in the writer's accent; avatar falls back to a monogram circle tinted with the accent.
- **feat(notifications):** stale-action cleanup + cohort cascade. Tokens minted in one `notify()` fanout now share a `cohort_id`; a successful action in any channel cascades `used_by_source=cascade` to siblings (web bell, Telegram, etc.) without deleting the audit trail. `user_notifications` payloads are rewritten in place so used buttons render as disabled `✓ <label> (from <source>, <relative time>)` pills and expired tokens render as `⌛ Expired`. Telegram sibling keyboards are stripped via `editMessageReplyMarkup`. New daily cron `sweepExpiredActionTokens` deletes tokens whose expiry is >7 days old. Adds `cohort_id`, `notification_id`, `used_by_source`, `used_by_user_id`, `telegram_chat_id`, `telegram_message_id` to `action_tokens`.
- feat(editor): "We need a story on X" Maxwell flow — draftEditorBrief + vetSources + findBestWriterForTopic + button-gated ingest-and-pitch via the notifications/actions system (project_editor_initiated_pitch)
- **feat(notifications):** schema foundation for cross-channel notifications + signed action tokens (PR-A of notifications/actions system). Adds `user_notifications`, `notification_preferences`, and `action_tokens` tables; feature flags `notifications_center` and `cross_channel_actions` (both default false); `lib/action-tokens.js` mint/verifyAndBurn skeleton. No endpoints or channel renderers yet.
- feat(notifications): unified `POST /api/actions/:token` endpoint + handler registry for approve/reject/assign/publish/revise/kill/dismiss (PR-B of notifications/actions system)
- feat(notifications): fire-and-forget `lib/notifications.js` service writing to user_notifications with optional action-button tokens
- feat(notifications): Telegram inline-keyboard renderer + callback_query action handling — pitch_created + review_needed events now dispatch to editor Telegram DMs with approve/reject buttons (PR-C of notifications/actions system)
- feat(notifications): web bell dropdown + `/notifications` page; polling-based unread count; inline action buttons hit `/api/actions/:token` end-to-end (PR-D of notifications/actions system)

---

## [4.9.1] — 2026-04-16

Same-day follow-up to v4.9.0 — Phase B polish, Story Levels backend, and the bug fix for enriched-articles missing from synthesized pitch output.

### Added

- **Story Levels backend** — `articles.importance` (standard / trending / major / breaking) auto-computed on publish from cluster velocity + source diversity + editorial score. Manual override via `PATCH /api/articles/:id/importance` sets `importance_locked=true`. Feature flag `story_levels`. Frontend badge deferred to `deepfeedai-web`. (#461)
- **+ New pitch modal** on the Pitches tab — pick source (id, internal URL, or external URL), writer, optional template, angle. (#460)
- **External URL support** in New Pitch modal — non-internal URLs are OG-scraped via `/api/fetch-url` then ingested via `/research/ingest` before pitch creation. (#462)
- **Angle templates** — 8 starter templates (compliance / technical / market / contrarian / explainer / forecast / sentiment / historical) prefill the angle textarea. (#464)
- **Pitch from Discover** — 📌 button on every Discover result; opens pitch modal pre-filled with that result; ingests + creates pitch in one step. (#465)
- **Reassign writer** — `PATCH /api/pitches/:id/assign` plus an "Assign writer" button on unassigned editor-tip pitches in the Pitches tab. (#460)
- **Editor identity in `/tip`** — when a `/tip` chat command comes from web chat (numeric admin user id), `requested_by_editor_id` is now populated. Discord/Telegram remain NULL since their userIds are platform snowflakes. (#460)

### Fixed

- **Enriched articles missing from synthesized pitch output** — clicking "Enrich sources" on a pitch then approving it didn't include the enriched articles in the generated piece. Three converging issues: async embedding timing, beat-category mismatch, 0.72 cosine threshold. Fixed via new `article_pitches.attached_article_ids JSONB` column populated by `/research/ingest` with `pitch_id`; `synthesizeFromPitch` now unconditionally unions attached + similarity-matched + source articles into the cluster. (#463)

---

## [4.9.0] — 2026-04-16

Major release. Three multi-phase initiatives shipped together: hybrid newsroom counter-angle pitches, on-demand external research, and the social-newsroom editor's workspace.

### Added — Hybrid Newsroom Phase B (counter-angle pitches)

- `article_pitches` table + feature flags `article_pitches` (boolean) and `max_originals_per_source` (numeric, default 2 — soft cap, editor override per pitch) (#441)
- REST endpoints: `POST/GET /api/pitches`, `POST /api/pitches/:id/approve`, `POST /api/pitches/:id/reject` with audit logging and override-required cap enforcement (#442)
- Writer-agent tool `proposeAngle(sourceArticleId, angleSummary)` for autonomous pitch submission, with dedupe + own-source detection (#443)
- `synthesizeFromPitch(pitchId)` synthesis fork — clusters around source via embedding similarity in writer's beats, generates an original under the pitching writer; `synthesis_meta.from_pitch` for provenance. Auto-triggers on approve via `setImmediate` (#444)
- Pitches tab on `/editorial` with override modal requiring justification when over cap (#445)
- Chat commands: `/pitch <id-or-url> -- <angle>` (writer) and `/tip <topic>` (editor) with backward-compat preserved on bare `/pitch` (#446)

### Added — External Research Phase 1 (web search + on-demand ingest)

- `articles.ingest_source` column (`rss` | `live` | `manual` | `enrichment`) for provenance filtering (#447)
- Feature flags: `agent_web_research` (boolean), `external_search_daily_cap` (200), `external_research_daily_cap` (50)
- `lib/research/` — Brave news + Hacker News (Algolia) + Reddit (public JSON) backends with normalized result shape, per-tenant quota, 12h response cache (#448)
- Writer/editor agent tool `enrichSources(topic, sources?, count?)` returning ranked candidates with publisher, score, snippet, age (#448)
- REST: `POST /api/research/search`, `POST /api/research/ingest` (dedupes by `source_url`, embeds, attaches to optional `pitch_id`) (#449)
- Editor-only agent tool `ingestExternalAsCurated(results, pitchId?)` (#449)
- `/tip <topic>` falls back to external research when no internal source matches — auto-ingests top 3 candidates and creates a pitch on the strongest (#450)
- "Enrich sources" button on Pitches tab opens search modal, editor checkboxes results to ingest, attaches to pitch (#451)

### Added — Social Newsroom (Editor's Workspace, 4 phases)

- **Phase 1** — In-admin per-writer chat (`/newsroom-chat.html` + `/api/newsroom-chat`) routed through the existing `messaging.handleIncoming` so single-shot vs LangGraph + all slash commands work identically. Feature flag `editor_workspace` (#452)
- **Phase 2** — Activity feed (`/newsroom-activity.html` + `/api/newsroom-feed`) with chronological cards for `published` / `pitched` / `pitch_approved` / `pitch_rejected` / `enriched` events. New `newsroom_events` table; fire-and-forget `recordEvent()` helper called from publish + pitch + research hooks (#453)
- **Phase 3** — Reactions (🔥💡🚩👀, toggle behavior, unique per actor+emoji) and threaded replies on feed cards. New tables `newsroom_reactions` + `newsroom_replies`. Feature flag `newsroom_social` (#454)
- **Phase 4a** — Agent presence (`writers.presence_state`: idle / chatting / drafting / researching / waiting-on-editor) with state TTLs auto-reset by a 5-min cron sweep. UI dot indicators on chat roster (#456)
- **Phase 4b** — `@mentions` in feed replies dispatch to the named writer's agent via `messaging.handleIncoming` with contextKey `feed:<eventId>`. Agent reply posts back as a threaded reply attributed to the writer. Loop-guarded (agent replies don't re-trigger) and per-event capped at 5 autonomous agent replies (#457)

### Fixed

- `users` table join used non-existent `u.name` column — corrected to `u.username` in `/api/newsroom-feed/.../replies` and `/api/pitches` queries (#455)

### Migration / rollout notes

- All new tables use `CREATE TABLE IF NOT EXISTS`; new columns use `ADD COLUMN IF NOT EXISTS` — no manual migrations
- All new behavior is feature-flagged off by default; tenants opt in via:
  - `article_pitches` (Phase B)
  - `agent_web_research` (External Research)
  - `editor_workspace` (Social Newsroom Phases 1+2)
  - `newsroom_social` (Social Newsroom Phases 3+4 — requires editor_workspace)
- New cron job `presence-sweep` runs every 5 minutes per tenant
- Existing routes/UI unaffected when flags are off

---

## [4.8.2] — 2026-04-16

### Added — Hybrid newsroom Phase A + agent tools

- **Shared curated wire** — new feature flag `curated_shared_wire` (default off). When on, writers see curated source articles matching their beats, not only ones stamped `writer_id` at ingest. Synthesis stays `writer_id`-scoped so one-lead-per-cluster holds. (#432)
- **`listArticlesInBeat` tool** — broad browse of recent articles in a writer's beats (originals by writer_id + curated by beat-category when shared-wire allows). Covers "what's in your beat?" questions the semantic `searchArticles` tool was the wrong shape for. (#433)
- **`getArticleSources` tool** — returns the actual publisher + URL citations behind a writer's original via `source_article_ids`, or the single source row for a curated item. Stops the agent from inventing publisher names when asked "what sources are reporting on this?" (#435)

### Changed

- `searchArticles` tool gained explicit `status` values (ok / no_results / error / tool_unavailable) with guidance in each message so the agent stops characterizing successful-but-empty responses as "search is down." (#433)
- Writer persona honors explicit formatting requests (bullet lists, tables, numbered steps) over default narrative voice. (#437, #438)
- Writer persona's citation nudge is now gated on `chat_agent_engine='langgraph'` — single-shot tenants get an honest-fallback instruction instead, preventing the model from emitting tool-call syntax as plain text. (#436)

### Fixed

- `/clear` and `/new` now delete `conversation_history` and `conversation_summaries` rows in addition to the in-memory buffer. Previously the next turn reloaded prior history from DB and the conversation appeared to continue. (#434)
- Pre-existing arg-order bug in `searchArticles`: `limit` was being passed as `siteUrl` to `findRelevantArticles`, which caused malformed article links. (#433)

---

## [4.8.1] — 2026-04-15

### Added — Feed Inbox usability

- **Recategorize bulk action** — 🏷️ button on `/feed-inbox` re-runs category detection through the same dry-run preview modal pattern as `/articles` (#427)
- **Status, Score, and Category filters** — Published/Draft/Review/Archived; score bucket (High ≥7 / Mid 5–6 / Low / No score); Category dropdown mirroring `/articles` filter bar (#428, #429)

### Fixed

- Curated articles stuck as "Uncategorized" on re-run — the recategorize loop was dropping `source_url` and the source's `default_category` when calling `detectCategory`, losing the source-affinity (+2) and default-category (+3) scoring boosts that applied at ingest time (#427)
- Category filter on `/feed-inbox` was already in the HTML but hidden because `window._siteCategories` was never loaded on that page — now calls `loadCategories()` on init (#429)

---

## [4.8.0] — 2026-04-14

### Added — LangGraph chat agent (pilot)

- Feature-flagged StateGraph (`chat_agent_engine` setting, default off) runs conversations through a tool-loop graph: load context → agent → (tools → agent)* → persist → END
- Six tools on `ToolContext`: `searchArticles`, `fetchArticle`, `listWriterBeats`, `getWriterMemory`, `updateWriterMemory`, `checkRecentColleagueWork`
- `ai-router-chat-model.ts` wraps `ai-router` as a LangChain `BaseChatModel`; tool calls round-trip through provider-native tool-use (Anthropic `tool_use`, OpenAI `tool_calls`, Gemini `functionDeclarations`)
- OpenTelemetry tracing bootstrap (no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` unset)
- `ai_usage.agent_session_id` UUID correlates the N rows from one user turn through a tool loop
- Cached vs fresh input token split (`input_tokens_cached` / `input_tokens_fresh`) with per-model cache pricing (Anthropic 10%, OpenAI 50%, Gemini 25%)
- Sessions tab in AI usage dashboard with per-iteration expand (cached/fresh/cost/duration)

### Added — Unified AI providers (text + image)

- `lib/providers/gemini.js` extracted to match the openai/anthropic/openrouter/ollama adapter layout
- `lib/providers/imagen.js` + `lib/providers/dalle.js` — unified image adapter contract
- `ai-router.generateImage()` dispatches from `settings.image_provider_config` (per-op + default override), falls back to legacy `imagen_model` for backward compat
- DALL-E pricing: `dall-e-3` $0.08/image standard, `dall-e-3-hd` $0.12/image HD at 1792x1024
- Settings: new **Image Provider** card with default + per-operation dropdowns (thumbnail-render / inline-image)
- Settings: **Google Gemini card folded into AI Providers** — Gemini is now a first-class BYOK provider alongside OpenAI/Anthropic/OpenRouter/Ollama
- `BYAI` renamed to `BYOK` throughout UI and comments; DB keys preserved (`is_byai` column, `byai` row in feature table)

### Added — Synthesis quality

- Semantic clustering via `pgvector` cosine similarity (≥0.72) with keyword-coherence guard, dispatched by `settings.synthesis_clustering_mode`
- Embedding backfill now covers curated articles with `COALESCE(enriched_summary, tldr_overview, summary)`
- `min_cluster_size` default 3 → 2 (primary + secondary source newsroom model) with floor clamp
- `GET /api/synthesis/diagnose/:writerId` + "Why no results?" UI button explains 0-cluster outcomes

### Added — Audit + observability (Tier 1)

- `logAudit` on all public user-auth endpoints: register, login success/fail/blocked, verify, forgot + reset password, account delete — with machine-readable `reason` codes on failure
- `logAudit` on all Stripe webhook events: subscription activate/cancel/update, credit purchase/refund, payment failed — via pseudo-req helper that tags tenant + `stripe:<event_id>` identity
- `middleware/rate-limit-log.js` — reusable handler emits structured `logger.warn` + audit row on security-sensitive 429s; wired into 10 limiters across server.js and user-auth.js
- `log-retention` cron purges `app_logs` + `request_logs` (30d) and `analytics_events` (90d), per-tenant overrides with safety floors
- Log viewer search matches JSONB `context` (app_logs) and `stack_sample` (error_aggregates) alongside `message`
- Embedding provider cache busts on settings changes (parity with chat + image provider caches)

### Added — SEO + agent activity

- `generated_title` surfaces everywhere the user sees an article title: "Just published" messages (Discord/Telegram/Slack), newsroom brief, standup, writer status, agent tool returns, `findRelevantArticles` (vector + keyword)
- `article.generated_title` kept in sync in memory after `prewarmSummary` writes it back to DB

### Added — Tooling

- TypeScript via `tsx` CJS preload scoped to `lib/agents/**` — no build step, runs in production
- Railway `railway.json` `startCommand` preloads `tsx/cjs` so TS agent files resolve at boot
- `MaxListeners` bumped to 100 for AbortSignal stacking in the tool loop

### Fixed

- Writer persona regenerate (refresh / rewrite modes) — two new prompts + `POST /admin/writers/:id/regenerate-persona`
- Discord slash command writer avatar handling (object responses)
- Chat agent hallucination: stronger tool description + grounding system prompt + structured `{status: "no_results"}` return
- Truncation-safe JSON parser recovers partial first element when AI arrays get cut mid-string
- `routes/ai-usage.js /sessions/:id` was calling sqlite-style `db.prepare().all()` against a pg pool

---

## [3.0.0-beta.6] — 2026-03-26

### Added — Feature Toggle System

- **Centralized feature registry** — 23 toggleable features across 7 categories (content, AI, media, engagement, distribution, admin, discovery) managed via new `feature_definitions`, `plan_features`, and `tenant_feature_overrides` tables
- **Per-tenant feature overrides** — platform admins can override any feature for a specific tenant with optional reason and expiry; useful for demos, trials, and custom arrangements
- **`requireFeature()` middleware** — Express middleware for route-level feature gating; returns 403 with upgrade prompt when feature is disabled
- **Feature enforcement on routes** — applied to audio generation (`audio`), image generation (`image_generation`), synthesis (`auto_synthesis`), deep dives (`deep_dives`), newsletter send (`newsletter`), comment posting (`comments`), and custom role creation (`custom_roles`)
- **Admin API** — `GET/PUT /api/admin/features` for plan-level configuration; `GET/PUT/DELETE /api/admin/features/tenants/:id/features/:key` for per-tenant overrides
- **Public features endpoint** — `GET /api/features` returns flat feature map for the current tenant (cached 60s server-side, 5min client-side)
- **Self-hosted mode** — `DEPLOYMENT_MODE=single` enables all features by default; explicit overrides still respected
- **Feature matrix UI** — platform admin Plans page now shows a full feature matrix with toggle switches per plan
- **Tenant feature card** — tenant detail page shows all resolved features with override badges; click to override or reset
- **Frontend feature awareness** — web frontend loads features on page init via sessionStorage-cached fetch; self-hosted sites get all features via Proxy

### Added — Database (Phase 18)

- `feature_definitions` table — registry of all toggleable features with name, description, category, type, default value
- `plan_features` table — plan-level feature values (plan + feature_key composite PK)
- `tenant_feature_overrides` table — per-tenant exceptions with reason, granted_by, and optional expiry

### Changed

- `lib/plan-limits.js` — `checkFeatureEnabled()` now delegates to feature registry with backward-compatible legacy column name mapping
- `routes/media.js` — replaced inline `checkFeatureEnabled` call with `requireFeature('audio')` middleware
- Existing `plan_limits` boolean columns (`audio_enabled`, `custom_domain_enabled`, `seo_titles_enabled`) preserved for backward compatibility; will be deprecated in next release

---

## [3.0.0-beta.5] — 2026-03-25

### Added — Featured Article Rotation

- **Automated featured rotation** — new cron job (`featured-rotation`, hourly check) automatically cycles the featured article carousel using a configurable scoring strategy; actual rotation interval is controlled by the `featured_rotation_interval_hours` setting
- **3 rotation strategies** — `score` (composite: 40% views + 30% quality + 20% recency + 10% diversity bonus), `category-balanced` (30% views + 25% quality + 25% recency + 0.2 diversity bonus, tracks categories assigned in-cycle to maximise variety), `recency` (pure recency-decay score)
- **Pinning** — `PUT /api/articles/:id/pin` toggles `is_pinned` on a featured article; pinned articles are never rotated out; pinning an unfeatured article auto-features it in the next open slot
- **Manual trigger** — `POST /api/articles/rotate-featured` forces an immediate rotation cycle (bypasses interval check); requires `articles.update` permission
- **Rotation status** — `GET /api/articles/rotation-status` returns current config, all featured articles with their source/pin/expiry state, and the last 10 log entries
- **Rotation log** — `GET /api/articles/rotation-log` returns paginated rotation history (default 20, max 100 rows)
- **Expiry support** — `PUT /api/articles/:id/feature` now accepts `featured_until` (ISO 8601 timestamp); expired featured articles are filtered from the public API and cleaned up at the next rotation cycle
- **`featured_source` tracking** — featured articles are tagged `'auto'` (cron-rotated) or `'manual'` (admin-set); this governs which slots the rotation cron is allowed to reclaim

### Added — Database (Phase 17)

- `articles.last_featured_at TIMESTAMPTZ` — when the article was last promoted to featured by auto-rotation
- `articles.featured_until TIMESTAMPTZ` — optional expiry; auto-rotation sets this to the next expected rotation time
- `articles.is_pinned INTEGER DEFAULT 0` — pin flag; pinned slots are never reclaimed by rotation
- `articles.featured_source TEXT` — `'auto'` or `'manual'`; existing featured articles backfilled to `'manual'`
- `featured_rotation_log` table — per-tenant rotation audit log (slots filled, articles in/out, strategy used)
- New settings defaults: `featured_rotation_enabled` (`0`), `featured_rotation_interval_hours` (`12`), `featured_rotation_strategy` (`score`), `featured_rotation_pool_days` (`7`), `featured_rotation_cooldown_days` (`3`)

---

## [3.0.0-beta.4] — 2026-03-24

### Changed — Plan Limit Tuning
- **Business plan**: set storage cap to 50 GB (was unlimited/unset), max tenants to 10 (was unset)
- **Starter plan**: storage bumped from 500 MB to 1 GB to support ~250 articles/mo of thumbnails
- **Pro plan**: storage bumped from 5 GB to 10 GB to accommodate audio generation
- **Free plan**: granted 250 credits/month (25/day) so new users can preview AI features

---

## [3.0.0-beta.3] — 2026-03-24

### Changed — Plan Restructure
- Replaced 5-plan system (demo/trial/starter/pro/business) with 4 plans: **free**, **starter**, **pro**, **business**
- Free plan: 3 sources, 1 writer, 25 articles/mo, $0 AI budget, 50 MB storage
- Starter plan updated: 10 sources (was 20), 4 writers (was 6), 250 articles/mo (was 500)
- Trial is now a time-limited state (`trial_ends_at` on tenants) granting pro-level access, not a plan
- Default plan for new tenants changed from `starter` to `free`
- Budget gate blocks all AI operations when plan AI budget is $0 (free plan)
- Rate limiting: free plan gets 300 req/min, trial tenants get pro-level (1200 req/min)
- Existing demo tenants migrated to free, trial tenants migrated to starter

---

## [3.0.0-beta.2] — 2026-03-23

### Added
- `GET /admin/tenants/plan-limits` endpoint for platform dashboard wizard and quotas display

---

## [3.0.0-beta.1] — 2026-03-23

Multi-tenant platform release (beta).

### Added — Platform Admin
- **Platform admin tenant management** — create, suspend, reactivate, delete, purge tenants (#215)
- **Tenant owner assignment** — auto-created placeholder users linked to OAuth (#216-218)
- **Tenant switcher UI** — admin sidebar switcher for multi-tenant users (#221)

### Added — Multi-Tenant Auth
- **OAuth login rewrite** — public user OAuth flow for multi-tenancy (#219)
- **X-Tenant-Slug CORS** — preflight support for tenant slug header (#220)

### Added — Storage
- **Multi-tenant R2 storage** — platform-level config with tenant fallback (#222-228)
- **User image uploads** — image upload support for articles (#222)
- **Upload-only image field** — removed editable URL, upload with clear button (#224)

### Added — Integrations
- **Platform-level Gemini/Imagen** — centralized AI config with tenant fallback (#229)
- **ElevenLabs BYOK** — centralized via app-config with tenant override (#230)

### Changed
- **Backend URLs renamed** — olympus → portal, asgard → portal-staging (#213)

### Fixed
- Category dropdown showing tenant 1's categories for all tenants
- Duplicate appCfg declaration crash in media.js generate-audio handler

---

## [2.5.1] — 2026-03-20

### Changed
- **Article preview redesign** — redesigned preview to match frontend layout with markdown support (#206)

---

## [2.5.0] — 2026-03-20

### Added
- **Editorial workflow** — draft → review → published status pipeline (#202)
- **Editorial UI polish** — workflow-related UI improvements (#203)

---

## [2.4.0] — 2026-03-20

### Added
- **Infinite scroll** — replace paginated articles with infinite scroll loading (#200)
- **Featured carousel** — rotating featured article carousel (#200)
- **Dropdown fixes** — filter dropdown UI improvements (#200)

---

## [2.3.0] — 2026-03-20

### Added
- **AI-generated excerpts** — synthesis prompts request dedicated excerpt line from Gemini (#198)
- **Weekly deep dives** — category-level weekly synthesis with inline AI images (#197)

---

## [2.2.0] — 2026-03-20

### Added
- **Responsive card view** — responsive design and card view for articles page (#195)
- **Filter dropdowns** — filter dropdowns added to admin articles page (#194)

---

## [2.1.1-hotfix.1] — 2026-03-19

### Fixed
- **Storage R2 from DB settings** — R2 credentials read from DB settings with caller fixes (#193)

---

## [2.1.0] — 2026-03-19

### Changed
- Release merge: staging → main incorporating v2.0.3 through v2.0.6-hotfix.1 (#191)

---

## [2.0.6-hotfix.1] — 2026-03-19

### Fixed
- **Writer auto-assign FK violation** — foreign key violation on fresh installs (#190)

---

## [2.0.6] — 2026-03-18

### Fixed
- **Newsletter exclusion** — exclude uncategorized articles from newsletter (#189)
- **App config cache bust** — bust app config cache after settings save (#188)

---

## [2.0.5] — 2026-03-18

### Added
- **Engaging synthesis** — improved prompt, citations, metadata (#186)
- **Deferred TLDR** — defer TLDR generation to post-publish (#185)
- **Uncategorized bucket** — low-confidence articles go to Uncategorized (#184)

### Fixed
- **Automation tab crash** — add Monitoring category for audit-alerts job (#183)
- **Security hardening** — OWASP Top 10 + LLM prompt injection fixes (#182)
- **Media URL resolution** — use request host for media URL resolution (#178-181)

---

## [2.0.4] — 2026-03-18

### Fixed
- **Relative media URLs** — resolve relative media URLs to absolute in API responses (#181)

---

## [2.0.3] — 2026-03-17

### Fixed
- **Admin role permissions** — upgrade admin role to wildcard permissions (#176)
- **Audio generation guard** — require writer with ElevenLabs voice for audio generation (#175)

---

## [2.0.2] — 2026-03-18

### Improved
- **AI thumbnail prompts** — rewritten for more relevant, article-specific images. Gemini now produces concrete visual scenes instead of forced abstractions, with tone-matched color palettes (urgent = bold/warm, analysis = cool/muted, product launch = bright/clean)
- **Niche-independent image generation** — site name pulled from SiteConfig; removed hardcoded "tech news site" and `CATEGORY_STYLES` map so non-tech niches get appropriate thumbnails
- **DRY image prompt code** — `routes/media.js` now imports shared `getVisualConcept`/`buildImagePrompt` from `lib/media-helpers.js` instead of duplicating 60+ lines

---

## [2.0.1] — 2026-03-18

### Changed
- **Deprecate Voices page** — ElevenLabs voice ID now stored directly on each writer (`elevenlabs_voice_id` TEXT field) instead of indirectly via the `voices` table FK. Eliminates the Voices admin page, simplifies audio generation, and lets each writer own their voice config.
- **Voice preview on Writers page** — text input for ElevenLabs voice ID with inline preview button replaces the old voice dropdown
- **Simplified audio generation** — articles auto-use their writer's voice; removed voice picker modal from articles page
- **Data migration** — existing voice assignments automatically copied to writers on startup

### Removed
- Voices admin page (`/voices.html`)
- Voices API routes (`/api/voices`)
- Voice picker modal on articles page
- `voices.*` permissions from role seeds

---

## [2.0.0] — 2026-03-17

Production release of v2.0 — multi-tenancy, RBAC, AI writer generation, and niche independence.

### Added — Core
- **Multi-tenancy** — `tenant_id` on all tables, tenant-scoped queries/caches, per-tenant settings and API keys
- **Local auth + RBAC** — username/password authentication, role-based permissions with wildcard support, user management admin UI
- **Setup wizard** — guided onboarding with 11 niche templates, 69 diverse AI writers with Marvel/DC character names
- **Audit logging** — audit trail for all admin create/update/delete actions
- **Docker support** — Dockerfile + docker-compose.yml for containerized deployment

### Added — AI Writers
- **AI writer generation** — generate complete writer personas from tenant categories via Gemini (name, bio, tone, style, system prompt, keywords, gender, ethnicity)
- **AI avatars** — Imagen-powered writer portrait generation with gender and ethnicity descriptors
- **Writer diversity** — gender/ethnicity fields on writers table, ~50/50 gender balance across all niche templates
- **Per-writer AI summaries** — writer persona (tone, style_guide, system_prompt) used in Gemini TLDR generation with "stay in character" instructions
- **Real-time avatar polling** — avatars appear in writers table as they generate (no page refresh)

### Added — Discovery & Content
- **YouTube discovery & embed** — YouTube Data API v3 search, import as articles, inline embed playback
- **Discovery page** — Brave Search + NewsAPI + YouTube with year-based and custom date range filtering
- **Unassigned articles filter** — Writer filter pills (All/Unassigned/Assigned) on articles page
- **Bulk auto-assign writers** — batch endpoint using `findBestWriter()` scoring with pre-fetched writers for performance

### Added — Operations
- **Scheduled tasks management** — cron registry with per-run logging, admin API, visual schedule builder with live preview
- **Configurable live news query** — per-tenant search terms for the live-news cron

### Added — Niche Independence
- **Trends page** — dynamic Gemini prompts using tenant categories, "Top Mentions" instead of "Top Companies"
- **Trends tenant isolation** — `tenant_id` on trends_cache and trends_history tables

### Added — Security
- **SSRF protection** — protocol allowlist + private IP DNS block on `/api/fetch-url`
- **Cross-tenant cache fix** — `app-config.js` cache keyed by tenantId
- **Storage path traversal** — resolved path validation in local adapter
- **XSS hardening** — `escHtml()` sanitization, iframe sandbox attributes
- **RBAC bypass fixes** — permission checks on all admin endpoints

### Fixed
- Article update 400 error when URL fields are empty strings (preprocess to null)
- Writer article count includes only published articles
- `findBestWriter()` tiebreak logic avoids unnecessary COUNT queries
- Bulk assign validates input with parseInt, 200-article cap, and audit logging
- `ON CONFLICT` clause for trends_history uses composite `(tenant_id, snapshot_date)`

---

## [2.0.0-beta.11] — 2026-03-17

Scheduled tasks management, visual schedule builder, security hardening, and configurable live news.

### Added
- **Scheduled Tasks Management** — new Automation tab in Settings with 9 cron job cards, enable/disable toggles, manual "Run Now", and run history modal
- **Visual Schedule Builder** — replace preset dropdowns with frequency/hour-range/day-of-week controls, live `cronstrue` descriptions, and next 3 run times preview
- **Configurable live news query** — per-tenant search terms for the live-news cron (Settings > Integrations), with auto-publish toggle
- **Cron registry** — refactored 9 hardcoded cron jobs into `lib/cron-registry.js` with per-run logging to `cron_runs` table
- **Cron admin API** — `GET/PUT/POST /api/admin/cron` for listing, updating, triggering, and viewing history

### Added — Security
- **SSRF protection** — protocol allowlist + private IP DNS block on `/api/fetch-url`
- **Cross-tenant cache fix** — `app-config.js` cache keyed by tenantId
- **Storage path traversal** — resolved path validation in local adapter
- **XSS hardening** — `escHtml()` in admin topbar, showToast, logo preview sanitizer
- **Schedule frequency limits** — reject per-second expressions, enforce minimum intervals per job
- **Per-job run cooldowns** — newsletter 10min, audio 5min, others 1min

### Changed
- Audit archive uses `requirePermission('audit.delete')` instead of inline role check
- CORS tenant subdomain regex requires `https://` (was `https?://`)
- Admin role includes `cron.read`, `cron.update`, `cron.execute` permissions

### Fixed
- `media_enabled` set to 1 for YouTube imports so embeds render
- Discovery page no longer re-searches after importing (marks imported in-place)
- `getAppConfig()` called with tenantId in live-news and newsletter handlers
- Concurrent run guard prevents duplicate job execution

---

## [2.0.0-beta.7] — 2026-03-17

YouTube video discovery, import, and embed support.

### Added
- **YouTube Discovery** — search YouTube videos via Data API v3 on the Discover page (alongside Brave/NewsAPI)
- **YouTube video import** — import videos as articles with embedded playback; `embed_url` reconstructed server-side from video ID (zero-trust)
- **YouTube API key** — configurable in Settings > Integrations > Live News Sources (encrypted at rest)
- **Discovery date filters** — year-based and custom date range filtering on the Discover page (#150)
- **Discovery full-width layout** — results table matches articles page width

### Added — Database
- `embed_url TEXT` and `embed_type TEXT` columns on articles table
- `from_date TEXT` and `to_date TEXT` columns on saved_searches table

### Changed
- CSP `frame-src` allows `youtube.com` and `youtube-nocookie.com`
- Public `/api/article` response now includes `embed_url`, `embed_type`, `source_type`
- YouTube checkbox defaults to unchecked (requires API key configuration)

### Fixed
- `media_enabled` now set to 1 when importing YouTube videos (#152)
- Post-fetch date filtering removes out-of-range results from API responses
- Brave Search freshness parameter uses date range format for year/custom periods

---

## [2.0.0-beta.2] — 2026-03-17

Post-beta patches deployed to staging.

### Added
- **Wizard writers** — character-inspired first names (Victor, Wanda, Reed, etc.) with tailored bios, keyword lists, and niche-specific system prompts
- **4 new niches** — Travel, Pro Wrestling, Investing, Entertainment (with 6 writers each)
- **Wizard branding** — sets all branding fields on launch (short name, copyright, logo HTML, footer tagline, newsletter subject, email from name)

### Changed
- Wizard niches sorted alphabetically (Custom always last)
- Image Generation settings panel renamed to "Google Gemini" to reflect full AI scope

### Fixed
- Summary and thumbnail cache `ON CONFLICT` clauses matched to tenant-scoped PKs

---

## [2.0.0-beta.1] — 2026-03-17

Major release: multi-tenancy, local authentication, RBAC, admin UI overhaul, and self-hosted tooling.

### Added — Multi-Tenancy
- Tenant isolation via `tenant_id` on all 20+ tables
- Plan limit enforcement (`max_sources`, `max_writers`, `max_articles_month`, `audio_enabled`)
- Unified storage layer with 3 pluggable backends (S3/R2, local filesystem, PostgreSQL BYTEA)
- Per-tenant aggregate rate limiting (starter 600/min, pro 1200/min, business unlimited)
- CORS validation for custom domains against tenant's `custom_domain` column
- Tenant provisioning with default categories, settings, and roles seeding
- `DEPLOYMENT_MODE=single` for self-hosted single-tenant deployments

### Added — Local Auth & RBAC
- `POST /api/auth/login` — local username/password authentication (bcrypt, rate-limited)
- `GET /api/auth/methods` — discover available login methods (Google/GitHub/local)
- 4 default roles: owner, admin, editor, viewer with granular resource.action permissions
- Custom role creation with permission picker
- `requirePermission()` middleware enforced on all 13 admin route files
- User CRUD: list, create, edit, deactivate, permanent delete, password reset
- Role CRUD: list, create, update, delete (system role protection)

### Added — OAuth & Secret Management
- OAuth credentials configurable via Settings > Authentication tab
- `ADMIN_EMAILS` env var removed — admin access via users table email matching
- JWT secrets auto-generated on first boot, stored encrypted in settings table
- Secret rotation support with previous-secret fallback (24h grace)
- All API keys (Gemini, ElevenLabs, Resend, NewsAPI, Brave, R2) overridable via Settings > Integrations
- `BASE_URL` and `MAIN_SITE_URL` configurable via Settings > General

### Added — Admin UI
- **Login page**: local auth form with OAuth method auto-detection
- **Users page**: CRUD table with add/edit/reset-password/delete modals
- **Roles page**: role management with interactive permissions grid (14 resource groups)
- **Audit Log page**: filterable event viewer with live tail (10s) and owner-only archive
- **Discover page**: search Brave/NewsAPI, preview results, selective import as draft/published
- **Saved searches**: store results, one-click load, refresh button
- Sidebar logo updates from site config (emoji + short name)
- Permission-aware controls: buttons hidden/disabled based on user role
- Settings > Integrations: panels for R2 storage, Email (Resend), Live News Sources

### Added — Self-Hosted
- `.env.example` with documented sections
- `scripts/setup.sh` — interactive setup with secret generation
- `Dockerfile` + `docker-compose.yml` — PostgreSQL 16 + app container
- Onboarding wizard (cherry-picked)

### Fixed
- 9 `getSiteConfig()` calls missing tenantId (cross-tenant data leak)
- Global pricing cache in `ai-usage.js` → tenant-scoped Map
- `articles.writer_id` FK corrected from `voices(id)` to `writers(id)`
- `ON CONFLICT (key)` → `ON CONFLICT (tenant_id, key)` across 35 queries
- Settings API filtered to never return JWT/cron secrets
- Rate limiter IPv6 validation error
- Admin user seeded as `owner` (was `admin`) on fresh databases
- Audit log captures user info and normalizes IPv6 to IPv4

### Security
- Timing-safe cron secret comparison (prevents timing attacks)
- `middleware/tenant.js` validates cron secret value (was presence-only)
- Settings API blocks writes to secret manager keys
- Permissions fallback fixed (non-platform-admin no longer gets `['*']`)
- Failed login attempts logged to audit log
- SQL injection audit: all queries use parameterized `$N` (confirmed clean)

### Tests
- 146+ tests (unit + integration) covering tenant isolation, plan limits, auth flows, storage, permissions, local login

---

## [1.15.1] — 2026-03-16

### Added
- **16 new dark theme presets** — expanded from 4 to 20 presets including Dark Rose, Dark Amber, Charcoal, Dark Red, Dark Orange, Dark Teal, Obsidian, Monokai, Dracula, Nord, Solarized Dark, Dark Slate, Dark Coral, Dark Gold, Dark Indigo

### Fixed
- **Categories sorted alphabetically** — `getCategories()` query now uses `ORDER BY name ASC` instead of `sort_order`; all consumers (admin, frontend, categorization) get alphabetical order without client-side sorting

---

## [1.15.0] — 2026-03-15

### Added
- **Auto-grab feed title** — new `POST /api/sources/preview-feed` endpoint validates RSS URLs and returns feed metadata; source name auto-populates when pasting a URL in the Add Source modal, with live validation status
- **30-day lookback for new sources** — first fetch of a newly added source uses a 30-day cutoff instead of 48 hours, pulling in a reasonable article backlog; subsequent fetches use the normal 48-hour window

### Fixed
- **Manual article add broken** — Zod v4 renamed `error.errors` to `error.issues`, causing `validate()` to crash with 500 on any validation failure instead of returning a proper 400; added `featured_priority` to `articleCreate` schema; fixed `fFeatured` select reset in Add Article modal
- **Fetch-url hang on large pages** — `res.destroy()` on pages exceeding 200KB cap never resolved the Promise, hanging the request indefinitely; now resolves with collected HTML (sufficient for OG meta extraction)
- **HTML entity encoding in auto-fill** — title, summary, author fields from `GET /api/fetch-url` now decoded via `decodeEntities()` (e.g. `&#039;` → `'`)

---

## [1.14.1] — 2026-03-15

### Added — Article Re-Categorization
- **Enhanced `POST /api/fetch/recategorize`** — supports `articleIds`, `category`, `days`, and `dryRun` filters; returns moves breakdown (`"Old → New": count`) and writer reassignment count; parameterized SQL, LIMIT 2000 safety cap
- **Articles page: bulk recategorize** — "Recategorize" button in bulk toolbar operates on selected articles with dry-run preview modal showing proposed category moves before applying
- **Articles page: global recategorize** — top-bar "Recategorize" button operates on all non-archived articles, scoped by active date filter (24h/7d/30d)
- **Settings page: post-save prompt** — after saving categories, automatically previews how existing articles would be re-categorized with updated keywords; user can apply or skip
- **Writer re-assignment** — articles that change category and have no writer are re-matched via `findBestWriter()` using the new category for beat scoring

---

## [1.14.0] — 2026-03-15

### Added — Writer Restructuring & Article Enhancements
- **Separate writers from voices (Phase 1)** — decoupled writer personas from voice profiles, new admin-writers route with dedicated CRUD
- **Writer restructuring phases 2–4** — multi-beat support, style profiles, performance tracking for writer personas
- **Auto-assign writer on article create** — writer assignment now triggers on article creation, not just publish
- **Article preview modal** — inline article preview in the admin articles list without navigating away
- **AI keyword generation for categories** — per-category "AI" button and bulk "AI Generate All" on Settings > Content; calls Gemini to generate 30–50 keyword suggestions

### Changed
- **Improved auto-categorization** — word-boundary regex matching, source-level default categories, Gemini AI fallback when keyword scoring confidence is low

### Fixed
- **AI keyword generation 502** — Gemini exceeded `maxOutputTokens` (1000) producing 100+ keywords, truncating JSON mid-array; increased limit to 2048, tightened prompt to cap at 50, added truncation-resilient JSON parsing
- **Synthesis page filtering** — was filtering on wrong field name for auto-writers
- **Articles table overflow** — fixed table layout overflow, curated auto-publish logic, and fetch endpoint hang (#133)
- **Admin-writers route mount order** — moved route mount after auth middleware declaration
- **Writers migration idempotency** — made migration resilient to partial runs with `IF NOT EXISTS` guards

---

## [1.13.0] — 2026-03-14

### Added — Unified Category System
- **`categories` table** — dedicated Postgres table replaces `site_categories` JSON blob in settings; columns: name (unique), color, keywords (TEXT[]), sort_order
- **One-time seed migration** — existing categories auto-migrated from legacy JSON setting on first boot
- **`GET /api/categories`** — public endpoint for frontend filter bar and admin dropdowns
- **`PUT /api/categories`** — admin bulk save with rename/delete detection (auto-updates articles + writer beats)
- **Fallback chain** — `lib/categories.js` falls back to legacy JSON if table is empty during transition
- **Dynamic auto-categorization** — `lib/categorize.js` rewritten to async keyword-driven detection from the categories table
- **Writer beat dropdown** — changed from free-text input to category `<select>` populated from `/api/categories`

### Changed — Settings UX
- **Per-panel save buttons** — every settings panel now has its own save button (Branding, Domain & URLs, Theme, Categories, AI & Newsletter, Analytics & Ads, Perspective API); removed the single combined "Save Site Settings" button that was on a different tab from the fields it saved
- **OG Image upload** — replaced text URL input with file upload widget (same pattern as logo/favicon); stores to Cloudflare R2 as `branding/site-og.{ext}`
- **Backend branding upload** — `POST /api/settings/logo` now supports `type: 'ogimage'` via configurable `BRANDING_TYPES` map

### Removed
- Hardcoded `CATEGORIES` arrays from `lib/schemas.js` and `public/admin.js`
- Category JSON migration logic from `PUT /api/settings` (moved to `PUT /api/categories`)

---

## [1.12.0] — 2026-03-14

### Added — Site Branding & Theme Customization
- **Shared R2 upload helper** — extracted `lib/r2.js` from voices.js; reused by logo upload and avatar upload
- **Logo/favicon upload** — `POST /api/settings/logo` endpoint accepts base64 dataUrl, stores to R2 under `branding/`, saves URL in settings table
- **Upload widgets** — Settings > General > Branding now has file picker + preview for site logo and favicon (max 2MB)
- **Extended color tokens** — 7 configurable theme colors: accent, background, surface, border, text, muted, accent hover
- **Theme presets** — 4 one-click presets: Dark Blue, Dark Cyan, Dark Purple, Midnight Green
- **Frontend consumption** — `brand.js` applies all 7 CSS custom properties + renders uploaded logo/favicon from site config

---

## [1.11.0] — 2026-03-14

### Changed — Admin UI Overhaul
- **DRY sidebar** — extracted duplicated sidebar HTML from 10 pages into shared `renderSidebar()` function in `admin.js`
- **Grouped navigation** — organized flat 10-item nav into 5 groups: Overview, Content, Engagement, Monitoring, System
- **Auto-active detection** — replaced hardcoded `active` class with automatic pathname matching
- **Settings tabs** — reorganized single long-scroll page into 4 tabs: General, Integrations, Content, Moderation
- **Consolidated API keys** — moved ElevenLabs, Imagen, Perspective, GA, and AdSense configs under Integrations tab
- Selected settings tab persists via `sessionStorage`

---

## [1.10.1] — 2026-03-14

### Fixed
- **Synthesis slugs** — stop appending timestamp to every synthesized article slug; timestamp now only used as fallback when title produces an empty slug

---

## [1.10.0] — 2026-03-14

### Added — Phase 4: Writer Follows & Following Feed
- **`writer_follows` table** — `(id, user_id FK→public_users, writer_id FK→voices, created_at, UNIQUE(user_id, writer_id))`; auto-created via migration in `db.js`
- **`POST /api/writers/:slug/follow`** — follow a writer (JWT auth); creates `writer_follows` row; returns updated `follower_count`
- **`DELETE /api/writers/:slug/follow`** — unfollow a writer (JWT auth); removes row; returns updated `follower_count`
- **`GET /api/writers/following`** — list writers the authenticated user follows
- **`is_following` annotation** — `GET /api/writers` and `GET /api/writers/:slug` now include `is_following: true/false` when a Bearer token is present
- **`follower_count`** — writer list and detail endpoints include follower count via `LEFT JOIN` on `writer_follows`
- **Following feed** — `GET /api/news?feed=following` filters articles to writers the authenticated user follows
- **Follow notifications** — `createNewArticleNotification(writerId, articleSlug, articleTitle)` added to `routes/notifications.js`; synthesis pipeline notifies followers when a writer publishes an original article
- **ElevenLabs subscription usage card** — AI Usage dashboard now shows ElevenLabs monthly character usage alongside Gemini/Imagen costs

---

## [1.9.0] — 2026-03-14

### Added — Phase 1: AI Usage Tracking & Cost Dashboard
- **`ai_usage` table** — logs every AI API call with provider, model, operation, token counts, estimated cost, and metadata; auto-created via migration in `db.js`
- **`lib/ai-usage.js`** — `logUsage()` helper with `estimateCost()` pricing for Gemini, Imagen, and ElevenLabs models; `extractGeminiTokens()` for automatic token extraction from API responses
- **14 API call sites instrumented** — `logUsage().catch(() => {})` added after every AI API response across `routes/summary.js` (2), `routes/media.js` (3), `routes/thumbnail.js` (1), `routes/trends.js` (1), `lib/synthesis.js` (1), `lib/writer-assign.js` (1), `lib/notify.js` (1), `routes/newsletter.js` (1), `routes/contact.js` (1), `routes/fetch.js` (2)
- **`GET /api/ai-usage/summary`** — dashboard API with `?range=7d|30d|90d`; returns totals by provider, operation, and day with budget status
- **AI Usage admin page** (`public/ai-usage.html` + `public/ai-usage-page.js`) — cost breakdown charts, daily spend, per-operation breakdown, budget warnings
- **AI Usage nav link** — added to sidebar on all admin pages
- **Settings seeded** — `ai_daily_budget`, `ai_budget_warn_pct` defaults added to `db.js`

### Added — Phase 2: Synthesis & Writer Pipeline Improvements
- **Beat-scoped synthesis** — `runSynthesisForWriter()` now filters articles by `writer_id`; falls back to unassigned articles in the writer's beat category if below `min_cluster_size`
- **Quality gate + editorial scoring** — new `lib/quality-gate.js` with `getEditorialScore(article)` returning `{ publish, newsworthiness, feature_worthy, reason }`; synthesized articles start as drafts and auto-publish only if they pass the quality gate
- **`editorial_score` column** — `ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_score INTEGER`
- **Auto-thumbnail after synthesis** — `lib/media-helpers.js` extracted from `routes/media.js`; synthesis pipeline auto-generates thumbnails for originals that pass the quality gate
- **Improved writer assignment** — abbreviation map, +2 title match weight, normalized comparisons
- **Settings seeded** — `daily_publish_target` (default `20`), `auto_editorial_scoring` (default `1`)

### Added — Phase 3: Full Autonomy
- **Budget-aware execution** — new `lib/budget.js` with `canSpend(operation)` checking today's spend vs `ai_daily_budget`; wired into synthesis, quality gate, media helpers, and summary routes
- **Auto-publish live news** — hourly cron reads `auto_publish_live` setting; articles run through heuristic checks → editorial scoring → daily target soft cap before publishing
- **Post-publish hooks** — new `lib/post-publish.js` with `onArticlePublished(articleId)`: pre-warm TLDR, generate thumbnail if missing, auto-assign writer; all budget-checked and fire-and-forget
- **Auto-audio cron** — daily `0 8 * * *` cron generates audio for top articles (editorial_score >= 8, featured, or original); capped at `auto_audio_daily_max`; respects `elevenlabs_monthly_chars` limit
- **Budget alerts** — daily cron checks monthly spend vs budget; sends admin email via Resend if over warning threshold
- **Settings seeded** — `auto_publish_live` (default `0`), `auto_publish_quality_gate` (default `1`), `auto_audio_enabled` (default `0`), `auto_audio_daily_max` (default `3`), `elevenlabs_monthly_chars` (default `100000`)

---

## [1.8.10] — 2026-03-11

### Added
- **Purge-all endpoint** — `DELETE /api/articles/purge-all` with dropdown (feed/original/all)
- **Purge originals button** — `DELETE /api/synthesis/purge` for testing
- **Synthesis dedup** — 50% source overlap check, 23h cooldown per writer, force override
- **Writer personas** — AI writer characters with configurable name, beat, bio, avatar, tone, synthesis schedule
- **Writer assignment** — auto-assigns articles to writers by beat/keyword matching
- **Original article synthesis** — clusters related articles and generates original long-form content
- **Public user auth** — JWT-based sign-up/sign-in for public users (separate from admin auth)
- **Comments system** — threaded comments on articles with reply notifications
- **Bookmarks** — save/unsave articles per user
- **Notifications** — in-app notification system for replies and follows

---

## [1.8.9] — 2026-03-10

### Added
- **AI-generated article thumbnails** via Google Imagen 4
  - Two-step pipeline: Gemini writes visual concept → Imagen 4 renders 16:9 image
  - 10 per-category style presets
  - Images stored to Cloudflare R2; local fallback for dev
- **Image column in articles table** — clickable thumbnail with AI badge
- **Bulk image generation** — select multiple articles → Generate Images
- **Image generation settings** — model selector (Standard/Ultra/Fast), API key override

---

## [1.8.8] — 2026-03-10

### Added
- **Voice Characters system** — full multi-voice management for ElevenLabs TTS
  - `voices` table with CRUD endpoints
  - Voice picker modal on audio generation
  - Voice snapshot on articles (`audio_voice_name`, `audio_voice_avatar_url`)
- **Voices page** (`/voices.html`) — voice management UI with Voice Test Studio
- **Settings page** (`/settings.html`) — ElevenLabs API key override

---

## [1.8.7] — 2026-03-09

### Added
- **48-hour article age filter** — RSS fetch skips articles older than 48 hours
- **Original article link** — 🔗 button in admin articles table

### Fixed
- **Cloudflare R2 audio storage** — confirmed working end-to-end in production

---

## [1.8.6] — 2026-03-09

### Added
- **Production deployment on Railway**
- **PostgreSQL support** — `db.js` rewritten for `pg` Pool with transparent SQL normalization
- **Cloudflare R2 audio storage** — MP3 uploads via `@aws-sdk/client-s3`
- **`railway.json`** + **`.env.example`**

### Fixed
- **All routes** — converted to `async/await` for pg Promises
- **Fetch endpoint hanging** — socket abort on timeout + fire-and-forget OG enrichment

---

## [1.8.5] — 2026-03-09

### Added
- **Soft-delete / archive system** — archive, restore, purge endpoints; 24-hour auto-purge cron
- **ElevenLabs audio generation** — Gemini writes spoken-word script → ElevenLabs TTS → MP3
  - Generate, delete, toggle endpoints
  - Audio columns in DB (`audio_url`, `audio_status`, `audio_transcript`, `media_enabled`)
  - Audio controls in admin articles table

---

## [1.8.4] — 2026-03-09

### Added
- **AI summaries** (`GET /api/summary`) — Gemini structured TLDRs
- **Single article lookup** (`GET /api/article?slug=`)
- **URL auto-fill** (`GET /api/fetch-url?url=`) — OG tags + JSON-LD scraping
- **Cache invalidation** (`GET /api/news/updated-at`)

---

## [1.3.0] — 2026-03-09

### Added
- **RSS auto-fetch** (`POST /api/fetch`) — fetch all sources, deduplicate, insert as drafts
- **30-minute cron job** — auto-fetch RSS sources
- **Category detection** — per-article keyword matching (removed from sources)

---

## [1.2.0] — 2026-03-09

### Added
- **AI summaries** (`GET /api/summary`)
- **Single article lookup** (`GET /api/article?slug=`)
- **Cache invalidation endpoint**
- **Featured article enforcement** — single featured at a time

---

## [1.1.0] — 2026-03-09

### Added
- **RSS auto-fetch** with 30-minute cron
- **Fetch All Sources button** on sources page
- **`last_fetched` column** on sources

---

## [1.0.0] — 2026-03-07

### Added
- Initial release — Express + SQLite admin panel
- JWT authentication with bcrypt password hashing
- Full CRUD for articles and RSS sources
- Mobile-friendly dark-theme UI (dashboard, articles, sources)
- Public `/api/news` endpoint for main site consumption
- Default seed: admin user + The Verge AI RSS source
