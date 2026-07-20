# 29 - KIS 휴장일 정직화 (평일 휴장일 실시간 위조 버그)

Type: bug
Status: open
Triage: ready-for-agent
Depends on: 25
Blocked by: None
Owner: (unclaimed)

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
