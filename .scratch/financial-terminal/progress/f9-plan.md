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
- [ ] **B2 intents + service + outbox**: one-time BrokerPaperOrderIntent(F8 binding 패턴), prepare/submit/cancel decide, stable client order identity, durable outbox + PendingBrokerSubmission을 book commit과 한 transaction으로.
- [ ] **B3 paper-transport + dispatch**: `provider-connections/paper-transport/` 4-route allowlist(paper env only), scripted broker fixture(TransportExecutor 뒤), authorize→assertCurrent→dispatch→commitWhileCurrent 흐름, Submission Uncertainty, lookup-before-retry, horizon 정책.
- [ ] **B4 fault points + revoke race + 수렴**: 4개 named fault point 각각에서 restart→lookup/reconciliation 수렴, revoke 선행/후행 case, crash redelivery, stream/poll duplicate end-to-end. blind 게이트.
- [ ] **B5 erasure 확장 + Live 부재 + perf + codex 패널 + Standards 리뷰 + closeout**.

## 진행 로그

- 2026-07-18 15:21 KST: claim + 계획 수립.
