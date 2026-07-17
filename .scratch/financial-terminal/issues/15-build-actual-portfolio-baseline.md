# 15 - F6 Actual Portfolio baseline 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 11, 12
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-17T15:37:43+09:00
Last heartbeat: 2026-07-17T15:37:43+09:00

## Objective

Opening Position과 Manual Position/Portfolio Activity를 append-only Actual Portfolio에 저장·표시하고 Paper Portfolio와 타입·저장·명령에서 격리한다.

## Owned scope

- `src/modules/actual-portfolio/baseline/**`, Actual journal/projection와 progressive PortfolioLoad.
- Actual-owned AI/Alert resolver의 baseline implementation.
- actual baseline literal fixture와 contract/browser/isolation test.
- shared contract/composition/migration/index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- `ActualPortfolio.open/change`, account별 contiguous revision, command idempotency와 superseding/reversal을 구현한다.
- Opening Position은 aggregate lot임을 표시하고 과거 transaction/tax lot/성과를 추정하지 않는다.
- Manual Position은 Broker Position을 덮어쓰지 않고 source/account provenance와 completeness를 유지한다.
- PortfolioLoad initial/update는 auth/scope/request/section/account/Evidence/policy revision과 resume cursor로 stale paint를 막는다.
- incomplete price/FX/position은 known subtotal과 missing list만 표시하고 total·비중·proposal value를 만들지 않는다.
- ActualPortfolio administrative erasure receipt는 account/journal/projection, source reference, personalized cache, export, outbox/queue와 derived section을 fence 뒤 제거하고 backup restore suppression을 유지한다.

## Interface contract

- Actual branded account/journal/repository는 Paper type과 범용 mode interface를 공유하지 않는다.
- price/FX는 `PortfolioEvidenceResolver`, AI/alert는 Actual-owned purpose-bound resolver만 사용한다.
- F7이 public interface를 변경하지 않고 calculation/journal을 확장하고 F10이 read-only broker sync를 주입한다.

## Acceptance criteria

- Opening Position 저장 후 reload에서 source/as-of/account를 유지하고 과거 수익·tax lot 표시가 0이다.
- same/same receipt, same/different conflict, stale revision, cross-workspace와 stale auth epoch에서 side effect 0이다.
- Paper 변화 뒤 Actual 모든 공개 필드가 불변이고 Actual 변화 뒤 Paper cash/position이 불변이다.
- incomplete fixture에서 전체 total/value/weight/proposal이 unavailable이고 알려진 subtotal은 누락 목록과 함께 표시된다.
- deletion fence 뒤 Actual read/update, resolver, queue/outbox commit과 cache hit가 0이고 module receipt가 coordinator에 durable하게 수집된다. late projection과 backup restore는 account/journal을 다시 만들지 않는다.
- Actual initial projection p95 450/800 ms와 update ordering/resume test를 통과한다.

## Out of scope

- TWR/XIRR/FX/P&L/corporate action 계산(F7), Broker Sync(F10), Paper command.
- 외부 provider gate 없음; scripted price/FX port만 사용한다.

## Traceability

- [승인 spec](../spec.md) `UF-06`, §6, §8, F6, `SEC-01/06/09`, `AT-06` baseline, `AT-07` isolation; ADR `A04`.
