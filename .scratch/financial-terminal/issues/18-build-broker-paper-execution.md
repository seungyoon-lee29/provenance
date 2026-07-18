# 18 - F9 Broker Paper execution 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 17
Blocked by: None
Owner: claude-main (Fable 5 session)
Claimed at: 2026-07-18T15:21:02+09:00
Last heartbeat: 2026-07-18T15:55:31+09:00

## Objective

Broker Paper Account 주문을 paper-only AuthorizedTransport, durable outbox와 lookup-before-retry 경계로 실행해 timeout/revoke/crash에서도 외부 주문 최대 하나로 수렴시킨다.

## Owned scope

- `src/modules/paper-trading/broker/**`, `src/modules/provider-connections/paper-transport/**`.
- BrokerPaperExecutionPort adapter, outbox/reconciliation worker와 broker-paper fault fixture.
- ProviderConnections core와 shared contract/composition/migration/index는 read-only다.

## Requirements

- stable client order identity, prepare binding, paper environment와 submit/lookup/status/cancel route allowlist를 강제한다.
- send 전에 durable outbox와 PendingBrokerSubmission을 commit하고 Submission Uncertainty를 실패로 덮지 않는다.
- provider event external identity+revision을 unique하게 저장하고 divergent payload를 quarantine한다.
- generation-first revoke, ConnectionLifecycleFence와 commit/publish 직전 authorization을 재검사한다.
- named fault point는 정확히 `after-intent-commit`, `after-broker-accept-before-local-ack`, `after-local-commit-before-queue-ack`, `after-authorize-before-route-dispatch`이며 각 restart에서 lookup/reconciliation로 수렴한다.
- PaperTrading erasure receipt를 broker outbox, PendingBrokerSubmission, provider identity/reconciliation event, transport reference와 pending queue까지 확장하고 restore suppression을 유지한다.
- Live Trading operation/capability/hostname/generated client를 등록하지 않는다.

## Interface contract

- F8 `PaperTrading` public contract, `BrokerPaperExecutionPort`, PortfolioWorkQueue와 F0 AuthorizedTransport primitive만 사용한다.
- F3 ProviderConnections core를 read-only로 소비하고 F10 read-transport subtree와 파일을 공유하지 않는다.
- external event append/reducer/reservation/cash/position/outbox는 한 transaction이다.

## Acceptance criteria

- 네 canonical named fault point에서 broker accepted 최대 1, blind retry 0이다. 특히 `after-authorize-before-route-dispatch`에서 revoke가 먼저 commit되면 route call 0, dispatch 가능 뒤면 `submission_unknown`+lookup이다.
- lookup/idempotency horizon, stream/poll duplicate, same-revision divergent payload와 crash가 deterministic fact/quarantine로 수렴한다.
- revoke 전 미전송은 외부 호출 0, 이미 dispatch 가능 case는 `submission_unknown`+lookup으로 끝나며 late commit은 fence된다.
- deletion fence 뒤 broker submit/lookup retry, outbox claim, transport resolve와 late event commit이 0이고 module receipt·backup restore suppression이 coordinator 상태에 반영된다.
- durable acceptance p95 450/700 ms이고 black-box Live route는 404/405, operation/capability registry 수 0이다.

## Out of scope

- Actual Broker Sync와 Live Trading.
- 기본 완료는 scripted broker network-off다. 실제 mutation은 정확히 `RUN_ALPACA_PAPER_ORDER_CONTRACT=1` 또는 `RUN_KIS_PAPER_ORDER_CONTRACT=1`, paper host, 최대 1 share/USD 10, lookup→cancel→cleanup이 모두 있을 때만 실행한다.

## Traceability

- [승인 spec](../spec.md) `UF-07`, §9, §12.2, F9, `SEC-04/05/06/10`, `AT-07/08/11`; ADR `A03/A04`.
