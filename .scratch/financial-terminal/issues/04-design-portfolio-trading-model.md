# 04 - 포트폴리오와 거래 모델 결정

Type: grilling
Status: resolved
Blocked by: None

## Question

수동 보유 종목, Broker Connection 동기화, 통화 환산, 성과·배당·리밸런싱과 Paper Trading 주문을 어떻게 구분하고 병합해야 실제 포트폴리오와 모의 거래가 혼동되지 않는가?

## Answer

### 공개 module과 seam

`ActualPortfolio`와 `PaperTrading`을 서로 다른 깊은 module로 채택한다. 하나의 portfolio module에 `mode: actual | paper`를 넘기는 구조, Actual 계좌와 Paper 계좌를 함께 받는 범용 주문 interface와 Live Trading submit interface는 만들지 않는다.

```ts
interface ActualPortfolio {
  open(
    request: ActualPortfolioRequest,
    viewer: ViewerContext,
  ): PortfolioLoad<ActualPortfolioView>;

  change(
    command: ActualPortfolioCommand,
    control: MutationControl,
    viewer: ViewerContext,
  ): Promise<ActualCommandOutcome>;
}

interface PaperTrading {
  open(
    request: PaperPortfolioRequest,
    viewer: ViewerContext,
  ): PortfolioLoad<PaperPortfolioView>;

  prepare(
    request: PreparePaperOrder,
    viewer: ViewerContext,
  ): Promise<InformationOutcome<PaperOrderIntent>>;

  change(
    command: SubmitOrCancelPaperOrder,
    control: MutationControl,
    viewer: ViewerContext,
  ): Promise<PaperCommandOutcome>;
}

type MutationControl = {
  idempotencyKey: string;
  expectedRevision: string;
};
```

- Actual, Internal Paper와 Broker Paper 계좌 참조는 서로 다른 branded type이다. Actual 계좌를 Paper command에 넘길 수 없다. branded type은 compile-time 실수 방지일 뿐 권한 근거가 아니며 모든 command가 Viewer Context에서 User Workspace를 다시 파생하고 account kind·소유권을 runtime에 확인한다.
- `ActualPortfolioCommand`는 Opening Position, 수동 Portfolio Activity와 correction, 원가 정책, Target Allocation, Exposure Guardrail, Broker Sync 요청, 연결 해제와 삭제만 다룬다. 주문 command는 없다.
- `PaperTrading`은 Internal Paper Account와 Broker Paper Account만 받는다. `LiveAccountRef`, `LiveOrder`, `LIVE_SUBMIT` type이나 capability는 없다.
- `PaperOrderIntent`는 브라우저가 조립할 수 없는 opaque server record다. User Workspace, Viewer Context auth epoch, Paper account kind·id, Provider Connection id·version, `paper` 환경, canonical order payload hash, account revision, simulation/provider policy version, 만료와 one-time 상태에 묶인다. 제출·취소 route는 wire의 raw ID를 branded type으로 cast하지 않고 workspace-scoped repository에서 다시 해석하며 계좌 revision, 현금·보유 수량, 연결 generation과 시장 Evidence를 재검사한다.
- `TerminalView`만 두 module을 화면에 조합한다. UI, route와 worker는 broker SDK나 repository를 직접 호출하지 않는다.

`PortfolioLoad<T>`는 PostgreSQL·Redis의 마지막 정규화 상태만 기다린 `initial`과 독립적인 valuation, performance, dividend, broker sync update를 전달하는 `updates`를 가진다. 각 update는 stream/auth epoch, Portfolio Scope, request revision, section key, 단조 증가하는 per-section calculation sequence, input account revision vector, price·FX Evidence watermark, policy version, unique update id와 resume cursor를 포함한다. caller는 scalar account revision이 아니라 section별 current watermark와 비교해 오래된 계산을 버린다. 느린 broker, FX, 배당 또는 전체 이력이 초기 shell을 막지 않는다.

### Actual Portfolio와 Paper Portfolio

두 module은 journal, account, 현금, position, order, revision과 projection을 공유하지 않는다. 계산 규칙의 순수 구현은 재사용할 수 있지만 Actual과 Paper를 하나의 aggregate 또는 repository로 저장하지 않는다.

- Actual Portfolio는 Manual Position과 Broker Position만 포함한다. 같은 instrument를 화면에서 합산해도 source account와 `manual | broker | disconnected` 출처를 보존한다.
- Manual Position은 Broker Position을 수정하거나 조정하는 수단이 아니다. 빠른 수동 입력은 기준일의 Opening Position을 synthetic aggregate lot으로 만들고 이전 거래, lot별 취득일이나 성과를 발명하지 않는다.
- 상세 수동 입력은 매수·매도, 배당, 수수료, 세금, 입출금, 환전, Portfolio Transfer와 Corporate Action Adjustment를 Portfolio Activity로 기록한다.
- Broker Position은 latest complete Broker Snapshot에서만 갱신한다. 사용자가 직접 수정할 수 없다.
- 실제 Broker Snapshot에 option, short, margin debt 또는 아직 지원하지 않는 instrument가 있으면 signed quantity, source type/value와 원문 참조를 가진 opaque source position으로 보존한다. 신뢰 가능한 valuation이 없으면 누락 목록에 넣고 전체 total, 비중과 Rebalancing Proposal을 unavailable로 둔다.
- Paper Portfolio는 하나의 Internal Paper Account 또는 Broker Paper Account의 현금, position, Paper Order와 fill만 포함한다. Actual Portfolio 평가액, 손익, 비중과 리밸런싱에는 들어가지 않는다.
- 여러 Actual 또는 Paper 계좌의 합산은 read projection일 뿐 원장 병합이 아니다.

모든 account 변경은 account별 append-only revision과 contiguous sequence를 갖는다. retained lifecycle 안에서 source observation과 event는 불변이며 이미 기록된 activity, broker correction, order event와 fill을 덮어쓰지 않고 superseding 또는 reversal event를 추가한다. current cash, position과 cost-basis projection은 새 revision으로 갱신한다. 사용자 삭제나 License Scope 만료에 따른 administrative erasure는 이 규칙의 명시적 예외다. 서로 다른 account 사이의 전역 순서는 약속하지 않는다.

같은 `(workspace, module, account, command kind, idempotency key)`와 canonical payload는 기존 receipt를 반환하고, 같은 key와 다른 payload는 side effect 없이 conflict로 거절한다. expected revision이 다르면 최신 revision을 반환하며 caller가 다시 확인한다.

### 값, 완전성, 환율과 성과

portfolio section은 공통 `InformationOutcome<T>`과 별도의 completeness를 함께 사용한다.

- `complete`: 고정된 Portfolio Scope의 모든 account·지원/미지원 position, 시작·종료와 외부 흐름 경계 가격, FX와 activity 근거가 있음
- `partial`: 일부 position의 원통화 값이나 알려진 소계만 있으며 누락 목록이 있음
- `unavailable`: 전체값을 계산할 수 없음

일부 가격이나 FX가 없을 때 알려진 값을 전체 평가액처럼 반환하지 않는다. `knownSubtotal`은 이름과 누락 position을 함께 표시하고 `total`은 unavailable로 둔다. 각 available 값은 Evidence Reference, 기준 시각, Portfolio Scope와 membership timeline, 계산 policy version과 필요하면 Performance Coverage를 가진다.

- 원통화 source fact, Source Cost Basis와 provider tax lot observation은 불변이다. current cash·position·basis projection은 append-only correction으로만 갱신한다.
- Reporting Currency 기본값은 KRW이며 사용자가 바꿀 수 있다. 모든 환산은 실제 FX Market Observation과 기준 시각을 인용한다.
- 현재 통합 평가에는 최신 허용 FX를, 과거 성과에는 각 평가·현금흐름 시점의 FX를 쓴다. FX가 없으면 원통화 값은 보여도 통합값을 만들지 않는다.
- Portfolio Return은 외부 입출금을 제거한 TWR다. Performance Coverage는 시작·종료 valuation과 각 외부 흐름의 적용 직전·직후 valuation convention을 요구하며, 필요한 경계값이 없으면 해당 구간을 unavailable로 둔다.
- Personal Return은 같은 Portfolio Scope의 완전한 외부 현금흐름에 XIRR을 적용한다. 사용자 관점에서 opening value와 입금은 음수, 출금과 terminal value는 양수로 두며 유효한 해가 정확히 하나일 때만 반환한다.
- Portfolio Transfer는 source·destination leg를 하나의 linked identity로 묶는다. 선택한 Portfolio Scope 안의 계좌 간 현금·현물 이동과 환전은 외부 흐름이나 매매가 아니고, scope 밖으로 나가거나 들어올 때만 external flow다. scope 경계의 현물 leg는 effective time의 Price·FX Evidence로 계산한 fair value를 return용 cash-equivalent external flow로 기록하고 Source Cost Basis와 분리한다. 해당 Evidence가 없으면 Personal Return과 관련 P&L identity를 unavailable로 둔다.
- source 금액과 Source Realized P&L은 `gross | net`, 이미 포함한 fee·tax, 기간과 계산 방법을 가진다. Portfolio Activity의 같은 fee·tax를 다시 차감하지 않는다.
- Portfolio P&L은 native-currency와 Reporting Currency 결과를 구분한다. Reporting Currency P&L은 증권과 cash의 FX translation을 포함하고 시작·종료 가치, 외부 흐름과 P&L component가 조정되는 identity를 제공한다.
- 자산 가격 contribution, FX Contribution과 둘의 multiplicative interaction을 별도 component로 보이거나 versioned attribution policy로 배분한다. 어느 방법이든 component 합은 Reporting Currency Portfolio Return과 정확히 일치하며 세무상 환차손익으로 표시하지 않는다.
- Source Cost Basis와 Source Realized P&L은 broker 값과 방법을 각각 보존한다. 수동 account의 Analytic Cost Basis는 사용자가 선택한 FIFO 또는 이동평균 policy로 계산하고 세무 신고 자료가 아님을 표시한다. Opening Position은 기준일의 synthetic aggregate lot으로만 사용하고 이전 보유기간·realized P&L을 복원하지 않는다.
- Broker Snapshot 또는 Opening Position만 있는 기간의 과거 Portfolio Return, Personal Return과 tax lot은 추정하지 않는다.
- benchmark는 같은 Performance Coverage와 Reporting Currency의 실제 Evidence가 있을 때만 비교한다.
- 계좌 추가·제외 또는 연결 해제는 Portfolio Scope membership 변경이다. 범위 변경 경계를 넘어 같은 시계열을 조용히 chain-link하지 않고 새 series 또는 명시적인 scope-change break로 표시한다.

### 배당, 기업행동과 리밸런싱

- Declared Dividend declaration은 회사 발표 Evidence, revision, `declared | corrected | canceled | paid` 상태, 금액, 통화, ex-date, record-date와 pay-date를 보존한다. 계좌별 Dividend Entitlement는 당시 position history와 시장별 규칙으로 별도 계산하며 이력이 부족하면 계좌 예상액을 unavailable로 둔다.
- Estimated Dividend는 실제 지급 이력 또는 정식 공급자 전망, 방법, 기준일과 coverage를 가진 별도 projection이다. Declared Dividend와 합쳐 확정 금액처럼 표시하지 않는다.
- 실제 지급 배당, 원천세와 수수료는 gross/net·포함 항목을 가진 Portfolio Activity로 대조한다. 미래 세후 배당은 추정하지 않는다.
- Price Evidence는 Price Basis `raw | split_adjusted | total_return_adjusted`와 corporate-action version을 가진다. position·cash·basis journal은 Corporate Action Adjustment와 실제 entitlement를 항상 정확히 한 번 적용한다. Actual Portfolio의 account valuation, TWR과 P&L은 raw point-in-time price를 기본으로 한다. adjusted series를 분석에 쓰면 quantity와 cash flow도 같은 basis로 일관되게 재표현하며 `total_return_adjusted`를 실제 account P&L에 직접 사용하지 않는다.
- 분할, 병합, symbol 변경, 합병, 분사, 상장폐지와 현금 대가는 Corporate Action Adjustment로 기록한다. 기존 거래를 수정하지 않고 변경 전후 상태와 Evidence를 보존한다. 분사·합병의 원가 배분 근거가 불완전하면 해당 basis와 영향 Performance Coverage를 unavailable로 둔다.
- symbol 변경은 같은 instrument의 연속성으로 처리한다. 상장폐지 뒤 가격 부재를 자동 0으로 바꾸지 않고 valuation unavailable로 둔다.
- Internal Paper Account에는 FinancialInformation Evidence를 받는 server-only idempotent lifecycle ingestion 경로가 배당 entitlement와 Corporate Action Adjustment를 적용한다. open GTC order는 action·시장별 versioned policy에 따라 adjust 또는 cancel하며 order event, Paper Reservation과 position·basis 변환을 하나의 account transaction에 적용하고 Evidence를 보존한다. Broker Paper Account는 sandbox 결과를 정본으로 삼고 공식 Evidence와 대조만 한다.
- Target Allocation이 있어야 리밸런싱 필요 여부를 계산한다. 미설정은 `not_configured`다.
- instrument·ETF 목표 비중과 허용 편차가 주문 수량 계산의 기준이다. eligible Portfolio Scope와 valuation denominator를 고정하고 목표 합계 100% 또는 명시적인 residual cash를 검증한다. sector, country와 currency Exposure Guardrail은 최소·최대 경고이며 단독으로 주문 수량을 만들지 않는다.
- Rebalancing Proposal은 실제 가격·FX Evidence, 기준 시각과 누락 여부를 가진 read result다. scope의 total valuation이 complete하지 않으면 금액 제안은 unavailable다. 주문이 아니고 Paper Order로 자동 변환하는 method도 없으며 사용자가 별도 Paper Order draft를 작성하고 다시 확인해야 한다.

### Broker Sync와 연결 해제

Actual live Broker Connection에는 account, position, cash와 activity read capability만 허용한다. credential 자체에 거래 권한이 있어도 AuthorizedTransport route registry에는 live submit route가 없고 broker adapter는 주문을 전송할 수 없다.

Broker Sync는 source와 local lifecycle을 분리한다. `ExternalAccountIdentity`는 User Workspace, provider, environment, provider tenant와 immutable provider account id로 구성하고, `ProviderDataEpoch`는 provider event ID가 유일한 원천 ledger 세대를 나타낸다. verified fingerprint를 보존하고 `ConnectionLifecycleFence`는 연결·권한·worker commit만 차단한다. retained reconnect는 fingerprint와 ProviderDataEpoch가 일치할 때만 기존 event namespace와 dedupe ledger를 이어가며 provider ledger reset·재활용 ID는 새 ProviderDataEpoch와 baseline으로 시작한다.

각 account는 PostgreSQL의 단조 증가 sync fencing token과 `ConnectionLifecycleFence`를 가진다. Redis lease는 작업 중복을 줄이는 최적화일 뿐 commit 권한이 아니다. 모든 batch transaction은 current fencing token, auth epoch, ConnectionLifecycleFence와 delete tombstone을 조건부 검사해 오래된 worker의 commit을 거절한다.

broker adapter capability contract는 cursor ordering·epoch, source retention, maximum lateness, comparable `ProviderEventVersion`, `SnapshotVersion`과 complete component manifest를 선언한다. 보장할 수 없는 항목을 추정하지 않는다.

1. last cursor 이후 activities의 모든 page를 읽는다.
2. provider가 지원하는 bounded sync cut 또는 overlap window를 사용해 paging 중 새 activity를 놓치지 않고 page coverage를 검증한다. safe activity watermark까지만 history를 complete로 확정하고, maximum lateness가 없으면 trailing coverage를 provisional로 유지하며 주기적인 deep backfill·checksum audit를 수행한다.
3. 모든 positions·cash·account page/component와 bounded skew를 증명하는 typed `CompleteBrokerSnapshot` manifest를 만든다. adapter-specific SnapshotVersion comparator가 strictly newer임을 확인하고 activity high-watermark와 시간 경계를 기록한다. 동일 version의 다른 checksum, partial component와 absence-vs-zero 모호성은 quarantine한다.
4. `(ExternalAccountIdentity, ProviderDataEpoch, provider event id)`마다 comparable ProviderEventVersion이 strictly newer일 때만 correction을 effective로 만든다. 같은 version의 다른 checksum은 Reconciliation Issue로 격리하고, non-comparable event와 original보다 먼저 온 reversal은 pending 상태로 둔다. checksum은 동등성 검사일 뿐 순서를 정하지 않는다.
5. 새 Snapshot과 activity-derived projection을 비교해 deterministic identity `(account lineage, snapshot version, activity watermark, diff fingerprint)`를 가진 Reconciliation Issue를 계산한다. issue는 영향 instrument·cash·기간과 `open | resolved | superseded` lifecycle을 가지며 더 새로운 complete cut에서만 idempotent하게 해결한다.
6. batch manifest, cursor epoch·safe watermark, normalized journal/correction, current position·cash·basis projection, `lastAppliedAccountSequence`, Snapshot, Broker Sync Status, Reconciliation Issue와 durable update outbox를 하나의 PostgreSQL transaction으로 commit하고 그 뒤에만 queue를 ack한다. 무거운 derived projection은 unique event inbox, next-contiguous-sequence CAS, gap parking/backfill, deterministic rebuild와 schema/policy version을 사용하며 watermark가 뒤처지면 view를 partial/unavailable로 둔다.
7. current fencing token, auth epoch 또는 ConnectionLifecycleFence와 다른 늦은 결과는 commit·publish하지 않는다. account lineage의 ProviderDataEpoch가 batch가 시작된 epoch와 달라도 commit하지 않는다.

부분 page, cursor invalidation, timeout, schema mismatch, snapshot version 위반 또는 재인증 실패는 마지막 complete Broker Snapshot을 교체하지 않는다. cursor reset은 새 epoch의 full/overlap sync를 staging해 완전성 검증 후 같은 fenced transaction으로 전환한다. late/backdated correction이 bounded overlap 밖에서 올 수 있으면 periodic deep audit가 끝나기 전 history coverage를 complete로 승격하지 않는다. Broker Sync Status만 진행, 최신 아님, 실패 또는 재인증 필요로 갱신한다. Snapshot은 현재 상태의 근거이지 과거 Portfolio Activity가 아니다. Snapshot과 activity projection이 다르면 Snapshot의 current position은 출처와 함께 보여도 영향 기간의 performance는 unavailable로 둔다.

연결을 해제하면 먼저 ConnectionLifecycleFence와 sync fencing token을 증가시키고 tombstone을 기록한 뒤 Provider Credential과 활성 token을 폐기해 진행 중 job capability를 무효화한다. 외부 조회가 이미 끝났더라도 commit·outbox publish 직전에 같은 DB transaction에서 auth epoch, ConnectionLifecycleFence와 tombstone을 다시 확인한다. 사용자는 normalized history 보존 또는 삭제를 선택한다.

- 보존하면 Disconnected Broker Account로 마지막 성공 시점에 고정하고 current Actual Portfolio total에서는 기본 제외한다. 과거 성과에는 coverage 안에서 남길 수 있다.
- 마지막 수량을 새 가격으로 재평가하는 선택 화면은 `마지막 동기화 수량 기준 추정`으로 분리하며 현재 Broker Position으로 표시하지 않는다.
- 공급자 License Scope가 보존을 금지하면 사용자 선택보다 계약 삭제 정책을 우선한다.
- 삭제는 append-only domain correction의 예외인 administrative erasure다. 별도 fenced command가 source/journal payload를 hard-delete 또는 crypto-shred하고 projection, cache, pending outbox·inbox·queue intent, analytics/search/export를 제거한다. 허용된 최소 비민감 tombstone만 남기고 backup expiry와 restore suppression을 적용해 복원 뒤 데이터가 재등장하지 않게 한다.
- 같은 ExternalAccountIdentity, verified fingerprint와 ProviderDataEpoch로 재연결한 경우에만 새 ConnectionLifecycleFence에서 기존 보존 journal을 명시적으로 이어 dedupe한다. 다른 identity, 새 data epoch나 삭제 완료 뒤 재사용된 provider ID는 새 account lineage로 만든다.

### Paper Trading과 주문 안전

Internal Paper Account를 기본값으로 하고 Alpaca Paper와 KIS 모의투자는 각각 별도 Broker Paper Account다. 주문 draft와 모든 화면에 `Internal Simulation | Alpaca Paper | KIS Paper` source label을 유지한다.

초기 Internal Paper 지원 범위는 미국·한국 현금 주식과 ETF, market·limit order, DAY·GTC다. regular session만 지원하며 short, margin, leveraged borrowing와 option order는 지원하지 않는다.

Paper Order는 하나의 enum으로 submission, execution과 cancellation을 섞지 않는다.

- submission: `draft | pending_submission | acknowledged | rejected | submission_unknown`
- execution: `not_started | open | partially_filled | filled | expired`
- cancellation: `none | requested | confirmed | rejected`

append-only provider event는 external identity·revision, effectiveAt과 receivedAt을 보존하고 cumulative filled quantity와 remaining quantity를 reducer가 계산한다. `draft | rejected` submission은 `not_started`이고 acknowledgement 또는 실제 provider fill이 submission을 입증할 때만 execution이 `open`으로 전이한다. cancel confirmation 뒤 늦게 도착한 유효 fill도 identity 기준 한 번 반영할 수 있으며 UI는 `partially_filled_then_canceled` 같은 파생 상태를 표시한다. correction·reversal도 별도 event다. order 제출은 position을 바꾸지 않고 fill만 현금과 position을 바꾼다.

`submit`은 order와 Paper Reservation을 같은 account transaction에서 만든다. 매수는 limit price 또는 versioned market-order max-notional·fee buffer를 현금에서 예약하고, 매도는 미예약 보유 수량을 예약한다. available cash·quantity는 ledger balance에서 활성 reservation을 뺀 값이다. fill은 reservation을 소비하고 submission rejection, confirmed cancellation, execution expiry 또는 final fill 뒤 남은 reservation만 해제한다. cancellation rejection은 original order가 열려 있으므로 reservation을 유지한다. 모든 변화는 account/order revision CAS를 사용하므로 동시 주문이 overspend·oversell할 수 없다.

Internal Paper Account의 Simulated Fill:

- 주문 accepted/effective time보다 market event time이 뒤이고 instrument, venue와 regular session이 일치하는 실제 Market Observation만 사용한다. 수신 시각만 늦은 과거 observation은 체결 근거가 아니다.
- provider, feed, as-of, Data Freshness, Evidence Reference와 versioned slippage·fee policy를 기록한다.
- delayed observation은 feed의 data clock이 order accepted time을 지난 뒤에만 평가하고 `지연 시세 기반 시뮬레이션`, market event time과 receivedAt을 함께 표시한다.
- hard-expired, unavailable 또는 failed observation에는 fill을 만들지 않는다.
- 장외 주문은 다음 regular session까지 대기하며 reservation을 만들 수 없는 주문은 거절한다.
- Internal simulator는 pure in-process implementation이며 broker execution port와 합치거나 adapter로 만들지 않는다.
- Internal fill identity는 order, market observation identity와 fill sequence로 결정론적으로 만들고 외부 fill과 같은 durable unique semantics를 사용한다. fill/order event append, reservation consume, cash·position journal update와 outbox를 하나의 PostgreSQL transaction으로 commit한다.

Broker Paper Account의 주문과 fill은 broker sandbox가 정본이다. Internal simulator로 누락 결과를 보완하지 않는다. Broker Paper execution transport는 `environment: paper`와 submit, `lookupByClientOrderIdentity`, status/follow, cancel allowlist에만 묶이며 lookup payload·response도 등록된 schema로 제한한다.

외부 호출 전에 canonical payload hash를 가진 stable client order identity, idempotency command와 transactional outbox를 durable하게 저장한다. worker는 PostgreSQL CAS와 fencing token으로 한 번에 하나만 submit/cancel 호출 ownership을 claim한다. lease 만료나 process 재시작은 즉시 재호출하지 않고 lookup/reconciliation으로 전환한다. timeout 또는 connection drop은 rejection이 아니라 Submission Uncertainty다.

- 먼저 client order identity로 broker lookup을 한다.
- 주문이 있으면 acknowledgement를 기록하고 재제출하지 않는다.
- adapter contract는 provider idempotency scope, canonical payload 제약, guarantee-until, lookup consistency horizon과 policy version을 기록한다. 주문이 없고 보장 창 안에서 같은 key의 idempotent submit이 보장될 때만 재시도한다.
- lookup이나 idempotency 보장이 없거나 보장 창이 끝나면 blind retry하지 않고 `submission_unknown`으로 유지한다. 새 주문은 별도 사용자 intent와 새 identity로만 만들 수 있다.
- 취소도 provider confirmation 전에는 canceled로 표시하지 않는다.
- stream update와 polling reconciliation을 함께 사용하고 모든 external order event에 `provider connection + paper account + order + event kind + external identity + revision`의 durable unique constraint를 적용한다. acknowledgement, rejection, cancel confirmation, expiry와 fill의 event append, reducer transition, reservation·cash·position 반영과 outbox는 한 transaction이다. 같은 identity·revision의 payload가 다르면 적용하지 않고 Provider Degradation과 Reconciliation Issue로 격리한다.
- submit/cancel/lookup 외부 route 호출 직전에 Viewer Context auth epoch, Provider Connection·credential generation, account ownership, Paper environment와 fencing token을 다시 확인한다. revoke는 generation을 먼저 증가시키고 이미 전송됐을 수 있는 호출을 Submission Uncertainty와 reconciliation로 전환한다.

Paper Blotter는 account별 주문 접수, fill, cancel, reject, expiry와 uncertainty를 시간순으로 보여주며 Actual Portfolio와 Live Trading 기록을 포함하지 않는다.

### 내부 collaboration interface와 dependency

- `BrokerReadPort`: true external. Alpaca/KIS/IBKR read adapter와 deterministic mock adapter가 사용한다.
- `BrokerPaperExecutionPort`: true external. paper submit, lookup-by-client-identity, status/follow와 cancel 전용 adapter 및 mock adapter가 사용한다.
- `PortfolioWorkQueue`: remote but owned. sync, broker paper submit와 reconciliation job을 전달한다.
- PostgreSQL journal/projection과 Redis lock/cache: local-substitutable internal seam. production adapter와 PGLite/in-memory test adapter를 둔다.
- 계산, journal reducer, Internal simulator, cost basis, TWR/XIRR, allocation: in-process. public interface를 통해 검증하며 불필요한 port를 만들지 않는다.
- 가격, FX, 배당과 corporate action은 FinancialInformation이 ActualPortfolio/PaperTrading에만 주입하는 server-only `PortfolioEvidenceResolver`로 purpose-bound typed calculation input을 받는다. ResearchAssistant 전용 EvidenceResolver를 재사용하거나 raw Evidence getter를 만들지 않는다.
- broker adapter는 ProviderConnections의 ProviderAuthorization이 발급한 read 또는 paper 전용 AuthorizedTransport만 받는다.
- queue에는 Viewer Context, Provider Credential, AuthorizedTransport, raw broker payload를 넣지 않는다. JobContextReference만 저장하고 실행 시 Identity가 권한 epoch와 capability를 다시 확인한다.

Public command의 예상 가능한 결과는 applied/accepted, duplicate, rejected, conflict와 failed Provider Degradation으로 구분한다. raw provider error, credential과 account secret은 interface 밖으로 나오지 않는다.

### 대안 비교와 선택 이유

네 가지 interface 대안을 비교했다.

- 단일 `Portfolios.read/change`: entry point는 가장 작지만 Actual과 Paper command union이 커지고 향후 잘못된 account 종류가 들어올 위험이 커 채택하지 않았다.
- capability catalog 중심 두 module: 확장성이 가장 높지만 초기 MVP에 범용 registry를 과도하게 노출할 수 있어 catalog는 implementation 내부로 제한했다.
- UI 중심 `PortfolioDesk`: 기본 caller는 단순하지만 presentation과 domain seam이 결합되므로 TerminalView가 이 역할을 맡게 했다.
- strict ports & adapters: BrokerRead와 BrokerPaper execution 분리, ambiguous submit, queue와 credential capability 설계가 가장 안전해 내부 seam으로 채택했다.

최종안은 별도 `ActualPortfolio`와 `PaperTrading` module, progressive read, branded account type과 strict server-only port를 결합한다. 이 구조는 caller surface를 작게 유지하면서 Actual/Paper 혼동과 Live 주문 경로를 타입, capability, transport route와 저장소 수준에서 동시에 차단한다.

수치 latency budget, stale threshold, XIRR·TWR worked example, simulated fill volume·slippage fixture, sync fault injection과 주문 state-machine property test는 티켓 05에서 확정한다.

## Review

도메인·회계, Paper Trading 안전성, Broker Sync·동시성의 독립 설계 검수에서 수집한 37건을 모두 반영했고 최종 재검수에서 새 finding이 없음을 확인했다. 종료 일관성 검수의 Medium 1건도 해결했다. finding, 수정 주제와 티켓 05로 넘긴 검증 항목은 [티켓 04 설계 검수 보고서](../../../docs/reviews/2026-07-14-ticket-04-design.md)에 기록한다.
