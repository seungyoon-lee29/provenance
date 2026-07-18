# F9 Broker Paper execution — 배치 계획 (ticket 18)

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
- [ ] **B5 erasure 확장 + Live 부재 + perf + codex 패널 + Standards 리뷰 + closeout**.

## 진행 로그

- 2026-07-18 15:21 KST: claim + 계획 수립.
