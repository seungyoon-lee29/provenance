# 32 - 게스트 공개 소스 증분: ECB 기준환율 (USD/KRW 스트립 셀)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 28, 30
Blocked by: None
Owner: main
Claimed at: 2026-07-21T07:25:00Z
Last heartbeat: 2026-07-21T07:50:00Z

## Resolution (2026-07-21)

### Answer

게스트 트랙 둘째 소스: ECB SDMX csvdata(`EXR/D.USD+KRW.EUR.SP00.A`, 무키, live probe 실측 —
한 요청에 두 시리즈)를 `createEcbFxInformation`으로 정규화. **USD/KRW는 파생 교차**(KRW.EUR ÷
USD.EUR)임을 정직하게 표기: `priceBasis:"indicative"`, feed `ecb:reference-cross`, 교차는 **양
시리즈가 모두 공표된 날짜에만** 존재(반쪽 교차 위조 금지, 테스트 고정). freshness는 공표시각
파라미터로 일반화한 공용 영업일 분류기(`classifyBusinessDayPublicationFreshness`, rule of three
둘째 실사례 — treasury도 위임으로 전환, 회귀 0). 게이트는 `PUBLIC_MARKET_ENABLED`로 승격
(기존 `PUBLIC_MARKET_TREASURY_ENABLED`는 별칭 유지). composition은 심볼 라우팅 합성
(ECB_FX_SYMBOLS → ecb, 나머지 → treasury), 같은 TTL 캐시·pinned origin·redirect 거부 공유.
guest 스트립 `index-usdkrw` 셀 + macro 위젯 행 배선(표시만 2dp 반올림, 값 원형 보존).

### Validation

- network-off 단위 9(교차 정확성·공통일 정직성·<2 공통일 invalid·0 분모·비십진·에러 매트릭스·
  scope 게이트·영업일 freshness 15:30Z) + treasury 29 회귀 green. check 전 레인 green(1,333).
- **실 ECB 계약 테스트 pass**(`ECB_CONTRACT=1`): live USD/KRW 교차 available·indicative·public·
  asOf 10일 내.
- 적대 리뷰(31·33과 배치, codex 기동 실패로 **차선 에이전트** — 상세 고지는 티켓 33): ECB 축은
  교차 정직성·공통일 선택·CSV 정렬·treasury 분류기 회귀 모두 **이상 없음** 판정. 단 게이트
  지적(legacy 플래그의 조용한 권한 확장)에 따라 별칭을 은퇴시키고 설정 시 부팅 오류로 변경 —
  `PUBLIC_MARKET_ENABLED`만 유효.

### Residual risks

- CSV 나이브 split은 인용부호 앞 컬럼(≤7)만 위치 안전 — 전 필드 엄격 검증으로 오정렬은 fail-closed.
- EU/KR 공휴일 미모델(fail-closed 방향, treasury와 동일 잔여). 추가 환율쌍·KRX EOD 이월.

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
