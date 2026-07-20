# 25 - KIS 장외 freshness 정직화 (codex HIGH 2 closure)

Type: implementation
Status: resolved
Triage: done
Depends on: 24
Blocked by: None
Owner: main
Claimed at: 2026-07-20T16:08:06Z
Last heartbeat: 2026-07-20T16:13:44Z

## Context

티켓 24 codex 리뷰 HIGH 2: KIS `inquire-price`(현재가)는 명시적 as-of 타임스탬프가 없어
어댑터가 `asOf = clock.now()`로 두었고, 그 결과 `applyObservationFreshness`가 항상
`realtime`/`priceBasis: trade`로 분류한다. **장 마감 후엔 KIS가 전일 종가를 반환**하는데,
이를 실시간 체결가로 위장하는 셈 — map "모든 Observation은 정확한 Data Freshness 포함" 및
"숫자를 만들지 않는다"의 정직성 하한 위반.

24에서는 어댑터가 어느 라우트에도 미배선이라 사용자 노출 0이라 P2로 이월했으나, **배선 전에
데이터가 정직해야** 하므로 배선(별도 티켓)보다 선행한다.

## Owned scope

- `kis-market-information.ts`: `asOf`/`priceBasis`를 wall-clock KRX 정규장 세션 상태로 도출.
  - 정규 연속매매(월~금 09:00–15:30 KST) 내 → `asOf = now`, `priceBasis = "trade"`.
  - 세션 밖(마감 후·개장 전·주말) → `asOf = 직전 세션 마감시각`, `priceBasis = "eod"`.
    → `applyObservationFreshness`가 residual 정책으로 stale/no_data를 정직하게 산출.
- network-off 테스트: 세션 내 realtime/trade, 마감 후 eod+비-realtime, 주말 eod.
- 계약 테스트: 세션 무관하게 값이 뜨도록 lenient 정책 사용(available+KRW+personal 유지).

## Out of scope (이월)

- **KRX 휴장일 캘린더**: 공휴일/임시휴장은 휴일 피드가 필요 — 이 슬라이스는 요일+시간만.
  공휴일엔 여전히 eod로 나와야 하나 "직전 세션 마감"이 전일로 잡히는 근사. 문서화 residual.
- **composition 배선 = 별도 티켓(26)**: 프로덕션 market 라우트/소비처가 아직 없음
  (`MarketInformation` 소비처는 데모 `f4-panels`뿐). RuntimeConfig KIS 노출 + market
  provider assembly + 라우트/SSE 소비처 신설이 필요한 설계-의존 큰 슬라이스. F11 릴리스 영역과 겹침.

## Acceptance

- 세션 내(예: 화 10:00 KST) 삼성전자 → available/realtime/trade.
- 세션 후(예: 화 17:00 KST)·주말 → priceBasis eod, freshness가 realtime 아님(stale 또는 정책상 no_data).
- 값 있으면 여전히 currency KRW, audience personal.

## Gates

- red-first TDD → 리스크 비례 리뷰 → 판단. 실제 적용은 아래 Resolution/Review 참조(순수 헬퍼라
  self-review 1-pass로 판단, 근거 기록).

## Resolution (2026-07-20)

### Answer
`krxSessionAsOf(nowMs)` 헬퍼로 KRX 정규장 세션(월~금 09:00–15:30 KST, half-open) 상태를 wall-clock
으로 판정: 세션 내 → `asOf = now`, `priceBasis = "trade"`; 세션 밖 → `asOf = 직전 세션 마감`,
`priceBasis = "eod"`. `applyObservationFreshness`가 이 asOf로 stale/no_data를 정직하게 산출해,
장 마감 후 전일 종가가 realtime 체결가로 위장되던 codex HIGH 2를 봉쇄. `receivedAt`도 asOf와
분리(실 수신 시각). 어댑터는 여전히 어느 라우트에도 미배선이라 사용자 노출은 배선 티켓에서.

### Changed files
- `src/modules/financial-information/data/kis-market-information.ts` (krxSessionAsOf + settle/toObservation 배선)
- `tests/kis-market-information.test.ts` (+6 세션 테스트: 장중·장후·주말·경계[09:00/15:30]·개장전)
- `tests/kis-market-information.contract.test.ts` (lenient 정책 — 세션 무관 available 유지)

### Validation
- `npm run check` green: vitest 1272 pass/26 skip(KIS 21) + seam 2.
- **실 KIS `:29443` 계약 테스트 pass — off-session(KST 새벽) 경로 실측**: 전일 종가를 eod/stale로,
  available+KRW+last>0+personal 유지. freshness 변경을 실 API로 end-to-end 검증.

### Review
self-review 1-pass(리스크 비례): 순수 date 헬퍼 + 3줄 배선이고 보안·크리덴셜 표면은 codex-리뷰된
24에서 불변이라 full codex 적대 라운드는 비례하지 않아 생략. 대신 경계 실수가 숨는 지점을 겨냥한
포괄 테스트(개장 09:00=trade, 마감 15:30=eod half-open, 주말/개장전 직전-평일 마감 step-back)로
검증. 필요 시 codex 라운드 추가 가능.

### Residual risks
- **KRX 휴장일**: 요일+시간만 — 공휴일/임시휴장은 휴일 피드 필요(직전 세션 마감이 전일로 근사). P2.
- **composition 배선(티켓 26)**: 프로덕션 market 라우트/소비처 신설 필요(설계-의존, F11 영역).
