# 11 - F2 chart tracer 구축

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 10
Blocked by: None
Owner: unclaimed
Claimed at: -
Last heartbeat: -

## Objective

종목과 기간·interval 변경이 실제 chart request, Evidence와 화면 값을 함께 바꾸고 늦은 응답이 최신 chart를 덮지 못하게 한다.

## Owned scope

- `src/modules/financial-information/chart/**`, `src/modules/terminal-view/presentation/chart/**`와 chart adapter.
- chart literal fixture, contract/browser/performance test.
- shared interface, composition root, migration와 barrel/index는 F0/main owner read-only다.

## Requirements

- 21개 range×interval manifest와 1M/1D, 1Y/1W request를 canonical calendar로 해석한다.
- bar는 OHLCV, Price Basis, Evidence Reference, provenance와 freshness를 보존한다.
- request revision, cancel, update dedupe와 latest-only paint를 TerminalView lifecycle에 맞춘다.
- 이동평균, Bollinger, RSI와 MACD는 versioned calculation policy와 literal oracle을 사용한다.
- hard-expired/rights-restricted/invalid bar는 value를 반환하지 않고 provider error를 raw로 노출하지 않는다.

## Interface contract

- UI는 `FinancialInformation.read/follow`와 TerminalView chart adapter만 사용한다.
- provider별 HTTP/WS, cache와 normalization은 FinancialInformation 내부 port이며 presentation에 export하지 않는다.
- chart public contract 변경은 F0/main owner 승인 전 금지한다.

## Acceptance criteria

- `1M/1D`는 22 bar, `1Y/1W`는 52 bar fixture를 반환하고 request, first/last, count, OHLCV와 accessible summary가 실제 browser에서 바뀐다.
- stale revision·취소된 request·out-of-order stream update의 paint가 0이다.
- cached chart server p95 250 ms/warm, 500 ms/cache miss, chart selection 표시 100 ms와 desktop/mobile paint 450/800 ms 예산을 통과한다.
- 10초 deadline, malformed/future timestamp, soft/hard expiry와 stale-if-error를 고정 clock으로 검증한다.

## Out of scope

- non-chart market/news/filing과 ResearchAssistant.
- 실제 Alpaca/KIS contract는 opt-in artifact이며 이 lane은 scripted HTTP/WS network-off로 완료한다.

## Traceability

- [승인 spec](../spec.md) `UF-02`, `WS-05/06`, §5.1~5.3, §6, §11, F2, `AT-02`; `T05` chart oracle.
