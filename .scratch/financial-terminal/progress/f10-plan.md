# F10 Broker Sync — 배치 계획 (ticket 19)

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 브로커 read transport · 스냅샷 승격 · sync 워커 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

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
- [x] **B2 snapshot assembly + 승격 + watermark + expiry** — `broker-sync/{projection,snapshot}.ts`. effective fold(F6 패턴 재사용: correction/reversal 도착 permutation 무관·reversal void·absence-vs-zero present set), `assessSnapshot`(component manifest 완전 paging·gap·checksum fold·bounded skew), CompleteBrokerSnapshot 원자 승격(partial/gap/divergent checksum/skew/older 전부 held — current+safe watermark 불변), fixed-clock 60s soft/15min hard expiry(hard 뒤 frozen only·current value 0), 생성자 주입 writeEpoch fence. projection 5 + snapshot 9 red-first. **mutation 중 gap fast-path(`size!==pageCount`)가 loop+checksum에 완전 종속인 dead code로 판명 → 삭제**(ponytail), loop gap guard로 kill 확인. 나머지 8 guard(checksum·skew·stale·soft/hard expiry·fence·reversal void·effective negate) 전부 kill. provisional watermark는 worker 누적 진행이라 B3로. check 1,159/93 green.
- [~] **B3 sync/rebuild worker + lineage namespace + blind** — `broker-sync/sync-worker.ts`(+`BrokerSyncCursorStore`) + read-transport 배선. full re-page 파이프라인(checksum head→component paging→event store record→snapshot promote), cursor-reset 감지(`pageIndex !== expected`), gap/divergent checksum/skew held(prior 보존), unauthorized held, **runKeys 스코핑**(스냅샷=이번 run에서 읽은 key만·divergence는 stored 원본 유지→snapshot-replace semantics), 새 provider epoch=새 namespace 격리, 재시작 수렴(fresh worker 재-page·이벤트 dedupe·double-count 0), provisional watermark(safe와 분리·held에도 전진). deep backfill/checksum은 매 sync가 full re-page+checksum 검증이라 구조적 포함(별도 method 불요·ponytail); maximum lateness는 expiry로 강제. read-transport checksum schema는 zero-page(present-empty) component의 빈 checksum 허용으로 완화. red-first 9. mutation: provisional per-page max가 snapshotAsOf fallback에 종속인 dead code로 판명→삭제(manifest asOf가 정직한 frontier), cursor_reset·runKeys·unauthorized·recordProgress 전부 kill. check 1,168/94 green. **blind 게이트: 26 tests·26 pass·불일치 0**(독립 oracle·손계산 literal·public seam; 3건 out-of-scope[perf·coordinator receipt·cursor erasure]는 B4에서 직접 커버). 커밋 e01a0f1.
- [x] **B4 erasure 확장 + lifecycle + Live 부재 + perf + codex 패널 + Standards + closeout** — `broker-erasure.ts`(broker-sync store 전부를 F6 `ActualPortfolioErasure.stores`에 라벨 등록·한 fence shred·receipt) + `f10-broker-erasure.test.ts`(2: 한 fence로 event/snapshot/cursor shred+receipt, fence 뒤 read/promote/record 0). disconnect/reconnect lifecycle(disconnected=frozen·current 제외·fresh sync만 currency 복원, snapshot store에 `disconnect()`+disconnected status). live-absence(read-only registry + F9 import 0 스캔). perf(sync p95 5s/deep rebuild 2000 pos·10k activity 20s). **codex 4축 반박 패널(다른 계열): 5 실버그 인정·0 artifact** — ①equal-asOf 구lineage 덮어씀(→monotonic ProviderDataEpoch 순서), ②`\|` delimiter injection lineage 충돌(→JSON injective key), ③manifest가 component 누락해도 complete(→REQUIRED 3 component 강제·`missing_component`), ④base 이중 correction order-dependent double-count(→최신 revision winner·loser void), ⑤authorize 중 erasure race가 read 1회(→SEC-06 authorize 후 fence 재검사). `f10-broker-panel.test.ts` 5 red→green. Fix1 초안(equal-asOf 다른 lineage 무조건 held)이 정당한 forward new-epoch를 깨서 epoch 단조성으로 교정(blind AC7e·worker new-epoch 회귀로 검출). 사후 Standards 축 1패스 후 closeout. check 1,207/100 green.

## 진행 로그

- 2026-07-19: claim + 계획 수립.
- 2026-07-19(B1): read-transport 4-route allowlist + lineage-scoped event store. red-first 9 tests, mutation 4/4 kill. check 1,145/91 green.
- 2026-07-19(B2): effective fold + completeness/promotion/expiry snapshot store. red-first 14 tests, mutation은 gap fast-path dead code 삭제 후 loop gap 포함 9 guard kill. check 1,159/93 green.
- 2026-07-19(B3): sync worker. red-first 9 + blind 26(불일치 0). 커밋 e01a0f1.
- 2026-07-19(B4): erasure/lifecycle/live/perf + codex 패널 5 실버그 수정(epoch 단조·injective key·missing_component·이중 correction·SEC-06 late fence). **사후 Standards 축 1패스(sonnet)**: HARD 2·JUDGEMENT 4. HARD 2건은 실 취약점 아님(transport responseSchema가 이미 검증)이나 일관성 개선 수용 — checksum cast를 inferred `BrokerReadChecksumResponse`로 타이트닝, brandLineage를 `brandReference` idiom으로, wire→domain 매핑을 `wireEventToBrokerSyncEvent` helper로 명시. JUDGEMENT 2/4(String(account)·facade)는 코드베이스 idiom으로 기각, JUDGEMENT 3(Zod/TS body 중복)은 residual 기록. check 1,207/100 green.
