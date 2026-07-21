# 28 - 게스트 공개 실데이터 어댑터 + guest shell 배선 (미 재무부 일별 수익률 곡선)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 27, 13, 10
Blocked by: None
Owner: main
Claimed at: 2026-07-21T05:33:23Z
Last heartbeat: 2026-07-21T06:15:00Z

## Progress

- 2026-07-21: claim. 계약·패턴 정독 완료(KIS 어댑터·freshness/outcome 헬퍼·/api/market 라우트·
  market-widget·guest shell·contract test 게이트). 설계 확정: XML `NEW_DATE`는 TZ 없는 로컬 포맷이라
  날짜부만 추출해 UTC 자정으로 고정(결정론·보수적 aging). change는 직전 발행 대비 산출(현재 연도
  엔트리 <2면 전년도 1회 추가 fetch 후 병합; 그래도 <2면 invalid_response — 숫자 위조 금지).
  red-first TDD 착수.
- 2026-07-21: v1 구현 green(15 테스트) → 라우트·위젯 배선 → 실 라우트 스모크(UST10Y 4.60%·eod·
  audience public·invalid 400) + 실 DOM QA(2Y/10Y 값+freshness 렌더, spinner 없음) + 실 재무부
  opt-in 계약 테스트 pass. codex 적대 리뷰 **BLOCK**(19건) → 실측 검증 후 확인 10건 TDD 수정,
  반증/잔여 기각 기록. v2 green(29 테스트) + 전 레인 check green.

## Resolution (2026-07-21)

### Answer

게스트 트랙 첫 실데이터 end-to-end 완성: 미 재무부 Daily Par Yield Curve(무키·public domain)를
`createPublicMarketInformation`(KIS 동형 `MarketInformation` drop-in)으로 정규화하고, owner-gate
없는 `/api/public-market` 라우트와 guest shell macro 패널의 `PublicTreasuryWidget`(2Y/10Y,
available일 때만 값+freshness)으로 배선했다. **egress 게이트**: `PUBLIC_MARKET_TREASURY_ENABLED`
(기본 false, rights.md·spec §12.2 정합) — off면 api_required·외부 egress 0. freshness는 spec §5.1
"Treasury·ECB daily" 그대로: 다음 예상 **영업일** 공표 +2h까지 realtime, 1회 누락 stale, 2회 누락
hard(no_data). 주말은 정직하게 realtime 유지(누락 아님).

### codex 적대 리뷰 (BLOCK → 확인 건 수정)

**확인·수정 10건**: ① cadence 정책이 spec §5.1(영업일 2회 누락 hard) 위반 → 영업일 기반
`classifyTreasuryFreshness` + `applyClassifiedObservationFreshness` seam 추출 ② `Date.parse`가
2026-02-30을 3/2로 정규화(실측) → 달력 roundtrip 검증, 위반 시 feed 전체 quarantine ③ 중복 날짜
entry → 뒤 entry가 revision으로 승계, change는 직전 '날짜' 대비 ④ 필드명 프리픽스 충돌
(BC_10YEAR_EXTRA가 BC_10YEAR로 오파싱 — 값 위조 경로) → 태그명 경계 정규식 ⑤ `Number("0x10")`=16
(실측) → 엄격 십진 lexicon ⑥ prototype 누출(`constructor`, 실측) → `Object.hasOwn` ⑦ fetch
redirect 기본 추종 → `redirect:"error"`(pinned origin이 최종 origin) ⑧ 요청당 연 XML 재fetch 증폭
→ `withTreasuryCache`(URL별 TTL 5분+single-flight, 200만 캐시) ⑨ PR job egress deny(spec §12.2)·
rights.md opt-in 위반 → 런타임 게이트 신설 ⑩ 위젯 fetch 무한 대기 → `AbortSignal.timeout(15s)`.
계약 테스트도 프로덕션 정책 + asOf 10일 하한으로 강화.

**기각·잔여 기록**: 0% prior 상대변화(ponytail 주석 잔여 — 2Y/10Y tenor에 0% 전례 없음),
chunked no-Content-Length 미캡(KIS transport 동형 잔여·origin pin으로 완화), 네임스페이스 변형
`<atom:feed>`(fail-closed + 계약 테스트가 감지 — 티켓 명시 설계), deadline 후 late 전년 fetch
(값 오염 없음·유휴 1요청 잔여), 라우트/DOM 통합 테스트 부재(KIS 라우트 동형 — live 스모크+실 DOM
QA로 대체).

### Changed files

- `src/modules/financial-information/data/treasury-market-information.ts` (신규 — 어댑터·캐시·게이트 어댑터)
- `src/modules/financial-information/data/observation-freshness.ts` (classifier 주입 seam 추출, 기존 호출자 무변경)
- `src/composition/public-market-server.ts` (신규 — 싱글턴·pinned origin·TTL 캐시·redirect 거부)
- `src/composition/runtime-policy.ts` (`PUBLIC_MARKET_TREASURY_ENABLED` → `treasuryMarketEnabled`)
- `src/app/api/public-market/route.ts` (신규 — 무인증 공개 라우트·zod symbol)
- `src/modules/terminal-view/presentation/guest/public-treasury-widget.tsx` (신규), `guest-terminal-shell.tsx` (macro 패널 mount)
- `tests/treasury-market-information.test.ts` (29), `tests/treasury-market-information.contract.test.ts` (opt-in 1)
- `.env.example`, `docs/release/rights.md` (Treasury 행·opt-in 문서화)

### Validation

- network-off 단위 29 green(파서 정직성·spec freshness·에러 매트릭스·scope 게이트·연 경계·캐시).
- `npm run check` 전 레인 green (1,312 pass; lint 경고 1은 기존 stryker.config 건).
- **실 재무부 opt-in 계약 테스트 pass**(map line 17 요건): live UST10Y available·%·public·asOf 10일 내.
- 실 라우트 스모크: UST10Y 4.60% `eod` audience public·invalid symbol 400·secret 0.
- **guest shell 실 DOM QA**(Playwright): 2Y 4.21%·10Y 4.60% 값+freshness+asOf 렌더, 무한 spinner 없음.
- 게이트 off 경로: 단위 테스트(zero-network api_required) + 스키마 기본 false.

### Residual risks

- 미 연방 휴일 미모델 → 긴 연휴에 진짜 최신 곡선이 hard-expire될 수 있음(fail-closed 방향;
  체감 시 US holiday 번들 추가 — 어댑터 주석에 승격 경로 명시).
- **배포·로컬에서 이 feed를 켜려면 `PUBLIC_MARKET_TREASURY_ENABLED=true` 필요**(기본 off).
  실행 중 dev 데몬은 재시작 전까지 구 싱글턴(게이트 이전) 유지.
- ECB FX·avg-rate·KRX EOD·DART 증분, 멀티소스 공통부 추출(rule of three)은 후속 티켓.

## Context

티켓 27이 미 재무부 소스를 **무키·live·public-domain(재배포 명확)**으로 확정했다. 사용자 결정
(2026-07-20): 게스트용 트랙 첫 소스는 **A) Daily Par Yield Curve(일별·수익률 곡선)** 하나를
end-to-end로 배포까지 먼저 굳히고, ECB FX·avg-rate·KRX EOD는 파이프라인 확립 후 얇게 증분한다
(rule of three — 둘째 실사례가 올 때 공통부 추출; 지금 멀티소스 프레임워크 선반영 금지).

## Owned scope

- **28-a 어댑터**: `createPublicMarketInformation`(KIS 어댑터 동형) — 저수준 HTTP 주입으로
  network-off 결정론 TDD. audience=`public` outcome(개인키 아님 → guest 재배포 허용). tenor 1개 =
  symbol 1개(`UST2Y`/`UST10Y` 등), `last`=금리%, `currency`=`"%"`(표시 단위), `priceBasis:"eod"`.
  freshness는 `cadence` policy(누락 발행 횟수 hard-expiry). XML(Atom) 파싱은 고정 필드
  정규식 추출 + 픽스처 테스트(ponytail: 스키마 변경 시 테스트가 잡음).
- **28-b 공개 라우트**: owner-gate 없는 public_display read(개인 라우트 `/api/market`와 분리).
  공개 데이터라 same-origin 불필요(단 심볼 zod 검증 유지).
- **28-c guest shell 배선**: `market-widget` 렌더 패턴(available일 때만 값+freshness) 재사용해
  guest shell(F1)에 공개 위젯 mount. 값 없는 outcome은 상태만.

## Acceptance

- 어댑터: 무키 fetch stub → available outcome(금리%·eod·audience public), 발행 누락 → cadence
  soft/hard 정직 age, 오류(404/5xx/malformed) → 값 없는 outcome. network-off TDD.
- 라우트: 심볼 → outcome JSON, 비밀·raw 0. guest(비로그인)도 값 받음(공개 라이선스).
- guest shell 실 DOM에서 값+freshness 표시, 무한 spinner 없음.
- opt-in 실 재무부 contract test(map line 17 요건) 1건 pass.

## 리스크 게이트

공개 feed = egress/no-redistribution 불변식(ticket 21) 표면. **red-first TDD → codex 적대 리뷰
(다른 계열) → 확인 건만 수정 → resolve.**

## Out of scope

- ECB FX·avg-rate·KRX EOD·DART 추가 소스 (파이프라인 확립 후 증분).
- 실제 배포/호스팅 (F11 게이트).
- 멀티소스 공통부 추출 (둘째 소스 실사례 시).
