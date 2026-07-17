# 16 - F7 포트폴리오 회계 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 15
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-17T23:04:53+09:00
Last heartbeat: 2026-07-18T01:25:00+09:00
Resolved at: 2026-07-18T01:25:00+09:00

## Objective

Actual Portfolio의 Performance Coverage 안에서 TWR, XIRR, FX Contribution, Portfolio P&L, transfer·배당·기업행동과 리밸런싱 제안을 literal oracle로 구현한다.

## Owned scope

- `src/modules/actual-portfolio/calculation/**`, `journal/**` 확장과 projection 내부 계산.
- portfolio accounting literal JSON/CSV, property/fault test.
- F6 public interface, shared contract/composition/migration/index는 read-only이며 변경은 main owner에게 요청한다.

## Requirements

- external cash flow를 제거한 Portfolio Return과 cash-flow timing을 반영한 Personal Return을 coverage 안에서만 계산한다.
- security+cash FX, 가격 성과·FX·interaction을 중복 없이 Reporting Currency P&L에 reconcile한다.
- Source/Analytic Cost Basis, dividend entitlement, transfer와 Corporate Action Adjustment를 append-only로 반영한다.
- Price Basis 중복 수익, incomplete merger/spin-off/delisting과 scope membership change를 fail closed한다.
- Target Allocation/Exposure Guardrail은 configured일 때만 평가하고 Rebalancing Proposal을 주문으로 전송하지 않는다.

## Interface contract

- `PortfolioEvidenceResolver`의 typed price/FX/dividend/corporate-action input만 사용하고 raw Evidence/provider payload를 읽지 않는다.
- F6 Actual public contract와 journal sequence를 유지하며 PaperTrading/NotificationCenter를 역호출하지 않는다.
- production 계산기/reducer를 expected-value 생성기에 import하지 않는다.

## Acceptance criteria

- TWR 21%, XIRR 10%와 multi-root unavailable, FX 10%+20%+2%=32%, gross 20-fee2-tax1=17 literal fixture가 일치한다.
- 2:1 split raw/restated 동등성, total-return basis 거절, transfer·dividend·corporate action exactly-once/all-old-all-new를 검증한다.
- incomplete coverage/basis/delisting은 value가 없고 scope add/remove/disconnect는 기존 series에 조용히 연결되지 않는다.
- target 없음은 `not_configured`, incomplete total은 proposal unavailable, guardrail만으로 주문 0, Actual→Paper 자동 변환 method 0이다.

## Out of scope

- Broker Sync, Paper simulator와 세무 신고용 tax-lot 산출.
- 모든 oracle은 network-off literal fixture이며 실제 provider가 필요하지 않다.

## Traceability

- [승인 spec](../spec.md) §8, F7, `AT-05/06`, `SEC-06/09`; `T04/T05`, ADR `A04`.

## Answer

F7 포트폴리오 회계를 scripted lane에서 완주했다. 모든 값은 coverage-typed(covered variant에만 숫자 존재)이고 coverage 밖·근거 결측·모호한 입력은 이유 있는 unavailable로 fail-closed다. Portfolio Return은 pre-flow 평가 관례의 TWR(외부 flow 효과 제거— 21% literal을 예입·인출 두 변형으로 증명), Personal Return은 유일해 XIRR(일반화 Descartes 부호 변화 1회 + bisection; 다중해는 근을 골라주지 않고 no_unique_solution — 20%/30% 및 bracket 인접 50%/1,000% 두 fixture), Reporting Currency P&L은 행별 price/fx/interaction 대수 항등 분해(32% literal, gross20−fee2−tax1=17, 소거 회피 형태임을 적대 패널 판정에서 실측 입증). F7 소유 append-only 회계 원장(배당·transfer·corporate action)은 §8 receipt trio+선형 교정 체인+SEC-09 fence-first이고, 2:1 split raw/restated 정확 동등·total_return_adjusted 거절·불완전 merger/상폐 fail-closed·scope membership 변경은 결합 수익률이 타입에 없는 scope_break·rebalancing proposal은 주문 경로가 구조적으로 부재다. 배치 기록: progress/f7-plan.md B1~B5.

## Changed files

- src/modules/actual-portfolio/calculation/: contracts, performance, personal-return, reporting-pnl, corporate-actions, transfers, rebalancing.
- src/modules/actual-portfolio/journal/: contracts, accounting-journal.
- tests: f7-performance, f7-personal-return, f7-reporting-pnl, f7-accounting-journal, f7-rebalancing, f7-acceptance(blind 38).
- 커밋 체인: B1 TWR → B2 XIRR → B3 P&L → B4 원장/CA/transfer → B5 rebalancing + blind + 판정 fix 2건.

## Validation

- npm run check green: 950 tests / 71 files + seam, pre-commit 훅 매 커밋 통과.
- AT-05: TWR 21%·XIRR 10%·다중해 unavailable·FX 10+20+2=32%·gross20−fee2−tax1=17 전부 literal 일치(author+blind 이중).
- AT-06: 2:1 split raw/restated 동등·total_return 거절·exactly-once(원장 replay=원 receipt·교정 replay 회귀 포함)·불완전 basis/상폐 unavailable·scope break 무단 연결 불가·not_configured/incomplete proposal unavailable/주문 경로 0.
- mutation 누적: B1 4, B2 4, B3 4, B4 6, B5 4 + blind-단독 3 + 판정 가드 2 = 27/27 kill(전부 물리 적용→RED→복원).

## Review

- blind test-authorship(sonnet, 새 위임 계약: tdd 스킬 지목·실호출 검증·하한 인라인): 38 tests green, 후보 버그 0. blindness 실측 — 임포트 공개 경로만·src 미열람(단 ls tests/ 파일명 목록 1회 기록, 내용 오염 불가). 판정 수정 1건 공개(ReadonlySet shim→Set, 단언 무변경).
- Workflow codex 적대 반박 패널 4축(다른 계열 모델, 전역 규칙 준수): 반박 5건 중 4건 실버그 인정·수정(타임스탬프 정규화, 음수 종가, XIRR NaN, 교정 체인 이중 계상) + 1건 실측 기각(P&L 분해가 참값과 오차 0, 반박 기준선이 소거 오류). 상세 f7-plan B5.
- 자가 발견 실버그 1건: 교정 replay가 unscoped receipt 조회로 already_corrected 오반환 + 교차 계정 replacement 가드 부재 → 수정+회귀 2 tests.

## Residual risks

- PortfolioEvidenceResolver 실배선 미완: 입력은 typed 값(scripted). FinancialInformation 실 envelope 배선은 F11 통합에서.
- 원장 편집 한계(안전-측): superseding 취소(reverse) 후 원본을 다시 교정할 수 없음 — 새 이벤트 append+reverse로 우회. 이중 계상은 불가능(가드), UX 제약만.
- P&L 분해는 fp에서 참값 대비 우월하나 극한 규모(1e15+)에서 표시 반올림 정책은 F11 표면 몫.
- perf 예산: 이 티켓 AC에 수치 예산 없음 — F11 통합 게이트에서 §11 예산으로 검증.
