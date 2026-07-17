# 17 - F8 Internal Paper Trading 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 11, 12, 15
Blocked by: None
Owner: claude-main (Fable 5 session)
Claimed at: 2026-07-18T01:37:47+09:00
Last heartbeat: 2026-07-18T02:06:00+09:00

## Objective

Internal Paper Account의 Paper Order prepare→reservation→simulation-v1 Simulated Fill→Paper Blotter를 deterministic하게 완주한다.

## Owned scope

- `src/modules/paper-trading/internal/**`, simulator, Paper journal/projection와 Paper Blotter presentation.
- Paper-owned AI resolver, internal-paper literal/property/fault test.
- shared contract/composition/migration/index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- `PaperTrading.open/prepare/change`, opaque one-time PaperOrderIntent와 account/revision/auth/payload/policy/expiry binding을 구현한다.
- account별 append-only revision, idempotency, CAS reservation과 세 상태축을 분리한다.
- Simulated Fill은 acceptedAt 뒤 동일 instrument/venue/session의 실제 Market Observation과 simulation-v1 policy만 사용한다.
- limit, 10% volume participation, slippage/fee, delayed data clock과 hard-expired Evidence를 정확히 처리한다.
- server-only idempotent lifecycle ingestion은 Corporate Action Adjustment와 dividend entitlement를 적용한다. 2:1 split 정책 fixture의 open GTC `5주 @ $110`을 `10주 @ $55`로 바꾸면서 order event, Paper Reservation, position과 basis를 한 account transaction에서 all-old/all-new로 변환한다.
- Actual account ID/type/repository를 Paper command에 사용할 수 없게 한다.
- PaperTrading erasure receipt는 Internal Paper account/journal/order/fill/reservation/Blotter, AI/alert reference, cache와 pending queue를 fence 뒤 제거하고 restore suppression을 유지한다.

## Interface contract

- Internal simulator는 in-process port이고 BrokerPaperExecutionPort와 journal을 공유하지 않는다.
- price input은 `PortfolioEvidenceResolver`, AI는 Paper-owned AiMaterialResolver만 사용한다.
- F9은 기존 Paper public contract 위에 Broker Paper 전용 subtree만 추가한다.

## Acceptance criteria

- replay/cross-workspace/stale intent·revision과 forged Actual account ID는 rejected+side effect 0이다.
- volume 10%, buy 100.07/sell 99.93 slippage fixture, limit/data-clock/freshness가 deterministic하게 수렴한다.
- duplicate/cancel rejection/late fill/concurrent funds에서 reservation·cash·position invariant와 three-axis trace가 일치한다.
- 2:1 split crash point마다 GTC order/reservation/position/basis 공개 view가 all-old 또는 all-new이고 같은 Corporate Action 재전달은 no-op이다.
- fill만 position을 바꾸고 terminal 조건에서만 남은 reservation을 해제하며 Paper↔Actual 공개 필드는 상호 불변이다.
- deletion fence 뒤 Paper read/command/fill/resolver/queue commit이 0이고 module receipt와 backup restore suppression이 coordinator 상태에 반영된다.
- local command p95 350/600 ms와 Paper Blotter browser tracer를 통과한다.

## Out of scope

- Broker Paper(F9), Live Trading, short/margin/option과 실제 주문 전송.
- 외부 gate 없음; scripted Market Observation만 사용한다.

## Traceability

- [승인 spec](../spec.md) `UF-07`, `WS-01`, §9, F8, `SEC-01/06`, `AT-06/07`; ADR `A04`.
