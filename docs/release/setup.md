# Setup

Provenance is a TypeScript modular monolith: a Next.js app, an async worker,
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

## CI gates (remote enforcement)

The local pre-commit hook ([`.husky/pre-commit`](../../.husky/pre-commit)) and
CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) enforce the
**same gates**, sharing one source so they cannot drift:

- Content gates (whitespace, credential-format scan, `.env.local`/`.secrets`
  untracked) live only in
  [`scripts/gates/content-gates.sh`](../../scripts/gates/content-gates.sh) —
  the hook runs it over the staged diff (`--cached`), CI over the push/PR range.
- Build gates are the single `npm run check` (typecheck · lint · unit · seams)
  that both call.

CI lanes mirror spec §16: `PR-fast` (hook parity, required), `PR-integration`
(`compose:verify` Docker stack, network-off), `PR-browser` and `nightly-perf`
(optional — hosted runners are not the spec's fixed-runner p95 source of truth).
No job uses a provider secret (scripted lane only, SEC-05); egress-off is proven
by the network-off harness, not a runner firewall.

**Push policy is unchanged.** Pushes are blocked by default
([`.husky/pre-push`](../../.husky/pre-push)); an intentional push is
`ALLOW_PUSH=1 git push`. CI is a *second* enforcement layer, not a relaxation —
it re-runs the gates on the remote so a commit that bypassed the local hook
(different tool, unhooked clone) still fails the same checks.
