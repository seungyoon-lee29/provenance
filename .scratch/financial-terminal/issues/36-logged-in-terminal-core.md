# 36 - 로그인 터미널 본체화 (헤더 로그인 + 메인 화면 개인 데이터 주입)

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 34, 26, 31, 12
Blocked by: 34
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

사용자 결정(2026-07-21): **"로그인 터미널이 본체, 게스트는 쇼케이스"**, 그리고 **데이터 소스가
없는 패널은 로그인 트랙 데이터로 채운다**.

현재 구조의 문제: 개인(KIS) 실데이터는 `/workspace` 위젯에만 있고 메인 화면(`/`)의 터미널
셸과 끊겨 있다. 그래서 로그인해도 지수 스트립·시장 요약·관심종목은 여전히 `API 필요`다.
헤더에는 로그인 진입점 자체가 없다(`/signin` 링크는 우측 패널 안쪽에만).

셸은 이미 `GuestFinancialInformation` 포트로 패널 데이터를 받는다 — **소스를 뷰어에 따라 갈아
끼우는 것**이 새 화면을 또 만드는 것보다 작다.

## Owned scope

- `src/app/page.tsx`(뷰어 분기 주입), 셸 헤더(로그인/계정 상태)
- 개인 패널 정보 소스(패널키 → KIS 심볼 매핑, owner 전용)
- `tests/`

## Approach

- 세션이 있으면 개인 소스를, 없으면 기존 공개 소스를 주입한다(같은 포트, drop-in).
- 개인 데이터는 `audience: personal` 그대로 — **map line 16(재배포 금지) 불변**: 게스트 응답
  경로로 개인 값이 새지 않는 것을 테스트로 고정한다.
- 헤더: 비로그인 → 로그인 링크, 로그인 → 계정·로그아웃.

## Acceptance

- 로그인 상태에서 메인 화면 지수 스트립(KOSPI·KOSDAQ)과 시장 요약/관심종목이 KIS 실값으로 찬다.
- 비로그인 응답에는 개인 값이 절대 포함되지 않는다(테스트로 고정).
- 헤더에서 로그인/로그아웃이 실제로 동작한다.
- 값 없는 outcome에 값을 만들지 않는다(F1 불변식 회귀 0).
