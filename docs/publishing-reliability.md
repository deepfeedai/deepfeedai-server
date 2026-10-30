# Publishing reliability

## Editorial workflow

1. In Pitches → Commissions, open **New editor assignment**. Save a topic, angle, category and writer. Saving a brief does not call AI. A stable request ID prevents duplicate creation; reusing it for a different brief returns a conflict.
2. Attach at least two real curated sources from the same workspace. Approval validates them and is separate from generation.
3. **Generate draft (paid)** explicitly confirms provider use. The assignment records Drafting before calling the provider, then Review only after an article exists. Reload the assignments page to recover status. Failed/interrupted attempts require acknowledgement of possible prior charges; never automatically retry an uncertain provider operation.
4. Open the draft, inspect attribution, content and image previews, then Save. Uploaded files are staged until Save; Cancel does not change the article pointer. Writer and article fields save together. Revision conflicts preserve form edits instead of overwriting another editor's changes.
5. Publish or approve deliberately. Publication requires a title, valid category and text; original/deep-dive articles also require a workspace writer and at least two available sources. Repeated publication requests specify the desired state and cannot toggle an article off. Scheduling and publication results reflect saved state.
6. Reader APIs expose published articles only, including Developing feed entries. Public article/feed responses omit internal editorial fields. Reader pages verify current publication before rendering; crawler previews use absolute media URLs, no-store responses and 404 after withdrawal.
7. Corrections preserve the slug, clear an obsolete generated headline and record private before/after history atomically. Unpublish cancels scheduled publication and immediately removes the article from public detail, feeds and Stories projections. Reader tabs revalidate on return; already downloaded content and third-party caches cannot be recalled.

## API contract and migrations

`PUT /api/articles/:id/publish` requires `{ "published": true|false }`. Empty legacy toggle requests return 400. Current editing clients send `expected_revision`; mismatches return 409. Save does not change publication state. `GET /api/articles/:id/history` requires article-read permission and is tenant scoped.

Scheduled approval preserves a future editorial `publish_at`; expired dates move to the next window. A full daily cap imposes tomorrow's first window as a lower bound, without advancing a later editorial date. Public topic-pulse counts, previews, activity and story links use only published, unarchived articles; activity also requires a public event. Public briefing pages require Ready and withhold the complete script/audio projection if any referenced article is unavailable, foreign or withdrawn. Existing media already downloaded or accessed by a previously known storage URL is not recalled by these API checks.

Startup adds `articles.publication_revision`, `post_publish_status`, `post_publish_error`, private `article_publication_history`, and `article_pitches.assignment_category` idempotently. Rollback to the prior application may leave these additive columns/table intact. Do not drop history or restore an older database over new user content merely to roll back code.

With `AUTOMATION_ENABLED=false`, post-publication automation is **skipped**. Explicit image/draft buttons retain their existing paid-action controls. Public topic-brief reads return `not_generated` rather than initiating AI. With automation enabled elsewhere, `dispatched` means hooks were dispatched, not that every background job completed. A failed/pending optional status does not undo successful publication. The editor shows saved state and history separately from unsaved edits.

## Repeatable acceptance command

From the server checkout on a machine with Bash and Docker:

```sh
bash scripts/test-publishing.sh
```

The command builds a test image, creates an internal Docker network and disposable tmpfs PostgreSQL database, passes only fixed test credentials, stubs providers, exercises real Express APIs plus mocked UI controls, then removes its own containers/network/image. It does not use production configuration or invoke AI. Dependency/image downloads happen during setup; test containers have no external route. The fixture refuses any database name except `publishing_acceptance` and requires automation disabled.

Reader tests, from the web checkout: `node --test tests/*.cjs`.

Full server regression: run `node -r tsx/cjs --test --test-concurrency=1 tests/*.test.js tests/integration/*.test.js tests/acceptance/publishing.test.js` inside the same isolated test environment. Do not point integration tests at production.

## Coverage and limits

- Real-route tests: idea → sources → approval → mocked draft → publication → public reads; invalid/foreign sources, permissions, duplicates, slow/failing providers and status reload, corrections/conflicts/history, upload Save/Cancel, failed replacement, unpublish/Stories and repeatable schema.
- Mocked UI tests: paid confirmation cancellation, repeated clicks, dirty-edit protection, failure recovery and retained image/form edits. Reader loader and crawler middleware run with simulated HTTP responses.
- Browser checks: actual brief creation, source attachment and approval passed. The browser automation tool timed out on its native generation confirmation; subsequent dialog inspection was unavailable. Full generation-to-reader browser interaction and mobile visual verification remain unverified, despite API and mocked UI coverage.
- Providers are simulated: real generation quality, billing and provider uptime require a deliberate user test. Existing unrelated TypeScript/dependency findings are outside this milestone.
- No CI workflow or scheduled automation is enabled by this change.
