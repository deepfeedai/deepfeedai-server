# Self-hosted runtime changes

Use Node.js 24 and PostgreSQL 16 with pgvector. The companion private infrastructure
repository provides Compose, gateway, build and recovery examples.

- `DATABASE_SSL=disable` explicitly selects plaintext transport for a private local
  database network; `verify-full` requires certificate verification. If unset, the
  prior compatibility behavior remains. Do not disable TLS for a remote untrusted link.
- `/health` reports process liveness. `/ready` stays 503 until database initialization
  finishes, then returns 200. It is an initialization gate, not an ongoing DB probe.
- `AUTOMATION_ENABLED=false` blocks both scheduled and manually triggered registry
  jobs and skips Telegram webhook restoration and Discord gateway startup. It does
  not prevent explicit manual AI requests; network isolation is a separate control.
- Fresh databases create the credit-pack index before its seed, advance the explicit
  platform tenant's sequence, and seed platform categories using `(tenant_id, name)`.
  Category names, colors and keywords are preserved from legacy settings.

## Validation without provider calls

Use an empty disposable pgvector database, never a live application database. Set
`DATABASE_URL`, `DATABASE_SSL=disable`, `NODE_ENV=test`, `DEPLOYMENT_MODE=multi` and
`AUTOMATION_ENABLED=false`; use a disposable test encryption key. Run:

```sh
node --test --test-concurrency=1 tests/*.test.js tests/integration/*.test.js
node tests/startup-smoke.mjs
```

The startup check requires no `.env` file and no database. The category integration
test checks seeded IDs and idempotency, then uses the real generation route with an
in-process AI stub. It never submits provider requests. Run tests on an internal-only
container network with no production secrets for additional protection.

Known limitations: the existing tool-schema TypeScript errors remain; this change
does not claim a clean typecheck or remediate dependency audit findings. Paid AI and
messaging integrations require separate explicit validation.
