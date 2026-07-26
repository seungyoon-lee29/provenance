# F9 Broker Paper execution — 배치 계획 (ticket 18)

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 브로커 실행 경로 전체 (book · outbox · transport · dispatcher) 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

Owner: claude-main (Fable 5 session). Blast radius: money/order 경로 → collaboration.md 최상위 tier(blind + 다른-계열 반박 + mutation + Standards 축 code-review 1패스).

## 불변식 (spec §9/AT-08/SEC-04·05·06·10)

1. **외부 주문 ≤ 1**: client order identity당 broker accepted 최대 1 — 모든 fault/restart/retry 경로에서. blind retry 0.
2. **durable-before-send**: outbox + PendingBrokerSubmission commit 뒤에만 route call. timeout/drop은 Submission Uncertainty(`submission_unknown`) — 실패로 덮지 않음.
3. **lookup-before-retry**: 재시도는 lookup으로 상태 해소 뒤에만. provider가 lookup/idempotency horizon 미보장 → 외부 call 0으로 `submission_unknown` 유지.
4. **event durable unique**: (connection, account, order, kind, external identity, revision). 같은 revision 다른 payload → quarantine(Reconciliation Issue), 상태 변화 0.
5. **한 account transaction**: event append + reducer + reservation/cash/position + outbox — 부분 상태 관측 불가. reservation은 F8과 같이 열린 주문에서 파생(드리프트 구조적 불가).
6. **generation-first revoke**: dispatch 전 revoke commit → route call 0. dispatch 가능 뒤 → `submission_unknown`+lookup. late local commit은 commitWhileCurrent가 fence — 상태는 uncertainty로 보존되고 reconciliation만이 해소.
7. **erasure 확장**: broker outbox·PendingBrokerSubmission·provider event/quarantine·transport reference·pending queue까지 fence-first, restore suppression.
8. **Live 부재**: paper-transport registry는 submit/lookup/status/cancel 4종·paper environment만. Live operation/capability 등록 0.

## Scoping 결정

- **scripted broker network-off가 기본 완주**(§12.2). `RUN_*_PAPER_ORDER_CONTRACT=1` 실 게이트는 out of scope — not_run artifact 규약만 존중.
- **limit 주문만 v1**: broker paper의 market buy는 사전 가격 bound가 없어 reservation을 bound할 수 없음(내부 레인은 관측×1.0025로 해결했으나 broker는 관측 포트 미배선). market은 fail-closed refuse + ponytail 주석(업그레이드 경로: 관측 bound). §12.2 order smoke도 far-from-market limit만 요구.
- **저장은 in-memory 결정론 레인**(F6/F7/F8 동일): durable store 배선은 F11 통합 경계.
- F8 internal과 **journal 미공유**(티켓 17 계약): broker book은 별도 fold. `FencedKeyedStore` substrate와 §8 receipt trio 패턴은 재사용.

## 검증 oracle

- `npm run check`, 손계산 literal(seed 100,000 / 5주@$110 limit / fill 5@$109.90 → cash 99,450.50·position 5·reserved 0), 배치별 물리 mutation, B4 blind(sonnet)+B5 codex 반박 패널(다른 계열), **B5 Standards 축 code-review 1패스(신규 게이트)**, durable acceptance p95 450/700ms.

## 배치 (각 = 체크포인트, npm run check green 후 커밋)

- [x] **B1 broker contracts + book** — `broker/{contracts,book}.ts`. 설계: F8 파생-reservation 인사이트 계승(저장 안 함, reserving 주문에서 유도), 돈은 통화별 minor-unit 정수 산술(`currencyMinorUnitScale`을 internal/contracts에 canonical 신설 — 리뷰 이월 4-site 통합의 1단계, internal 마이그레이션은 B5). event durable-unique key + 같은 key 다른 payload → quarantine Map(재전달 멱등). fold 가드: over-limit fill refuse, confirmed 취소 축 terminal, late fill은 revision < cancelRevision만, late fill affordability fail-closed, oversell/overspend CAS. limit-only v1(market fail-closed refuse + ponytail 주석). author 17 green(테스트 선작성 → 구현). mutation 6/6 kill — 설계 중 M5(post-cancel revision fill) 갭을 테스트 추가로 선보완(F8 M3 계열). check 1,063/81 green.
- [x] **B2 intents + service + outbox** — `broker/{outbox,service}.ts` + book에 §8 trio `command()`/revision/`requestCancelLocal` 추가. prepare가 intent와 **stable client order identity를 함께 발급**(dispatch 전 고정), submit은 trio→CAS→act 한 transaction(intent 소비+주문+파생 reservation+outbox row+PendingBrokerSubmission — route call 전 durable). binding 재검사(consumed/expiry/account revision/connection generation)는 **trio 뒤 act 내부**(F8 설계 — 내 초안이 consumed를 trio 앞에 둬 replay가 원 receipt 대신 refuse받는 버그를 red로 발견·수정). generation-first: prepare 뒤 revoke → submit refuse `connection_revoked`, outbox/route 효과 0. cancel은 requested 축+cancel outbox row, `cancel_pending`/`cancellation_terminal` refuse. author 12 green. mutation 6/6 kill(trio·CAS·outbox commit·generation 재검사·intent 소비·pending commit). check 1,075/82 green.
- [x] **B3 paper-transport + dispatch** — `provider-connections/paper-transport/{routes,paper-order-transport}.ts` + `broker/dispatcher.ts`. 설계 스파인: **outbox 상태가 곧 안전성 증명** — `pending_dispatch`=전송 불가능 증명(재전송 안전), route call **전에** durable `dispatched` 마킹=이후는 전부 Submission Uncertainty(lookup만 허용, blind retry 0). 4-route 레지스트리(submit/lookup/status/cancel, paper env·`paper_order` capability만 — Live는 미등록이 곧 부재 증명), F0 ProviderAuthorization로만 transport 발급(assertCurrent 3중+commitWhileCurrent late-commit fence). timeout→`submission_unknown`+reservation 유지, accepted-but-lost→lookup 해소(재전송 0), not-found→horizon 보장 시에만 동일 client identity 재전송(외부 주문 여전히 1), 미보장 시 영구 unknown. revoke 선행→route call 0+로컬 rejected+reservation 해제. scripted broker는 TransportExecutor 뒤 결정론 fixture(§12.2 network-off). author 8 green. mutation 5/5 kill(dispatched 마커·horizon 게이트·uncertainty 마킹·revoke 해소·lookup 반영). check 1,083/83 green.
- [x] **B4 fault points + revoke race + 수렴 + blind 게이트** — `tests/f9-broker-faults.test.ts`(7) + 하네스 공유 추출(`f9-broker-harness.ts`, B3 테스트 재사용). 매 테스트 **새 dispatcher 인스턴스로 재시작 모델링**(durable store만으로 수렴 증명). 매트릭스: after-intent-commit→안전 재파견(전송 0 증명), after-authorize→lookup-verified retry(호출 0에서 수렴), 크래시 후 revoke→submission_unknown 영구 보존(조작된 rejected 없음)+route 0, after-broker-accept→lookup 1회 해소(재전송 0·이중 fact 0·재reconcile no-op), after-local-commit→queue ack만(외부 호출 0), late-commit fence(broker accept와 revoke 경합→로컬 ack fence·정직한 uncertainty), 수렴 후 stream 재전달 duplicate. **blind 게이트**(sonnet, tdd 실호출, 구현 미열람 — grep로 export 타입명만 조회 편차 보고됨·오염 불가 판정): 28 tests. **후보 버그 2건 모두 기각** — "reconcile이 blind retry" 주장은 측정 기준선 오류(크래시 **이전** submitCalls=0 캡처 → after-broker-accept fault는 정의상 원본 dispatch의 정당한 1회 송신 **후** 크래시). 실측 제출: 크래시 시점 1→reconcile 후 1+lookup 1. 판정문 주석 공개+기준선을 크래시 경계로 수정, 28/28 green. tsc 제네릭 스왑 2건 기계 수정(단언 무변경).
- [x] **B5 erasure 확장 + Live 부재 + perf + codex 패널(4축) + Standards 리뷰 + closeout** — erasure: `broker/broker-erasure.ts`(book·outbox·pending·intents를 F8 `PaperTradingErasure` participant에 등록, 한 fence·module receipt·restore suppression) + `f9-broker-erasure.test.ts`(3). Live 부재: `f9-live-absence.test.ts`(3 — 4-route paper-only registry, live-env authorization은 executor 0, src/app에 live 표면 부재). perf: `f9-broker-performance.test.ts`(durable acceptance p95 450/700ms, 2,000주문). **codex 반박 패널 4축(다른 계열, 병렬 실행 반례)**:
  - **dispatch**: ①동시 dispatch+reconcile→submit 2회(마커 비-CAS) ②터미널 outbox 재개방 — 인정, dispatched 마커를 authorize 전 CAS claim화(패자 not_pending)+`acknowledged`/`closed` terminal 불변. 4 방어(stale lookup·4 fault·double reconcile·cancel race).
  - **money**: ①취소-후 late fill로 reserved>held(sell affordability 비대칭) ②externalIdentity permutation 재적용 ③float limit 교차 ④1e308 비유한 잔고 ⑤교차통화 basis 오염 — **5건 인정**: sell을 buy와 대칭(reserved-by-others 제외)로, (order,kind,revision) 2차 identity는 quarantine, limit/price는 submit·fold에서 tick 정렬+safe-integer 경계 강제, 교차통화 fill refuse. 방어: 정확 replay/divergence·rejection 후 late fill·confirmed terminal.
  - **erasure**: ⑤ `provision(epoch=2)`가 fence=1 우회 — **인정**: 근본 원인은 내가 F8과 달리 per-call `atEpoch`를 공개 표면에 노출한 계약 약화. book·outbox·pending 전부 생성자 주입 `writeEpoch`(상수)로 고정, 우회 인자 자체 제거. 5 방어(mid-flight late commit·reconcile 후 erase·transport 스푸핑·헤더 주입·사후 열거).
  - **intent**: ⑧trio-후 epoch 재검사 누락 ⑨만료 `now==expiresAt` — 인정: act 진입에 epoch 재검사 추가, 만료 `>=`. ⑩강제 clientOrder 충돌은 fixture 아티팩트(실 minting 전역 유일)로 회귀 증명. 5 방어(double-submit race·conflict 누출·cross-workspace cancel·refusal 잔류·revision binding).
  - 회귀: `f9-broker-panel.test.ts`(9, red→green 각 확인, A는 fix 제거 시 RED 실증) + dispatch 2건은 `f9-broker-faults.test.ts`. 신규 6가드 mutation 전부 kill(개별 RED 확인). **사후 Standards 축 code-review 1패스**(신규 게이트) 후 closeout. check 1,136/89 green.

## 진행 로그

- 2026-07-18 15:21 KST: claim + 계획 수립.
- 2026-07-18(B5 후): **사후 Standards 축 code-review 1패스**(신규 게이트, sonnet). hard 0 / judgement 6 / suppressed 5. **6건 전부 수정**(전부 저비용, 게이트 취지대로): J1 F9 내부 `@/`↔relative import 혼용→relative 통일, J2 `currencyMinorUnitScale` 마이그레이션 완결(journal.ts·simulator.ts의 잔여 `?1:100` 삼항 제거 — F8 리뷰 이월 완료), J3 `dispatchCancel`에 dispatchSubmit과 대칭인 authorize-전 CAS claim 추가, J4 `service.canonical`→`commandPayload` 개명(book.canonical 딥소트와 동명이의 해소), J5 `connection!` 단언을 명시적 refuse 가드+주석으로 교체, J6 여분 빈 줄 제거. check 1,136/89 green 유지(J2가 F8 money 파일 접촉 — 전 F8 스위트 green 재확인).
