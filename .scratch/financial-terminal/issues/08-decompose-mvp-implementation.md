# 08 - MVP 구현 티켓 분해

Type: docs
Status: resolved
Triage: ready-for-agent
Depends on: 07
Blocked by: None
Owner: /root
Claimed at: 2026-07-15T12:00:03+09:00
Last heartbeat: 2026-07-15T12:31:45+09:00

## Question

승인 MVP spec의 F0~F11 vertical slice를 어떤 의존성, 단일 파일 ownership, interface contract와 관찰 가능한 acceptance 기준의 implementation ticket으로 분해해야 첫 frontier부터 안전하게 구현을 시작할 수 있는가?

## Acceptance criteria

- F0~F11 각각을 번호가 연속된 `Type: implementation` ticket 하나로 만들고 spec lane ID와 source requirement를 추적한다.
- 각 ticket에 Objective, Owned scope, Requirements, Interface contract, Acceptance criteria와 Out of scope를 기록한다.
- `Depends on`과 `Blocked by`가 spec의 dependency graph와 일치하고 순환이 없으며, resolved 선행 티켓만 가진 첫 implementation ticket 하나가 frontier가 된다.
- shared public type, composition root, migration, barrel/index와 spec의 단일 owner 규칙을 유지하고 병렬 group P1~P3의 파일 ownership이 겹치지 않게 한다.
- implementation artifact가 아직 없는 외부 provider/secret/egress gate를 가짜 완료 조건으로 만들지 않고 scripted/network-off 기본과 opt-in contract를 구분한다.

## Answer

- 승인 spec의 F0~F11을 [issue 09](./09-build-foundation-contracts.md)부터 [issue 20](./20-integrate-release-artifacts.md)까지 12개 implementation ticket으로 1:1 분해했다.
- F0~F3 sequential contract spine, `F4→F5`, `F6→F7`, `F6→F8→F9`, `F6→F10` release branch와 F11 join을 실제 ticket dependency/blocker로 옮겼다.
- F0/main이 public type, composition root, migration, barrel/index와 shared vault/transport primitive를 계속 소유하고 P1~P3는 module/subtree가 겹치지 않게 했다.
- 각 ticket에 Objective, Owned scope, Requirements, Interface contract, Acceptance criteria, Out of scope와 spec traceability를 기록했다.

## Changed files

- `.scratch/financial-terminal/issues/09-*.md`~`20-*.md`: F0~F11 implementation ticket.
- `.scratch/financial-terminal/spec.md`: edge-valid dependency-depth critical path와 CredentialVault/ProviderConnections ownership 보완.
- `.scratch/financial-terminal/map.md`: implementation plan과 첫 frontier 링크.
- `docs/reviews/2026-07-15-ticket-07-spec.md`, `docs/reviews/2026-07-15-ticket-08-implementation-plan.md`: 후속 정정과 티켓 분해 검수 기록.
- 이 ticket: 분해 결정, 검증과 잔여 위험.

## Validation

- issue 09~20의 metadata, 필수 section, 내부 Markdown link와 changed-file whitespace 검사가 통과한다.
- dependency graph는 acyclic이고 issue 08 resolved 뒤 claim 가능한 첫 implementation frontier가 issue 09 하나임을 검증한다.
- 각 `Blocked by`는 unresolved direct `Depends on`과 일치하고 P1~P3 owned subtree가 겹치지 않는다.
- staged allowlist, secret-shaped value와 `.env.local`/`.secrets` 미포함 검사를 commit 전에 통과한다.

## Review

dependency/ownership과 acceptance/traceability 두 읽기 전용 관점으로 검수하고 같은 reviewer에게 affected-scope re-review를 수행했다. critical-path edge, ProviderConnections ownership, module별 administrative erasure, Internal Paper 기업행동과 Broker Paper fault/gate finding을 모두 수정했으며 최종 잔여는 Critical 0 / High 0 / Medium 0이다. 상세는 [티켓 08 구현 계획 검수](../../../docs/reviews/2026-07-15-ticket-08-implementation-plan.md)에 기록했다.

## Residual risks

- 저장소에는 아직 실행 앱이 없으며 실제 구현과 runtime 검증은 issue 09부터 시작한다.
- issue 10~20의 `Blocked by`는 선행 ticket resolve 때 제거하되 `Depends on` 이력은 유지해야 한다.
- 실제 provider/OAuth/email/broker smoke와 실데이터 screenshot은 각 ticket의 opt-in/external gate이며 일반 PR 성공으로 가장하지 않는다.
