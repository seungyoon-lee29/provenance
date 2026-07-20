# 23 - Persistence seam (P1): Identity·PersonalCache 영속 + 삭제억제 드릴

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 09
Blocked by: None
Owner: unclaimed
Claimed at: -
Last heartbeat: -

## Objective

현재 앱은 network-off in-memory tracer로, postgres에는 `runtime_components`·`schema_migrations`만 있고 모든 모듈 상태(erasure fence 포함)가 RAM에 있다(F11 gate 2 재실사, 2026-07-19). 이 티켓은 **persistence seam을 도입**한다: (1) 여러 repository write를 한 postgres 트랜잭션으로 묶는 Unit-of-work 포트와 스키마 컨벤션(append-only·단조 revision·idempotency·fence-first)을 확정하고, (2) **Identity(accounts·sessions·erasure fence) + PersonalCache(entries·fence)** 한 세트를 end-to-end로 postgres에 이관해, **스택 레벨 backup/restore/deletion-suppression 드릴(F11 gate 2)이 이 저장소들에 대해 실제로 성립**하게 만든다.

돈 원장·outbox·event(F6~F10)는 **이 티켓 범위 밖**이다(money/체결 경로 = 최상위 gate, P2+에서 클러스터별 별도 티켓). 이 티켓이 확정하는 트랜잭션 포트·스키마 컨벤션을 그 티켓들이 상속한다.

## Owned scope

- 신규 `src/platform/persistence/**`: Unit-of-work 트랜잭션 포트 + repository 베이스(append-only·revision·idempotency·fence 헬퍼). in-memory와 pg 두 구현.
- `src/modules/identity/session-store.ts`(+연관 identity 저장 필드)를 repository 포트에 의존하도록 리팩터 — **공개 동작 불변**, backing만 교체.
- `src/modules/financial-information/data/personal-cache.ts` 동일 리팩터.
- 신규 migration(`db/migrations/000N_*`): identity/personal-cache 테이블 + fence 테이블.
- `tests/persistence/**` 통합 테스트 + compose `backup-drill` 프로파일과 드릴 스크립트.
- shared composition/index/spec 변경 요청은 F0/main owner에게 낸다(직접 편집 금지).

## Requirements

- **Unit-of-work 트랜잭션 포트**: 범위 내 원자 연산(예: 계정 생성·세션 발급, erase 시 fence 증가+shred+참여 store 정리)이 **한 pg 트랜잭션**으로 커밋된다. 부분 실패는 half-write를 남기지 않는다. store 메서드는 실행자(executor/tx)를 주입받는다.
- **스키마 컨벤션(P2+가 상속)**: append-only 테이블은 `(scope, revision)` 유니크로 단조 revision·optimistic conflict/rejected를 보존한다. idempotency는 `(workspace, module, account, kind, idempotency-key)` + canonical payload hash 유니크로 same/same=receipt·same/different=conflict를 보존한다. fence는 단조 값 테이블이며 모든 write가 **fence 선검사**(fence-first, SEC-09) 후 진행한다.
- **Identity 이관**: accounts·sessions·`erased_accounts`(단조 삭제 fence)를 postgres로. session lookup은 여전히 fence로 가려지고, generation/authorization epoch·workspace switch·deletion fence 의미가 보존된다. restore로 계정 row가 재활성돼도 fence가 override한다.
- **PersonalCache 이관**: entries + fence. soft/hard expiry 의미(시각 기반)와 erasure fence를 보존한다.
- **이관 안 한 store는 포트 뒤 in-memory 구현 유지**: 돈 원장·outbox·event 등은 이번엔 in-memory 그대로(같은 포트의 in-memory impl). 앱은 계속 뜨고 network-off CI는 green.
- **backup/restore/deletion 드릴**: compose `backup-drill` 프로파일이 seed→erase→`pg_dump`→clean db restore→migrate→**(a) 삭제된 계정·cache 부재, (b) fence row 존재, (c) 재생성 시도가 fence로 억제됨**을 스택에서 실증한다.
- **secret at rest 하한**: 어떤 테이블에도 credential 평문 컬럼 금지. (vault ciphertext 영속은 P2 — 이 티켓은 건드리지 않음.)

## Interface contract

- 새 공개 port: `persistence`의 `UnitOfWork`(typed repository 접근 + `withTransaction`). 모듈은 이 포트에 생성자 주입으로 의존한다.
- Identity·PersonalCache store는 **in-memory impl(기존 단위 테스트의 행동 oracle)** 과 **pg impl(러닝 스택)** 두 구현을 갖고, composition root가 러닝 스택엔 pg를, 단위 테스트엔 in-memory를 배선한다.
- 모듈의 **공개 outcome(receipt·conflict·rejected·fence 의미)은 변경 없음** — 기존 module 단위 테스트가 회귀 oracle로 그대로 통과해야 한다.
- 실제 hosting/Live Trading은 호출하지 않는다. 이관 대상은 Identity·PersonalCache로 한정한다.

## Acceptance criteria

- Identity·PersonalCache 상태가 **실제 pg에 대해 프로세스 재시작을 넘어 생존**한다(스택 통합 테스트).
- 범위 내 원자 연산이 **한 pg 트랜잭션**으로 커밋된다 — 주입 실패점에서 half-write 0.
- SEC-09 fence: erase→재시작/restore 후 대상 계정·cache가 부재하고 재생성이 억제된다.
- **스택 레벨 backup/restore/deletion-suppression 드릴 통과**(compose `backup-drill`) — F11 gate 2의 스택 증명(이관된 store 한정).
- 기존 전체 단위 테스트 green(in-memory impl 행동 불변), `npm run check`·`compose:verify`(network-off 포함) green, 신규 pg 통합 테스트 green.
- 어떤 테이블에도 secret 평문 없음, `git diff --cached --check`·secret scan·clean worktree 통과.

## Gates (risk-proportional)

트랜잭션 포트·스키마 컨벤션은 P2+ 돈 티켓들이 상속하므로 **아키텍처 gate**를 적용한다: red-first TDD → 포트/스키마 설계 리뷰 → **다른 계열(codex) 적대 리뷰**(트랜잭션 경계·fence-first race·revision/idempotency 유니크 충돌·restore가 fence를 우회하는 경로) → 판정. 이관 자체는 공개 동작 불변이라 기존 module 테스트가 회귀 oracle.

## Out of scope

- 돈 원장(Actual·Accounting·Paper·BrokerBook)·outbox(Broker·Delivery)·event(BrokerSync)·delivery fact 영속 — **P2+ 클러스터별 티켓, money-path 풀 gate에서**. gate-2 완전 종결은 거기서.
- credential vault ciphertext 영속(P2), ephemeral/rate-limit 상태의 Redis 백킹(별도·선택), 다중 인스턴스/HA·read replica·pool 튜닝.

## Traceability

- 발단: [20 - F11 release integration](./20-integrate-release-artifacts.md) gate 2 재실사(in-memory tracer라 backup 드릴 불성립) → persistence 선행 티켓 필요로 재분류.
- [승인 spec](../spec.md) §8(append-only·한 account transaction 원자성), §12(durability·erasure SEC-09), §11(durability 예산). [09 - F0 기반](./09-build-foundation-contracts.md)의 pool·migration runner·vault 경계 위에 얹는다.
