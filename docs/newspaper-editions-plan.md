# Newspaper Edition implementation plan

## Scope and current architecture

The server owns the authenticated newsroom, PostgreSQL article records, article
publication revisions, tenant permissions and local media storage. The reader
and Platform are separate applications; this milestone adds one server-owned
editor and print view, not a second article store or an AI workflow. Server main
`2236af27ef4b298c7877c54f579d91d9911eac17` is the starting point. The integrated
commission button styling remains intact; the obsolete overlay is not reapplied.

## Product and data contract

- Publish → Newspaper editions opens the editor. A named, dated issue is private
  by default. Published-content mode selects authored published articles; private
  proof mode also allows authored drafts and is visibly marked DRAFT.
- Authored eligibility uses the existing original/deep-dive classification;
  imported curated RSS bodies cannot be printed as owned editorial content.
- Search and paginate candidates, select/order articles, choose a lead, and set
  Letter/A4, color/ink-saving and images on/off. No generated summaries.
- A working issue retains selected article snapshots on ordinary save. Explicit
  Refresh updates text/media; adding a new article takes its current snapshot.
  Finalization locks issue text, order and layout. It never publishes articles.
- Snapshot images are bounded local raster copies held outside public static
  media and served only through edition authorization. Unsupported or unavailable
  images are omitted with an explanation. No remote image fetch is introduced.
- Sharing a finalized published-content issue is a separate publish-permission
  action. Public reads revalidate every source; withdrawal/deletion makes the
  public issue unavailable rather than exposing an old unpublished snapshot.
  Private authorized archives retain the saved evidence. Printed/downloaded
  copies cannot be recalled.
- Revision checks protect saves/refresh/finalize/share from stale concurrent
  edits. A creation request key prevents duplicate issues on retries.

## Implementation phases and ownership

1. Backend: additive idempotent schema, service and real-route tests, scoped
   permissions, snapshots and protected media, eligibility and public withdrawal.
2. Editor: accessible responsive selection/order/settings workflow, explicit
   refresh/finalize/share, loading/errors/retry, coherent saved/unsaved state.
3. Print: one newspaper template, honest continuous-screen preview, browser print
   action, paper settings, safe text rendering, bounded images and proof marks.
4. Integration: shared navigation/help, focused tests and full disposable-DB
   regression, desktop/mobile checks and actual PDF rendering/visual review.
5. Independent review of final diff, fixes and exact-head reruns; draft PR only.
6. Consistent backup and candidate build, then authorized backend rollout with
   readiness/site/asset/data checks and documented rollback.

## Acceptance and safeguards

Tests cover draft privacy on API and assets, tenant/permission denial, authored
eligibility, source nonmutation, snapshot stability/explicit refresh, immutable
finalization, order/lead preservation, repeated and stale writes, public
withdrawal, safe rendering and no implicit AI/publication. UI checks include
search/pagination, cancel/reopen, errors, keyboard and narrow viewports. PDF
checks cover Letter/A4, short/long text, headings/images, ink-saving, missing
images, margins and absence of controls/clipping. Browser page breaks are the
authority; screen preview is approximate. Browser-generated headers/footers and
printer defaults are documented rather than fake page numbers.

Tests use disposable fixtures and no provider credentials or paid calls. No
physical printing, synthetic live publication, automatic editions/distribution,
credentials/network changes, or scheduled automation. Existing baseline type
errors are reported separately. No CI deployment workflow is introduced.

## Rollout and rollback

Record source/image identities and preserve database, media, settings and current
artifacts together before mutation. Build a candidate and run isolated migration
and regression checks. Deploy only required components, keep automation disabled
and database internal, then verify all four existing sites and exact assets.
Rollback restores prior application image/source, leaving additive edition tables
intact; do not overwrite newer user data with a backup merely to revert code.
Retain root-protected backup and a runbook with exact rollback commands. The
`v1.2.0-beta.1` tag remains unchanged; feature PR stays unmerged for user testing.

## Contributor extension

Capture public profile fields and bounded portrait bytes alongside each newly
selected or explicitly refreshed article. Preserve the existing writer assignment
as the credit; do not infer reporting, human review or verified credentials.
Only configured AI personas receive an AI label. Aggregate captured writer IDs
without concealing different saved profile versions. Add optional portraits and
an end-of-issue contributors section, with safe legacy byline fallback.

Storage adds nullable portrait columns idempotently. Existing finalized issue #1
and its reference repair remain unchanged; there is no historical-profile backfill.
Validate real routes, snapshot stability, resource limits, tenant/public withdrawal
protection, and actual Letter/A4 PDFs before the backed-up backend-only rollout.
