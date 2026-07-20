# 27 - 게스트 공개 실데이터 소스 조사·probe (재배포 가능 public feed 첫 파이프라인)

Type: research
Status: resolved
Triage: ready-for-agent
Depends on: 01, 13
Blocked by: None
Owner: main
Claimed at: 2026-07-20T17:11:19Z
Last heartbeat: 2026-07-20T17:20:00Z

## Progress

- 2026-07-20: 착수. 게스트 공용 feed용 재배포 가능 소스 파이프라인을 증명하기 위한 live probe.
- 2026-07-20: 미 재무부 2개 엔드포인트 live probe로 Q1·Q2·Q3·Q5 실측 해소, Q4는 F4 계약
  검토로 해소(계약이 이미 Treasury/ECB daily cadence를 상정). RESOLVED → 티켓 28 범위 확정.

## Context / 왜 지금

개인용 트랙(KIS, 24/25/26)은 `free_personal` personal-license라 guest 공용 feed로 재배포
불가(map line 16; ticket 01 line 26 "무료 비용은 공개 표시·재배포 권리를 뜻하지 않는다").
취업용 목표(배포·공개 서비스 운영)에는 **재배포 가능한 public-license 실데이터**를 guest
shell(F1)에 붙여야 하는데, 현재 guest feed는 synthetic만 있어 F11 공개 스크린샷·배포 게이트가
막혀 있다. 사용자 결정(2026-07-20): 개인용/게스트용 두 트랙을 분리 운영하고, 게스트 실데이터
파이프라인을 **재배포권이 가장 명확하고 즉시 live인 소스**로 먼저 증명한다.

## 조사 대상 (ticket 01 line 14 공공 정본 — 전부 public-license 후보)

- **1순위 probe: 미 재무부 Fiscal Data API** (JSON·무키·US-gov public domain) — 재배포권이
  가장 명확해 파이프라인(public 어댑터 → guest shell → 배포)을 de-risk하는 첫 소스.
- 후속 후보: ECB 환율, SEC EDGAR / Open DART 공시, KRX 일별(EOD). 재배포권·shape는 별도 확인.
  KRX EOD는 재배포권 불확실성(line 17 실시간 보류)이 커서 파이프라인 증명 뒤에 얹는다.

## Open questions (live probe로 해소)

- **Q1** 미 재무부 Fiscal Data API의 base·엔드포인트·인증(무키 확인)·rate limit·응답 shape?
- **Q2** 어떤 데이터셋이 "금융 터미널" guest feed에 적합한가 (par yield curve vs avg rate vs ...)?
- **Q3** 재배포/공개 표시 라이선스 근거 확인 (무료≠재배포권, line 26) — public domain/ToS 명시?
- **Q4** 기존 `MarketObservation`/`InformationOutcome`(F4) 계약에 rate/FX가 매핑되나 (equity
  quote와 shape 다름) — 재사용 vs 새 observation kind 결정.
- **Q5** freshness: 발행 주기(일 1회 등)와 asOf/priceBasis 매핑, 장외/주말 처리 방향.

## Acceptance

- 라이브 read-only probe로 Q1·Q2·Q3·Q5를 실측 해소하고, 응답 shape·라이선스 근거를 티켓에 기록.
- Q4 매핑 방향(계약 재사용 vs 새 kind) 결정 + 다음 어댑터 티켓(28) 범위 확정.
- 비밀·사용자 데이터 전송 0(공개 무키 API). 재배포권 미확인 소스는 활성 후보에서 제외.

## Out of scope

- 어댑터 구현·guest shell 배선 (→ 티켓 28).
- KRX EOD·DART 재배포권 확정 및 배선 (파이프라인 증명 후 후속 티켓).
- 실제 배포/호스팅 (F11 게이트, ready-for-human).

## Findings (live probe 2026-07-20)

- **[A] Fiscal Data API** `GET https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date` — **무키·JSON** 확인. record_date 2026-06-30, `avg_interest_rate_amt:"3.706"`(문자열 숫자), meta.total-count 4977. **월별 cadence**(record_date=월말).
- **[B] Daily Treasury Par Yield Curve** `GET https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=2026` — **무키·XML(Atom)** 확인. `<updated>2026-07-17T15:46:44Z</updated>`(직전 영업일), entry별 `NEW_DATE`+`BC_1MONTH`…`BC_30YEAR` tenor. **일별 cadence**, ~210KB/년.
- **Q1** 둘 다 무키·rate-limit 인증 없음. base 확정(위).
- **Q2** 터미널 적합도: 일별 yield curve([B])가 "market" 느낌 최상(2Y/10Y 등 tenor). avg_interest_rates([A])는 JSON이라 파서 부담 0이지만 월별.
- **Q3 재배포권**: 둘 다 **미 연방정부 저작물 → public domain(17 U.S.C. §105)**, Fiscal Data는 무키 공개 API로 프로그램 접근 설계. "무료≠재배포권"(line 26)의 실제 근거 = public domain(KRX보다 훨씬 명확).
- **Q4 계약 매핑**: `MarketObservation` **재사용**이 정답 — `contracts.ts` line 46-52가 `cadence` policy를 "Treasury/ECB daily, KRX EOD, SEC/DART"로 **이미 상정**. tenor 1개 = symbol 1개(예 `UST10Y`), `last`=금리%, `priceBasis:"eod"`. 유일 마찰: `currency` 필드가 rate엔 의미상 안 맞음 → 표시 단위로 `"%"` 사용(문자열, 계약 변경 0). FX면 마찰 0(currency=진짜 통화).
- **Q5 freshness**: `cadence` expiry(누락 발행 횟수로 hard). asOf=레코드 business date, basis=`eod`. 주말/장외는 직전 발행이 eod로 정직하게 age.

## Resolution (2026-07-20)

### Answer
미 재무부 2개 소스가 **무키·live·public-domain(재배포 명확)**임을 실측. guest 공용 feed 파이프라인의
첫 소스로 확정. `MarketObservation` 계약을 그대로 재사용(계약이 이미 Treasury daily cadence 상정),
audience=`public` 어댑터로 KIS와 동형(port drop-in) 구현 가능. **티켓 28** = 이 어댑터 + guest shell
배선. 소스 선택(일별 yield curve[XML] vs 월별 avg-rate[JSON]) 및 currency-단위 처리는 28 설계 포인트.

### Validation
live read-only probe 2건(2026 실데이터 반환, 무키, 비밀·사용자 데이터 전송 0). 계약 매핑은
`contracts.ts` MarketObservation/ObservationExpiryPolicy 검토로 확인.

### Residual risks
- 소스 선택 fork(yield curve 일별·XML 파서 부담 vs avg-rate 월별·JSON)는 티켓 28에서 결정.
- ECB FX(계약 마찰 0)·KRX EOD·DART는 후속 소스로 이월.
- 실제 재배포는 어댑터가 audience=`public` outcome을 만들 때 비로소 발생 → egress/no-redistribution
  불변식(ticket 21) 하에서 28이 TDD+codex 게이트 대상.
