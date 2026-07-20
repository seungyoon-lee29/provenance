# 29 - KIS 휴장일 정직화 (평일 휴장일 실시간 위조 버그)

Type: bug
Status: resolved
Triage: ready-for-agent
Depends on: 25
Blocked by: None
Owner: main
Claimed at: 2026-07-20T18:10:01Z
Last heartbeat: 2026-07-20T18:22:09Z

## Progress

- 2026-07-20: claim. 특일정보 API probe → `KRX_API_KEY`로 401(미구독/비-data.go.kr 키). 사용자
  결정으로 폴백(검증된 하드코딩)으로 전환. 웹 3중 교차검증(calendarlabs·smarthan-note·ekn.kr)으로
  2026 KRX 휴장일 확정, **초기 가정 오류 교정**(추석 대체는 일요일 겹칠 때만 → 2026 9/26 토요일이라
  9/28 대체 없음). red-first TDD(휴장일 5·9/28 거래일 가드·설날 step-back) → 번들+헬퍼 구현 → green.

## Context (확인된 버그, 2026-07-20)

`kis-market-information.ts`의 `krxSessionAsOf`는 **요일+시간만** 본다(line 110-113). 평일 휴장일
(신정·삼일절·어린이날·설날·추석·대체공휴일 등)에 장이 닫혔는데도 in-session 분기가 실행돼
`{ asOfMs: nowMs, basis: "trade" }`를 반환 → **닫힌 장에서 실시간 시세를 위조**한다. step-back 루프
(line 118-124)도 주말만 건너뛰고 휴장일은 안 건너뛰어, 휴장일 다음날 개장 전 asOf가 "일어나지 않은
마감"을 가리킨다. 둘 다 map line 11(freshness 정직성) 위반. 티켓 25가 P2로 이월한 그 gap.

## 걸림돌 (설계 결정 필요)

가장 큰 휴장(설날·추석·석가탄신일·대체공휴일)은 **음력 기반이라 순수 계산 불가**. 부분 하드코딩
(고정일만)은 설날·추석에서 오히려 또 다른 위조. 정확한 KRX 휴장일 데이터를 **번들 static**으로
확보해야 함(runtime은 network-off·결정론 유지). 데이터 출처(연 1회 갱신 or KRX 캘린더 API 1회
fetch 후 번들)와 커버 연도(현재+차년) 결정 필요.

## Owned scope

- KRX 휴장일 set(번들 static, 커버 연도 명시) + `isKrxClosed(kst)` = 주말 || 휴장일.
- in-session 분기와 step-back 루프 둘 다 `isKrxClosed`로 교체(휴장일 = off-session eod).
- red-first TDD(+휴장일: 평일 신정·설날·추석·대체공휴일·휴장일 다음날 개장전 step-back).

## Acceptance

- 평일 휴장일 nowMs → `basis:"eod"`, asOf=직전 *영업일(비휴장)* 마감. `trade` 위조 0.
- 커버 연도 밖은 명시적 fallback(현행 weekday-only)과 ponytail 천장 주석.
- network-off 결정론 TDD green.

## 리스크 게이트

데이터-정직성/freshness 경로. red-first TDD → self-review(순수 헬퍼) 1패스. 휴장일 데이터가
외부 소스면 그 확보 단계는 별도 검증.

## Out of scope

- 휴장일 실시간 캘린더 API 상시 연동(번들 static으로 충분).
- 해외/선물 세션 캘린더.

## Resolution (2026-07-20)

### Answer
`krxSessionAsOf`가 요일+시간만 보던 걸 `isKrxClosed(kst)`(주말 || 휴장일) 기반으로 교체 —
in-session 분기와 step-back 루프 둘 다. 평일 휴장일은 이제 off-session eod로 정직 산출(실시간
위조 0), step-back은 주말+휴장일을 건너뛴 직전 *영업일* 마감을 asOf로 준다. 휴장일 데이터는
network-off 유지를 위해 static 번들(`krx-holidays.ts`, 2026)로, 특일정보 API 대신 웹 3중 교차검증
으로 취득(키 401로 폴백).

### Changed files
- `src/modules/financial-information/data/krx-holidays.ts` (신규 — 검증된 2026 휴장일 16개 + 커버연도)
- `src/modules/financial-information/data/kis-market-information.ts` (`isKrxClosed`/`krxDateKey` 추가,
  `krxSessionAsOf` 재작성, 루프 상한 7→10)
- `tests/kis-market-information.test.ts` (+7: 휴장일 5·9/28 거래일 가드·설날 step-back)

### Validation
- red-first: 신정·설날·대체·선거·폐장 5건이 `trade` 위조로 실패 → 구현 후 eod green.
- `npm run check` green (typecheck/lint/test 1283 pass, +7). 순수 헬퍼 self-review 1패스.
- **데이터 교차검증**: calendarlabs·smarthan-note·ekn.kr(대체 4건 일치)로 2026 확정. 규칙 교정 —
  설날/추석 연휴는 일요일 겹칠 때만 대체 → 9/28은 정상 거래일(테스트로 가드).

### Review
red-first TDD + self-review 1패스(리스크 비례: 순수 헬퍼+static 데이터, 로직 단순). 실 리스크는
데이터 정확도라 codex 코드-적대 리뷰보다 웹 다중출처 교차검증으로 대응. codex 원하면 추가 가능.

### Residual risks
- **커버 연도 2026뿐**: 2026 밖 nowMs는 weekday-only 폴백(크로스이어 step-back asOf가 직전 해
  마지막 거래일이 아닐 수 있음 — 예 신정에서 2025-12-31로 착지). 매년 갱신 or 특일정보 재생성이 경로.
- **임시공휴일 미포함**: 정부 수시 지정은 static 목록에 없음. 특일정보 API 키 확보 시 갱신.
- **세션 시간 연장(2026-06-29 12시간 체제 추진)**: SESSION_OPEN/CLOSE는 09:00–15:30 고정 — 확정 시 별도.
