# T8 — 백테스트 엔진 (InternalPaperSimulator × 과거 캔들 + 시간축 커서)

상태: **claimed** (2026-07-24). Owner: main(Fable 5). Claimed at: 2026-07-24. Last heartbeat: 2026-07-24 (S1·S2 green).

정본 문맥: pivot 메모 §6 "이후 — 엔진" T8 + §3 결정 3(캔들 only)·6(엔진 하나, 정밀도 모드)·
7(신뢰도 판정)·8(백테스트 먼저 — 결정론·CI 가능). 스케치: [design/t8-transaction-cost-model-v1.md](../design/t8-transaction-cost-model-v1.md).

## Blast radius / 검증 tier 선언 (AGENTS.md 하한 — 착수 전 필수 절)

- **Tier: 최상위** — `src/modules/paper-trading/**` 는 tier-gate guarded 경로이며, 백테스트
  결과는 사용자의 투자 판단 입력이 된다(틀린 체결·look-ahead 누출 = 그럴듯한 거짓 성과).
- **요구 게이트** (resolve 전): blind test-authorship + codex(다른 계열) 반박 패널 +
  Standards 축 1패스 + mutation 실증. 커밋 트레일러 `Tier: top (...)` — 중간 체크포인트는
  `pending`, resolve 커밋은 기록 위치 명시.
- **Contain**: 프로덕션 소비자 0(CLI 골격 전까지 조립 경로 없음), Live 경로 부재 불변식 유지,
  network-off 결정론(실 KIS 캔들 fetch는 opt-in 스크립트로 분리). blast radius 낮음 —
  그래도 tier 는 코드 경로 기준 최상위 유지.

## 목표 (pivot §2 차별점의 구현부)

같은 체결 엔진(`InternalPaperSimulator` + `PaperJournal`)이 **관측치 원천만 바꿔** 백테스트
(과거 캔들)와 실시간 모의(T11)를 구동한다. 리포트는 어느 정밀도 모드였는지 명시한다(결정 6).

## 실측 기반 설계 확인 (2026-07-24 코드 정독)

- **simulator 무변경이 성립한다** — look-ahead 의 체결 절반은 이미 엔진이 강제:
  `eventTime > acceptedAt`(simulator.ts:206) + `dataClock > acceptedAt`(:209) + DAY 만료
  (utcDay 비교). 남은 절반은 **전략이 미래 bar 를 못 보게 하는 것** — 이건 러너의 커서 소관.
- **메모리 원장 경로가 이미 예비돼 있다** — `PaperTradingDependencies.journalStore?` 주석:
  "omitted = in-memory (tests, backtest)" (service.ts:60). 백테스트 run 은 ephemeral 계산이라
  메모리가 맞고, durable(PG)은 CLI paper 세션(S2)의 몫.
- **캔들 타입 재사용** — F2 `ChartBar`(periodStart·OHLCV·priceBasis·complete,
  financial-information/chart/contracts.ts:30). 새 타입 발명 금지.
- **관측치 매핑** — bar → `PaperMarketObservation`(price=close, volume, eventTime=bar 마감,
  dataClock=eventTime, freshness=~~"stale"~~ **"realtime"** [← 정정 (S1 구현 시): 시뮬레이션
  클록 틀에서 bar 는 zero-age — 진행 절 "설계 배움" 참조], evidence=bar 유래 참조).
  acceptedAt=bar N 마감이면 bar N 관측으로는 체결 불가(strict >), bar N+1 부터 체결 —
  종가 접수·익봉 체결의 업계 관례가 엔진 불변식에서 공짜로 나온다.

## 슬라이스

- **S1 — 백테스트 러너 코어** (이번 착수): `paper-trading/backtest/` — 시간축 커서 +
  ChartBar→관측 어댑터 + 전략 seam(TS 함수, pivot §9-1) + 결정론 클록(wall clock 0).
  look-ahead 차단 oracle: 전략이 커서 밖 bar 를 봤다면 실패하는 property.
- **S2 — CLI 골격 + composition 배선**: 첫 실소비자. `PgPaperJournalStore`·erasure 실조립
  (§6 검증기록 ① 선행 조건 이행) + Stage 3 의 선행 조건(CLI 골격) 충족. --json envelope
  (T10 메모 [개선해서 차용]: stdout 순수성·성공/실패 동일 envelope).
- **S3 — 거래세 cost 모델**: design/t8-transaction-cost-model-v1.md 그대로 (D1~D5).
- **S4 — 성과 리포트 최소**: T9 연계 — calculation/ TWR·XIRR 재사용 + 체결 신뢰도 집계(결정 7).

## S1 수용 오라클

- 같은 캔들 배열 + 같은 **순수** 전략 → **바이트 동일 결과** (엔진 결정론: wall clock·랜덤 0.
  ← codex 정직화: 상태 있는 전략은 config 의 일부라 결정론 주장은 순수 전략 전제).
- 전략은 커서 시점까지의 bar 만 `view.bar()` 로 받는다 — 미래 인덱스는 RangeError.
  (← codex 정직화: **인터페이스 차단**이지 절대 보장 아님. 같은 스코프 클로저의 series 캡처는
  user-code 백테스터의 본질적 한계. CLI 는 전략이 별도 모듈이라 series 참조 부재 = 실 표면 containment.)
- 체결은 접수 bar 에서 일어나지 않는다(bar N 접수 → bar N+1 이후 체결) — 기존 simulator
  불변식 테스트로 확인.
- `complete: false` bar(미완 봉)는 체결 평가에서 제외 — 미완 봉 체결은 look-ahead 의 변종.
- 게이트: check green + 신규 테스트. blind/codex/Standards/mutation 은 S1~S2 묶음 resolve 전.

## 진행

- (착수 — 이 문서가 tier 선언 커밋)
- **S1 코어 구현** (2026-07-24): `backtest/backtest-runner.ts` — 러너는 journal 직접 append 가
  아니라 **실제 제품 seam(prepare→change)** 을 몬다. 근거: `order_submitted` 는 journal 검증에서
  `command_only` — 잔고/예약 가드가 service decide 콜백에 있어, 직접 몰면 돈 로직 중복(F8 사후
  리뷰가 잡은 드리프트 계열)이 된다. simulator·journal·service 무변경 (service 는 `presentState`
  export 한 줄만). 신규 테스트 7 green: 결정론(바이트 동일)·접수봉 무체결+익봉 체결 literal
  10,006(5bps+참여 slippage·adverse ceil)·DAY 익일 만료(일봉의 정직한 의미 — 종가 접수 DAY 는
  익봉이 다음 날이라 체결 전 만료. 일봉 전략은 GTC 를 쓸 것)·look-ahead 구조 거부(RangeError)·
  overspend refusal fact·cancel 경로·fail-closed 입력 4종.
  - **설계 배움 (freshness 프레임)**: 백테스트 관측치 라벨을 "stale"(벽시계 직관)로 했다가
    reservation bounding(`#reservationUnitPrice`: realtime|delayed only)에 거부됨 —
    시뮬레이션 클록 틀에서 bar 는 zero-age 라 **realtime 이 정직한 라벨**. 출처는
    `backtest:` evidence prefix + `mode:"approximate"` 가 명시.
  - import 관례 실측: `@/` 는 타입 전용(런타임 소거), 값 import 는 상대경로 (vitest 에 alias 없음).
  - 게이트: check 586(579+7) green · build green. blind/codex/Standards/mutation 은 S1~S2 묶음
    resolve 전 (커밋 트레일러 pending).
- **S2 CLI 골격 + composition 배선** (2026-07-24): `src/cli/{main,commands}.ts` +
  `composition/paper-assembly.ts`. **PgPaperJournalStore 첫 프로덕션 소비자** — §6 검증기록 ①
  선행 조건 이행 + Stage 3 선행 조건(CLI 골격) 충족. 명령 3종: `backtest run --series --strategy
  --seed`(러너 S1 소비, 전략은 dynamic import TS 함수), `paper open --seed --currency`(durable
  genesis-once), `paper account`(read-only — **open() 우회 필수**: open 은 provision 을 내장해
  읽기가 빈 seed genesis 를 만들어버림 → journal hydrate 직접 경로). T10 메모 차용 이행:
  --json 전 명령·성공/실패 동일 envelope·stdout 순수성(스트림 소유는 entry 만)·exit 0/1/2/3.
  - CLI workspace 는 `cli:` 네임스페이스로 web workspace 와 분리 — PaperTradingErasure 의 web
    코디네이터 배선은 **의도적 유예**(Stage 3 에서 잘릴 표면에 배선하지 않음, SEC-09 구멍 없음
    은 네임스페이스 분리가 근거. 계정 lifecycle 을 소유할 CLI 쪽 erasure 는 T11).
  - 실표면 QA: `npm run cli -- backtest run … --json | python json.load` 파이프 무결(fill 1·
    cash 899,940·exit 0), usage 오류 envelope+exit 1, human 오류는 stderr. `paper account` 는
    로컬 DB 인증 실패를 api envelope+exit 2 로 정확 분류(크래시·비밀 누출 0).
  - service.ts 변경 두 줄: `presentState`(S1)·`defaultPaperAccount` export — 파생 로직 중복 방지.
  - 게이트: check 593(+CLI 핸들러 7) green · build green. durable happy path 는 pg 레인
    (`paper-cli.pg.test.ts`: genesis-once·재-open 원본 보존·fresh 조립 재읽기) — compose 환경에서 실행.
  - **S2 잔여**: pg 레인 실행은 compose 기동 환경 필요(로컬 스모크는 인증 실패 — 컴포즈 미기동
    상태였음). packaged bin/npm-publish 형태는 Stage 3 릴리스 재정의 때.

## 게이트 (tier top — S1~S2 묶음, 2026-07-24 진행 중)

- **Standards 축 1패스 완료** (code-review 스킬, 메인 tier 에이전트). 하드 위반 0. triage:
  | 지적 | 판정 | 조치 |
  |---|---|---|
  | 티켓 "ChartBar 재사용·새 타입 금지" vs `BacktestBar` 발명 | **정정 기록** | ← 정정: 모듈 경계상 paper-trading 이 자기 관측 타입을 소유하는 저장소 패턴(PaperMarketObservation 선례)을 따랐고, 구조적 부분집합이라 ChartBar 값이 그대로 대입 가능 — "재사용"의 실체는 구조 호환. 발명이 아니라 경계 준수가 우선했다 |
  | `--seed` 가 RNG seed 로 오독 가능 (에이전트 CLI 에서 실질 리스크) | **수정 확정** | `--cash` 로 개명 (blind 완료 후 — blind 계약이 seed 서명 기준) |
  | catch-all 이 모든 예외를 "database unavailable"/api 로 라벨 — 서비스 버그가 인프라로 위장 | **수정 확정** | `code` 속성 있는 infra 오류만 api/2, 나머지는 crash/1 (원인 분리 관례 정합) |
  | runner 의 refusal push 3중 중복 | **수정 확정** | 소형 헬퍼 추출 |
  | policy 블록+updateId 중복 (assembly vs runner) | **기각 (기록)** | 결정론 체제가 다르다 — runner 는 커서 클록·결정론 id, assembly 는 벽시계·운영 id. 공용화는 백테스트 결정론을 운영 조립에 결합시킴. 셋째 사본 등장 시 재고 |
  | viewer 구성 중복 (runner/cli 첫 src 사본 2개) | **기각 (기록)** | SEC-01(Viewer 는 Identity 만 생성)의 의도적 예외 2곳 — 공용 synthetic-viewer 헬퍼는 web 경로 오용 표면을 만든다. 국소·명시 유지가 안전 |
  | CLI 가 service.journal 을 직접 조작 (Feature Envy) | **T11 이월** | read-only 서비스 표면은 실시간 세션 read 요구와 함께 설계 (우회 사유는 코드에 문서화됨) |
- **blind test-authorship 완료** (sonnet, 구현 미열람 — Interface Contract+SPEC 만 제공):
  `tests/t8-blind.test.ts` **13/13 pass, 발견 0**. 독립 유도 literal 이 구현과 일치 — buy 10,006·
  sell 체결가·볼륨 캡 25→10/10/5 분할·돈 보존 항등식(seed−final=Σbuy−Σsell, reserved 0)·
  look-ahead RangeError·DAY 익일 만료·CLI envelope/exit 3축. 무결성 노트: 금지 파일 열람 0,
  pivot 설계 문서로 simulation-v1 상수 교차확인(허용 — корroborate only), 일회용 프로브 스크립트로
  단언이 실값을 변별하는지 확인(vacuous pass 방지). 테스트는 표준 회귀로 보존.
  - 사후 수리 (기록): 메인이 blind 에게 준 계약이 `deps.pool` 을 `unknown` 으로 오기 → blind 스텁이
    `Pool` 캐스트 없이 작성돼 tsc 실패. **타입 캐스트만 수리**(런타임 동일·단언 무변경), 13/13 재확인.
- **codex 적대 반박 완료** (다른 계열, 백그라운드 태스크). 1차는 OpenAI 콘텐츠필터 오탐("공격"
  프레이밍)으로 턴 차단 → 검증-리뷰 언어로 재프레이밍 재기동. 판정 **REJECT: 2 BLOCKER + 5 HIGH**.
  메인이 **실코드 프로브로 전건 재현 판정** 후 triage (fileless probe, `$CLAUDE_JOB_DIR/tmp`):

  **확정 수정 (실측 재현됨 → 코드 수정)**:
  | 심각도 | 지적 | 재현 | 조치 |
  |---|---|---|---|
  | BLOCKER | 전략이 `view.orders[].fills[].quantity` 변조 → 원장 오염(cash −600·pos 100) | 프로브 재현 | runner 가 `structuredClone(presentState)` 로 view 격리 — 전략은 clone 만 만짐, 원장 불가침. `bar()` 도 clone 반환 |
  | BLOCKER→검증부재 | seed cash 미검증(−1·NaN·Infinity·sub-unit 이 balance −1·null·0 으로 fold) | 프로브 재현 | `isRepresentableCash`(양수·유한·정수 minor) 경계 검증 → `invalid_seed_cash` refuse |
  | HIGH | async/비배열 전략 결과 → `actions.length` undefined → 무주문 "성공" 리포트 | 프로브 재현 | `!Array.isArray(actions)` → `invalid_strategy_result` refuse |
  | HIGH(SEC-05) | DB 오류 메시지가 접속 URI 비밀번호 그대로 노출(`swordfish`) | 프로브 재현 | catch 를 고정 문자열 `"database unavailable"` 로 — raw error 미보간 |
  | HIGH | CLI 시리즈 스키마가 음수/소수 volume 허용(시뮬레이터 무성 skip) | — | `z.number().int().nonnegative()` |
  | HIGH | priceBasis 폐기 → adjusted close 를 raw 로 체결(무고지) | — | 시리즈 optional priceBasis, `total_return` refuse(§8 정합), 리포트에 basis 고지 |
  | Standards | refusal push 3중 중복 | — | `refusalStatus` 헬퍼 + 루프내 `pushRefusal` |
  | Standards | `--seed` 가 RNG seed 오독 | — | 플래그 `--cash` 개명(내부 param 은 `seed` 유지 — 테스트 안정) |

  **claim 정직화 (과대 주장 → 정직 서술, 코드 아닌 문서/주석)**:
  - **결정론**: "same config → byte identical" 은 **순수 전략 전제**에서만 성립(상태 있는 전략은 config 의 일부). 엔진은 결정론(클록·id·정렬). → 서술 범위 축소, 순수성 요구 문서화.
  - **look-ahead 구조 보장**: `view.bar()` 로는 차단되나, 같은 스코프 클로저가 `series.bars[cursor+1]` 를 캡처하면 우회 가능 — 이는 user-code 백테스터의 본질(Zipline/Backtrader/Lean 동일). **CLI 경로는 전략이 별도 모듈이라 series 참조 자체가 없어 우회 불가**(실제 제품 표면의 containment). periodStart=period-start 근사는 순서 보존(절대시각은 시작점 라벨) — 문서화.
  - **JSON stdout 순수성**: main.ts 는 envelope 만 쓰지만 `npm run` 배너·전략 모듈 top-level IO 가 오염 가능 → main.ts 주석에 `--silent`/직접 node 호출·전략 무부작용 규약 명시.
  - **exit code 3**: T11 credential 용 예약(현재 도달 불가) — 주석 정정.

  **기각/이월 (직접 근거 불충분 또는 범위 밖, 사유 기록)**:
  - **cli:local 삭제 경로 부재(HIGH)**: 정당한 지적이나 **범위 판정 = 이월**. cli:local 은 단일소유 로컬 행(멀티테넌트 PII 아님), 사용자가 DB 자체를 통제. web erasure 코디네이터 미배선은 SEC-09(멀티테넌트) 대상 밖. `paper erase` 명령+participant 는 T11(계정 lifecycle 소유 시점). 네임스페이스 분리는 collision 방지지 erasure 완결 주장 아님 — 서술 정직화.
  - 전략 dynamic import 신뢰 경계: 로컬 CLI 도구로서 수용(사용자 자기 코드). 문서화로 갈음.
- **mutation 실증 2건**: ① structuredClone 제거 → 격리 회귀 테스트 사망(복원 통과) ② seed 검증 제거 →
  seed 회귀 테스트 사망(복원 통과). 각 수정이 실제로 결함을 잡음을 실증.
- **회귀 테스트 6건 신규**(t8-backtest-runner +4, t8-cli-commands +2): view 격리·seed 검증·async
  거부·total_return 거부·SEC-05 무노출·volume 스키마. blind 사후수리 1건(계약 `pool:unknown` 오기
  → `Pool` 캐스트, 단언 무변경). 게이트: check 612 · build green · lint 경고 1(기존 stryker).

## 게이트 종합 판정 (S1~S2, tier top)

4개 축 전부 실행: **Standards ✅**(하드 위반 0) · **blind ✅**(13/13, 발견 0 — 독립 유도 일치) ·
**codex ✅**(REJECT → 실측 재현 4 수정 + Standards 3 + claim 3 정직화 + 이월 2) · **mutation ✅**(2건).
S1~S2 슬라이스 **게이트 통과**. 잔여: S3(거래세)·S4(리포트) — 각자 착수 시 재-게이트.
- mutation 실증: blind·codex 완료 후 (소스를 부수므로 라이브 트리 검증과 충돌)
