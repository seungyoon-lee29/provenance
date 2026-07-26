# F7 (ticket 16) 진행 — 포트폴리오 회계

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 AccountingJournal 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

Owner: main-agent. Claimed 2026-07-17T23:04:53+09:00. 기준: spec §8·AT-05/06·SEC-06/09·ADR A04, `docs/agents/collaboration.md`.

## Blast-radius 프레이밍
- **되돌릴 수 없는 위험**: (1) 잘못된 재무 수치 표시(TWR/XIRR/FX/P&L 오산 → 사용자 투자 판단 오도 — 이 티켓의 핵심 리스크), (2) 중복 수익 계상(Price Basis 이중 반영, corporate action 이중 적용), (3) coverage 밖 값 생성(추정 금지 위반), (4) Rebalancing Proposal이 주문 경로에 닿는 것. 외부 egress 없음(전 oracle network-off literal fixture) → blast radius는 **표시 정확성**에 집중.
- **Prevent**: coverage-typed 결과(값은 covered variant에만 존재 — F6 completeness 패턴 계승), `total_return_adjusted` basis 거절, proposal 타입에 주문 필드 자체 부재, Actual→Paper 변환 method 부재.
- **Contain**: 계산은 F6 journal/projection 위의 순수 함수(F6 public interface read-only — baseline/** 무수정). F7 소유 회계 이벤트(배당·transfer·corporate action)는 `journal/`의 **별도 append-only 원장**(FencedKeyedStore 재사용, SEC-09 fence 계승).
- **Detect**: spec 고정 literal oracle(TWR 21%, XIRR 10%, FX 10+20+2=32%, gross20-fee2-tax1=17, 2:1 split 동등성), **oracle 독립성**(production 계산기를 expected-value 생성기에 import 금지 — 티켓 명시), blind test-authorship + **Workflow 적대 반박 패널**(사용자 승인 2026-07-17: 구현은 직렬 유지, 게이트만 workflow — finding당 반박 검증자, 동시 팬아웃 ≤4~6, 기계적 스테이지 sonnet 명시).

## 추론 강도
- TWR/XIRR/FX·P&L reconciliation 엔진 = **XHigh**(돈 산술). transfer/dividend/corporate action exactly-once = **XHigh**. coverage/scope 경계·proposal guardrail = High. fixture 배선 = Medium.

## 위임 계약 (AGENTS.md 402ebc9 반영)
- 모든 위임 프롬프트: ① 필요한 스킬 지목+호출 지시, ② 해당 하한 규칙 인라인, ③ 모델 티어 명시. blind는 격리 제약 인라인 유지. 검수 시 실제 스킬 호출 여부를 subagents/agent-*.jsonl에서 확인.

## 핵심 invariant
1. Portfolio Return = TWR(외부 cash flow 효과 제거), Personal Return = 유일해 XIRR(cash-flow timing 반영). Performance Coverage 밖·flow 시점 평가액 결측·다중해/무해 XIRR → **값 없음**(unavailable, 부분값·추정 0). (§8/AT-05)
2. Reporting Currency P&L은 가격 성과·FX·interaction으로 분해되고 성분 합 = 총 P&L (중복·누락 0). security+cash 모두 포함. (AT-05)
3. Source/Analytic Cost Basis 구분 보존, fee/tax 포함 여부 원천대로. raw Price Basis와 Corporate Action Adjustment는 **정확히 한 번** 반영. `total_return_adjusted` basis는 P&L 입력에서 거절. (§8/AT-06)
4. 배당·transfer·corporate action은 F7 회계 원장에 append-only, exactly-once, all-old/all-new. Portfolio Transfer는 scope 안 = 외부 flow 아님, scope 경계 현물 = evidence-based fair value 있을 때만 return용 flow. (§8)
5. 2:1 split의 raw/restated series는 동일 결과. 불완전 merger/spin-off basis·상장폐지 후 price 결측 → basis/coverage/valuation unavailable (fail closed). (AT-06)
6. scope membership 변경(add/remove/disconnect)은 기존 series에 조용히 연결되지 않고 scope-change break/새 series. (§8/AT-06)
7. Target Allocation/Exposure Guardrail은 configured일 때만 평가(`not_configured` 구분), incomplete total → proposal unavailable, proposal → 주문 전송 경로 0, Actual→Paper 자동 변환 method 0. (AT-06)
8. oracle 독립성: expected value는 손으로 푼 spec literal만. production 계산기/reducer를 기대값 생성에 import 0.

## 검증 oracle
- `npm run check`, AT-05/06 literal fixture 대조, mutation(배치별 3~5, 물리 적용→RED→복원), B5에서 blind + Workflow 반박 패널.
- 브라우저/perf 게이트는 이 티켓 AC에 없음(계산 fixture 동등성만) — 표면 mount는 F11(ticket 20) 통합에서.

## 배치 (각 = 체크포인트, npm run check green 후 다음)
- [x] **B1 calculation contracts + Performance Coverage + TWR** — `calculation/{contracts,performance}.ts`: coverage-typed `PortfolioReturnResult`(값은 covered variant에만), 외부 flow 시점 분할·pre-flow 평가 관례·기하 연결. fail-closed: flow 시점 평가액 결측·경계 결측·base ≤0·window 밖 flow·혼합 통화 → 이유 있는 unavailable(보간 0). literal oracle(손으로 푼 값): 1,000→1,100·+900→2,000→2,200 ⇒ 21%, 인출(−600) 변형도 21%(flow 효과 제거 증명), 동시각 flow 합산. author 9 green(red-first). mutation 4/4 kill(base가 flow 누락 4f·보간 허용 1f·산술 합산 3f·flow 부호 무시 2f — 물리 적용→RED→복원, untracked 파일이라 git checkout 불가 → scratchpad 백업 방식 사용). check green.
- [x] **B2 XIRR(Personal Return)** — `calculation/personal-return.ts`: 유일해 판별을 일반화 다항 Descartes 규칙으로(시간순 합산 flow의 부호 변화 1회 = 유일근 보장 + 경계 극한으로 존재 보장), bisection(결정론). 부호 변화 >1 → **no_unique_solution**(근을 하나 골라주지 않음), 0회 → no_sign_change, <2 flow → insufficient, 혼합 통화 거절. literal(손 계산): −1,000/+1,100@1y ⇒ 정확히 10%, 같은 금액 2y ⇒ √1.1−1(타이밍 민감 = Personal), 손실 −10%, 동시각 분할 합산. 다중해 fixture 2종: (20%·30% — bracket 밖)과 **(50%·1,000% — 첫 근이 bracket 안)** — 후자는 mutation 설계 중 "guard 제거 변이가 bracket 실패로 우연 생존"을 발견하고 방어를 조이려 추가. author 9 green(red-first). mutation 4/4 kill(guard 제거 — 신규 fixture가 잡음·타이밍 무시·bisection 생략·동시각 덮어쓰기). check green.
- [x] **B3 Reporting Currency P&L + FX 분해** — `calculation/reporting-pnl.ts`: 행별 price=(N₁−N₀)F₀ / fx=N₀(F₁−F₀) / interaction=(N₁−N₀)(F₁−F₀) — 합이 N₁F₁−N₀F₀와 **대수 항등**(근사 아님)이라 중복·누락이 구조적으로 0. security+cash 동일 항등(현금 flat → fx-only). fx 필드는 외화 행 필수·보고통화 행 금지(이중 환산 타입 가드). literal(손 계산): 50→55 USD·FX 10→12 ⇒ 50/100/10=160, 수익률 10%+20%+2%=32%; gross 20−fee 2−tax 1=17; 혼합 3행 reconciliation 230. fail-closed: fx 결측(가정환율 0)·보고통화 행에 fx·base≤0·요금 통화 불일치/음수. author 8 green. **정직 기록: 테스트 선작성은 지켰으나 구현 전 RED 실행을 생략**(B1/B2와 동일한 module-missing red 구조라 생략했지만 규율 위반은 위반 — B4부터 복원). mutation 4/4 kill(interaction 탈락·price에 end FX(이중 계상)·tax 부호 반전·fx 가드 제거). check green.
- [x] **B4 회계 원장 확장(F7 소유)** — `journal/{contracts,accounting-journal}.ts` + `calculation/{corporate-actions,transfers}.ts`. AccountingJournal(배당·transfer·corporate action record): §8 receipt trio(원 receipt 재반환/다른 payload conflict)·교정 체인 선형(supersede/reverse 추가만, 원 row 잔존)·FencedKeyedStore 3층(entries/receipts/sequences)로 SEC-09 fence-first(late append suppressed). **scoping 결정 기록**: expectedRevision CAS는 미포함(회계 이벤트는 사용자 상호작용 command가 아니고 §8 trio의 CAS 분기는 F6 command 경로가 이미 증명 — 필요해지면 F11 배선에서). corporate-actions: PriceBasis 3종 — total_return_adjusted는 P&L 입력 거절(배당 이중 계상 방지), raw는 split을 정확히 한 번(중복 actionReference 거절), split_restated는 무적용 → **raw+조정 == restated 정확 일치**(2:1 literal: 10,000→5,000, 수량 factor 2/1, 가치 연속 10×10,000=20×5,000), merger/spin-off basisAllocation 결측·상폐 후 가격 존재 → fail-closed. transfers: scope 내 = 외부 flow 0, 경계 현물은 evidence fair value 있을 때만 signed flow(결측 → unavailable). computeScopeAwareReturn: 막간 membership 변경 → **scope_break variant(결합 수익률 필드 타입 부재)** + 세그먼트별 결과, break 시각과 정확히 겹치는 flow는 조용한 배정 대신 unavailable. author 15 green(red-first — RED 실행 복원). mutation 6/6 kill(replay 이중 적용·체인 비선형·restated 이중 조정·total_return 수용·internal 미인식·break 무단 연결). check 899/68 green.
- [x] **B5 proposal/guardrail + 게이트 + closeout** — `calculation/rebalancing.ts`: target 부재 not_configured, complete 외 completeness → incomplete_total(known subtotal 승격 0), weights 합≠1 invalid_target(재정규화 안 함), guardrail은 configured일 때만, proposal은 순수 데이터(주문/submit/paper 키·함수 부재를 deep-scan으로 단언). literal: 60/40 → 50/40/10 target ⇒ delta −100k/0/+100k(합 0). author 6 green(red-first), mutation 4/4 kill. **blind 게이트**(sonnet, 새 위임 계약: tdd 스킬 지목 — 실호출 검증됨, 하한 인라인, 모델 명시): 38 tests 전부 green, 후보 버그 0. blindness 실측: 임포트 공개 경로만, src 읽기 0 — 단 `ls tests/`로 파일명 목록 열람 1회(내용 미열람, 기대값 오염 불가) 기록. blind-단독 mutation 3/3 kill. 판정 수정 1건 공개: 런타임 `ReadonlySet` shim이 tsc strict 거부 → Set 교체(단언 무변경). **자가 발견 실버그**(패널 준비 중): 교정 replay가 unscoped receipt 키 조회 → 원 receipt 대신 already_corrected 반환(exactly-once 위반) + 교차 계정 replacement 주입 가드 부재 → 수정 + 회귀 2 tests. check 945/71 green. **Workflow codex 반박 패널 4축(twr/xirr/pnl/ledger)** — 다른 계열 모델(codex) 4 refuters 병렬, 구조화 findings. 반박 성공 주장 5건 판정: ④건 실버그 인정+수정 — (1) ISO 정밀도 혼합 같은 시각이 문자열 키로 갈라져 경계 flow가 창 가드를 우회(phantom sub-period) → 전 시각 Date.parse 정규화+invalid_timestamp fail-closed, (2) 음수 종가가 covered −110%로 → end ≤0 가드, (3) XIRR 'not-a-date'가 NaN 연쇄로 +10% 수익을 covered −99.99%로 → invalid_timestamp fail-closed, (4) 원장 깊이-2 교정 체인(A→sup B→sup C)에서 parity가 원본 부활 → 배당 이중 계상 → superseding은 base event만 target(교정의 교정은 reverse로만) + 회귀 테스트. ①건 **실측 기각** — P&L 소거 오차 주장: 분해값이 실수 참값과 오차 0(tsx 실측), 반박자 기준선(직접 fp 뺄셈 2.25)이 소거로 0.028 틀림 — 분해가 수치적으로 우월한 형태임을 역으로 입증. transfers의 동일 계열 문자열 비교도 선제 정규화. 판정 회귀 5 tests, 신규 가드 mutation 2/2 kill. check 950/71 green. → closeout.

## 진행 로그
- 2026-07-17: claim + 계획 수립.
