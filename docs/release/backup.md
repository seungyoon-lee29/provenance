# Operations: backup, restore, migration

Same-region operation is assumed: app + worker (2 vCPU / 4 GiB each), PostgreSQL
(2 vCPU / 4 GiB), Redis (1 vCPU / 1 GiB). The production image runs as a
non-root user with health and readiness endpoints.

## Health and readiness

- App: Next.js health route; the container is `--wait`-gated in
  [`compose.yaml`](../../compose.yaml).
- Worker: `WORKER_HEALTH_PORT` (see [`.env.example`](../../.env.example)),
  entry [`src/worker/main.ts`](../../src/worker/main.ts).

## Migrations

Forward and rollback migrations are applied by
[`scripts/migrate.ts`](../../scripts/migrate.ts):

```
npm run db:migrate    # up
npm run db:status
npm run db:rollback   # down
```

`scripts/verify-migrations.ts` checks apply → reapply (idempotent) → rollback.
The compose `migration-smoke` profile runs this against a real PostgreSQL.

## Backup and restore drill

1. Snapshot PostgreSQL (and any durable Redis state).
2. Restore into a clean instance.
3. Re-run migrations to head.
4. **Deletion-suppression check**: confirm that data erased before the backup
   was taken does NOT reappear after restore — the erasure fence (see
   [privacy.md](./privacy.md)) suppresses re-creation. This is asserted at the
   module level in the erasure test suites and must also be confirmed on the
   restored stack (ready-for-human, see [release.md](./release.md)).

## Rollback

Deploy rollback = redeploy the previous image tag + run `db:rollback` to the
matching migration. Because migrations are reversible and idempotent, a failed
release rolls back without data loss.
