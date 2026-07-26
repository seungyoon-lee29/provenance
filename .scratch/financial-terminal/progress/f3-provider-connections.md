# F3 — ProviderConnections core (progress)

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 provider-connections 웹 표면 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

Status: DONE. `npx vitest run tests/provider-connections-core.test.ts` → 9 passed. `npx tsc --noEmit` → 0 errors repo-wide (nothing originates in provider-connections/** or the test).

## Files created (exact paths)
- `src/modules/provider-connections/core/contracts.ts` — concrete command/view/receipt shapes extending the shared brands.
- `src/modules/provider-connections/core/provider-connections-core.ts` — `createProviderConnectionsCore(deps)` factory + `ProviderConnectionsCore` interface. In-memory store (network-off lane; no DB, no transport).
- `tests/provider-connections-core.test.ts` — 9 independent oracles. Fixtures marked `SYNTHETIC TEST DATA`.

## Public shapes (for barrel + composition wiring)

From `contracts.ts`:
- `VerificationState = "unverified" | "verified" | "failed" | "revoked"`
- `ProviderConnectionMaskedView` (extends nominal `ProviderConnectionView`): `{ connectionReference, provider, environment, capability, credentialType, credentialGeneration, credentialVersion, lifecycleFence, revision, verification, maskedHint }` — masked only, NO plaintext.
- `SaveProviderConnectionCommand` (extends `SaveProviderConnection`): `{ connectionReference: ProviderConnectionReference | null, provider, environment, capability, credentialType, secret }`. `connectionReference === null` ⇒ create; a reference ⇒ rotate.
- `VerifyProviderConnectionCommand` (extends `VerifyProviderConnection`): `{ connectionReference, result: "verified" | "failed" }`.
- `RevokeProviderConnectionCommand` (extends `RevokeProviderConnection`): `{ connectionReference }`.
- `ProviderConnectionReceipt` (extends `ProviderConnectionOutcome`), disc. union on `disposition`:
  - `accepted`  → `{ view: ProviderConnectionMaskedView, submissionUncertainty: boolean }`
  - `conflict`  → `{ view: ProviderConnectionMaskedView }`
  - `rejected`  → `{ reason: "stale_revision" | "unauthorized" | "not_found", currentRevision?: Revision }`

From `provider-connections-core.ts`:
- `createProviderConnectionsCore(deps: ProviderConnectionsCoreDeps): ProviderConnectionsCore`
- `ProviderConnectionsCoreDeps = { vault: CredentialVault; now: () => number; newConnectionReference: (seed: string) => ProviderConnectionReference }`
- `ProviderConnectionsCore extends ProviderConnections` — narrows `list/save/verify/revoke` return types to the concrete masked view / receipt union; adds two seams:
  - `authorizeSnapshot(reference, generation, viewer): boolean` — true only if the connection's CURRENT generation has a live sealed secret (models "can produce an AuthorizedTransport"). Post-revoke returns false for every generation.
  - `debugSealedEnvelope(reference): CredentialEnvelope | undefined` — inspection seam; envelope is `undefined` after revoke. Never crosses a network boundary.

## Invariants satisfied
- SEC-03: secret sealed via `vault.seal` with a correct `CredentialAadContext` (purpose `provider_credential`, workspace/connection/provider/credentialType/environment). Only the `CredentialEnvelope` is stored; views expose masked fields + last-4 hint. Oracle asserts `JSON.stringify` of the API surface contains no secret substring, and an AES round-trip (ciphertext ≠ plaintext, only vault opens it).
- SEC-10 idempotency: create keyed on `(workspace, idempotencyKey)`; rotate/verify/revoke keyed on connection-scoped idempotencyKey vs canonical payload. same/same ⇒ existing receipt, no generation bump; same/different ⇒ side-effect-free conflict; stale `expectedRevision` ⇒ rejected carrying `currentRevision`, no mutation. Canonical payload uses the secret's masked hint + length, NOT plaintext.
- SEC-10 generation-first revoke: `generation++` and `fence++` (and `revision++`) BEFORE dropping the envelope; verification → `revoked`; `submissionUncertainty: true`. After revoke, `authorizeSnapshot` is false for old AND new generation, envelope is gone. `// ponytail:` note points reconciliation to F8/F9.
- SEC-01 isolation: only `WorkspaceViewerContext` may mutate; guest ⇒ rejected/unauthorized with 0 seal + 0 store change; cross-workspace viewer sees nothing (`owned()` filters by `workspaceReference`), foreign revoke ⇒ rejected, owner's connection untouched.

## Integration notes for the main agent
1. Barrel: no `src/modules/provider-connections/index.ts` created (main agent owns barrels). Export `createProviderConnectionsCore`, `ProviderConnectionsCore`, `ProviderConnectionsCoreDeps` from `./core/provider-connections-core` and the contract types from `./core/contracts`.
2. Composition must inject `deps`: a real `CredentialVault` (from platform), a `now: () => number` clock, and a `newConnectionReference` generator (UUID-backed). Store is in-memory inside the factory — swap for a repo-backed store when F3 gains durability (out of scope now).
3. `authorizeSnapshot`/`debugSealedEnvelope` are core-local seams, NOT the real transport. Real authorization flows through `src/platform/provider-transport` `ProviderAuthorization` — wiring the generation/fence gate into that grant reader is a later integration step (transport was explicitly out of scope for F3 core).
4. `credentialVersion` currently mirrors `credentialGeneration` (both bump together on save/rotate). If version must diverge from generation, revisit `view()`.
5. Runtime imports are relative (no `@/` alias at runtime in vitest); type-only imports use `@/shared`. Match this if you re-home files.
