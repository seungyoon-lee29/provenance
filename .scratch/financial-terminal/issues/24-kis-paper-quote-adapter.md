# 24 - KIS 모의투자 REST 시세 어댑터 (첫 free_personal 실공급자)

Type: implementation
Status: resolved
Triage: done
Depends on: 12, 13
Blocked by: None
Owner: main
Claimed at: 2026-07-20T15:20:49Z
Last heartbeat: 2026-07-20T15:47:46Z

## Progress

- 2026-07-20: live probe로 open-q #1·#2 해소(모의 `:29443`이 시세 서빙, tr_id/shape 확정).
- 2026-07-20: seam 합의 — 저수준 HTTP 주입(`KisHttp`). red-first TDD 착수.
- 2026-07-20: 5 슬라이스 red→green(happy·토큰캐시·scope guard·오류매핑·견고성). check green.
- 2026-07-20: codex 적대 리뷰 BLOCK(3 BLOCKER+3 HIGH, 4건 반증). 확인된 5건 TDD 수정,
  HIGH 2(장외 freshness)는 근거와 함께 P2 이월. 실 KIS `:29443` 계약 테스트 통과 → RESOLVED.

## Context / 왜 지금

전체 아키텍처(FinancialInformation `MarketInformation` port, `InformationOutcome`
정규화, Data Freshness, License Scope, runtime-policy 계약 게이트)는 처음부터 **실공급자
데이터를 받도록** 설계됐지만, 현재 실제 데이터 소스는 `scripted-market-information.ts`
합성 공급자뿐이고 그마저 데모 라우트(`src/app/f4-panels/page.tsx`)에만 배선돼 있다.
실공급자 HTTP 어댑터는 **0건**이다.

map.md가 이미 사용자 결정으로 근거를 깔아뒀다:
- line 16: "KIS Open API는 ... 구독비 USD 0의 `free_personal` 공급자로 취급하고 개인
  목적에 유용한 시세·차트·계좌·모의투자 capability를 활성 후보로 둔다. ... 어느 개인
  key도 비로그인 공용 feed나 다른 사용자 cache로 재배포하지 않는다."
- line 17: ".env.local에는 ... KIS ... 변수 이름이 구성돼 있다. 값·유효성·API별 승인
  상태는 **별도 contract test 전에는 확정하지 않는다.**"

이 티켓은 그 "별도 contract test"를 acceptance gate로 두고, KIS 모의투자 REST **시세
read** 어댑터를 free_only·contract-gate·personal-license 안에서 붙이는 첫 슬라이스다.
(F11/티켓 20의 실데이터 스크린샷 게이트와의 관계는 아래 Out of scope에서 명시적으로
분리한다 — 개인키는 공용 feed가 아니다.)

## API 사실 (공식 repo `koreainvestment/open-trading-api` + auth 코드에서 확정)

- REST base: 실전 `https://openapi.koreainvestment.com:9443`, 모의(VTS)
  `https://openapivts.koreainvestment.com:29443` (코드 verbatim 확인)
- 토큰 발급: `POST /oauth2/tokenP` (appkey/appsecret → access_token). 유효 24h,
  **1분당 1회만 발급** → 토큰 캐시 필수
- 주문 hashkey: `POST /uapi/hashkey` (시세 read엔 불필요 — 이 슬라이스 범위 밖)
- WebSocket approval_key: `POST /oauth2/Approval` (실시간 — 범위 밖)
- 레이트리밋: 초당 초과 시 `EGW00201`. 표준 문서값 실전 20/s·모의 2/s (contract test로 실측 확정)
- 요청 헤더에 access_token(Bearer) + appkey + appsecret + **tr_id**(거래ID) 필요

## Probe results (2026-07-21) — live 실측, open-question #1·#2 해소

owner의 실 모의 크리덴셜(`KIS_ENVIRONMENT=paper`,
`KIS_REST_BASE=https://openapivts.koreainvestment.com:29443`)로 read-only probe 실행
(토큰+현재가만, 주문 0, 비밀 미출력). 삼성전자 005930 기준:

- **모의(`:29443`)가 시세 현재가를 직접 서빙 → 별도 실전 키 불필요.** open-q #1 해소.
  - 토큰: `POST /oauth2/tokenP` (JSON body) → `http=200`, `expires_in=86400`(24h 확정).
  - 시세: `GET /uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=005930`,
    header authorization Bearer + appkey + appsecret + `tr_id=FHKST01010100` + `custtype=P`
    → `http=200 rt_cd="0" msg_cd="MCA00000" msg1="정상처리 되었습니다."`.
  - 응답 shape: `{ rt_cd, msg_cd, msg1, output:{...80필드} }`. 확인 필드:
    `stck_prpr`(현재가), `prdy_vrss`(대비), `prdy_ctrt`(등락률) 모두 채워짐. open-q #2 해소.
- **1분당 1회 토큰 발급 제약이 실제로 물림**: probe가 서버 재시도 시 `http=403`,
  `"접근토큰 발급 잠시 후 다시 시도하세요(1분당 1회)"`. → **토큰 캐시는 선택이 아니라
  403 lockout 방지 필수**. 재시작 스톰이 1/min을 소진하면 owner가 잠긴다(아래 Design 3 갱신).

남은 소소한 impl 결정(리스크 낮음, 착수 시 80필드 output에서 확정):
- 전일종가 정확한 필드명(probe의 `stck_prdy_clpr`는 undefined — 다른 키). `MarketObservation`
  필수값(last/change/changePercent)은 이미 확보돼 blocker 아님.
- **as-of 타임스탬프/freshness**: inquire-price 스냅샷엔 명시적 as-of가 없음 →
  freshness 정책은 request 시각+장중 여부로 as-of를 도출해야 함(map "모든 Observation은
  as-of·freshness 포함" 요건). 정책 파라미터(soft/hard residual) 착수 시 확정.

## Owned scope

- `src/modules/financial-information/data/` 아래 신규 파일 1개:
  `kis-market-information.ts` — `MarketInformation` port 구현
  (`read(query: MarketQuery, viewer: ViewerContext): MarketLoad`).
- 토큰 발급/캐시(24h TTL·1분 발급 제약 존중, in-memory 단일 캐시).
- KIS 현재가 응답 → `MarketObservation`(last/currency=KRW/change/changePercent/
  priceBasis) 정규화 + `applyObservationFreshness`(as-of 기준) + `InformationOutcome` wrap.
- KIS 오류 → `ProviderFailureKind` 매핑(`outcome-classification.ts` 재사용):
  EGW00201→quota, 토큰오류→reauthentication_required/denied(credential),
  timeout→timeout, 5xx→upstream, malformed/future asOf→invalid_response(+quarantine).
- License Scope `audience: "personal"` 부착(재배포 백스톱이 downstream에서 강제되도록).
- 활성 게이트: config에 KIS 크리덴셜쌍 + `RUN_KIS_PAPER_READ_CONTRACT=true` +
  `LOCAL_PROVIDER_CREDENTIAL_MODE=single_owner` + **viewer == owner workspace**일 때만
  실 KIS를 read; 그 외에는 scripted/unavailable로 fall-through(개인 데이터 누출 0).
- 기존 10s 데이터 `withDeadline` 배선.
- network-off 결정론 단위 테스트(녹화 KIS JSON fixture) + opt-in sandbox contract test.

## Out of scope (이후 슬라이스로 이월)

- WebSocket 실시간 시세(approval_key) — slice 2.
- 해외주식·선물옵션·채권·ELW·ETF/ETN — 이 슬라이스는 **국내주식 현재가 1종**만.
- 주문/체결(hashkey, tr_id 주문계열) — Live 주문 전송은 map line 63에 따라 out of scope,
  F9(티켓 18) broker execution은 scripted 유지.
- per-user ProviderConnections 크리덴셜 배선 — slice 1은 `single_owner`(env) 전용.
  다중 사용자 각자 KIS 연결은 별도 티켓(티켓 12 vault 위에).
- **F11 비로그인 공개 실데이터 스크린샷(티켓 20 게이트-4)** — personal-license 개인키는
  map line 16에 의해 공용 feed로 재배포 **불가**. 그 게이트는 공개-license 소스가 별도로
  필요한 다른 질문이다. 이 티켓은 그것을 풀지 않는다(로그인 owner workspace 한정).

## Design

1. **크리덴셜 모델**: process-global `single_owner`. runtime-policy(:110) 이미 존재 —
   `APP_ENVIRONMENT=development` + 불변 `LOCAL_PROVIDER_OWNER_WORKSPACE_ID` 요구.
   어댑터는 그 owner workspace의 viewer에게만 KIS 데이터를 준다(ViewerContext +
   license audience=personal 이중 방어).
2. **토큰 lifecycle**: `POST {base}/oauth2/tokenP` → {access_token, expires_in=86400}.
   캐시 **필수**(선택 아님): probe에서 1분당 1회 초과 시 `http=403` lockout 실측 —
   무캐시면 매 read가 즉시 403. 만료 near일 때만 재발급, 403 시 마지막 유효 토큰 재사용.
   ponytail: single_owner 슬라이스는 in-memory TTL 캐시로 충분하되 **재시작 스톰이
   1/min을 소진하면 owner 잠김** → 토큰을 durable 캐시(pg, 티켓 23 seam)로 두는 업그레이드
   경로를 주석으로 명시. 시세 read는 hashkey 불필요.
3. **시세 read** (probe 확정): `GET {base}/uapi/domestic-stock/v1/quotations/inquire-price`,
   header tr_id=`FHKST01010100`+`custtype=P`, query `fid_cond_mrkt_div_code=J` +
   `fid_input_iscd={종목코드}`. base=`:29443`(모의)가 시세를 서빙 — 실전 키 불필요.
4. **정규화**: KIS 필드(`stck_prpr` 현재가, `prdy_vrss` 대비, `prdy_ctrt` 등락률) →
   `MarketObservation.value`(currency=KRW, priceBasis 매핑). as-of로 freshness(soft/hard) 산출.
5. **실패 매핑**: `classifyProviderFailure` 재사용, EGW00201 등 KIS 코드를 기존 6종
   `ProviderFailureKind`로 접는다.
6. **fall-through**: 게이트 미충족·viewer 불일치·크리덴셜 없음 → 실 KIS 호출 0,
   scripted/unavailable outcome. network-off CI에선 항상 이 경로.

## Acceptance criteria (관측 가능한 oracle)

- **[agent, now]** network-off 단위: 녹화 KIS JSON fixture(성공/EGW00201/토큰만료/
  malformed) → 각각 올바른 `MarketObservation` / `InformationOutcome` /
  `ProviderFailureKind`. 실네트워크 0.
- **[agent, now]** 토큰 캐시: TTL 내 2회 read가 tokenP를 1회만 호출; near-expiry 재발급.
- **[agent, now]** scope-guard: 비-owner viewer는 실 KIS 데이터를 절대 수신 안 함(fall-through).
- **[agent, now]** license: outcome에 audience=personal이 실려 redaction/narrowing 백스톱 통과.
- **[ready-for-human]** opt-in sandbox contract test: 실 `KIS_APP_KEY/SECRET` +
  `RUN_KIS_PAPER_READ_CONTRACT=true`로 실서버에 붙어 알려진 종목(예: 삼성전자 005930)
  현재가가 fresh `MarketObservation`으로 온다. 티켓 05의 opt-in sandbox contract seam 방식,
  network-off CI는 skip. **이게 map line 17의 "별도 contract test" — KIS 값·승인 확정 지점.**

## Risks / Open questions

1. ~~모의 서버가 시세를 서빙하는가~~ **해소(probe)**: `:29443`이 현재가 직접 서빙.
2. ~~정확한 엔드포인트/tr_id/응답 shape~~ **해소(probe)**: inquire-price + FHKST01010100 +
   `{rt_cd,msg_cd,msg1,output(80필드)}` 확정. fixture는 이 shape로 고정.
3. 크리덴셜 원문은 코드·문서·allowlist·fixture 어디에도 평문 금지. fixture는 응답 JSON만,
   토큰·appkey·appsecret redact.
4. (잔여) as-of/freshness 도출 정책, 전일종가 필드명 — Probe results의 "남은 impl 결정" 참조.
   리스크 낮음, 착수 시 확정.

## Plan / gates

- 리스크 비례 게이트(돈/브로커/크리덴셜 인접·인증): 구현 시 red-first TDD → code-review
  1패스 → **codex 적대 리뷰(다른 계열)** → 판단. 티켓 16~19와 동일 패턴.
- 첫 단계 권장: owner가 live probe(needs real creds → ready-for-human)로 서버 라우팅·
  tr_id·응답 shape 확정 → 그 shape로 agent가 어댑터+network-off 테스트 구축 →
  opt-in contract test로 실측 마감.

## Review (codex 적대 리뷰 — 다른 계열 GPT)

VERDICT BLOCK → 확인된 5건 수정 후 재검증 green. 판정 요약:

**수정(확인됨):**
- BLOCKER 1 `read()` reject 가능(clock.now() try 밖) → clock 호출 try 내부, occurredAt 독립 fallback.
- BLOCKER 2 deadline 미배선(무한 pending) → `withDeadline`(DATA_DEADLINE_MS, sleep 주입) 배선.
- BLOCKER 3 토큰 이중 발급 race(동시 read → tokenP 2회 → 1/min lockout) → in-flight 프라미스 single-flight.
- HIGH 1 빈 가격 `""`→`Number("")=0` 조작값 → `toNumber` blank→NaN→invalid_response.
- HIGH 3 token 403(1/min)→terminal reauth 오분류 → token 전용 `tokenFailure`(403→quota retryable).

**반증(codex 증거):** guest/비-owner 키 사용(networkCalls 0), 심볼 URL 인젝션(encodeURIComponent),
시크릿 outcome 노출(진단 핸들만), undefined 가격→0(undefined는 NaN→invalid_response). 전부 REFUTED.

**이월(확인됐으나 별도 슬라이스):** HIGH 2 — 장외 시간 전일종가를 realtime/trade로 오표기.
근본 수정은 KRX 세션 캘린더 필요(별도 feature). 어댑터가 아직 어느 라우트에도 **미배선**이라
사용자 노출 0 → freshness 정확도는 **배선 슬라이스**에서 세션 컨텍스트와 함께 처리. P2.

## Resolution (2026-07-20)

### Answer
KIS 모의(`:29443`) REST 국내주식 현재가를 F4 `MarketInformation` seam에 drop-in하는 첫
free_personal 실공급자 어댑터를 red-first TDD로 구현. 저수준 `KisHttp` 주입으로 network-off
결정론 검증, personal-license·single-owner scope guard로 map line 16(재배포 금지) 3중 방어,
토큰 캐시+single-flight로 1/min lockout 봉쇄, withDeadline로 §11.3 10s 계약 self-guarantee.
실 KIS `:29443` opt-in 계약 테스트로 end-to-end 실측(map line 17 요건 충족).

### Changed files
- `src/modules/financial-information/data/kis-market-information.ts` (신규 — 어댑터)
- `tests/kis-market-information.test.ts` (신규 — network-off 16 테스트)
- `tests/kis-market-information.contract.test.ts` (신규 — opt-in 실계약, KIS_CONTRACT 게이트)
- `package.json`? (미변경 — 계약 테스트는 KIS_CONTRACT 미설정 시 자동 skip)

### Validation
- `npm run check` green: vitest 1267 pass/26 skip(KIS 16 포함) + public-seam + server-seam.
- typecheck·lint clean.
- **실 KIS `:29443` 계약 테스트 1 pass** (`KIS_CONTRACT=1`, 삼성전자 005930 → available KRW,
  last>0, audience personal). 토큰+시세+정규화 end-to-end 실측.

### Review
red-first TDD → codex 적대 리뷰(다른 계열, BLOCK) → 확인 5건 수정 → 재검증 green. 위 Review 참조.

### Residual risks (P2)
- **HIGH 2 배선**: 장외 freshness/priceBasis 정확도 — KRX 세션 캘린더 필요, 배선 슬라이스로.
- **composition 배선**: 어댑터는 아직 어느 라우트에도 미배선(single_owner 런타임 config +
  route 선택 필요). 별도 슬라이스.
- **커버리지 확대**: 해외주식·선물옵션 등 다른 카테고리, WebSocket 실시간(approval_key), 주문(hashkey).
- **오류 매핑 정밀화**: token 403 credential-vs-ratelimit discriminator, business rt_cd 무-데이터/
  invalid-symbol 세분 — 실 error_code를 계약 테스트로 축적하며 확장.
- **토큰 durable 캐시**: 재시작 스톰 시 1/min 소진 방지용 pg 캐시(티켓 23 seam) 업그레이드.
