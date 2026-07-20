# 26 - KIS composition 배선 — /api/market 라우트 + workspace 위젯

Type: implementation
Status: resolved
Triage: done
Depends on: 24, 25
Blocked by: None
Owner: main
Claimed at: 2026-07-20T16:17:57Z
Last heartbeat: 2026-07-20T16:35:20Z

## Context

티켓 24가 KIS 어댑터를, 25가 장외 freshness를 끝냈지만 어댑터는 **어느 라우트에도 미배선**
(MarketInformation 소비처는 데모 `f4-panels`뿐). 사용자 결정(2026-07-20): 로그인 owner의
workspace 페이지 + `/api/market` 라우트에 실시세를 배선(풀).

## 고위험 — 크리덴셜 흐름 + 새 라우트 + composition. 리스크 비례 게이트: TDD → codex 적대 리뷰.

## 분해

- **26-a 조립/게이팅**: `RuntimeConfig.kisMarketEnabled`(RUN_KIS_PAPER_READ_CONTRACT + single_owner
  + creds 존재 시 true) 파생. `market-assembly.ts`(assembleIdentityStores 패턴, relative import)가
  backend="kis"면 실 fetch transport로 KisMarketInformation, 아니면 scripted fallback을 반환.
  **secret은 RuntimeConfig에 싣지 않고 env에서 직접**(buildVault가 keyring을 파일에서 읽는 패턴).
  `marketServer()` globalThis 싱글턴(identityServer 패턴).
- **26-b `/api/market` 라우트**: server-only, `viewerFrom(request)`로 viewer 해석 → owner workspace
  아니면 fall-through(어댑터 scope guard가 이미 방어). `read(query{personal_display}, viewer)` →
  InformationOutcome JSON 반환(secret·raw 0). same-origin 가드.
- **26-c workspace 위젯**: `/api/market?symbol=` 소비, 값+freshness/priceBasis/provenance 표시.
  값 없는 outcome은 값 없이 상태만(F1 규율). 최소 위젯.

## Acceptance

- 조립: kisMarketEnabled+creds → KIS backend; 아니면 scripted. gating TDD.
- 라우트: owner viewer + 심볼 → outcome JSON(available이면 KRW/freshness 포함); guest/비-owner →
  값 없는 outcome(누출 0); 응답 어디에도 appkey/appsecret/token 없음.
- 위젯: 실 DOM에서 값+freshness 표시, 무한 spinner 없음(deadline).

## Out of scope

- 실시간 SSE 스트리밍(follow) — 이 슬라이스는 단발 read. WS는 티켓 24 out-of-scope.
- per-user ProviderConnections 경로 — single_owner env 전용.
- 해외/선물·주문·휴장일 캘린더(티켓 25 residual).

## Review (codex 적대 리뷰 — 다른 계열 GPT)

VERDICT BLOCK(1 BLOCKER + 2 MEDIUM) → 3건 모두 처리 후 재검증 green.

- **BLOCKER — KIS_REST_BASE 크리덴셜 유출**: 임의 호스트 base면 토큰 POST가 appkey/appsecret을
  외부로 전송. → **FIX(TDD)**: `loadRuntimeConfig`이 KIS_REST_BASE를 공식 KIS origin 2개
  허용목록으로 검증(fail-closed throw), `config.kisMarketBase`로 노출, market-server가 env 직접
  읽기 대신 이 검증된 값 사용. runtime-policy.test 3 assertion.
- **MEDIUM 2 — cross-site GET이 owner 키 사용(CSRF)**: Lax 쿠키가 top-level GET에 실려 same-origin
  검사 없이 owner로 resolve. → **FIX**: 라우트에 `clientProofFrom(request).sameOrigin` 가드
  (connections POST와 동일 패턴). **live 스모크**: cross-site→403, same-origin→200, foreign origin→403.
- **MEDIUM 1 — 무제한 body 버퍼링**: 공격자 base로 거대 JSON → 메모리 소진. BLOCKER 픽스(base pin)로
  실공격면 제거. → best-effort Content-Length 가드 추가. 청크(무 Content-Length) 스트리밍 캡은 residual.

반증(codex 증거 인정): H1 싱글턴 토큰 교차유출(servesOwner 선행 → 비-owner는 KIS 호출 0),
H2 심볼 인젝션(zod+encodeURIComponent), H5 viewerFrom 예외, H6 kisMarketEnabled 게이팅. 전부 REFUTED.

## Resolution (2026-07-20)

### Answer
KIS 어댑터(24/25)를 running stack에 배선: `market-assembly`(kis/scripted 선택) + `marketServer()`
싱글턴(env→KisConfig, 실 fetch transport, AbortSignal.timeout) + `/api/market` 라우트(same-origin
가드 → viewer 해석 → personal_display read → outcome JSON) + workspace 위젯(available일 때만 값,
owner 로그인 시 노출). 크리덴셜 목적지는 공식 KIS origin으로 pin(codex BLOCKER 봉쇄).

### Changed files
- `src/composition/market-assembly.ts` (신규), `src/composition/market-server.ts` (신규)
- `src/composition/runtime-policy.ts` (kisMarketEnabled + kisMarketBase 허용목록)
- `src/app/api/market/route.ts` (신규), `src/app/workspace/market-widget.tsx` (신규), `page.tsx` (마운트)
- `tests/kis-market-assembly.test.ts` (신규 2), `tests/runtime-policy.test.ts` (+2)

### Validation
- `npm run check` green: vitest 1276 pass/26 skip + seam 2.
- **라우트 live 스모크**: synthetic→200 available, invalid symbol→400, 실 심볼→no_data, 응답 secret 0;
  same-origin 가드 cross-site→403·same-origin→200. workspace SSR 200(위젯 owner-only).

### Review
red-first TDD(assembly·config·base) → codex 적대 리뷰(BLOCK) → 확인 3건 수정(BLOCKER TDD-검증,
MEDIUM 2 live-smoke, MEDIUM 1 best-effort+residual) → 재검증 green.

### Residual risks
- **running-server KIS→라우트 통합**: single_owner 부팅 + owner 세션으로 /api/market이 실 KIS를
  주는 경로는 각 seam(assembly·adapter contract·route-scripted·config)으로 커버했으나 한 프로세스
  end-to-end는 미실행(owner workspace == 세션 workspace 셋업 필요). ready-for-human 통합 스모크.
- **MEDIUM 1 스트리밍 캡**: Content-Length 없는 청크 응답은 미캡(base가 KIS로 pin돼 실위협 낮음).
- **위젯 브라우저 QA**: 로그인 세션에서 위젯 렌더 시각 확인 미수행(라우트 데이터 경로는 실측).
- 실시간 SSE·해외/선물·주문·휴장일 캘린더는 이월(티켓 24/25 범위).

## Verification — 실 KIS end-to-end 라이브 스모크 (2026-07-21)

위 residual의 **running-server KIS→라우트 통합**과 **위젯 브라우저 QA**를 실측 종결:
- 독립 pg(migrate) + `IDENTITY_PERSISTENCE=postgres` + `LOCAL_PROVIDER_CREDENTIAL_MODE=single_owner`
  + 실 KIS(.env.local) + `RUN_KIS_PAPER_READ_CONTRACT=true`로 dev 부팅.
- peek seam으로 이메일 로그인 자동화 → workspace id 확보 → owner 설정 후 재부팅(pg 세션 생존).
- owner 세션 `/api/market?symbol=005930` → **available, 244,000 KRW, priceBasis eod, freshness stale,
  venue KRX, asOf 2026-07-20T06:30Z(=15:30 KST 전일 마감), audience personal**(공용 유출 0).
- 실브라우저 `/workspace` 위젯 렌더 확인(스크린샷): 삼성전자 244,000·SK하이닉스(000660) 1,764,000,
  인터랙티브 조회 live. 프론트↔백엔드 일치는 위젯을 `InformationOutcome<MarketObservation>` 계약
  타입 소비로 리팩터해 컴파일러 강제(커밋 4286c77).
- 폐장 시간대라 정직하게 stale/eod. 실시간 틱은 개장(09:00 KST) 후. 개인용 잔여 = 티켓 29(휴장일)뿐.
