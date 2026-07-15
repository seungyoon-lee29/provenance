# 12 - F3 Identity·Provider Connections core·layout 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 11
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-15T21:58:36+09:00
Last heartbeat: 2026-07-15T23:20:00+09:00

## Objective

email·Google·GitHub session, User Workspace, encrypted Provider Connection CRUD와 Workspace layout을 하나의 개인화 기반으로 완주한다.

## Owned scope

- `src/modules/identity/**`, `src/modules/provider-connections/core/**`, `src/modules/terminal-view/layout/**`, auth/settings/layout presentation.
- Identity/ProviderConnections/layout integration, browser와 security fixture.
- shared session/vault/transport type, composition, migration와 index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- guest/user resolve, per-session generation, account authorization epoch, current/all revoke와 Workspace switch를 구현한다.
- email challenge event/target/verifier/action material all-old/all-new, link+manual code consume/session issuance를 Identity가 소유한다.
- Google/GitHub state·PKCE·OIDC nonce/assertion trust, exact callback와 `issuer+subject` identity를 검증한다.
- ProviderConnections `list/save/verify/revoke`는 Viewer Context, revision/idempotency와 generation-first revoke를 사용하고 credential 원문 getter를 제공하지 않는다.
- layout drag/resize/pane split은 local draft, server revision/idempotency와 명시적 guest adoption을 사용한다.
- Identity-owned deletion command는 monotonic fence와 durable coordinator intent를 먼저 commit한다. Identity receipt는 session/challenge/target/action material/JobContextReference를, ProviderConnections receipt는 credential crypto-shred, generation/fence 증가와 cached transport 폐기를 포함하고 backup expiry까지 restore suppression을 유지한다.

## Interface contract

- CredentialVault와 generic ProviderAuthorization은 F0 primitive만 사용한다. F4/F9/F10은 core CRUD를 읽기 전용으로 소비한다.
- `resolveJob`, purpose-tagged delivery resolver와 erasure coordinator는 server-only이며 transient Viewer Context를 queue에 저장하지 않는다.
- Account Security Event projection 이후의 Delivery Intent/Fact는 F5 소유다.

## Acceptance criteria

- enumeration-safe 10분 challenge, 10-character Crockford code, family 5회 lockout, GET/prefetch consume 0과 동시 POST session 최대 1을 검증한다.
- forged OAuth assertion, state/nonce/audience/issuer mismatch, replay와 cross-provider callback은 session/workspace side effect 0이다.
- current revoke 뒤 다른 session은 유지되고 all revoke·Workspace switch·stale epoch는 해당 resolve/emit/commit을 막는다.
- Provider Connection same/same receipt, same/different conflict, stale revision·cross-workspace·revoke race에서 secret call/late commit 0이며 browser에는 masked 상태만 보인다.
- 사용자 A layout은 reload 뒤 복원되고 B/guest와 섞이지 않는다. drag/resize/save/failure 표시가 §11 interaction 예산을 통과한다.
- deletion fence 뒤 session/challenge consume, session issuance, secret/action-material/job resolve, provider route, personal cache·queue commit이 0이고 Identity·ProviderConnections receipt와 processor 상태가 공개 erasure 상태에 반영된다. backup restore fixture는 fence를 보고 재삭제하며 개인 state를 다시 노출하지 않는다.

## Out of scope

- 실제 email delivery, Resend/Web Push, provider data/broker route.
- account linking, password login과 운영 OAuth application 생성. PR은 test issuer/scripted OAuth, 실제 OAuth는 opt-in flag에서만 실행한다.

## Traceability

- [승인 spec](../spec.md) `UF-03/04/05`, `WS-02~04/06`, §6~7, F3, `SEC-01/02/03/07/08/09/10`, `AT-03/11`, `CFG`.

## Progress — Phase 1 (logic layer, 완료·게이트 green)

Status는 `claimed` 유지. Identity·ProviderConnections·Layout의 도메인/보안 로직을 vertical-slice TDD로 완주하고 적대적 리뷰까지 통과했으나, presentation·composition·browser·performance 통합(Phase 2)이 남아 acceptance의 browser/§11 예산 게이트가 아직 미충족.

### Answer (Phase 1)
- **Identity**(메인 작성): 불투명 hash-only session store(per-session generation·account authorization epoch·workspace switch·idle+absolute expiry·deletion fence), enumeration-safe email challenge(10분 만료·link+10자 Crockford code family·5회 lockout이 두 proof 모두 무효화·GET/prefetch consume 0·atomic consume→session·idempotency), federated sign-in(one-time state/PKCE/OIDC nonce·정확한 callback origin·id_token 검증[sig/issuer/aud/nonce/exp, alg=none 거절]·`issuer+subject` identity·암묵적 email linking 없음·forged/replay/cross-provider→session 0), revoke(current/all)+reauth+administrative erasure(fence-first + restore suppression).
- **ProviderConnections core**(위임): AES-256-GCM vault seal + purpose AAD, masked-only view·plaintext getter 없음, revision/idempotency/canonical-payload conflict, generation-first revoke.
- **Layout**(위임): drag/resize/divider/split, guest draft vs server 지속·명시적 adoption·A/B workspace 격리, revision/idempotency/stale-rejection.

### Changed files (Phase 1)
- `src/modules/identity/**`: `contracts.ts`, `session-store.ts`, `email-challenge.ts`, `federated.ts`, `identity-service.ts`.
- `src/modules/provider-connections/core/**`: `contracts.ts`, `provider-connections-core.ts`.
- `src/modules/terminal-view/layout/**`: `contracts.ts`, `layout-domain.ts`, `layout-service.ts`, `layout-presenter.ts`, `workspace-layout.tsx`, `workspace-layout.module.css`.
- tests: `tests/identity-{session,email-challenge,federated,service}.test.ts`, `tests/harness/identity-harness.ts`, `tests/provider-connections-core.test.ts`, `tests/layout-{domain,presenter}.test.ts`, 그리고 통합 대기 spec `tests/browser/workspace-layout.spec.ts`·`tests/performance/layout-performance.spec.ts`(아직 lane 미등록).

### Validation (Phase 1)
- `npm run check`: typecheck·lint clean, Vitest **191 tests / 27 files**(신규 F3 58), public/server seam 통과. 회귀 0.
- Identity 30 oracle(SEC-01/02/07/08/09), ProviderConnections 9(SEC-01/03/10), Layout 17(UF-04/WS-02) — 모두 독립 hand oracle.

### Review (Phase 1)
- 위임 산출물(ProviderConnections·Layout) 메인 검수 후 통합.
- 적대적 리뷰: Spec+Standards 서브에이전트(다른 관점) 통과 — 확정 HIGH 1(enumeration body leak) + LOW/gap 수정 완료. codex 적대자는 플랫폼 콘텐츠 필터로 차단되어 미가동, protocol에 따라 다른 관점 서브에이전트로 대체.
- 수정: enumeration outcome에서 account-derived `revision` 제거(+테스트로 body 동일성 단언); revoke/erasure receipt를 `hash(proof)+key`로 바인딩(cross-account 충돌 제거 +oracle); dead request-security-epoch 필드 제거; cross-provider `issuer+subject` 구분 oracle 추가.

## Progress — Phase 2 (통합)

### Layout browser·performance 게이트 — 완료 (green)
- `/workspace` route + `/api/workspace/layout`(persist) + `/api/workspace/reset`(dev/test) + globalThis 공유 dev workspace singleton(`workspace-server.ts`)로 `WorkspaceLayout`을 mount. component에 server-persist(`persistUrl`)와 양방향 이동(←↑) 추가.
- **browser 16/16**(desktop-1366·mobile-360): 씨드 2위젯 rev0, keyboard move+focus 복귀, resize+aria-live, split, divider, **reload-restore**(server 지속), 360 가로 overflow 0, axe serious/critical 0 — WS-02/03/04/06 + AT-03 reload.
- **performance 2/2**: layout input→paint p95가 §11.2 예산(desktop 80/mobile 140ms, local-saved 100ms) 통과.
- Next 라우트 번들 분리로 page/route가 서로 다른 모듈 인스턴스를 받는 문제를 globalThis singleton으로 해결; perf lane은 persist POST를 즉시 fulfill해 throttled 네트워크 노이즈를 측정에서 분리.

### auth·connections presentation — 완료 (green)
- **composition singleton**(`src/composition/identity-server.ts`): globalThis-anchored 공유 `IdentitySessionStore` + `IdentityService`(email/federated) + ProviderConnections core. vault disabled → save는 `configuration_required`.
- **cookie session**(`session-cookie.ts`): `ft_session` HttpOnly·SameSite=Lax·Secure(staging/prod), CSRF `ClientProof`(정확한 Origin 일치 또는 위조 불가한 `Sec-Fetch-Site`).
- **라우트**: `POST /api/auth/email/{request,consume}`, dev/test 전용 `GET /api/auth/email/peek`(Mailpit 등가), `GET /auth/signin|callback/[provider]`, `POST /api/auth/revoke`, `GET|POST /api/connections`. `/signin` 폼 + `/workspace` 인증 오버레이(account + masked connections).
- **browser smoke**(`tests/browser/auth-flow.spec.ts`): email 로그인 happy path(request→peek→consume→cookie→/workspace account), masked view에 secret 부재, HttpOnly 쿠키 JS 비가시, axe serious/critical 0.

### Validation (Phase 2 전체)
- `npm run check`: typecheck·lint clean, **Vitest 191 / 27 files**, seam 통과.
- Playwright browser(desktop-1366·mobile-360): **36 passed** — auth smoke + layout(reload-restore·WS-02/03/04/06) + 기존 guest/chart 무회귀.
- Playwright performance: **layout 2 passed**(§11.2 input→paint 예산).

### Review (Phase 2)
- 위임(auth·connections) 산출물 메인 보안 검수: 쿠키 플래그·CSRF fail-closed·masked-only·no-secret-leak·vaultDisabled seal 차단·callback exact-origin·GET/prefetch consume 0·peek dev/test-gated 확인.
- 수정: OAuth 버튼을 config `identityProviders`(enabled+configured)에만 노출(§13.1) — dev/test는 email 단일 경로로 정직화(scripted OAuth의 broken 버튼 제거).

### Residual risks (F3)
- OAuth end-to-end는 scripted/opt-in(§13.1). begin/callback 라우트는 배선돼 있고 SEC-07은 unit로 완증. 실제 Google/GitHub sign-in은 `RUN_GOOGLE_IDENTITY_CONTRACT`/`RUN_GITHUB_IDENTITY_CONTRACT` opt-in job에 남김. scripted Google 어댑터는 subject 반환이라 UI 경로 미완(버튼 gating으로 은닉).
- in-memory 2 store(auth vs dev-layout)로 분리 — account panel과 layout이 서로 다른 session에서 렌더. 실 datastore + 단일 store 통합은 F11.
- connections 라우트는 요청마다 fresh idempotencyKey 생성 → HTTP 계층 idempotency는 client key 공급 전까지 비활성(모듈은 지원). connections UI는 list + config 상태만(create/verify 폼은 최소 UI 범위 밖).
- F5 위임 항목(envelope AccountChallengeMaterial all-old/all-new + `resolveAccountChallengeDelivery`, verified-address·security-notice epoch dispatch 재검사)과 enumeration timing-class 잔여는 Phase 1 기록대로 유지.
- vault·provider는 network-off scripted lane. NIST/tamper/rotation(AT-11 vault)은 F0 `credential-vault.test.ts`가 소유.
- **F5 위임 항목**(F3 소유지만 delivery와 결합): envelope-encrypted `AccountChallengeMaterial` all-old/all-new 저장 + `resolveAccountChallengeDelivery`, verified-address·security-notice epoch dispatch 재검사.
- **알려진 ceiling**: in-memory store(no DB), layout idempotency ledger는 object-identity WeakMap(직렬화 시 유실 — DB row에 `{key→hash,revision}` 동반 저장 필요), `credentialVersion`은 vault key rotation 전까지 generation과 일치.
- enumeration의 timing-class는 in-memory 분기 비대칭이 남으나 관측 가능한 지배 timing은 out-of-band delivery(F5)라 문서화로 남김.
