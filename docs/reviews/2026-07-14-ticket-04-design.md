# 티켓 04 설계 검수 보고서

- **Target**: `.scratch/financial-terminal/issues/04-design-portfolio-trading-model.md`, `CONTEXT.md`, ADR 0004
- **Reviewers**: 도메인·회계, Paper Trading 안전성, Broker Sync·동시성
- **Date**: 2026-07-14

## Severity summary

| Dimension | Critical | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 도메인·회계 | 0 | 7 | 8 | 1 | 16 |
| Paper Trading 안전성 | 0 | 6 | 6 | 0 | 12 |
| Broker Sync·동시성 | 0 | 6 | 2 | 1 | 9 |
| **Total** | **0** | **19** | **16** | **2** | **37** |

세 관점이 함께 다룬 권한 폐기, reservation, 기업행동 주제는 같은 위치의 같은 문제가 아니라 외부 호출, 계좌 원장, 동기화 commit이라는 서로 다른 실패 경로이므로 별도 finding으로 유지했다. 모든 finding을 [티켓 04](../../.scratch/financial-terminal/issues/04-design-portfolio-trading-model.md)에 반영한 뒤 세 reviewer가 read-only 재검수했으며, 남은 finding과 새 finding이 없음을 확인했다.

설계 검수 37건과 별도로 종료 일관성 검수에서 티켓 04가 이관한 stale threshold와 Simulated Fill volume·slippage fixture가 후속 목록에서 빠진 Medium 1건을 발견했다. 두 항목을 티켓 05와 아래 Residual verification에 추가했고 재검수에서 해결과 새 finding 없음이 확인됐다.

## 도메인·회계 findings

### High

1. **TWR·XIRR 경계값과 완전성 누락** — Performance Coverage가 시작·종료와 외부 흐름 직전·직후 valuation을 요구하고, XIRR은 sign convention과 유일한 해가 있을 때만 반환하도록 했다.
2. **계좌 간 이체의 내부·외부 흐름 오분류** — Portfolio Transfer를 고정된 Portfolio Scope에 상대적으로 판정하고 scope 경계 현물은 별도 return용 cash-equivalent flow로 기록한다.
3. **gross/net 손익·세금·수수료 중복 차감** — Source Realized P&L의 포함 항목과 계산 방법을 보존하고 같은 fee·tax를 Portfolio Activity에서 다시 차감하지 않는다.
4. **Reporting Currency P&L의 cash FX 누락** — 증권과 cash의 FX translation, 시작·종료 가치, 외부 흐름과 component가 맞는 reconciliation identity를 요구한다.
5. **조정가격과 배당·분할의 중복 반영** — Price Basis를 증거에 명시하고 account valuation·TWR·P&L은 raw price를 기본으로 하며 ledger corporate action을 정확히 한 번 적용한다.
6. **분사·합병 원가 근거 없는 기업행동 적용** — Corporate Action Adjustment 근거가 불완전하면 basis와 영향 Performance Coverage를 unavailable로 둔다.
7. **Internal Paper 배당·기업행동 lifecycle 경로 누락** — server-only idempotent lifecycle ingestion을 추가하고 Broker Paper Account는 sandbox 결과를 정본으로 유지한다.

### Medium

1. **불변 source와 갱신 projection의 correction 모순** — source observation과 event는 append-only로 보존하고 superseding·reversal event가 current projection을 갱신한다.
2. **자산·FX 수익의 multiplicative interaction 누락** — FX Contribution과 interaction을 분리하거나 versioned attribution policy로 배분하되 component 합을 Reporting Currency Return에 일치시킨다.
3. **배당 발표와 계좌별 수령 권리 혼합** — revision이 있는 Declared Dividend와 position history로 계산하는 Dividend Entitlement를 분리한다.
4. **Target Allocation 합계·분모·누락자산 검증 부재** — eligible scope, 100% 또는 residual cash, complete valuation denominator가 없으면 금액 제안을 만들지 않는다.
5. **Disconnected account 제거로 인한 성과 survivorship bias** — Portfolio Scope membership timeline과 scope-change break를 근거에 포함한다.
6. **미지원·부채성 Broker Position 누락** — option, short, margin debt를 signed opaque source position으로 보존하고 신뢰 가능한 valuation이 없으면 total을 unavailable로 둔다.
7. **Scope 경계 현물 이체의 return 측정 금액 누락** — effective-time Price·FX fair value를 사용하고 Source Cost Basis와 분리하며 증거가 없으면 관련 수익률을 unavailable로 둔다.
8. **기업행동 시 GTC 주문·reservation 불일치** — versioned policy에 따라 adjust 또는 cancel하고 order event, reservation, position과 basis를 한 transaction에서 바꾼다.

### Low

1. **Opening Position의 합성 lot이 실제 tax lot처럼 보일 위험** — synthetic aggregate lot으로만 정의하고 이전 거래·보유기간·realized P&L을 복원하지 않는다.

## Paper Trading 안전성 findings

### High

1. **PaperOrderIntent 재생·교차-workspace 우회** — intent를 workspace, auth epoch, account·connection revision, payload hash, policy와 만료에 묶은 opaque one-time server record로 만들고 runtime ownership을 다시 확인한다.
2. **미체결 주문의 동시 overspend·oversell** — Paper Reservation, available cash·quantity와 account/order revision CAS를 정의했다.
3. **중복 worker의 submit·cancel 이중 외부 호출** — transactional outbox, PostgreSQL CAS·fencing single owner와 lookup reconciliation을 사용한다.
4. **fill 중복 및 fill·현금·position 반쪽 commit** — deterministic fill identity와 durable unique constraint를 사용하고 event, reducer, reservation, ledger와 outbox를 한 transaction에 둔다.
5. **단일 order enum의 cancel·fill race 오판** — submission, execution, cancellation을 독립 축으로 분리하고 cumulative quantity와 late valid fill을 reducer가 처리한다.
6. **cancellation rejection 뒤 reservation 조기 해제** — submission rejection, confirmed cancellation, expiry 또는 final fill에만 해제하고 cancellation rejection에는 유지한다.

### Medium

1. **주문 이전 market event를 사용한 time-travel fill** — event time이 accepted time 뒤이며 instrument·venue·session이 일치하고 delayed data clock이 주문 시각을 지난 증거만 허용한다.
2. **권한 폐기와 broker 외부 호출 사이 TOCTOU** — route 호출 직전에 auth epoch, connection·credential generation, ownership, paper environment와 fence를 재검사한다.
3. **idempotency 보장 종료 뒤 blind retry** — provider scope, canonical payload, guarantee-until과 lookup consistency horizon을 계약하고 보장 밖에서는 `submission_unknown`을 유지한다.
4. **safe lookup route 누락** — `lookupByClientOrderIdentity`를 paper 전용 allowlist와 BrokerPaperExecutionPort에 추가했다.
5. **draft·rejected 주문이 open으로 보이는 상태 모델** — execution의 `not_started`와 acknowledgement 또는 실제 fill에 의한 cross-axis 전이를 정의했다.
6. **fill 외 order event의 중복·반쪽 반영** — 모든 external order event에 durable identity·revision uniqueness와 atomic reducer transaction을 적용한다.

## Broker Sync·동시성 findings

### High

1. **provider correction의 순서·격리 규칙 누락** — comparable ProviderEventVersion이 strictly newer일 때만 적용하고 divergent·non-comparable·orphan reversal을 격리한다.
2. **재연결 뒤 event ID namespace 충돌** — ExternalAccountIdentity, ProviderDataEpoch와 ConnectionLifecycleFence를 분리하고 fingerprint·epoch가 맞는 retained reconnect만 dedupe ledger를 잇는다.
3. **비연속 projection replay로 watermark가 앞서는 문제** — unique inbox, next-contiguous-sequence CAS, gap parking·backfill과 deterministic rebuild를 정의했다.
4. **느린 section update가 최신 화면을 덮는 문제** — section sequence, account revision vector, Evidence watermark, policy version, unique update ID와 resume cursor를 비교한다.
5. **연결 삭제와 append-only 보존 정책 충돌** — administrative erasure를 명시적 예외로 두고 source부터 cache·outbox·backup restore까지 hard-delete 또는 crypto-shred한다.
6. **late event가 overlap 밖에서 사라지는 문제** — provider maximum lateness, safe/provisional watermark와 periodic deep backfill·checksum audit를 요구한다.

### Medium

1. **불완전 snapshot을 complete로 승격** — 모든 component·page·bounded skew를 증명하는 CompleteBrokerSnapshot manifest와 strictly-newer SnapshotVersion comparator를 요구한다.
2. **reconciliation issue의 중복·조기 해결** — deterministic identity, 영향 범위와 `open | resolved | superseded` lifecycle을 정의하고 더 새로운 complete cut에서만 해결한다.

### Low

1. **연결 세대 용어 혼용** — commit·disconnect·reconnect 규칙을 `ConnectionLifecycleFence`로 통일하고 별도의 sync fencing token·ProviderDataEpoch와 역할을 구분했다.

## Residual verification for ticket 05

- 흐름 경계, scope 경계 현물 이전, XIRR unique-root, 다중 통화와 gross/net P&L worked example
- raw·adjusted Price Basis와 기업행동 exactly-once, GTC order·reservation 변환 fixture
- cancellation rejection, 세 상태 축 조합, stream·poll duplicate와 delayed observation property test
- provider/feed별 stale threshold·hard expiry와 Simulated Fill의 volume participation·slippage fixture
- transaction crash·redelivery, lookup-before-retry, idempotency horizon과 revoke route race fault injection
- overlapping sync worker, correction·reversal ordering, cursor reset·late event, partial snapshot와 absence-vs-zero test
- retained reconnect·provider reset·삭제 race, projection gap, 느린 section update와 reconciliation lifecycle test
- Alpaca Paper와 KIS 모의투자 sandbox의 실제 계좌·주문·취소·체결 capability contract test

위 항목은 설계 finding을 연기한 것이 아니라 [티켓 05](../../.scratch/financial-terminal/issues/05-define-testing-seams.md)에서 구현 합격 기준과 자동 검증 seam으로 구체화할 후속 작업이다.
