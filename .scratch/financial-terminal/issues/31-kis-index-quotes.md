# 31 - workspace KIS 업종지수 위젯 (코스피·코스닥 현재지수, owner 전용)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 24, 25, 26, 29
Blocked by: None
Owner: main
Claimed at: 2026-07-21T07:00:00Z
Last heartbeat: 2026-07-21T07:20:00Z

## Resolution (2026-07-21)

### Answer

KIS 어댑터가 지수 심볼(`KOSPI`→U/0001, `KOSDAQ`→U/1001)을 같은 `MarketInformation` port로
서빙: `inquire-index-price`(TR `FHPUP02100000`)·`bstp_nmix_*` 필드 → `currency:"pt"`(표시 단위
관례, treasury "%" 동형). owner-only·personal_display·재배포 금지 fence가 지수에도 동일 적용
(guest → KIS 호출 0, 테스트 고정). workspace market-widget에 코스피·코스닥 행(available일 때만
값+등락+freshness). 세션/휴장일 freshness 로직 그대로 재사용.

### Validation

- network-off 단위 5(available 매핑·KOSDAQ 코드·guest 0호출·빈 지수값 invalid_response·주식 회귀)
  + 기존 KIS 28 회귀 green. `npm run check` 전 레인 green(1,324).
- **실 KIS 계약 테스트 pass**(`KIS_CONTRACT=1`, 모의 :29443): TR·경로·필드 가정 실서버 확정,
  실 KOSPI point 수신.
- codex 적대 리뷰는 32·33과 배치 1회로 실행(예산 시퀀싱) — 결과는 각 티켓에 반영.

### Residual risks

- workspace 실브라우저 QA(owner 세션 부팅)는 데몬 재시작 후 — 위젯은 26-c live 검증된 계약·패턴
  재사용이라 낮은 위험. 해외지수·SSE 이월.

## Context

사용자 요청(2026-07-21): 지수(코스피 등)를 KIS에서. **게스트 화면은 불가**(personal 라이선스
재배포 금지, map line 16) — 로그인 owner workspace에는 정당. KIS 국내업종 현재지수 API
(`inquire-index-price`, TR `FHPUP02100000`, 시장분류 U)로 개인용 트랙을 확장한다.

## Owned scope

- **31-a**: `kis-market-information`에 지수 심볼 지원 — 심볼 allowlist(`KOSPI`→U/0001,
  `KOSDAQ`→U/1001) → 지수 TR·필드(`bstp_nmix_prpr` 등) 분기. 기존 주식 경로·scope guard
  (owner-only·personal_display·재배포 금지) 불변. 세션/휴장일 freshness 로직 재사용.
- **31-b**: workspace market-widget에 지수 행 추가(available일 때만 값+freshness).
- **31-c**: opt-in 실 KIS 계약 테스트 1건(`KIS_CONTRACT=1`, :29443 probe로 TR·필드 확정).

## Acceptance

- network-off 단위: 지수 available 매핑(값·"pt" 단위 처리), 주식 경로 회귀 0, guest/비-owner →
  KIS 호출 0 불변.
- 실 KIS 계약 테스트 pass(모의 :29443에서 코스피 현재지수 수신) — 실패 시 TR/필드를 probe로 교정.
- codex 적대 리뷰(크리덴셜 경로 — 다른 계열) 후 확인 건만 수정.

## Out of scope

- 게스트 화면 지수 표시(재배포 불가), 해외지수, SSE 스트리밍.
