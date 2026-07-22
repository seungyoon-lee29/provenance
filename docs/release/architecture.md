# Architecture

> ⚠️ 2026-07-22 방향 전환 — 이 문서가 서술하는 모듈 일부(research-assistant·notification-center·broker-sync 등)는
> 삭제됐거나 삭제 예정이다. 재작성 전까지 이력 기준선으로만 읽을 것. 정본: [docs/notes/2026-07-22-pivot-backtest-strategy-engine.md](../notes/2026-07-22-pivot-backtest-strategy-engine.md)

A TypeScript **modular monolith** ([ADR 0001](../adr/0001-typescript-modular-monolith.md)):
one Next.js process serves the UI and server actions, one async worker runs
scheduled and queued jobs, backed by PostgreSQL and Redis. Modules communicate
only through published contracts — never by reaching into each other's storage.

## Processes

| Process | Entry | Responsibility |
| --- | --- | --- |
| app | `src/app` (Next.js) | guest + workspace surfaces, server actions |
| worker | [`src/worker/main.ts`](../../src/worker/main.ts) | delivery dispatch, sync, scheduled jobs |
| postgres | `compose.yaml` | durable state (F11 integration boundary) |
| redis | `compose.yaml` | cache, queue |

The production image ([`Dockerfile`](../../Dockerfile)) runs as a **non-root**
user; health/readiness and same-region operation are covered in
[backup.md](./backup.md).

## Module seams

Every caller uses only the public interfaces in `src/shared` and the
server-only collaboration seams. The runtime composition lives in
`src/platform/runtime`.

| Feature | Module area | Notes |
| --- | --- | --- |
| Foundation, vault, transport | `src/platform` | AES-256-GCM credential vault ([ADR 0002](../adr/0002-encrypt-provider-credentials.md)), fail-closed `ProviderAuthorization` |
| Market info, chart, AI | `src/modules/financial-information`, `research-assistant` | Information Outcome, source-owned resolvers ([ADR 0003](../adr/0003-isolate-evidence-and-provider-credentials.md), [ADR 0005](../adr/0005-use-gemini-for-all-supported-materials.md)) |
| Identity, connections | `src/modules/identity`, `provider-connections` | opaque sessions, generation-first revoke |
| Notifications | `src/modules/notification-center` | append-only Delivery Facts, fenced stores |
| Actual portfolio | `src/modules/actual-portfolio` | append-only journal, broker sync ([ADR 0004](../adr/0004-separate-actual-and-paper-books.md)) |
| Paper trading | `src/modules/paper-trading` | internal simulator + broker paper execution |

## Ledger isolation

Actual and Paper books share no journal, account, cash, position, order or
revision ([ADR 0004](../adr/0004-separate-actual-and-paper-books.md)). References
are distinct branded types, re-checked at runtime. Broker Sync
(`src/modules/actual-portfolio/broker-sync`) is read-only and never imports the
paper-order execution subtree.

## Data flow guarantees

- **Information Outcome**: values only appear with provenance, freshness and
  License Scope; API-required / no-data / provider-failure are distinct states.
- **One-transaction commits**: event append + reducer + cash/position + outbox
  land atomically; stream/poll duplicates and crash redelivery converge.
- **Fence-first erasure**: administrative deletion is monotonic and suppresses
  late writes and backup restores (see [privacy.md](./privacy.md)).
