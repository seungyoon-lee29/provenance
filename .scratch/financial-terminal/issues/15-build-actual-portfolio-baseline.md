# 15 - F6 Actual Portfolio baseline 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 11, 12
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-17T15:37:43+09:00
Last heartbeat: 2026-07-17T16:25:24+09:00
Resolved at: 2026-07-17T16:25:24+09:00

## Objective

Opening Position과 Manual Position/Portfolio Activity를 append-only Actual Portfolio에 저장·표시하고 Paper Portfolio와 타입·저장·명령에서 격리한다.

## Owned scope

- `src/modules/actual-portfolio/baseline/**`, Actual journal/projection와 progressive PortfolioLoad.
- Actual-owned AI/Alert resolver의 baseline implementation.
- actual baseline literal fixture와 contract/browser/isolation test.
- shared contract/composition/migration/index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- `ActualPortfolio.open/change`, account별 contiguous revision, command idempotency와 superseding/reversal을 구현한다.
- Opening Position은 aggregate lot임을 표시하고 과거 transaction/tax lot/성과를 추정하지 않는다.
- Manual Position은 Broker Position을 덮어쓰지 않고 source/account provenance와 completeness를 유지한다.
- PortfolioLoad initial/update는 auth/scope/request/section/account/Evidence/policy revision과 resume cursor로 stale paint를 막는다.
- incomplete price/FX/position은 known subtotal과 missing list만 표시하고 total·비중·proposal value를 만들지 않는다.
- ActualPortfolio administrative erasure receipt는 account/journal/projection, source reference, personalized cache, export, outbox/queue와 derived section을 fence 뒤 제거하고 backup restore suppression을 유지한다.

## Interface contract

- Actual branded account/journal/repository는 Paper type과 범용 mode interface를 공유하지 않는다.
- price/FX는 `PortfolioEvidenceResolver`, AI/alert는 Actual-owned purpose-bound resolver만 사용한다.
- F7이 public interface를 변경하지 않고 calculation/journal을 확장하고 F10이 read-only broker sync를 주입한다.

## Acceptance criteria

- Opening Position 저장 후 reload에서 source/as-of/account를 유지하고 과거 수익·tax lot 표시가 0이다.
- same/same receipt, same/different conflict, stale revision, cross-workspace와 stale auth epoch에서 side effect 0이다.
- Paper 변화 뒤 Actual 모든 공개 필드가 불변이고 Actual 변화 뒤 Paper cash/position이 불변이다.
- incomplete fixture에서 전체 total/value/weight/proposal이 unavailable이고 알려진 subtotal은 누락 목록과 함께 표시된다.
- deletion fence 뒤 Actual read/update, resolver, queue/outbox commit과 cache hit가 0이고 module receipt가 coordinator에 durable하게 수집된다. late projection과 backup restore는 account/journal을 다시 만들지 않는다.
- Actual initial projection p95 450/800 ms와 update ordering/resume test를 통과한다.

## Out of scope

- TWR/XIRR/FX/P&L/corporate action 계산(F7), Broker Sync(F10), Paper command.
- 외부 provider gate 없음; scripted price/FX port만 사용한다.

## Traceability

- [승인 spec](../spec.md) `UF-06`, §6, §8, F6, `SEC-01/06/09`, `AT-06` baseline, `AT-07` isolation; ADR `A04`.

## Answer

F6 Actual Portfolio baseline을 scripted lane에서 완주했다. append-only journal(contiguous revision, §8 idempotency 3분기, superseding/reversal은 추가만·교정 체인 선형)이 spine이고, effective projection이 교정을 해소하며(교정의 reverse는 원본 복원), completeness 표현은 승격 금지를 타입으로 강제한다(total·비중은 complete variant에만, partial은 known subtotal+누락 목록, FX 결측 시 원통화 값 유지). `ActualPortfolio.open/change`는 Viewer Context만 권한 근거로(SEC-01: command에 workspace 필드 부재, 계좌 소유권은 journal 최초 기록 고정, guest/stale epoch/cross-workspace denied·side effect 0), initial은 정규화 journal 상태만 대기하고 refresh는 emit 직전 epoch 재검사+§8 메타 전세트를 가진다. SEC-09 erasure participant는 실제 IdentityService coordinator(fence-first)에서 journal 전체(receipt·소유권 포함)를 한 fence로 shred하고 재생성 0을 유지한다. 배치 기록: `progress/f6-plan.md` B1~B5.

## Changed files

- `src/modules/actual-portfolio/baseline/`: contracts, journal, projection, valuation, portfolio-load, actual-erasure.
- `src/app/f6-portfolio/page.tsx` (dev-only synthetic 표면).
- tests: `f6-actual-journal`, `f6-actual-projection`, `f6-portfolio-load`, `f6-actual-erasure`, `f6-actual-paper-isolation`, `f6-baseline-acceptance`(blind 37), `f6-portfolio-performance`, `tests/browser/f6-portfolio.spec.ts`.
- 커밋 체인: b3b28f5(B1)→5f598f8(B2)→ae329a9(B3)→d1dd0af(B4)→813bdfb(B5).

## Validation

- `npm run check` green: 858 tests / 66 files + seam. pre-commit 훅(typecheck+전체 테스트+secret 스캔) 매 커밋 통과.
- browser `f6-portfolio.spec.ts` 10/10(desktop 1366+mobile 360): no-promotion DOM 증명(partial에 total 요소 0개), aggregate lot 기준일 이름 표시, superseded 수량 반영.
- perf: initial projection p95 450/800ms(500-entry journal) green.
- AC 대조: same/same receipt·same/different conflict·stale revision·cross-workspace·stale epoch 전부 side effect 0(author+blind). 100 동시 동일 append → row 1·전 결과 원 receipt(실측). deletion fence 뒤 read/update/resolve 0·late projection/backup restore 재생성 0·receipt=coordinator 공개 fence. incomplete fixture에서 total/비중/proposal 부재+known subtotal+누락 목록.
- mutation 누적: B1 5, B2 5, B3 5, B4 3(+blind 단독 3) 전부 kill.

## Review

- blind test-authorship(별도 Sonnet, 구현·기존 테스트 미열람, 공개 경로 import 검증): 37 tests. 후보 버그 2건 보고 → 판정 결과 둘 다 구현 무결: ① FX 전부 결측 경계는 내 계약 문구 자기모순(구현 경계가 0원 소계 오표시를 막는 안전한 쪽, 원통화 값은 unavailable에서도 유지), ② "100 append가 revision 1~100" 주장은 실측 반박(전 결과 원 receipt·row 1, 그들 단언이 replay receipt의 status를 오집계). 단언 2곳 판정 수정 공개(f6-plan B4).
- 자가 발견 결함 1건: 계좌 소유권을 서비스 인스턴스에 뒀다가 동일 journal의 복수 서비스 불일치 → journal(원장) 속성으로 이전+erasure 포함.

## Residual risks

- AT-07 행동적 상호 불변 미완: PaperTrading(ticket 17) 부재로 "Paper 변화 뒤 Actual 불변"은 구조적 격리(브랜드 비호환 tsc 강제+저장소 분리+paper import 부재 스캔)까지만 증명. 행동 증명은 17에서 완성해야 한다.
- in-memory 저장: PostgreSQL/Redis durable store·마이그레이션은 후속(F0/main owner 통합 경계). journal receipt·소유권도 프로세스 수명.
- PortfolioEvidenceResolver 실배선 미완: 가격/FX는 scripted port. FinancialInformation의 실 envelope 배선은 F7 계산 도입 시.
- coordinator 실등록: ActualPortfolioErasure를 composition의 IdentityService participants 배열에 등록하는 것은 composition 통합 시(현재는 통합 테스트로 계약 증명).
