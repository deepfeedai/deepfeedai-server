# Newspaper editions

Open **Publish → Newspaper editions**. This is a layout and snapshot tool: it
does not call AI, publish an article, email subscribers or print automatically.

1. Choose **New edition**, give it a name and issue date, and choose its mode.
   Published-content reader editions use published `original`/`deep-dive`
   articles. Private editorial proofs can also include those articles' drafts.
   Imported RSS bodies and ambiguous legacy `curated` records are excluded.
2. Search and select up to 20 articles. Reorder them and choose the lead story.
   Choose Classic Newspaper, Morning Brief, Large Print, or Magazine separately
   from Letter/A4, color/ink-saving, images, sources and contributor options.
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

## Rename, retract, archive and delete

Finalization freezes article content, order, images, references and contributor
profiles. **Rename edition** changes only the issue's display title, including
the masthead on subsequent previews and shared views. It does not regenerate or
refresh any article snapshot. Renaming a public issue also requires publishing
permission. The old/new title and actor are recorded in history.

**Retract public edition** requires a reason and publishing permission. It makes
the issue private immediately for subsequent public text/image/portrait requests,
while retaining authorized internal access. Already downloaded/printed copies
cannot be recalled. **Archive edition** also makes it private and hides it from
the Active list; use the Archived filter to find it. **Restore** returns it to
the active list privately, never automatically sharing it. Archiving requires
update and publishing permissions; restoring requires update permission.

**Permanently delete** is available only after archiving and requires delete
permission, a reason and the exact issue title. It removes that edition's saved
text and image/portrait copies transactionally. Original articles, writer portraits
and snapshots belonging to other editions are untouched. Minimal audit history
survives deletion; existing backup retention is unchanged. A failed database cleanup
rolls back the deletion. If a response is lost, reload/check history before retrying;
an already-deleted issue returns unavailable rather than being recreated.

Actions use revision checks. If another editor changes an issue, reload its latest
state before trying again. The selected row always reflects the edition actually
loaded in the editor, including after renaming and browser Back/Forward.

## Edition URLs

Edition links now use stable random UUIDs. Internal sequential database keys remain
internal; opaque URLs are defense in depth, not authorization credentials. Private
issues still require sign-in and permission, and public links still require sharing
and eligible published articles. IDs are assigned once and are not rotated on startup.

Old authenticated numeric editor/private-preview bookmarks can resolve to the new
canonical URL. **Old public numeric URLs no longer work and are not redirected.**
Open the issue in the editor and copy its new share link. This migration changes
identifiers only, not the issue's title, revision, visibility or saved contents.

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
video, tables or interactive content. These are presets, not a layout designer.

### Layout and content presets

Classic Newspaper remains the default for existing issues: its saved text and
two-column presentation remain unchanged. Morning Brief uses a compact single
column and explicitly labeled excerpts. Large Print uses a single column with
16-point body text, larger supporting text and high contrast. Magazine uses
spacious single-column typography and larger images. All presets support both
paper sizes and ink-saving. Large Print and long issues can require more pages;
Morning Brief does not guarantee a page count, especially with sources or
contributors enabled.

The content selector offers full saved articles or labeled excerpts; Morning
Brief always uses excerpts. Excerpts use the captured description when present,
otherwise the opening captured article text, bounded to 900 Unicode characters.
They are displayed literally, preserving citation numbers and the original source
list without interpreting truncated Markdown. No AI summary, live backfill or
article rewrite occurs. A link opens the complete saved article (or complete saved
excerpt when that is all the issue captured) within the same protected edition.
This view retains authorization, public withdrawal checks and private proof labels.
Sources can be explicitly hidden; citation numbers remain literal text and a notice
discloses that omission. Writer attribution remains visible in all formats.

These settings persist on working editions and freeze at finalization. Missing
settings on older issues mean Newspaper, full captured content and sources shown.
Opening or printing an old issue does not enrich or change its snapshots.

Only local workspace PNG/JPEG/WebP raster images can be preserved in this version.
Remote/S3/database-adapter URLs are not fetched; missing, unsupported, oversize or
unsafe images are omitted with a notice. Images are copied into protected edition
storage (5 MiB per image, 25 MiB total; bounded pixel dimensions), so later source
image replacement does not silently change finalized issues. Text is limited to
200,000 characters per article. These snapshots increase database backup size.

## Writer credits and contributors

Newly captured articles preserve a deliberately limited writer profile: name,
configured role/focus, public biography and an existing local portrait. A configured
AI prompt identifies an AI writer persona; the prompt itself is never included.
An unknown author is not labeled AI. Credits say “Assigned writer for this article,”
which describes the recorded assignment, not verified reporting, fact-checking or
human review. Profile descriptions are configured descriptions, not independently
verified credentials.

Portraits and the optional **Meet the contributors** section are edition settings.
Images-off suppresses portraits too. Contributor counts refer only to articles in
that saved issue. If one writer has different captured profile versions, those
versions remain distinguishable rather than being silently combined.

Ordinary saves preserve retained snapshots. Explicit refresh of a working edition
captures current profiles; finalization freezes them with the text and layout.
Existing finalized issues keep their original saved bylines and do not look up
today’s profiles. They are not automatically enriched. Portraits use the same
protected, bounded raster storage and withdrawal checks as article images, sharing
the edition’s total image budget. No biography or portrait generation is performed.

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
