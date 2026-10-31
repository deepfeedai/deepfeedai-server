# Writer cards and edition contributors

Newspaper bylines emphasize the saved writer name, portrait, AI identity when recorded, and configured writing focus. Article dates are separate metadata: published dates require a saved published state; proofs use a clearly labeled update date. Contributor links navigate within the saved issue rather than reading mutable live profiles.

The optional contributors section groups saved profiles and lists each associated article with its recorded role. Writing focus, writing style and About are configuration, not verified human credentials. AI biographies are identified as persona descriptions. Missing information is handled without inventing expertise, generation credit or human review.

## Snapshot compatibility

No migration or backfill is required. Existing finalized editions retain their captured names, biographies, portraits, references and attribution. Their rendering improves, but absent writing-style metadata stays absent. Newly captured articles and explicitly refreshed working editions can include a bounded style name and tone. Only tenant-owned or designated system styles are eligible; prompts, examples and private style instructions are excluded. Finalization continues to freeze these values.

Writer assignment alone supports only Assigned writer. The current records do not provide immutable generating/revising-writer provenance, so this enhancement does not infer stronger credit. Article counts describe linked contributions, not claims of authorship or review.

## Verification and manual review

Run `bash scripts/test-newsroom-workflow.sh` with Docker for the isolated full suite. Run `node scripts/edition-print-qa.cjs <output-directory>` with Playwright/Chrome available for browser and PDF fixtures; these intercept API responses and never call a provider or printer. Inspect Letter and A4 PDFs visually in addition to automated assertions.

Review a saved edition with contributors enabled, then with contributors or images disabled. Check the compact byline, separate date, internal contributor links, long and missing biographies, multiple articles per writer, mobile layout and print output. Existing proof authorization, withdrawal and snapshot-image access rules remain unchanged. No real provider calls or physical print jobs are part of verification.
