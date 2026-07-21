# 33 - 게스트 공시 패널: Open DART 최근 공시 배선

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 28, 30, 13
Blocked by: None
Owner: (unclaimed)

## Context

guest shell 공시 패널이 stub. Open DART 공시검색(list.json)은 무료 API 키 기반 공공 정본으로,
공시 목록 메타데이터는 출처표시 하 공개 표시 가능(ticket 01 조사). 키는 서버 환경변수로만 —
게스트에 키 노출 0.

## Owned scope

- **33-a**: `createDartFilingsInformation` — 최근 공시 list read(저수준 HTTP 주입, 픽스처 TDD).
  키 부재 시 api_required(정직). audience=`public`(출처표시), cadence freshness.
- **33-b**: guest `filings` 패널 배선(30-a seam) — v1은 최신 공시 1건을
  displayValue로("회사 · 제목 · 시각"), 목록 UI는 후속. `ponytail:` 주석으로 ceiling 명시.
- **33-c**: opt-in 실 DART 계약 테스트(`DART_CONTRACT=1` + `DART_API_KEY`) — 키는 읽지 않고
  환경변수 존재만 게이트로 사용.

## Acceptance

- network-off 단위: available 매핑·키 부재 api_required·오류 매트릭스·키가 outcome/로그에 0.
- 실 DART 계약 테스트 pass(키 있으면) — 키 없으면 not_run으로 정직 기록.
- guest 실 DOM 공시 패널에 실 공시 1건 표시.
- codex 적대 리뷰(공개 feed·키 취급) 후 확인 건만 수정.

## Out of scope

- 공시 상세/원문 뷰, 종목별 필터, EDGAR(미국) — 후속.
