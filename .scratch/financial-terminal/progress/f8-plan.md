# F8 (ticket 17) 진행 — Internal Paper Trading

Owner: claude-main (Fable 5 session). Claimed 2026-07-18T01:37:47+09:00. 기준: spec §9·§6·UF-07·WS-01·SEC-01/06/09·AT-06/07, ADR A04, `docs/agents/collaboration.md`.

## Blast-radius 프레이밍

- **되돌릴 수 없는 위험**: (1) Actual/Paper 경계 붕괴 — 위조된 Actual account ID가 Paper command에 수용되거나 Paper 변화가 Actual 공개 필드를 바꾸는 것(ADR A04의 존재 이유), (2) overspend/oversell — reservation·CAS 결함으로 현금/포지션 불변식 위반, (3) 비결정적/조작 가능한 fill — synthetic·hard-expired·acceptedAt 이전 관측으로 fill 생성, slippage/volume 상한 위반, (4) exactly-once 위반 — duplicate fill/corporate action 이중 적용, late fill 이중 반영, (5) 삭제 후 재생성(SEC-09). 외부 egress 0(전부 scripted) → blast radius는 **모의 원장 무결성·경계 격리**에 집중. Live 경로는 존재 자체가 금지(스캔으로 부재 단언).
- **Prevent**: branded reference(Actual↔Paper 타입 비호환은 tsc 강제), PaperOrderIntent는 서버만 생성 가능한 opaque one-time record(브라우저 조립 불가), 세 상태축을 독립 필드로 타입화(불법 전이는 반환 타입에 부재), proposal/Live 필드 부재.
- **Contain**: Internal simulator는 in-process port·BrokerPaperExecutionPort와 journal 미공유(F9 경계), 모든 저장은 FencedKeyedStore 위(SEC-09 구조적), fill은 journal append로만 위치 변경(직접 setter 부재), scripted observation만 입력.
- **Detect**: spec 고정 literal oracle(buy 100.07/sell 99.93, volume 10%, 2:1 split 5주@$110→10주@$55), replay/forge/stale 매트릭스 side effect 0, blind test-authorship(sonnet) + **codex 반박 패널**(전역 규칙: 돈/체결 경로는 다른 계열 모델 적대 리뷰), 배치별 mutation 3~5.

## 추론 강도

- reservation CAS·simulator 산술(slippage/volume/limit)·corporate action all-old/all-new·intent one-time/epoch 재검사 = **XHigh**(체결/돈 경로). journal/erasure/three-axis 전이 = High. Blotter 표면·dev page = Medium.

## 위임 계약 (AGENTS.md 반영)

- 모든 위임 프롬프트: ① 필요한 스킬 지목+호출 지시, ② 해당 하한 규칙 인라인, ③ 모델 티어 명시(blind·기계적=sonnet, 판정·적대=메인/codex). blind는 구현·기존 테스트 미열람 격리 인라인. 검수 시 실호출 확인.

## 핵심 invariant

1. Paper command의 권한 근거는 Viewer Context뿐(SEC-01). 위조 Actual account ID·cross-workspace·stale auth epoch/revision·replay/expired intent → rejected + side effect 0. (§9/AT-07)
2. submit은 Paper Order + Paper Reservation을 한 account transaction에 만들고 CAS로 overspend/oversell 0. fill만 position을 바꾸고, 남은 reservation은 terminal 조건(filled/expired/rejected/confirmed cancellation)에서만 해제. cancel rejection은 reservation 유지, confirmed cancellation 뒤 late valid fill도 fill identity로 정확히 한 번 반영. (§9/AT-07)
3. 세 상태축(submission/execution/cancellation)은 독립 보존·조합 trace 일치. rejected/draft는 execution not_started, ack/valid fill만 open. (§9/AT-07)
4. Simulated Fill 입력은 `market event time > acceptedAt`·동일 instrument/venue/regular session·실제 Market Observation·Evidence Reference·versioned simulation-v1뿐. delayed feed는 data clock이 acceptedAt을 지난 뒤에만 평가(event time/receivedAt 모두 표시), hard-expired/unavailable/failed Evidence → fill 0. (§9)
5. simulation-v1: account/instrument/observation 활성 주문 전체 incremental volume 10% 상한, slippage 5bps+20bps×participation 최대 25bps, deterministic acceptedAt/order-identity allocation, tick/lot rounding. slippage 적용가가 limit을 불리하게 넘으면 fill 0. (§9/AT-07: buy 100.07/sell 99.93)
6. lifecycle ingestion(server-only, idempotent): 2:1 split이 open GTC 5주@$110을 10주@$55로 — order event·reservation·position·basis를 한 transaction에서 all-old/all-new, 같은 Corporate Action 재전달 no-op. dividend entitlement 동일 규율. (§9/AT-06)
7. Paper↔Actual 공개 필드 상호 불변(행동 증명 — F6 잔여 위험 완결). Paper Blotter에 Actual/Live record 0. (AT-07/ADR A04)
8. deletion fence 뒤 Paper read/command/fill/resolver/queue commit 0, module receipt coordinator 수집, backup restore suppression. (SEC-09)
9. oracle 독립성: expected value는 손으로 푼 spec literal만. production simulator/reducer를 기대값 생성에 import 0.

## Scoping 결정 기록

- **저장은 in-memory 결정론 레인**(F6/F7과 동일): PostgreSQL/Redis durable 배선은 F11/F0-owner 통합 경계. 잔여 위험으로 기록.
- **market buy의 cash reservation**: limit이 없으므로 submit 시점 유효 관측가 × (1+최대 slippage 25bps)를 tick 올림해 예약. 유효 관측 부재 시 submit 거절(overspend를 bound할 수 없으면 fail-closed).
- **PortfolioEvidenceResolver 배선**: 가격 입력은 F6/F7과 같은 scripted observation port 뒤에 둔다(계약상 자리). 실 envelope 배선은 F11 통합 경계.

## 검증 oracle

- `npm run check`(typecheck+lint+전체 테스트+seam), AT-07 literal 대조, 배치별 mutation(물리 적용→RED→복원), B4 blind(sonnet)+B5 codex 반박 패널, browser tracer(`tests/browser/f8-paper.spec.ts`)와 local command p95 350/600ms.

## 배치 (각 = 체크포인트, npm run check green 후 커밋)

- [x] **B1 contracts + journal + reservation/CAS + open/prepare/change spine** — `internal/{contracts,journal,service}.ts`. 설계 핵심: **모든 공개 수치는 journal fold의 파생값**(reservation은 open 주문에서 유도 — 예약 드리프트가 구조적으로 불가), appendCommand는 receipt trio→revision CAS→semantic decide→append 순서의 단일 동기 경로(CAS 원자성), appendSystem은 dedupe key exactly-once(fill/corporate action용). Intent는 workspace-scoped store의 one-time record(consumed/expiry/epoch/account kind·id·revision binding 전부 submit에서 재검사). market buy는 유효 관측(realtime/delayed)×(1+25bps) tick 올림으로 bound, 관측 부재 시 fail-closed refuse. 취소는 단일 entry(요청 즉시 confirm — 내부 계좌는 비동기 venue 없음, requested 중간 상태는 F9용 타입 보존), confirmed 후 재취소는 rejected 기록이되 confirmed 축 퇴행 없음(red→green으로 발견·수정). author 16 green(red-first). mutation 5/5 kill(overspend 가드·reserving 유도·intent one-time·conflict 분기·epoch binding). check 966/73 green. **정직 기록**: journal fold의 corporate action/dividend/fill 케이스를 entry 타입 정의와 함께 선작성(B2/B3 테스트 대상 — 미검증 상태로 커밋됨을 명시).
- [x] **B2 simulation-v1 simulator** — `internal/simulator.ts`. spec 공식 그대로: cap=floor(10%×volume), bps=min(25, 5+20×누적 participation), adverse tick 반올림(정수 tick 산술로 FP 노이즈 제거 — 100.07/99.93 literal 정확 일치), (acceptedAt, order id) 결정론 allocation. 유효성 게이트: eventTime>acceptedAt 엄격, data clock>acceptedAt(전 freshness 일관 적용), hard-expired/volume≤0/세션·venue·instrument 불일치 → fill 0. limit은 slippage 적용가 기준 불리 교차 시 fill 0. **관측별 durable cap 계정**(fill의 evidenceReference를 fold에서 합산)으로 redelivery가 새 주문에도 10%를 초과 배분 못 함. affordability fail-closed(market 이동·late fill의 초과 인출/매도 차단, 부분 배분 shaving 없음 — ponytail 주석). DAY expiry는 UTC 일 경계(venue-local calendar는 업그레이드 경로 주석), expiry도 dedupe exactly-once. 수수료 0을 published 가정으로 명시. author 13+1 green(red-first). mutation 6+1: cap·participation slippage·eventTime·dataClock·limit 가드·journal dedupe 계층(테스트 추가 후) 7종 kill. **정직 기록: M6(fill identity 무작위화) 생존** — durable cap 계정이 모든 도달 가능 경로에서 identity dedupe를 독립적으로 subsume(중복 방어). identity는 journal 계층 defense-in-depth로 유지하고 그 계층은 직접 테스트로 별도 kill. check 980/74 green.
- [ ] **B3 lifecycle ingestion + late/duplicate/concurrent** — `internal/lifecycle.ts`: 2:1 split all-old/all-new(주문·reservation·position·basis 한 transaction)·재전달 no-op, dividend entitlement idempotent, confirmed cancel 뒤 late valid fill exactly-once, cancel rejection reservation 유지, concurrent funds CAS.
- [ ] **B4 erasure + Paper-owned AI resolver + isolation + blind 게이트** — `internal/{paper-erasure,ai-resolver}.ts`: fence 뒤 전 저장(account/journal/order/fill/reservation/Blotter/AI·alert ref/cache/queue) 제거+restore suppression, AiMaterialResolver purpose-bound, Paper↔Actual 행동 상호 불변. blind test-authorship(sonnet, 격리)로 AT-07 반증 테스트.
- [ ] **B5 Blotter + dev page + browser/perf + codex 반박 패널 + closeout** — `internal/blotter.ts` + `src/app/f8-paper/page.tsx` + `tests/browser/f8-paper.spec.ts` + perf p95 350/600ms. codex 4축 반박 패널(intent/reservation/simulator/lifecycle) → 판정·수정 → 티켓 resolve + map 갱신.

## 진행 로그

- 2026-07-18: claim + 계획 수립.
