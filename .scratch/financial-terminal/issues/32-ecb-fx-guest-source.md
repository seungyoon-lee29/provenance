# 32 - 게스트 공개 소스 증분: ECB 기준환율 (USD/KRW 스트립 셀)

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 28, 30
Blocked by: None
Owner: (unclaimed)

## Context

게스트 트랙 둘째 공개 소스(rule of three — 이번에 공통부가 실제로 둘이 되므로 필요한 만큼만 추출).
ECB 일별 기준환율은 출처표시 하 재배포 허용(ticket 01/27 조사). USD/KRW는 ECB가 직접 공표하지
않으므로 EUR 기준 두 공표값의 **교차 산출** — 파생값임을 정직하게 표기(`priceBasis:"indicative"`,
feed에 cross 명시).

## Owned scope

- **32-a**: ECB SDMX API live probe(무키 확인·응답 shape 기록) → `createEcbFxInformation`
  (KIS/treasury 동형 drop-in). 심볼 `USDKRW`(교차: KRW.EUR ÷ USD.EUR), audience=`public`.
  영업일 공표 freshness는 treasury의 classifier를 공표시각 파라미터로 일반화해 공유(둘째 실사례).
- **32-b**: `/api/public-market`이 심볼로 treasury/ECB 라우팅(composition에서 심볼→어댑터 매핑).
- **32-c**: guest 스트립 `index-usdkrw` 셀 배선(30-a seam 재사용) + macro 위젯 행.
- 게이트: 기존 `PUBLIC_MARKET_TREASURY_ENABLED`와 별개 플래그 대신 **공용 게이트로 승격**
  (`PUBLIC_MARKET_ENABLED`) 여부는 구현 시 결정 — 어느 쪽이든 기본 off·PR egress 0 불변.

## Acceptance

- network-off 단위: 교차 산출 정확성(수치 픽스처)·파생 표기·양 소스 중 하나라도 값 없으면 값 없음
  (반쪽 교차 위조 금지)·freshness 영업일 로직.
- opt-in 실 ECB 계약 테스트 1건 pass.
- guest 실 DOM에서 USD/KRW 값+freshness.
- codex 적대 리뷰(공개 feed egress 표면) 후 확인 건만 수정.

## Out of scope

- KRX EOD·기타 환율쌍·멀티소스 프레임워크 일반화(셋째 소스 때).
