# 19 - F10 Broker Sync 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 15
Blocked by: None
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-19 (resolved)
Resolved at: 2026-07-19

## Objective

Broker Position·cash·Portfolio Activity를 read-only로 동기화해 complete Broker Snapshot만 current projection으로 승격하고 paging/late/correction/delete race에서 lineage를 보존한다.

## Owned scope

- `src/modules/actual-portfolio/broker-sync/**`, `src/modules/provider-connections/read-transport/**`.
- BrokerReadPort, sync/rebuild worker, lineage/snapshot/fault fixture.
- ProviderConnections core와 shared contract/composition/migration/index는 read-only다.

## Requirements

- ExternalAccountIdentity+verified fingerprint+ProviderDataEpoch, ConnectionLifecycleFence와 provider event unique identity를 구현한다.
- component manifest, absence-vs-zero, bounded skew와 maximum lateness를 만족한 complete Snapshot만 원자 승격한다.
- safe/provisional watermark, deep backfill/checksum과 correction/reversal을 deterministic하게 처리한다.
- unsupported signed position/source value/reference를 보존하고 valuation 불가 시 total/weight/proposal을 unavailable로 둔다.
- disconnect retain/delete, reconnect lineage와 administrative deletion permanence를 구현한다.
- ActualPortfolio erasure receipt를 broker account identity, sync cursor/event/snapshot/lineage, Reconciliation Issue와 rebuild queue까지 확장하고 restore suppression을 유지한다.

## Interface contract

- F6 `ActualPortfolio` public contract, `BrokerReadPort`, PortfolioWorkQueue와 read-only AuthorizedTransport만 사용한다.
- F3 ProviderConnections core를 read-only로 소비하고 F9 paper-transport subtree/submit operation을 import하지 않는다.
- partial/failure는 이전 complete projection과 cursor를 덮지 않는다.

## Acceptance criteria

- partial component, absence-vs-zero, cursor reset, late event, correction/reversal permutation, divergent checksum과 gap fixture가 이전 complete snapshot을 보존한다.
- retained reconnect/new epoch, stale fence, disconnect/delete와 backup restore에서 old lineage가 current로 부활하지 않는다.
- deletion fence 뒤 broker read/queue claim/snapshot promotion과 late event commit이 0이고 broker-sync receipt가 coordinator 상태에 수집된다.
- complete sync+60초 soft, 15분 hard expiry 뒤 current value가 0이고 last snapshot은 frozen evidence view에서만 보인다.
- 표준 sync browser paint p95 5초, deep rebuild 20초와 progress/resume oracle을 통과한다.

## Out of scope

- broker order mutation과 Live Trading.
- scripted read port가 정본이다. 실제 Alpaca/KIS data/paper read는 네 opt-in flag에서만 실행하고 미실행/미지원 상태를 artifact로 남긴다.

## Traceability

- [승인 spec](../spec.md) `UF-06`, §8, §11~12, F10, `SEC-04/06/09/10`, `AT-09/11`; `T04`.

## Answer

F10 Broker Sync를 scripted read lane에서 완주했다. 설계 스파인은 **CompleteBrokerSnapshot만이 승격 가능한 유일 진실**: manifest 전 component(positions/cash/activity)가 contiguous paging(no gap) + checksum fold 일치 + bounded skew 안일 때만 원자 승격하고, partial page·cursor reset·gap·divergent checksum·skew·older/lower-epoch·unauthorized는 전부 held로 이전 complete snapshot과 safe watermark를 절대 덮지 않는다. lineage(`ExternalAccountIdentity + verifiedFingerprint + ProviderDataEpoch`)가 event dedupe namespace를 injective JSON key로 격리해 ledger reset/다른 fingerprint·epoch/삭제후 ID 재사용은 새 lineage(구 event 미승계)다. event는 durable-unique로 dedupe하고 divergent payload·identity permutation은 quarantine(Reconciliation Issue, 상태변화 0). read-only 투영으로 source 값을 재도출 없이 보존(미지원 signed position/source reference 유지, valuation은 F7 다운스트림). fixed-clock 60s soft/15min hard expiry 뒤 current value 0·frozen evidence만. disconnect-retain은 frozen Disconnected Broker Account로 current 제외, fresh sync만 currency 복원(구 snapshot 부활 0). SEC-09 erasure는 broker-sync store 전부(event/identity/quarantine·snapshot current/safe/disconnected·cursor/provisional)를 F6 `ActualPortfolioErasure` 한 fence로 shred + restore suppression, SEC-06 late fence가 authorize 후 read 직전 재검사(read 0). paper-only import 0·mutation route 0으로 Live 부재. 매 sync가 full re-page+checksum이라 deep backfill을 구조적으로 포함. 배치 기록: `progress/f10-plan.md` B1~B4.

## Changed files

- `src/modules/actual-portfolio/broker-sync/`: contracts(lineage/event/injective key), event-store(dedupe/quarantine/namespace/fence), projection(effective fold·branching correction·absence-vs-zero), snapshot(completeness/promotion/watermark/expiry/disconnect/monotonic epoch), sync-worker(paging/cursor-reset/runKeys/provisional/SEC-06 fence), broker-erasure.
- `src/modules/provider-connections/read-transport/`: routes(read-only 4-route allowlist·Zod schema), broker-read-transport(broker_read authorize facade).
- tests: `f10-broker-event-store`, `f10-read-transport`, `f10-broker-projection`, `f10-broker-snapshot`, `f10-broker-sync-worker`(+harness), `f10-blind-acceptance`(blind 26), `f10-broker-panel`(codex 5), `f10-broker-lifecycle`, `f10-broker-erasure`, `f10-live-absence`, `f10-broker-performance`.
- 커밋 체인: c7891f3(B1)→525ed8b(B2)→e01a0f1(B3)→<B4>.

## Validation

- `npm run check` green: 1,207 tests / 100 files + seam. pre-commit 훅(typecheck+전체 테스트+secret 스캔) 매 커밋 통과.
- 배치별 물리 mutation: B1 4/4, B2 9(gap fast-path dead code 삭제 포함), B3 4(provisional dead code 삭제 포함), B4 disconnect 2 — 전부 kill. codex 패널 5 fix 각 red→green 실증.
- perf: standard sync p95 < 5s(250 pos/5 currency, 40 run), deep rebuild < 20s(2,000 pos/10,000 activity).
- AC 대조: partial/gap/cursor-reset/late/correction-permutation/divergent-checksum → 이전 complete snapshot 보존. retained reconnect/new epoch/disconnect → 구 lineage current 부활 0. deletion fence 뒤 read/promote/record/late commit 0 + receipt coordinator 수집. 60s/15min expiry 뒤 current value 0·frozen only.

## Review

- **blind test-authorship**(별도 sonnet, 구현 body 미열람·contracts+AC만): 26 tests·26 pass·불일치 0(독립 oracle·손계산 literal·public seam). out-of-scope 3건(perf·coordinator receipt·cursor erasure)은 B4에서 직접 커버.
- **codex 4축 반박 패널**(다른 계열): **5 실버그 인정·0 artifact** — ①equal-asOf 구 lineage 덮어씀(→monotonic ProviderDataEpoch), ②`|` delimiter injection 충돌(→injective JSON key), ③missing component가 complete(→REQUIRED 3 component 강제), ④base 이중 correction double-count(→최신 revision winner), ⑤authorize 중 erasure race read 1회(→SEC-06 late fence). Fix1 초안 과교정을 forward new-epoch 회귀로 검출·epoch 단조로 재교정.
- **사후 Standards 축 1패스**(신규 게이트, sonnet): HARD 2·JUDGEMENT 4. HARD는 실 취약점 아님(transport responseSchema 검증)이나 일관성 수용(inferred checksum type·brandReference idiom·wire→domain helper). JUDGEMENT 2/4 기각(코드베이스 idiom).

## Residual risks

- in-memory 결정론 레인: PostgreSQL/Redis durable store·마이그레이션은 F11 통합 경계. cursor/watermark/snapshot 모두 프로세스 수명.
- scripted read port가 정본: 실 Alpaca/KIS read·checksum/manifest·paging semantics는 4 opt-in flag contract test에서만 검증(미실행 artifact). 실 provider의 maximum-lateness/horizon 보장은 배선 시 재확인.
- routes.ts Zod body와 contracts.ts TS body가 병렬 정의(Standards JUDGEMENT 3): 필드 추가 시 drift 가능. checksum 경계는 inferred type로 닫았으나 body 3종은 미통합(둘 다 테스트됨).
- coordinator 실등록: `brokerSyncErasables`를 composition의 ActualPortfolioErasure stores에 배선하는 것은 F11 통합 시(현재는 통합 테스트로 계약 증명, F6 baseline과 동일 상태).
- ActualPortfolio projection 실병합 미완: broker Position을 F6 projection에 주입하는 배선은 F11/F7 경계. F10은 CompleteBrokerSnapshot 투영까지 소유.
- 3-deep correction-of-correction 체인은 F6 linear-chain 모델 상속(단일 correction·branching은 결정론 처리, 3-deep는 read-sync 비발생 시나리오로 미처리).
