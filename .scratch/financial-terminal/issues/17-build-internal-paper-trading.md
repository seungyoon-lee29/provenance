# 17 - F8 Internal Paper Trading 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 11, 12, 15
Blocked by: None
Owner: claude-main (Fable 5 session)
Claimed at: 2026-07-18T01:37:47+09:00
Last heartbeat: 2026-07-18T02:40:00+09:00
Resolved at: 2026-07-18T02:40:00+09:00

## Objective

Internal Paper Account의 Paper Order prepare→reservation→simulation-v1 Simulated Fill→Paper Blotter를 deterministic하게 완주한다.

## Owned scope

- `src/modules/paper-trading/internal/**`, simulator, Paper journal/projection와 Paper Blotter presentation.
- Paper-owned AI resolver, internal-paper literal/property/fault test.
- shared contract/composition/migration/index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- `PaperTrading.open/prepare/change`, opaque one-time PaperOrderIntent와 account/revision/auth/payload/policy/expiry binding을 구현한다.
- account별 append-only revision, idempotency, CAS reservation과 세 상태축을 분리한다.
- Simulated Fill은 acceptedAt 뒤 동일 instrument/venue/session의 실제 Market Observation과 simulation-v1 policy만 사용한다.
- limit, 10% volume participation, slippage/fee, delayed data clock과 hard-expired Evidence를 정확히 처리한다.
- server-only idempotent lifecycle ingestion은 Corporate Action Adjustment와 dividend entitlement를 적용한다. 2:1 split 정책 fixture의 open GTC `5주 @ $110`을 `10주 @ $55`로 바꾸면서 order event, Paper Reservation, position과 basis를 한 account transaction에서 all-old/all-new로 변환한다.
- Actual account ID/type/repository를 Paper command에 사용할 수 없게 한다.
- PaperTrading erasure receipt는 Internal Paper account/journal/order/fill/reservation/Blotter, AI/alert reference, cache와 pending queue를 fence 뒤 제거하고 restore suppression을 유지한다.

## Interface contract

- Internal simulator는 in-process port이고 BrokerPaperExecutionPort와 journal을 공유하지 않는다.
- price input은 `PortfolioEvidenceResolver`, AI는 Paper-owned AiMaterialResolver만 사용한다.
- F9은 기존 Paper public contract 위에 Broker Paper 전용 subtree만 추가한다.

## Acceptance criteria

- replay/cross-workspace/stale intent·revision과 forged Actual account ID는 rejected+side effect 0이다.
- volume 10%, buy 100.07/sell 99.93 slippage fixture, limit/data-clock/freshness가 deterministic하게 수렴한다.
- duplicate/cancel rejection/late fill/concurrent funds에서 reservation·cash·position invariant와 three-axis trace가 일치한다.
- 2:1 split crash point마다 GTC order/reservation/position/basis 공개 view가 all-old 또는 all-new이고 같은 Corporate Action 재전달은 no-op이다.
- fill만 position을 바꾸고 terminal 조건에서만 남은 reservation을 해제하며 Paper↔Actual 공개 필드는 상호 불변이다.
- deletion fence 뒤 Paper read/command/fill/resolver/queue commit이 0이고 module receipt와 backup restore suppression이 coordinator 상태에 반영된다.
- local command p95 350/600 ms와 Paper Blotter browser tracer를 통과한다.

## Out of scope

- Broker Paper(F9), Live Trading, short/margin/option과 실제 주문 전송.
- 외부 gate 없음; scripted Market Observation만 사용한다.

## Traceability

- [승인 spec](../spec.md) `UF-07`, `WS-01`, §9, F8, `SEC-01/06`, `AT-06/07`; ADR `A04`.

## Answer

F8 Internal Paper Trading을 scripted 레인에서 완주했다. 설계 스파인: **모든 공개 수치는 append-only journal fold의 파생값**(reservation은 open 주문에서 유도 — 드리프트 구조적 불가), 사용자 command는 §8 receipt trio→revision CAS→semantic decide의 단일 동기 경로, 시스템 이벤트(fill/expiry/corporate action)는 dedupe key exactly-once. PaperOrderIntent는 workspace-scoped one-time 서버 record(account kind·id·revision/epoch/environment/policy/expiry를 submit에서 전부 재검사). simulation-v1은 BigInt 정수 tick 산술(cap=floor(10%×vol), bps=min(25,5+20×누적 participation), 불리 방향 반올림 — buy 100.07/sell 99.93 literal 정확 일치), eventTime>acceptedAt·data clock·hard-expired 게이트. lifecycle은 2:1 split(5주@$110→10주@$55, reservation $550 불변)·dividend를 한 revision all-old/all-new + 재전달 no-op으로 적용. **journal이 돈의 유일 변경 경계라는 원칙을 검증으로 강제**(codex 패널 후속): forged/unaffordable/over-limit/시간창 밖 fill, 위조 만료, 이중 genesis, fractional split을 경계에서 refuse. SEC-09 erasure는 fence-first participant(journal+intents+AI material store, 원 receipt 보존, 백업 복원 suppressed). Paper↔Actual 행동 상호 불변을 양방향 바이트 동일성으로 증명(F6 잔여 위험 완결). Blotter는 닫힌 kind union(Actual/Live 표현 부재)으로 journal-time 순 표시, dev 표면과 브라우저 tracer로 노란 PAPER 배지·세 축·literal 검증. 배치 기록: `progress/f8-plan.md` B1~B5.

## Changed files

- `src/modules/paper-trading/internal/`: contracts, journal(+validateSystemBody 경계 검증), service, simulator, lifecycle, paper-erasure, ai-resolver, blotter.
- `src/app/f8-paper/page.tsx` (dev-only synthetic 표면).
- tests: `f8-paper-trading`(17), `f8-paper-simulator`(18), `f8-paper-lifecycle`(11), `f8-paper-erasure`(6), `f8-paper-blotter`(1), `f8-paper-performance`(1), `f8-journal-boundary`(10), `f8-blind-acceptance`(blind 31), `tests/browser/f8-paper.spec.ts`(8).
- 커밋 체인: c54f41f(B1)→ea28aad(B2)→B3→B4→B5.

## Validation

- `npm run check` green: 1,045 tests / 80 files + seam examples. pre-commit 훅(typecheck+전체 테스트+secret 스캔) 매 커밋 통과.
- browser `f8-paper.spec.ts` 8/8(desktop 1366+mobile 360): 노란 PAPER 배지 텍스트+CSS, 현금 literal(99,009.30 = 100,000−1,000.7+10), 세 축 텍스트 상태, blotter 7행 journal 순서, Actual/Live 어휘 0.
- perf: Internal Paper command p95 350/600ms(2,000주문 §11 fixture) green — 실측 수 ms.
- AC 대조: replay/cross-workspace/stale intent·revision/forged Actual ID 전부 rejected·refused·denied+side effect 0(author+blind+codex 프로브 실출력). volume 10%·buy 100.07/sell 99.93·limit/data-clock 결정론 수렴. duplicate/cancel rejection/late fill/concurrent funds에서 reservation·cash·position 불변식+세 축 trace 일치. 2:1 split all-old/all-new+재전달 no-op. fill만 position 변경·terminal에서만 reservation 해제·Paper↔Actual 상호 불변(행동 증명). deletion fence 뒤 read/command/fill/resolver commit 0+원 receipt+restore suppression.
- mutation 누적 27종: B1 5, B2 6+1, B3 5+1, B4 4, B5(경계·정밀도) 4 — 26 kill, 1 생존(fill identity 무작위화 — durable cap 계정이 전 도달 경로에서 subsume하는 중복 방어, journal dedupe 계층은 별도 직접 kill로 커버, f8-plan B2 기록).

## Review

- blind test-authorship(별도 sonnet, 구현·기존 테스트 미열람 — 타입 선언 3파일 열람은 oracle 오염 불가 판정·편차 기록): 31 tests. 후보 버그 2건 → 1건 부분 인정(이중 cancel의 applied+no-op 행 → `already_cancelled` refuse로 수정), 1건 기각(post-erasure suppressed 요구는 열거 누출 — refused가 판정 계약, 판정문 주석 공개).
- 사후 code-review v1(Standards 축, resolve 뒤 2026-07-18): hard violation 0, judgement call 7. **실버그 1건 수정** — lifecycle pre-validation이 journal의 dedupe-first 순서를 깨서 적용된 3:2 split 재전달이 no-op 대신 `fractional_result` refuse(AC "재전달 no-op" 위반; 2:1 fixture는 정수×2라 은폐). pre-validation 삭제(journal `validateSystemBody`가 전 항목 커버)+회귀 테스트. dead `payloadHash`(쓰기만, 읽기 0)+허위 doc 주석 삭제, `LifecycleOutcome` 잉여 alias 제거. check 1,046/80 green. 잔여 4건은 Residual risks로 이관.
- codex 반박 패널 4축(다른 계열 모델, 병렬·실행 반례 강제): **실버그 5건 인정·수정** — (money) journal 경계에 위조 fill 주입 시 음수 잔고 → 경계 검증 신설, (simulator a/c) epsilon 가드가 진짜 sub-tick slippage 삼킴 → BigInt 정수 산술로 교체+limit tick 정렬 강제, (simulator e) hard-expired 조기 반환이 DAY 만료 가로챔 → 만료 sweep 선행, (lifecycle a/c) split 후 stale 단가·over-limit fill 경계 수용 → limit tick 대조 추가. **기각 1건**(split 내용-해시 dedupe — reference가 동일성 정의). **방어 실측 확인**: intent 축 8 프로브 전부, 10% cap redelivery, 배분 결정론, erasure 전 경로, AI resolver 격리. 모든 인정 건은 패널 공격 그대로 회귀 테스트화(red 확인 후 수정).

## Residual risks

- in-memory 저장: PostgreSQL/Redis durable store·마이그레이션·worker 배선은 F11/F0-owner 통합 경계(F6/F7과 동일 레인). intent·receipt·fence도 프로세스 수명.
- PortfolioEvidenceResolver 실배선 미완: 가격 입력은 scripted observation port 뒤(계약상 자리 확보). FinancialInformation 실 envelope 배선은 F11 통합에서.
- 시장 캘린더 단순화(ponytail 주석으로 명시): DAY 만료는 UTC 일 경계(venue-local 세션 캘린더는 업그레이드 경로), dividend는 적용 시점 보유 기준(ex-date entitlement는 캘린더 도입 시), 수수료 0을 published 가정으로 명시.
- composition 실등록: PaperTradingErasure의 IdentityService participants 배열 등록과 TerminalView 우측 패널/WS-01 mount는 F11 통합 시(현재 dev 표면+계약 테스트로 증명). PaperTrading 공개 interface의 composition 배선도 동일.
- F9 경계: BrokerPaperExecutionPort는 미구현(스펙대로 journal 미공유 — F9은 기존 public contract 위 subtree만 추가해야 하며, journal 경계 검증이 그 안전망).
- 사후 code-review 이월(maintenance-grade, F9/F11에서 해당 파일 접촉 시): 통화→tick 매핑 4곳 2표현 → 공유 helper 1개; EPSILON 정의 산재(journal/simulator/service inline 1e-9·1e-6); `PaperJournalEntry`/`PaperEntryBody` union 이중 서술 → 한쪽에서 파생; `PaperSectionKey`의 `blotter`가 orders를 반환(presentBlotter는 dev page만 배선 — F11 composition에서 실배선 또는 키 삭제).
