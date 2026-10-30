# Stories: publication and explicit AI actions

Stories group **published, unarchived articles in the same tenant**. Inbox sources and review drafts must first go through their normal publication workflow. Creating a story validates every attachment before inserting anything; attaching and removing articles lock the story and update membership atomically. Duplicate attachments do not increment counts or repeat notifications.

Public list, detail, following, article-widget and catch-up responses derive covers and counts from eligible articles. Unpublishing or archiving an article therefore takes effect immediately without deleting its historical association. The last eligible image disappearing clears the cover. Story names may change; the original slug remains stable.

## Summaries and privacy

The additive startup migration adds `story_timelines.summary_article_ids` and `story_ai_runs`. It is safe to run repeatedly. A public summary is served only when its recorded source IDs match current published membership and no invalid legacy links remain. Existing summary text is retained in the database and admin detail, but a summary with no source snapshot is withheld publicly until an editor reviews and saves it or explicitly regenerates it. Editing the summary records the current eligible source snapshot without an AI call.

`GET /api/news/stories/:slug/summarize` reads the saved, publication-safe summary. It never calls a provider; missing or invalidated summaries return 404. The reader does not need a new paid API integration.

## Explicit generation

An editor with `articles.update` can use **Generate name + summary (paid)**. Saving, linking, reading, publishing, backfill and scheduled detection do not generate story summaries. The former unbounded bulk regeneration endpoint returns actionable guidance to generate individually; its dry-run count remains available. This avoids hiding multiple paid operations behind one status message.

`POST /api/story-timelines/:id/regenerate` requires:

```json
{"confirmPaid":true,"requestKey":"a-unique-stable-request-key","retryAcknowledged":false}
```

Reuse the request key after an uncertain network response. A completed request key never generates twice. One session advisory lock protects each story across processes; concurrent requests return 409. Only one story may generate per tenant at a time; another story returns 429 rather than consuming unbounded worker/database capacity. Provider budget checks remain in force, and successful requests have a one-minute cooldown. Job states are `running`, `ready`, `skipped` and `failed`; the admin detail response includes the latest job. Error messages shown to users are controlled text, never provider credentials or raw provider errors.

A process interruption releases the lock. A later status check records an interrupted failure; a new request requires `retryAcknowledged:true` because the provider may already have charged. There is no automatic retry. Do not interpret failure as proof that no charge occurred.

The UI disables repeated actions, polls durable status, preserves unsaved edits and resumes status checking when the drawer is reopened. It loads successive pages beyond the original first-100 limit. On narrow screens the drawer occupies the available width.

## Validation and rollback

`tests/integration/stories-publication.test.js` uses a disposable database and mocked AI. `tests/stories-routes.test.js` verifies authorization and read-only public summaries; `tests/stories-ui.test.js` covers cancellation, duplicate clicks, polling, unsaved edits and pagination. No live provider test is required to run these tests.

Back up database, media, configuration and running artifacts before rollout. Roll back application artifacts to the prior image if necessary; leave the additive column and job table in place. Dropping them loses generation history and is not required for application rollback. Restoring an old database is a separate recovery operation that can discard newer user work. Existing scheduled automation must retain its deployment setting; this feature does not enable it.
