# Editor assignments

An editor proposal can be saved without inventing a source. Chat saves a research brief in the existing `article_pitches` table with `is_editor_assignment=true`, topic, angle and optional assigned writer. Find these briefs in **Pitches > Commissions > Editor assignments**.

## Transitions and costs

- **Needs sources:** fewer than two curated workspace articles with supporting text. Add real sources through the normal inbox/import workflow, then select them and a writer. This milestone does not browse or manufacture sources.
- **Proposed:** at least two sources attached. **Approve assignment (no generation)** records approval only.
- **Approved:** **Generate draft (paid)** asks for explicit confirmation before using the configured synthesis provider. Saving, source attachment and approval do not call a provider.
- **Drafting:** the request holds a database advisory lock. Duplicate requests are rejected. The UI polls status without restarting generation.
- **Review:** a saved, unpublished article awaits normal human editorial review. Assignment generation bypasses automatic enrichment and automatic publication. Existing publication controls remain permission-gated.
- **Published / Scheduled:** list status derives from the actual linked article, not a successful AI response.
- **Failed:** a safe actionable error is retained. Retry requires explicit acknowledgement of possible previous charges. Interrupted drafting is recoverable only after ten minutes and after its worker lock has gone away. A previously saved draft is reconciled before any new provider request.

Editing sources/writer invalidates approval. Tenant checks apply to sources, writers and drafts. Source selection currently lists the latest 200 admin articles and assignments list the latest 100; larger archives need future searchable pagination. Existing sourced pitches keep their legacy workflow, and editor assignments cannot enter that automatic synthesis path.

## API and schema

`/api/editor-assignments`: GET (`articles.read`), POST (`articles.update`, stable `request_key`). `/:id/sources` PUT and `/:id/approve` POST require `articles.update`; `/:id/generate` POST requires `articles.create` and `confirmPaid: true`. Retry additionally requires `retryAcknowledged: true`. All routes require authentication and the `article_pitches` feature.

Startup adds assignment fields, makes `source_article_id` nullable, and creates unique tenant/request-key and tenant/article-provenance indexes. Initialization is repeatable and does not rewrite existing rows. Generated articles record `synthesis_meta.editor_assignment_id` before saving, providing duplicate persistence protection. Legacy commission synthesis now reports Review unless its linked article is actually published.

## Operations and rollback

Keep `AUTOMATION_ENABLED=false` when scheduled operation is unwanted. This milestone does not start background image queues or change provider configuration. Test real drafting manually only after confirming provider costs and source quality.

Back up database, media, configuration and the previous application image before rollout. Roll back the backend image and source artifacts if required; retain the additive schema and assignment records. Do not restore the old NOT NULL constraint or drop assignment fields while source-free records exist. An older application does not understand assignment actions; keep affected assignment operations unavailable until forward repair. A full database restore would discard subsequent user content and requires a separate recovery decision.

Offline regression coverage exercises idempotence, cross-tenant rejection, approval without generation, parallel request protection, failure/retry, review-only persistence and UI error/cancel behavior. Mock browser QA is not a paid provider or live content test.
