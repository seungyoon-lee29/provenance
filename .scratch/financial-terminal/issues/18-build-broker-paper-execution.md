# 18 - F9 Broker Paper execution 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 17
Blocked by: None
Owner: claude-main (Fable 5 session)
Claimed at: 2026-07-18T15:21:02+09:00
Last heartbeat: 2026-07-18T16:29:38+09:00
Resolved at: 2026-07-18T16:29:38+09:00

## Objective

Broker Paper Account 주문을 paper-only AuthorizedTransport, durable outbox와 lookup-before-retry 경계로 실행해 timeout/revoke/crash에서도 외부 주문 최대 하나로 수렴시킨다.

## Owned scope

- `src/modules/paper-trading/broker/**`, `src/modules/provider-connections/paper-transport/**`.
- BrokerPaperExecutionPort adapter, outbox/reconciliation worker와 broker-paper fault fixture.
- ProviderConnections core와 shared contract/composition/migration/index는 read-only다.

## Requirements

- stable client order identity, prepare binding, paper environment와 submit/lookup/status/cancel route allowlist를 강제한다.
- send 전에 durable outbox와 PendingBrokerSubmission을 commit하고 Submission Uncertainty를 실패로 덮지 않는다.
- provider event external identity+revision을 unique하게 저장하고 divergent payload를 quarantine한다.
- generation-first revoke, ConnectionLifecycleFence와 commit/publish 직전 authorization을 재검사한다.
- named fault point는 정확히 `after-intent-commit`, `after-broker-accept-before-local-ack`, `after-local-commit-before-queue-ack`, `after-authorize-before-route-dispatch`이며 각 restart에서 lookup/reconciliation로 수렴한다.
- PaperTrading erasure receipt를 broker outbox, PendingBrokerSubmission, provider identity/reconciliation event, transport reference와 pending queue까지 확장하고 restore suppression을 유지한다.
- Live Trading operation/capability/hostname/generated client를 등록하지 않는다.

## Interface contract

- F8 `PaperTrading` public contract, `BrokerPaperExecutionPort`, PortfolioWorkQueue와 F0 AuthorizedTransport primitive만 사용한다.
- F3 ProviderConnections core를 read-only로 소비하고 F10 read-transport subtree와 파일을 공유하지 않는다.
- external event append/reducer/reservation/cash/position/outbox는 한 transaction이다.

## Acceptance criteria

- 네 canonical named fault point에서 broker accepted 최대 1, blind retry 0이다. 특히 `after-authorize-before-route-dispatch`에서 revoke가 먼저 commit되면 route call 0, dispatch 가능 뒤면 `submission_unknown`+lookup이다.
- lookup/idempotency horizon, stream/poll duplicate, same-revision divergent payload와 crash가 deterministic fact/quarantine로 수렴한다.
- revoke 전 미전송은 외부 호출 0, 이미 dispatch 가능 case는 `submission_unknown`+lookup으로 끝나며 late commit은 fence된다.
- deletion fence 뒤 broker submit/lookup retry, outbox claim, transport resolve와 late event commit이 0이고 module receipt·backup restore suppression이 coordinator 상태에 반영된다.
- durable acceptance p95 450/700 ms이고 black-box Live route는 404/405, operation/capability registry 수 0이다.

## Out of scope

- Actual Broker Sync와 Live Trading.
- 기본 완료는 scripted broker network-off다. 실제 mutation은 정확히 `RUN_ALPACA_PAPER_ORDER_CONTRACT=1` 또는 `RUN_KIS_PAPER_ORDER_CONTRACT=1`, paper host, 최대 1 share/USD 10, lookup→cancel→cleanup이 모두 있을 때만 실행한다.

## Traceability

- [승인 spec](../spec.md) `UF-07`, §9, §12.2, F9, `SEC-04/05/06/10`, `AT-07/08/11`; ADR `A03/A04`.

## Answer

F9 Broker Paper execution을 scripted network-off 레인에서 완주했다. 설계 스파인: **outbox 상태가 곧 안전성 증명** — `pending_dispatch`는 전송이 증명상 불가능(재전송 안전), route call **전에** durable `dispatched`로 CAS claim(authorize 전 — 경쟁자는 route call 0), 그 뒤는 전부 Submission Uncertainty(lookup만, blind retry 0). broker book은 F8과 **journal 미공유** 별도 fold(통화별 minor-unit 정수 산술, reservation은 reserving 주문에서 파생 — 드리프트 구조적 불가). external event는 (connection·order·kind·externalId·revision) durable-unique + 같은 (order,kind,revision)의 2차 identity·같은 key 다른 payload는 quarantine(Reconciliation Issue), 상태 이동 0. PendingBrokerSubmission worklist + durable outbox를 book commit과 한 account transaction으로(durable-before-send). §8 trio→CAS→act 단일 경로, intent one-time binding(workspace/epoch/account revision/connection generation/expiry 전부 act 직전 재검사). generation-first revoke는 dispatch 전 commit 시 route 0+로컬 rejected, dispatch 가능 뒤엔 `submission_unknown`+lookup(commitWhileCurrent가 late commit fence). 4 named fault point(after-intent-commit / after-authorize-before-route-dispatch / after-broker-accept-before-local-ack / after-local-commit-before-queue-ack)는 새 dispatcher 재시작으로 lookup/reconciliation 수렴(외부 주문 ≤ 1). paper-transport는 4-route(submit/lookup/status/cancel, paper env·`paper_order` capability만) allowlist를 F0 ProviderAuthorization 위에 올려 Live operation/capability 등록 0. SEC-09 erasure는 book·outbox·pending·intents를 F8 `PaperTradingErasure` participant에 등록(한 fence·module receipt·restore suppression). 배치 기록: `progress/f9-plan.md` B1~B5.

## Changed files

- `src/modules/paper-trading/broker/`: contracts, book(external event fold+§8 trio command+파생 reservation), outbox(durable outbox+PendingBrokerSubmission, terminal 불변 CAS transition), service(intent/prepare/submit/cancel, epoch 재검사), dispatcher(CAS dispatch·lookup-before-retry·horizon 정책·4 fault point·reconcile), broker-erasure.
- `src/modules/provider-connections/paper-transport/`: routes(4-route allowlist), paper-order-transport(paper-only facade).
- `src/modules/paper-trading/internal/contracts.ts`(`currencyMinorUnitScale` 공유 helper 신설), `internal/{journal,simulator}.ts`(helper 마이그레이션 — F8 리뷰 이월 완결).
- tests: `f9-broker-book`(17), `f9-broker-service`(12), `f9-broker-dispatch`(8), `f9-broker-faults`(9 incl. dispatch 패널 2), `f9-broker-erasure`(3), `f9-broker-panel`(9 money/intent 패널 회귀), `f9-broker-performance`(1), `f9-live-absence`(3), `f9-blind-acceptance`(blind 28), `f9-broker-harness.ts`.
- 커밋 체인: 8775456(B1)→1cd63f8(B2)→24e1ac9(B3)→35c3541(B4)→e954790(B5)→Standards 수정.

## Validation

- `npm run check` green: 1,136 tests / 89 files + seam examples. pre-commit 훅(typecheck+전체 테스트+secret 스캔) 매 커밋 통과.
- perf: Broker Paper durable acceptance p95 450/700ms(2,000주문 §11 fixture) green.
- AC 대조: 4 fault point 각각 broker accepted ≤ 1·blind retry 0(after-authorize-before-route-dispatch에서 revoke 선행 시 route 0, 후행 시 `submission_unknown`+lookup). lookup/idempotency horizon·stream/poll duplicate·same-revision divergent payload·crash가 deterministic fact/quarantine로 수렴. revoke 전 미전송 외부 호출 0·dispatch 가능 case `submission_unknown`+lookup·late commit fence. deletion fence 뒤 broker submit/lookup/outbox/transport/late event commit 0+module receipt+restore suppression. Live route 404/405 구조적 부재(4-route paper-only registry, live-env authorization executor 0, src/app live 표면 부재).
- mutation: B1~B5 각 배치 물리 mutation(book 6·service 6·dispatcher 5·신규 패널 6가드) 전부 개별 RED 확인 kill.

## Review

- blind test-authorship(별도 sonnet, tdd 실호출, 구현 미열람 — grep로 export 타입명만): 28 tests. 후보 버그 2건 → **모두 기각**(측정 기준선을 크래시 이전에 캡처한 오류 — after-broker-accept fault는 정의상 원본 dispatch의 정당한 1회 송신 후 크래시; 실측 크래시 1→reconcile 후 1+lookup, 판정문 주석 공개).
- **codex 반박 패널 4축**(다른 계열, 병렬·실행 반례): **실버그 10건 인정·수정** — dispatch 2(마커 CAS화·terminal 불변), money 5(sell affordability 대칭·identity permutation quarantine·tick 정렬·safe-integer 경계·교차통화 refuse), erasure 1(per-call epoch 우회 표면 제거→writeEpoch 주입), intent 2(act-time epoch 재검사·만료 경계 `>=`). **기각 1**(강제 clientOrder 충돌 — fixture 아티팩트, 실 minting 전역 유일). 인정 전부 red→green 회귀(`f9-broker-panel` 9 + faults 2), 신규 가드 mutation 개별 kill. 방어 실측 다수(transport 스푸핑·헤더 주입·사후 열거·conflict 누출·double-submit race·revision binding).
- **사후 Standards 축 code-review 1패스**(신규 게이트): hard 0 / judgement 6 — 6건 전부 수정(import 통일·helper 마이그레이션 완결·cancel CAS 대칭·개명·assertion→가드·빈 줄). suppressed 5.

## Residual risks

- in-memory 저장(F6/F7/F8 동일): durable store·outbox worker 배선은 F11 통합 경계. intent·outbox·pending·fence·book 모두 프로세스 수명.
- ProviderConnections 실배선: `BrokerConnectionSnapshotPort`(generation 조회)와 paper-transport의 grant/state/header resolver는 계약상 자리(scripted). 실 vault/connection 배선은 F11.
- cancel reconciliation은 submit 전용 worklist 밖(best-effort dispatchCancel). cancel outbox의 crash 재개는 F11 worker 배선 시 pending 확장.
- composition 실등록: broker erasable stores의 IdentityService participants 배열 등록·TerminalView 배선은 F11(현재 계약 테스트로 증명).
- 실 order smoke(`RUN_*_PAPER_ORDER_CONTRACT=1`)는 out of scope — not_run artifact 규약만 존중.
- market order·multi-currency 확장은 fail-closed refuse로 상한(ponytail 주석): broker lane market buy의 관측 bound, 종목당 단일 통화 가정.
