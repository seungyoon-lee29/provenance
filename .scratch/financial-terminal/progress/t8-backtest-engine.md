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

- 같은 캔들 배열 + 같은 전략 → **바이트 동일 결과** (결정론: wall clock·랜덤 0).
- 전략은 커서 시점까지의 bar 만 받는다 — 미래 bar 접근이 컴파일/런타임에서 불가능한 형태
  (배열 슬라이스 전달이 아니라 구조적으로).
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
