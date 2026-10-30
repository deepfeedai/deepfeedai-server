# Commission source picker

This milestone replaces the Editor assignment's unsearchable source list with a paginated evidence picker. It is stacked on the workflow-navigation branch; it does not merge that work or change the separate Platform application.

## Workflow

Review attached source cards, choose **Add sources**, search titles/publishers/summaries, and optionally filter publisher, topic or date. Date filtering uses the article's stored creation/import timestamp; it is not a claim about the publisher's original publication date. Newest sorting is deterministic; relevance sorting ranks title matches, then publisher matches, then summary matches, with newest/ID tie-breaking. No embeddings or AI requests are involved.

Checkbox selections survive searching, filtering and pagination. Already attached articles are marked Added and cannot be selected again. The footer saves only the selected additions. Cancel discards pending selections without changing the assignment. Removing an attachment is a separate explicit operation and never deletes the source article. Editing the writer is separate from attaching evidence.

The API returns the same minimum/maximum source rules used by approval and drafting. Adding sources never approves, generates or publishes an article. Changed evidence or writer selection invalidates approval; repeated identical additions preserve existing approval.

## Integrity and limits

Assignment mutations lock the tenant-scoped assignment row, validate source eligibility and atomically preserve concurrent additions. Source IDs are deduplicated; foreign, archived, missing or unsupported articles are rejected. Errors preserve pending selection. After an uncertain save result, repeating the additive request is safe; it does not duplicate attachments or invoke a provider. A concurrently changed assignment state can reject edits and requires reloading its current state.

Eligible evidence follows the existing curated-article and stored supporting-text rule. This does not certify the accuracy or substantive quality of a source; HTML-only stored text remains an inherited quality limitation. Publisher/topic facets are bounded to avoid returning an entire library; search remains available for values absent from the facet lists. Source previews render as plain text, and external links accept only HTTP(S) URLs without embedded credentials.

## Validation

Run `bash scripts/test-workflow-navigation.sh` with Docker for the aggregate disposable-database tests. The source-picker route tests are in `tests/integration/assignment-source-picker.test.js`; UI controller tests are in `tests/commission-source-picker.test.js`. The guarded `tests/acceptance/commission-picker-browser-fixture.js` seeds only disposable example evidence for desktop/mobile testing. No real provider keys or production content are used.

Manual checks: open an assignment; inspect existing attachments; search and select across pages; cancel/reopen; add the selection once; verify cards immediately update; remove only an attachment; edit/cancel a writer independently; check keyboard focus/Escape and narrow-screen scrolling. Do not use Generate draft to test source management.

## Overlay reconciliation

The separately unpublished Editor button customization overlaps the original renderer/save handler and remains preserved in its original worktree. It must not be blindly reapplied over the picker or silently included in publication. Consolidation/publication/deployment require the separately requested approval; local canonical implementation and disposable tests can proceed independently.
