# Setup

FakeBloomberg is a TypeScript modular monolith: a Next.js app, an async worker,
PostgreSQL and Redis. The default runtime is **network-off with scripted
providers** — no external API keys are required to build, test, or run the demo
surfaces.

## Prerequisites

- Node.js ≥ 22 (see [`package.json`](../../package.json) `engines`).
- Docker + Docker Compose (for the production-like stack).

## Configure

Copy the example environment and leave it as-is for the scripted lane:

```
cp .env.example .env.local
```

Every provider credential in [`.env.example`](../../.env.example) is empty and
every `RUN_*_CONTRACT` flag is `false` — the app runs on scripted data until a
single-owner operator opts in (see [rights.md](./rights.md)). Secrets are never
committed: `.env.local` and `.secrets/` are gitignored and blocked by the
pre-commit hook.

## Run (local Node)

```
npm install
npm run dev          # Next app on http://localhost:3000
npm run worker:dev   # async worker
```

## Run (production-like stack)

```
npm run compose:up     # postgres, redis, migrate, app, worker (profile: local)
npm run compose:down
```

The compose stack is defined in [`compose.yaml`](../../compose.yaml) and the
image in [`Dockerfile`](../../Dockerfile) (non-root, see
[architecture.md](./architecture.md)).

## Database

```
npm run db:migrate    # apply migrations (scripts/migrate.ts)
npm run db:status
npm run db:rollback
```

## Verify

```
npm run check              # typecheck + lint + unit + seam checks
npm run check:release-docs # markdown links + stale-contract references
npm run package:release    # secret-free release ZIP + SHA-256 manifest
```

Browser and performance suites need the app running:

```
npm run test:browser
npm run test:performance
```

See [release.md](./release.md) for the full gate matrix and the ready-for-human
operational drills.
