# Newspaper editions

Open **Publish → Newspaper editions**. This is a layout and snapshot tool: it
does not call AI, publish an article, email subscribers or print automatically.

1. Choose **New edition**, give it a name and issue date, and choose its mode.
   Published-content reader editions use published `original`/`deep-dive`
   articles. Private editorial proofs can also include those articles' drafts.
   Imported RSS bodies and ambiguous legacy `curated` records are excluded.
2. Search and select up to 20 articles. Reorder them and choose the lead story.
   Choose Letter or A4, color or ink-saving, and whether to include images.
3. Save the working edition. Text and supported local images are captured;
   ordinary subsequent saves preserve existing captures. **Refresh** explicitly
   replaces them with current article versions. Cancel discards unsaved edits.
4. Preview the issue. A working issue or proof is clearly marked DRAFT. When
   satisfied, finalize to lock its text, order, paper and image settings. Create
   another edition for later changes. Its mode cannot change after creation.
5. Use **Print** from preview to open the browser dialog, then select your
   printer or Save as PDF. Nothing sends a physical print job automatically.

## Privacy and sharing

All editions begin private. Reading private editions and snapshot images requires
article-read permission in the same workspace; creation/update use the existing
article-create/update permissions. Sharing requires article-publish permission
and is possible only for finalized published-content editions. Proofs cannot be
shared publicly. Sharing never changes article publication state.

Every public issue and image request checks current source eligibility. If any
article is withdrawn, archived, deleted, or republished under a new publication
timestamp, the whole issue becomes unavailable. Make a new issue from the current
published versions rather than reviving withdrawn text. Corrections made during
the same publication remain intentionally separate from finalized snapshots.
Private authorized archives retain their captured content and disclose withdrawal.
Browser preview rechecks when returning to the tab and before its Print action.
Previously downloaded, displayed, cached externally or physically printed copies
cannot be recalled; sharing an issue should be a deliberate editorial decision.

## Print behavior and limits

The screen preview is continuous and approximate. Browser print preview determines
page breaks. Match the saved Letter/A4 paper size, use 100% scale, and disable the
browser's default URL/date headers and footers. Select background graphics if the
browser otherwise omits the proof watermark; proof text labels also identify it.
Printer drivers and other browsers can paginate differently. Page numbers are
not synthesized by the application. Review the preview before printing.

The template uses readable serif body columns, an edition masthead, headlines,
bylines and bounded images. Article HTML is converted to inert text. Common
Markdown headings, emphasis, lists, quotes, code and safe links are recognized, not arbitrary embedded HTML, scripts,
video, tables or interactive content. This is one template, not a layout designer.

Only local workspace PNG/JPEG/WebP raster images can be preserved in this version.
Remote/S3/database-adapter URLs are not fetched; missing, unsupported, oversize or
unsafe images are omitted with a notice. Images are copied into protected edition
storage (5 MiB per image, 25 MiB total; bounded pixel dimensions), so later source
image replacement does not silently change finalized issues. Text is limited to
200,000 characters per article. These snapshots increase database backup size.

## Operations

Startup adds `newspaper_editions` and `newspaper_edition_articles` idempotently.
The latter holds protected image bytes and saved text, with no cascading source
article deletion. Include the database in consistent application backups. A code
rollback may leave these additive tables intact; do not drop them or restore an
older database over subsequent user edits merely to revert application code.

The feature is server-only. Existing reader, marketing, docs and Platform builds
remain compatible. Scheduled automation remains disabled in the private rollout.
See `newspaper-editions-plan.md` for implementation and acceptance criteria.

## Repeatable verification

Run the existing isolated Docker/database harness with edition tests included:

```sh
bash scripts/test-editions.sh
```

Browser fixtures intercept all API calls and prohibit external requests. With
Playwright/Chromium installed locally (or `PLAYWRIGHT_MODULE` / `CHROME_PATH`
pointing to installed tooling):

```sh
node scripts/qa-editions-editor.cjs
node scripts/edition-print-qa.cjs
```

These scripts use invented local content, produce screenshots/PDFs in a temporary
output directory and do not send physical print jobs. See the script options for
PDF text/geometry verification. Actual printer-driver output is a user check.
## Images, formatting and sources

Protected snapshot images are fetched with the edition's normal authorization and
rendered as bounded raster data URLs permitted by the existing Content Security
Policy. No policy relaxation, remote image retrieval or snapshot refresh is needed.
Retry reloads the saved bytes; public withdrawal still invalidates the whole issue.

New and explicitly refreshed snapshots preserve the article's ordered reference
metadata. Numbered citations link to a per-article Sources footer, with original
numbers, titles, publishers and printable/clickable safe URLs. Dates are not
invented. Missing or ambiguous references produce warnings. Credential-bearing
URLs are omitted, and no current article/source lookup happens when printing an
old snapshot. Markdown tables and unresolved reference-style definitions remain
literal text. Extremely complex malformed formatting falls back to escaped text
under a bounded parsing budget, without discarding article text.

The operator-only `scripts/backfill-edition-one-references.cjs` is a narrowly scoped
repair for the existing finalized edition #1 in workspace #1. It is never run on
startup or exposed as an API. `--dry-run` emits only IDs, reasons, counts and hashes;
`--apply --plan-stdin` requires that exact reviewed plan after a consistent backup.
The transaction locks the edition and articles, verifies captured text/version and
publication identity, and adds reference metadata only to verified items. It checks
preserved text/image/order hashes and edition settings/state, then increments the
edition revision once. Changed or ambiguous items are left untouched. Do not run
it against another deployment or without reviewing the dry run and authorizing the
specific repair. Finalized editions are not silently refreshed or rewritten.

Additional PDF checks (after browser fixtures):

```sh
python scripts/edition-print-images-verify.py /path/to/qa-output
python scripts/edition-print-sources-verify.py /path/to/qa-output
```

The browser fixture enforces the production CSP and checks decoded five-image
private/public issues, retries, withdrawal, Markdown and citation destinations.
PDF checks count actual raster drawing operations and internal/external link
annotations, alongside visible source URLs and existing layout/content checks.