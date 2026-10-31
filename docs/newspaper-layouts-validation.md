# Selectable edition layouts: validation

Implemented on LV426 from remote main `2032157045692fda1ac2aa528449004a46a7e501`.
No repository AGENTS.md or `.agents` instructions were present in that checkout.
The earlier checkpoint `7caed8b` is an ancestor; the intervening changes only add
CodeQL and Debricked workflows through merged PRs 12 and 13. They are retained.

## Results

- Complete final suite on a fresh disposable database: **579 passed**, 40 suites,
  zero failures, cancellations or skips.
- Untouched current-main comparison on a separate fresh database: **568 passed**,
  40 suites, zero failures, cancellations or skips.
- Complete unit suite: **437 passed**. Edition real API subset: **34 passed**.
- Editor Chrome fixtures pass at 1440px and 390px, including layout selection,
  excerpt mode, source/paper persistence, keyboard focus and finalized controls.
- Independent implementation and post-pagination-fix reviews found no blocking
  defects. JavaScript syntax and whitespace checks pass.
- **47 actual Chrome PDFs** pass browser and PDF structural checks, including
  the 32-case layout/paper matrix and private/public full-article views. Assertions
  cover dimensions, complete full text, truthful digest text, attribution, source
  options, protected images, citation links, hidden controls and no empty or
  footer-only pages in new formats.
- Final matrix visual review covers **148 pages**. Repaired pages were rendered
  again and checked visually; the final geometry scan found no top-margin clipping.
  Chrome version: **157.0.8103.26**.

Visual QA caught Chromium clipping with `column-count:1` and isolated trailing
notices/footers. New formats now use normal block flow (`column-count:auto`) and
keep trailing content together through contributor boundaries; legacy Newspaper
CSS is unchanged. Sparse final pages can still occur with variable-length content.

Local evidence is retained outside the repository under the task workspace:
`qa-output-final/` (PDFs and browser/PDF JSON results), `editor-qa/` (desktop/mobile
screenshots), and `qa-output/` (fresh-database full-suite comparison logs).

The full Windows run enumerates `rg --files tests -g '*.test.js'`, with
`node -r tsx/cjs --test --test-force-exit --test-concurrency=1` and disposable
fixture environment variables: `PUBLISHING_ACCEPTANCE=1`, `NODE_ENV=test`,
`AUTOMATION_ENABLED=false`, `DEPLOYMENT_MODE=multi`, `DATABASE_SSL=disable`,
`DATABASE_URL=postgresql://postgres@127.0.0.1:55439/publishing_acceptance`,
and a fixture-only 64-character settings key. Force-exit is needed for legacy
test files that retain database pool handles. Reused fixture databases can cause
unrelated publishing-category failures; final results use fresh databases.

## Reproduction

Install locked repository dependencies with `npm ci`. Run the isolated Docker
acceptance harness with `bash scripts/test-editions.sh` when Docker is available.
The new layout tests are included in that harness. On Windows with Node 22,
enumerate test files explicitly: passing `tests/` directly is not supported by
that runtime. The PowerShell unit command is:

```powershell
$files = @(Get-ChildItem tests -Filter '*.test.js' | ForEach-Object FullName)
node -r tsx/cjs --test --test-concurrency=1 $files
```

Browser fixtures use invented local content, intercept API calls and prohibit
external requests. Point `PLAYWRIGHT_MODULE` at an installed Playwright package
and `CHROME_PATH` at local Chrome when not using bundled Chromium:

```sh
node scripts/qa-editions-editor.cjs
node scripts/edition-print-qa.cjs /absolute/qa-output
python scripts/edition-print-verify.py /absolute/qa-output
python scripts/edition-print-images-verify.py /absolute/qa-output
python scripts/edition-print-sources-verify.py /absolute/qa-output
python scripts/edition-layout-pdf-verify.py /absolute/qa-output
```

The new PDF matrix covers all four formats, Letter/A4, short/long stories,
missing images, images off, ink-saving, sources off, contributors, long URLs,
code, unsupported literal tables and hostile markup. Full saved article links
are exercised in private and public previews. Inspect rendered PDF pages as
well as structural results; screen screenshots cannot verify page breaks.

## Compatibility and limitations

There is no schema migration or live backfill. Source text, images, reference
numbers and writer snapshots remain unchanged. Legacy omitted settings retain
their defaults and request hash behavior. Finalized settings remain immutable.

Excerpts are literal bounded saved text, so Markdown notation may remain visible;
the complete saved article view retains normal safe Markdown rendering. Page count
depends on selected articles, sources and contributors. Browser/driver pagination
can differ; no physical printer testing was performed.

LV426 had no Docker or installed PostgreSQL. Database tests use a portable
PostgreSQL 18 instance bound to loopback with only a disposable
`publishing_acceptance` database. The optional pgvector extension is unavailable;
edition tests do not require embedding functionality. No live database,
infrastructure, publication state or tag is changed.

Typecheck reproduces exactly the same 21 existing errors as untouched main;
the complete outputs are byte-identical. The errors are in unchanged agent
TypeScript code, outside the edition JavaScript changes. No lint script is
configured; JavaScript syntax and `git diff --check` are checked instead.

Main now includes CodeQL and Debricked workflows (merged PRs 12 and 13), unlike
the earlier project checkpoint. Their remote PR results are separate from the
local application test evidence.
