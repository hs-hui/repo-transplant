# Transplanting backend features

Backend mistakes cost more than UI mistakes: they can lose data, expose it, or take production down. Work from `trace.backend`, and account for every row of it.

## API contracts

For each route in the spec, record method, path, **who may call it**, request, response, every error status and every side effect. `auth` is required. Use `"public"` only when the route really is public.

Then fit the contract to the target:

- Use the target's route layout, middleware chain, validation library, error format and response envelope.
- Keep the behavior. If the source returns 404 for another user's record to hide its existence, keep that.
- Do not trust `auth_hint`. It is a text match, and a missing hint does not mean the route is public. Read the handler.
- Check authorization per object, not only per route: can user A read user B's record by changing an id?

## Data model

**Never copy source migrations.** Write a new migration with the target's tool against the target's schema.

- Inspect the target's existing tables first. Reuse an entity when one exists, and mark it `reuse`.
- Prefer additive changes. A new nullable column or a new table is safe to roll back.
- For a required column on an existing table, add it nullable, backfill, then enforce it, across separate deploys.
- Check dialect differences: JSON columns, enums, generated ids, timestamps with time zones, full-text search, and upsert syntax.
- Add indexes for the new query paths, and consider table size. On Postgres, `CREATE INDEX CONCURRENTLY` cannot run in a transaction.
- Declare every migration in the plan with its rollback. Destructive steps need `destructive: true` and a reason.

**Migrations run only against a local database.** `transplant_verify` refuses connection strings that point elsewhere. Applying them to shared environments is the user's job, and the report says so.

## Secrets and configuration

- Account for every secret in `trace.backend.env_vars`, in the spec or in `out_of_scope`.
- Add names to `.env.example` without values, in the target's config style. If the target validates env at startup, extend that.
- Decide what happens when a value is missing: fail at startup for required values, and disable the feature cleanly for optional ones.

## Background work and integrations

- **Jobs:** use the target's queue. Keep retry policy, backoff and concurrency. Handlers must be idempotent, because queues deliver more than once.
- **Webhooks:** verify the signature over the raw body, reject old timestamps, and deduplicate by event id. Respond fast and do the work in a job.
- **External services:** put calls behind a small adapter, set timeouts, and define behavior for outages. In tests, fake at the adapter or HTTP boundary. Never call the real service from verification.
- **Transactions:** find writes that must succeed together, and do not hold a transaction open across a network call.
- **Realtime:** check how the target authenticates connections, and whether it runs more than one instance, which needs a shared pub/sub layer.

## Testing

Run contract and integration tests against a real local database when the target's setup allows it, using a throwaway container or SQLite. Cover at least:

- The success path, with its response shape and its stored data.
- Validation failures.
- Unauthenticated, and authenticated but not allowed.
- Duplicate submission, for anything with side effects.

Long-running servers do not belong in a verification command. Use the test runner's in-process client, such as supertest, TestClient or httptest.

## Rollback

The plan's `rollback` must say how to back out after deploying, not only how to delete the branch: which migration to reverse, which env vars to remove, and what happens to data written meanwhile.
