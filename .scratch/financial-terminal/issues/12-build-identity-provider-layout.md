# 12 - F3 Identity·Provider Connections core·layout 구축

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 11
Blocked by: 11
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
