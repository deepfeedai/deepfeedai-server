'use strict';
// Explicit operator-only repair. Never mounted as an API or called during startup.
// Dry run: node scripts/backfill-edition-one-references.cjs --dry-run > protected-plan.json
// Apply after backup/review: node scripts/backfill-edition-one-references.cjs --apply --plan-stdin < protected-plan.json
const fs = require('node:fs');
const { backfillEditionOne } = require('../lib/edition-references');
async function main() {
  const args = process.argv.slice(2);
  const dry = args.length === 1 && args[0] === '--dry-run';
  const apply = args.length === 2 && args[0] === '--apply' && args[1] === '--plan-stdin';
  if (!dry && !apply) throw new Error('Use --dry-run, or --apply --plan-stdin after backup and plan review');
  const expectedPlan = apply ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
  const pool = require('../db').getPool();
  try { console.log(JSON.stringify(await backfillEditionOne(pool, { apply, expectedPlan }), null, 2)); }
  finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
