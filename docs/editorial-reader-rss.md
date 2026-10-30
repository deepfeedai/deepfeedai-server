# Editorial Reader and RSS Sources

The editorial Reader upgrades `/feed-inbox.html`; it is not a second Platform
application. Newsroom Wire links to the Reader for source reading and triage,
while its specialist synthesis overview remains available. Platform provides a
link to the editorial workspace. Existing article IDs, source subscriptions,
article folders, assignments, citations and Stories are retained.

## Reading and editorial actions

The Reader uses authenticated, tenant-scoped `/api/reader` routes with server-side
search, filtering, pagination and counts. Read/unread and saved state belongs to
the current principal, not all editors. Bulk requests distinguish explicit IDs
from all matching results. Reading displays text rather than trusting feed HTML;
keyboard navigation, visible focus and a mobile reading/back flow accompany the
three-pane desktop layout.

Saving a research brief and attaching sources to an existing assignment do not
generate an article. Approval and paid generation remain separate. The optional
AI summary action is explicitly labeled and requires confirmation; interrupted
or failed enrichment is visible and a retry requires acknowledgement of possible
prior provider use. Summaries do not replace original source text.

RSS refresh imports feed text and applies deterministic category rules. It no
longer silently generates summaries, embeddings or writer assignments. The
ordinary folder sorting path uses rules and existing folders; the legacy AI
sorting/recategorization paths require `confirmPaid: true`, including previews.
Opening, reading, saving, moving, importing and exporting sources do not call AI.
No scheduled automation is enabled by this milestone.

## Exact repeats versus coverage

Exact ingestion identity combines conservative article URL normalization with a
feed-scoped GUID identity. Only recognized tracking parameters and fragments are
ignored for article identity; meaningful query parameters and publisher hosts
remain distinct. Feed subscription URLs retain their query parameters. Original
article URLs are preserved for reading and fetching, because rewriting signed
addresses can break access.

Tenant-scoped advisory locking and durable identity keys prevent concurrent
imports from creating multiple copies. `rss_occurrences` records each feed's
original URL and occurrence, even when multiple subscriptions point to one
article. The same GUID in two different feeds is not sufficient to merge their
articles. Matching headlines are never a deduplication key. Conflicting GUID and
URL identities are skipped and counted, not silently merged. Identities whose
article was separately deleted are repaired on the next ingestion.

The duplicate report is a dry run. Explicit collapse adds a reversible
`rss_duplicate_links` relationship between exact URL duplicates; it does not
delete either article or rewrite citations, assignment references or Story
memberships. Undo restores separate display. A canonical article becoming
unavailable must not permanently hide its aliases.

Same-event coverage from different publishers remains independent reporting.
Reader topic grouping uses existing tags and is distinct from exact repeats.
Manual removal from a Reader topic group records a durable Reader exclusion; it
does not delete source material, change a published Story or promise that all
other synthesis clustering algorithms will exclude the article.

## Subscription management

`/sources.html` supports pasted URLs, OPML and JSON imports with a preview and
per-item outcomes. Invalid items do not discard valid entries. Repeating an
import reports existing subscriptions rather than adding them again. Removed
subscriptions are reported separately and restored explicitly.

Bulk pause/resume, folder/category changes and removal accept selected IDs or an
explicit all-matching filter. Filters and selections are validated within the
current publication/tenant. Restore returns subscriptions paused so recovery
does not unexpectedly start fetching. Clear all is a separate operation requiring
the exact phrase `CLEAR ALL SOURCES` and acknowledgement of the export offer.
It soft-removes only the current publication's current subscriptions. Imported
articles, media, citations, pitches and Stories are not deleted. The legacy
single-source DELETE also soft-removes; legacy toggling requires a desired
`is_active` boolean so repeated requests cannot undo the requested state.

Subscription folders use `folder_path` (for example `Research/AI`); they are not
the article `feed_groups` table. Changing a subscription folder does not move all
previously imported articles between editorial folders.

## Import, export and network boundaries

- Imports are limited to 500 entries and 500 KB of text. OPML uses a strict XML
  parser with document types/entities rejected and bounded nesting. No import
  preview fetches remote feeds; feed connectivity testing is a separate action.
  Only the four POST import endpoints receive a 3,010,000-byte JSON wire limit,
  allowing worst-case JSON escaping of 500,000 decoded bytes plus the envelope.
  Decoded content (or serialized legacy source arrays) remains capped at 500,000
  bytes; unrelated API routes retain the default 64 KB parser limit.
- OPML preserves names, URLs and nested folders. It does not preserve platform
  priority, pause state, ingest limit or default category. JSON includes those
  selected source configuration fields. CSV is a readable export, not a supported
  import format. Exports are not full database backups and contain no provider
  credentials or unrelated application settings.
- Feed URLs may contain private tokens in either paths or query strings. Normal
  visual display and import reports mask both. Authorized source APIs/edit/export
  still carry full URLs where required; keep export files private and avoid
  screenshots or sharing of credentials. Logs and per-item errors do not echo
  original URLs or raw parser/network errors. Source responses use `no-store`.
- Fetching validates DNS, rejects private/internal destinations, pins the checked
  address on the socket, and rechecks each redirect. It has a total deadline,
  redirect limit and response-size limit. IPv6-only destinations deliberately
  fail closed until equivalent address-range handling is implemented. The current
  allowlist is conservative and can reject some public special-use ranges.
- RSS refresh is synchronous and processes active feeds sequentially. Each feed
  is bounded, but large source collections can exceed a gateway request timeout.
  Do not automatically retry an ambiguous timeout; inspect source health/results
  first. A durable background fetch queue is a future improvement.
- The legacy duplicate dry run scans at most 5,000 source articles and reports
  `truncated: true` if more exist. It is not a complete historical deduplication
  migration and never automatically collapses old records.

## Additive schema and rollback

Startup runs `initRssSchema(pool)` before `initReaderSchema(pool)`. Both are
idempotent. RSS adds source removal/folder/identity/error fields, nullable
`articles.source_id`, identity and occurrence tables, and duplicate relationships.
Legacy source IDs are backfilled only when a source name identifies exactly one
subscription in the same tenant; ambiguous names remain unlinked. Reader adds
per-principal state, topic exclusions and enrichment-run status tables.

Application rollback may leave these additive tables/columns in place. Preserve
them and all newer user content; do not restore an old database merely to undo a
UI release. Older code does not understand soft removal and may fetch removed
subscriptions if their active state is changed outside the new API. Keep restored
subscriptions paused and inspect source configuration before running old code.
Use the deployment's protected release backup/runbook for image and source rollback.

## Repeatable offline verification

From this repository on a machine with Bash and Docker:

```sh
bash scripts/test-editorial-reader-rss.sh
```

The command builds the existing acceptance image, creates a uniquely named
internal Docker network and disposable tmpfs PostgreSQL database, and passes only
fixed test credentials. Real Express API tests use mock providers/feed downloads;
destructive source actions operate only on owned fixture tenants. Test containers
have no external route or host port. Cleanup removes only the command's own
containers, network and image. Dependency/image downloads occur during setup.
Never substitute a production `DATABASE_URL` or production environment file.

The focused suite covers imports/exports, invalid and hostile input, DNS/redirect
boundaries, concurrent identities and provenance, deletion/re-ingestion,
reversible duplicates, tenant/user isolation, selection/pagination, source
recovery, no-AI refresh, and UI keyboard/mobile/error/confirmation behavior through
isolated route and DOM tests. Real browser checks and deployment checks are
reported separately; passing mocked UI tests is not a claim that every browser
interaction was exercised. Provider quality/billing and real publisher access
remain deliberate manual tests. Existing unrelated TypeScript/dependency findings
are not remediated by this milestone.
