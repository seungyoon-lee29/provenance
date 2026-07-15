# 19 - F10 Broker Sync 구축

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 15
Blocked by: 15
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
