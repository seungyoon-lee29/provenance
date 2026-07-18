# F10 Broker Sync — 배치 계획 (ticket 19)

Owner: claude-main. Blast radius: read-only broker projection이 current total·P&L·rebalance·Paper fill 입력을 먹임 → money-display 경로. collaboration.md 최상위 tier(blind + 다른-계열 반박 패널 + mutation + Standards 축 1패스). 단, 주문 mutation/CAS/outbox 없음(read-only) → F9보다 blast radius 작음.

## 설계 스파인

**CompleteBrokerSnapshot만이 승격 가능한 유일 진실.** 나머지(partial page·cursor reset·schema·re-auth·divergent checksum·gap)는 전부 provisional이며 `current` 포인터와 cursor를 절대 덮지 않는다. 승격은 manifest 전 component가 bounded skew·maximum lateness 안에서 완전 paging + checksum 일치일 때만 원자적으로 일어난다.

- **lineage**: `ExternalAccountIdentity + verifiedFingerprint + ProviderDataEpoch` 삼중키가 event dedupe namespace를 scoping. 삼중 일치 retained reconnect만 namespace를 잇고, ledger reset·다른 fingerprint/epoch·삭제 후 provider ID 재사용은 새 lineage(구 event 미승계).
- **event durable-unique**: `(connection, account, event, kind, externalIdentity, revision)` — 같은 key 다른 payload → quarantine(Reconciliation Issue), 상태변화 0. F9 factKey quarantine 패턴 재사용.
- **absence-vs-zero**: component가 paging 완료+0 event = zero(값 있음), manifest 미충족 = absence(승격 불가). 타입 구분.
- **watermark**: provisional(수신 최대) vs safe(CompleteSnapshot 존재 최대). caller가 section watermark 비교로 stale 폐기(§8).
- **correction/reversal**: append-only, lineage 안 supersede 체인. 도착 permutation 무관 결정론 fold(F6 effective 패턴 재사용).
- **expiry**: 주입 clock, 마지막 성공 +60초 soft / 15분 hard. hard 뒤 current value 0, 마지막 snapshot은 frozen evidence view에만.
- **erasure**: broker-sync store 전부 FencedKeyedStore, F6 `ActualPortfolioErasure.stores`에 등록(fence-first, restore suppression). fence 뒤 read/queue claim/promotion/late commit 0.

## Scoping 결정

- **scripted read port가 정본**(§out-of-scope). 실 Alpaca/KIS read는 4 opt-in flag에서만 — not_run artifact 규약만 존중.
- **F9 미import**: paper-transport subtree/submit operation import 0(read-transport는 별 subtree). F3 ProviderConnections core·shared contract/composition/migration/index는 read-only.
- **저장은 in-memory 결정론 레인**(F6~F9 동일): durable store 배선은 F11 경계.
- **valuation 미재도출**: F10은 broker Position/cash/activity를 source-preserved로 투영만. price×qty·FX·P&L은 F7 다운스트림(PortfolioEvidenceResolver). 미지원 signed position/source value/reference 보존, valuation 불가 시 total/weight/proposal unavailable.
- read-only이므로 정수 minor-unit 산술 불요(합산·표시만). F6 SourceMoney류 원본 보존.

## 검증 oracle

- `npm run check`, 손계산 fixture(positions/cash/activity 완전 snapshot vs partial), 배치별 물리 mutation, B3 blind(sonnet), B4 codex 반박 패널(다른 계열 — lineage·completeness·money-preserve·erasure 축), Standards 축 1패스, sync p95 5s / deep rebuild 20s.

## 배치 (각 = 체크포인트, npm run check green 후 커밋)

- [x] **B1 read-transport + BrokerReadPort + event store** — `provider-connections/read-transport/{routes,broker-read-transport}.ts` + `actual-portfolio/broker-sync/{contracts,event-store}.ts`. read-only 4-route allowlist(positions/cash/activity/checksum, live env·broker_read capability·POST, mutation route 0), `BrokerReadTransport`은 F0 ProviderAuthorization `broker_read` purpose로만 발급(SEC-04). lineage-scoped event store: durable-unique dedupe + divergent payload quarantine + (component,entity,kind,revision) identity permutation quarantine + lineage namespace 격리(새 epoch=새 namespace) + 생성자 주입 writeEpoch fence(F9 per-call atEpoch 우회 회피). red-first(event-store 6, read-transport 3). mutation 4/4 kill(divergent·permutation·namespace·fence). check 1,145/91 green.
- [ ] **B2 snapshot assembly + 승격 + watermark + expiry** — `broker-sync/{snapshot,projection}.ts`. component manifest·completeness·bounded skew·maximum lateness, CompleteBrokerSnapshot 원자 승격(partial never overwrites), safe/provisional watermark, correction/reversal effective fold, fixed-clock 60s/15min expiry.
- [ ] **B3 sync/rebuild worker + lifecycle + blind** — `broker-sync/{sync-worker}.ts` + read-transport 배선. cursor/paging·cursor-reset·deep backfill/checksum·gap·late event, 재시작 수렴, lineage lifecycle(disconnect retain/delete·reconnect same/new epoch·stale fence). blind 게이트.
- [ ] **B4 erasure 확장 + Live 부재 + perf + codex 패널 + Standards + closeout** — broker-sync store를 `ActualPortfolioErasure`에 등록 + fence 뒤 0 증명, live-env read authorization executor 0, perf(sync p95 5s/deep 20s), codex 4축 반박 패널, 사후 Standards 축 1패스, closeout.

## 진행 로그

- 2026-07-19: claim + 계획 수립.
- 2026-07-19(B1): read-transport 4-route allowlist + lineage-scoped event store. red-first 9 tests, mutation 4/4 kill. check 1,145/91 green.
