# 16 - F7 포트폴리오 회계 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 15
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-17T23:04:53+09:00
Last heartbeat: 2026-07-17T23:15:30+09:00

## Objective

Actual Portfolio의 Performance Coverage 안에서 TWR, XIRR, FX Contribution, Portfolio P&L, transfer·배당·기업행동과 리밸런싱 제안을 literal oracle로 구현한다.

## Owned scope

- `src/modules/actual-portfolio/calculation/**`, `journal/**` 확장과 projection 내부 계산.
- portfolio accounting literal JSON/CSV, property/fault test.
- F6 public interface, shared contract/composition/migration/index는 read-only이며 변경은 main owner에게 요청한다.

## Requirements

- external cash flow를 제거한 Portfolio Return과 cash-flow timing을 반영한 Personal Return을 coverage 안에서만 계산한다.
- security+cash FX, 가격 성과·FX·interaction을 중복 없이 Reporting Currency P&L에 reconcile한다.
- Source/Analytic Cost Basis, dividend entitlement, transfer와 Corporate Action Adjustment를 append-only로 반영한다.
- Price Basis 중복 수익, incomplete merger/spin-off/delisting과 scope membership change를 fail closed한다.
- Target Allocation/Exposure Guardrail은 configured일 때만 평가하고 Rebalancing Proposal을 주문으로 전송하지 않는다.

## Interface contract

- `PortfolioEvidenceResolver`의 typed price/FX/dividend/corporate-action input만 사용하고 raw Evidence/provider payload를 읽지 않는다.
- F6 Actual public contract와 journal sequence를 유지하며 PaperTrading/NotificationCenter를 역호출하지 않는다.
- production 계산기/reducer를 expected-value 생성기에 import하지 않는다.

## Acceptance criteria

- TWR 21%, XIRR 10%와 multi-root unavailable, FX 10%+20%+2%=32%, gross 20-fee2-tax1=17 literal fixture가 일치한다.
- 2:1 split raw/restated 동등성, total-return basis 거절, transfer·dividend·corporate action exactly-once/all-old-all-new를 검증한다.
- incomplete coverage/basis/delisting은 value가 없고 scope add/remove/disconnect는 기존 series에 조용히 연결되지 않는다.
- target 없음은 `not_configured`, incomplete total은 proposal unavailable, guardrail만으로 주문 0, Actual→Paper 자동 변환 method 0이다.

## Out of scope

- Broker Sync, Paper simulator와 세무 신고용 tax-lot 산출.
- 모든 oracle은 network-off literal fixture이며 실제 provider가 필요하지 않다.

## Traceability

- [승인 spec](../spec.md) §8, F7, `AT-05/06`, `SEC-06/09`; `T04/T05`, ADR `A04`.
