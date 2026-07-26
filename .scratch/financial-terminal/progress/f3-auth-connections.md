# F3 — Auth + Provider-Connections Presentation (HTTP/route + UI marshalling)

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 인증 워크스페이스 UI · `/workspace` 랜딩 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

Status: COMPLETE. All three gates green. Module security logic untouched (import-only).

## Files created

Composition (server-only, globalThis singleton):
- `src/composition/identity-server.ts` — one `IdentitySessionStore` shared by `IdentityService`
  (with `EmailChallengeService` + `FederatedSignInService`) and the ProviderConnections core.
  Scripted federated adapters (fixed issuer/subject per provider) for dev/test; real OAuth opt-in,
  out of scope. Vault: `disabled` → stub vault + `vaultDisabled:true` flag (route gates save before
  seal is ever reached); otherwise `loadLocalCredentialKeyring` → real `CredentialVault`.
  Exposes `store` so the revoke route can read `accountSecurityRevision` for `expectedRevision`.
- `src/composition/session-cookie.ts` — `ft_session` cookie helpers (`HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` when APP_ENVIRONMENT is staging/production), `clientProofFrom` (CSRF ClientProof),
  `viewerFrom` (cookie → resolve).

API routes (App Router `route.ts`, zod-validated, runtime=nodejs):
- `src/app/api/auth/email/request/route.ts` — POST → `requestAccountEmail`; outcome passed through as-is.
- `src/app/api/auth/email/consume/route.ts` — POST → `consumeAccountChallenge`; on `issued` sets cookie, returns status only.
- `src/app/api/auth/email/peek/route.ts` — GET dev/test-only (404 otherwise) → `drainOutbox` → `{code, linkToken}`.
- `src/app/auth/signin/[provider]/route.ts` — GET → `beginFederatedSignIn` → 302 to authorizationUrl.
- `src/app/auth/callback/[provider]/route.ts` — GET → `consumeFederatedSignIn` → issued: cookie + 302 `/workspace`; else 302 `/signin?error=1`.
- `src/app/api/auth/revoke/route.ts` — POST → CSRF gate → `revokeSession({scope:"current"})` → clears cookie.
- `src/app/api/connections/route.ts` — GET `list(viewer)` (masked); POST `save|verify|revoke` by action; disabled vault save → `configuration_required` (409).

UI (Korean):
- `src/app/signin/page.tsx` + `src/app/signin/signin-form.tsx` — email+purpose request, code consume,
  Google/GitHub links; `aria-live` status; focus moves to code field on stage change (WS-06); 44px targets.
- `src/app/workspace/account-panel.tsx` — signed-in account reference + 로그아웃 (revoke) + masked
  connections list; "설정 필요" when vault disabled.
- `src/app/workspace/page.tsx` — MODIFIED: reads `ft_session` via `next/headers` cookies(); real session
  adds the account overlay; guest/no-cookie keeps the dev auto layout so layout/perf specs still render
  the seeded grid at `[data-role="workspace-layout"]`.

Browser smoke:
- `tests/browser/auth-flow.spec.ts` — email happy path (goto /signin → verify_email → peek code →
  consume → land on /workspace authenticated), asserts masked connections config exposes no secret,
  session value absent from HTML, HttpOnly cookie invisible to `document.cookie`, axe 0 serious/critical.

## Gate results (exact)

- `npm run check`: typecheck OK, lint OK, **vitest 191 passed / 27 files**, public-seam OK, server-seam OK.
- `npx playwright test --config=playwright.config.ts`: **36 passed, 2 skipped, 0 failed** (both viewports;
  new auth-flow smoke + existing workspace-layout/guest specs — no workspace-layout regression).
- `npx playwright test layout-performance --config=playwright.performance.config.ts`: **2 passed** (both viewports).

## Security decisions / notes

- Cookie always `HttpOnly` + `SameSite=Lax`; `Secure` only in staging/production (verified in helper).
- `/api/auth/email/peek` 404s unless APP_ENVIRONMENT ∈ {development, test} (verified).
- CSRF: every state-changing POST builds ClientProof (`sameOrigin` = Origin===APP_PUBLIC_ORIGIN OR
  `Sec-Fetch-Site: same-origin`). email/request+consume enforce it inside the module; revoke and
  connections POST additionally 403 on `!sameOrigin` at the route. Verified via curl: foreign Origin → rejected.
- Federated callback passes `callbackOrigin: APP_PUBLIC_ORIGIN` (service verifies exact match); raw code
  only travels in the query→service, never logged/persisted/rendered.
- Manual curl verification (dev): email issue→cookie set; connections masked list; save w/ disabled vault →
  409 configuration_required; /workspace authenticated shows account, no secret leak; github scripted
  begin→302→callback→cookie→/workspace.
- Revoke `expectedRevision`: route reads `store.accountSecurityRevision(accountRef)` (store exposed from the
  composition singleton — composition code, not module logic). ponytail: fine for in-memory single-node;
  a concurrent revoke race would just no-op via the module's idempotency/revision guard.

## Residuals / not done

- Real OAuth (spec §13.1) intentionally scripted — out of scope.
- `/api/connections` POST is wired (save/verify/revoke) but the account-panel UI only lists + shows the
  config state; there is no create/verify/revoke *form* in the UI (not required by the task's minimal-UI scope).
- Federated end-to-end is validated by curl + module unit tests, not by a Playwright spec (browser smoke is
  the email path per the task); the scripted authorizationUrl only resolves when APP_PUBLIC_ORIGIN == serving host
  (true in the Playwright lanes).
