# 11 - F2 chart tracer 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 10
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-15T20:24:59+09:00
Last heartbeat: 2026-07-15T21:33:40+09:00

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

## Answer

`FinancialInformation` chart port와 TerminalView chart adapter를 구현해, 종목·기간·interval 변경이 실제 request revision·bar 집합·화면 값·접근 가능한 summary를 함께 바꾸고 늦은 응답이 최신 chart를 덮지 못하게 했다. 21개 range×interval manifest를 canonical calendar로 사이징(1M/1D→22, 1Y/1W→52)하고, 각 bar에 OHLCV·Price Basis·provenance·freshness를, 각 series에 Evidence Reference를 보존한다. MA·Bollinger·RSI·MACD는 versioned calculation policy(`policy:f2-indicators-v1`)와 독립 oracle로 검증한다. tracer는 monotonic revision, 직전 in-flight cancel, 10초 deadline, latest-only paint로 stale·취소·out-of-order 응답을 0회 paint한다. soft expiry는 `available+오래됨+degradation`, hard expiry는 값 없음, future/malformed timestamp는 watermark를 전진시키지 않는 `invalid_response`로 처리하고 raw provider error를 노출하지 않는다. guest Workspace 중앙 열의 F2 예약 seam(SSR initial frame + 클라이언트 tracer)에 mount했고, production `public` 모드는 synthetic 데이터 없이 정직한 `api_required`를 표시한다.

## Changed files

- `src/modules/financial-information/chart/**`: chart contracts, canonical range×interval manifest, indicators(SMA/Bollinger/RSI/MACD + policy version), freshness/expiry/invalid-response 정책, 결정론적 series generator, scripted `FinancialInformation` chart port와 catalog fixture.
- `src/modules/terminal-view/presentation/chart/**`: revision/cancel/latest-only + 10초 deadline tracer, presenter(접근 가능한 summary·provenance), SSR frame resolver, 클라이언트 `ChartWorkspace`와 CSS.
- `fixtures/spec/f2/chart-catalog.json`: `SYNTHETIC TEST DATA` catalog와 scenario 심볼(fresh/soft_expired/slow_miss/never/future/malformed).
- `tests/chart-manifest|indicators|freshness|provider|tracer|presenter.test.ts`, `tests/browser/guest-chart.spec.ts`, `tests/performance/chart-performance.spec.ts`: 단위 oracle, browser observability·접근성, interaction 성능.
- main-owner 통합(F2 모듈 scope 밖, F2 예약 seam·gate): `src/app/page.tsx`(SSR chart prop), `src/modules/terminal-view/presentation/guest/guest-terminal-shell.tsx`(예약된 중앙 열 seam에 `ChartWorkspace` mount), `package.json`(`check:f2`), `playwright.performance.config.ts`(chart 성능 lane).

## Validation

- `npm run check`: typecheck·lint, Vitest 20 files / 133 tests(+38 chart), public/server seam 통과.
- Playwright browser(desktop-1366·mobile-360): 18 passed / 2 intentional single-lane skip. golden 22-bar SSR, 선택 시 count 22→52와 summary·OHLCV 변경, 느린 SLOW 응답이 최신 선택을 덮지 않음, chart axe critical/serious/color-contrast 0, 그리고 F1 shell overflow·44px 터치타깃 계약 유지 확인.
- Playwright performance: 4 passed. F2 chart selection-visible/cached-paint p95 desktop `17.5/33.6 ms`(예산 100/450), mobile `17.1/33.3 ms`(예산 100/800). F1 shell 무회귀: desktop cold/warm `158.27/129.44 ms`, mobile `576.31/490.13 ms`.
- 단위 oracle: manifest 21 window + 22/52 golden; indicators 독립 oracle(flat=50, only-gains=100, SMA/EMA/Bollinger/MACD hand case); freshness soft/hard/future/malformed·stale-if-error 고정 clock; tracer revision·latest-only·out-of-order·10초 deadline.

## Review

- 두 축 self-review(main-agent). Standards: F1 패턴 준수(nominal 공유 contract를 모듈에서 확장, scripted fixture + zod, `ChartClock`/`ManualClock` 결정론 seam, presenter tone 모델, aria-live·role=group·aria-pressed 접근성). 중복 invalid-response 분기 1건 제거. raw provider error 미노출, Price Basis·Evidence Reference 보존 확인.
- Spec: `AT-02`(22/52·request/first/last/count/OHLCV/접근 summary), `WS-05`(선택이 데이터+revision 변경, stale 미덮음), `WS-06`(색만 아님·aria-live·axe), §5.1(soft→stale+degradation, hard→값 없음, future/malformed→invalid_response·watermark 미전진), §11 예산 충족.
- Scope: chart 모듈·presentation은 owned scope. `page.tsx`·guest shell·`package.json`·성능 config는 F2 예약 seam(guest shell placeholder가 명시적으로 F2에 예약)과 F2 gate의 main-owner 통합으로 여기에 기록.
- 적대적 review 라운드(Standards + Spec 병렬 서브에이전트 + codex 적대적 pass — 원 작성자와 다른 모델). 확정·수정:
  - [HIGH · Spec+codex 공통] freshness age를 `periodStart+interval`이 아니라 `periodStart` 기준으로 측정하고 soft/hard 경계를 exclusive(`<`)로 변경 → §5.1 표(soft=interval+lag+15s, hard=3×interval+lag)와 정확히 일치. 테스트도 spec 경계로 재작성(잘못된 경계를 encode하던 oracle 교정).
  - [HIGH · codex] `validateChartBars`가 non-canonical/impossible 날짜(예: 2/30), 중복·역순 period, 음수 volume, bar 간 price basis 불일치를 malformed로 거절하도록 강화 — malformed 데이터가 watermark를 전진시키지 못하게.
  - [MEDIUM] RSI Wilder mixed-series hand anchor(66.67/77.78)와 MACD signal warm-up null 경계(idx33) 추가로 지표 oracle tautology 제거; indicator period 정수 guard 추가.
  - [MEDIUM] stale-if-error를 `STALE_ERROR` 시나리오로 실 read 경로에 연결(unit-only → end-to-end 검증).
  - [MEDIUM] presenter failed 분기의 per-code copy(F1 `failureCopy`) 복원 — timeout/invalid_response 등 코드별 구분.
  - `follow()`를 명명 helper로 정리.
  - 재검증: `npm run check`(133 tests)·browser 18·performance 4 전부 재통과.

## Residual risks

- chart 상호작용은 synthetic scripted provider(network-off lane)에 연결돼 있다. 실제 Alpaca/KIS chart 계약은 F11 opt-in이며, production `public` 모드는 synthetic 데이터를 구성하지 않고 정직한 `api_required`를 표시한다.
- indicator golden은 결정론적 generator + 독립 hand-verified anchor(SMA/RSI/Bollinger/MACD edge case)로 검증한다. 22/52 series의 per-bar frozen snapshot은 만들지 않았고 구조·anchor 단언으로 대체했다.
- 성능은 local fixed-lane 증거이며 canonical 2 vCPU/4 GiB release-runner 재현은 F11에 남는다(F1과 동일).
- `follow()`는 빈 update를 반환한다. 라이브 incomplete-bar stream의 out-of-order dedupe는 selection revision latest-only(tracer seam에서 증명) 범위 밖으로 남겨 F4/F11에서 다룬다. out-of-order/취소/stale **응답**의 paint 0은 tracer revision guard로 보장하며 단위·브라우저로 증명했다.
- supersede된 provider read는 deadline timer만 abort하고 upstream fetch는 취소하지 않는다(F1 guest tracer와 동일 패턴). latest-only guard가 stale paint 0을 보장하므로 정확성 문제는 아니고, 버려진 read는 resolve 후 revision guard로 폐기된다. abortable read 계약 확장은 shared `FinancialInformation`(F0 owner) 변경이라 F2 단독으로 넓히지 않는다.
