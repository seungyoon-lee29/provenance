# 33 - 게스트 공시 패널: Open DART 최근 공시 배선

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 28, 30, 13
Blocked by: None
Owner: main
Claimed at: 2026-07-21T07:55:00Z
Last heartbeat: 2026-07-21T08:50:00Z

## Resolution (2026-07-21)

### Answer

Open DART 최근 공시 목록을 F4 `FilingEntry`/`EvidenceValue` 재사용으로 정규화
(`createDartFilingsInformation` + `FilingsInformation` v1 port). 키는 env→URL만, spec §5.1
"DART latest list" soft 5분은 transport TTL 캐시로 강제. guest 공시 패널 v1(최신 공시 1건
한 줄, `ponytail:` ceiling 주석). 게이트 = `PUBLIC_MARKET_ENABLED` + `DART_API_KEY` 존재.

### 적대 리뷰 (31~33 배치, BLOCK → 확인 건 수정)

**리뷰 주체 고지**: 1차 codex 시도는 자체 병렬 서브리뷰 위임 후 26분+ 무출력 행업, 2차 시도는
codex CLI가 샌드박스 권한 오류(`Operation not permitted`)로 기동 실패 → **규칙상 차선인 별도
에이전트(다른 관점·프레이밍) 직접 검토로 대체**. 차선이었음을 여기 남긴다.

**확인·수정 5건**: ① DART 반사 키 유출 경로(rcept_no 등 upstream 문자열이 키를 반사하면
accession·link·EvidenceReference로 승격) → 접수번호 14자리 숫자 강제 + **body 전체 반사 키
quarantine** ② legacy `PUBLIC_MARKET_TREASURY_ENABLED`가 ECB+DART까지 조용히 확장 →
**플래그 은퇴·설정 시 부팅 오류**(명시적 재동의 강제, 별칭 제거) ③ KIS `toNumber`가
null→0·true→1·"0x10"→16 강제변환(실측) → **엄격 십진 lexicon**(주식 경로 root-cause 동시 봉쇄)
④ DART status 매핑 뭉개짐 → 공식 가이드 exhaustive map(901 재인증·012/101 접근거부·100
비재시도·021 quota·800 upstream) ⑤ 위 반례들 고정 픽스처 테스트 부재 → 전부 red-first 추가.
**이상 없음 판정 축**: KIS fence·분기, ECB 교차 정직성·treasury 분류기 회귀, guest 값 위조·패널
누출.

### Validation

- network-off 단위: DART 11 + KIS 지수 7 + guest 배선 9 + runtime-policy 강화. check 전 레인
  green(**1,349**).
- **실 DART 계약 테스트 pass**(키 유효, 실 공시 목록 수신, 키 누출 0 어서션 포함).
- 수정 후 **실 KIS 계약 재실행**(주식+지수 2건 pass — 엄격 lexicon이 실응답 비거부 확인).

### Residual risks

- 공시 목록 UI는 v1 한 줄(최신 1건) — 목록·필터·상세는 후속.
- DART 키 없으면 api_required(정직) — 배포 시 `DART_API_KEY` 필요.
- EDGAR(미국 공시)·종목별 필터 이월.

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
