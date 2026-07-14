# 05 - 테스트 seam과 성능 예산 결정

Type: grilling
Status: resolved
Blocked by: 02, 03, 04

## Question

공급자 장애, 기간·인터벌 차트 변경, 사용자별 저장, 포트폴리오 회계·주문·동기화 안전 경계, 초기 로딩과 반응형 레이아웃을 어떤 상위 seam에서 검증하며 성능 합격 기준을 무엇으로 정할 것인가?

## Inputs from ticket 04

- Portfolio Scope의 흐름 경계, 현물 이전 fair value, TWR·XIRR sign/root와 incomplete coverage worked example
- raw·adjusted Price Basis, 기업행동의 exactly-once 처리, GTC 주문·Paper Reservation 동시 변환
- 다중 통화 및 gross·net·수수료·세금·Source Realized P&L reconciliation
- cancellation rejection, submission·execution·cancellation 축 조합, stream·poll 중복, delayed observation clock의 state-machine/property test
- provider/feed별 stale threshold·hard expiry와 Simulated Fill의 volume participation·slippage fixture
- transactional outbox crash, lookup-before-retry, idempotency horizon과 revoke 직전 route-call race의 fault injection
- lease 만료 중첩 worker, cursor reset·late event·correction/reversal 순서, multi-page partial snapshot, reconnect·삭제·projection gap race
- Alpaca Basic과 KIS 개인 자격증명으로 실제 지원 가능한 시세·차트·뉴스 entitlement, 계좌 조회, 주문 유형, 취소, 체결·정정·재연결 범위를 provider/sandbox contract test로 기록하되 외부 공개 시장 feed 권리로 간주하지 않음

## Answer

### 무료 우선 실행 정책

현재 단계의 외부 데이터·뉴스·AI 공급자 구독비는 `USD 0/월`이고 실행 모드는 `free_only`다. 인프라·도메인 비용도 유료 결정을 하기 전에는 로컬 Docker 또는 사용자가 이미 가진 환경으로만 검증한다.

composition root의 내부 provider catalog는 `public_official | free_approval | free_personal | free_developer | paid` billing class와 환경·목적별 License Scope를 가진다. 각 capability manifest는 source, environment, purpose, plan/feed, 관측 시각, `validUntil`, quota/rate와 entitlement를 보존하고 만료·축소·drift 때 fail closed한다. `free_only`에서는 paid adapter, route와 background schedule을 등록하지 않고, paid key가 우연히 있어도 startup validation이 거절한다. 향후 유료 전환도 feature flag 하나로 열지 않고 계약 identity·version·유효기간·환경·표시 목적을 가진 entitlement record가 함께 있어야 한다.

| 실행 환경 | 실제값을 허용하는 기본 원천 | 명시적으로 비활성화하는 범위 |
| --- | --- | --- |
| 비로그인 공개 화면 | SEC EDGAR, 미국 재무부, ECB, 서버 key와 목적 승인이 있는 Open DART, 공개 목적 승인이 있는 KRX EOD | 미국·한국 실시간 주식, 실제 지수, OPRA 옵션, 선물, 공개 뉴스 원문·번역 |
| 로그인 개인 Workspace | 공개 원천 + 사용자 자신의 Alpaca Basic IEX·주식 이력·indicative option·entitled News, KIS 개인 시세·차트·계좌와 Paper Account | 다른 사용자 공유 cache, guest stream, 개인 key를 사용한 공용 기술지표 |
| 로컬 개발 | 위 원천 + News API Developer, Alpaca IEX·delayed SIP·indicative option, KIS 개인 capability와 Alpha Vantage 같은 무료 평가 범위 | localhost 전용 결과의 staging·production 표시 |
| AI | Viewer Context·최소화/redaction·원천 License Scope를 통과한 시장·뉴스·공시·차트·Actual/Paper Portfolio·주문 문맥 등 모든 지원 자료의 Gemini 무료 티어; 외부 처리가 금지되거나 key·quota·timeout 조건이 맞지 않을 때 지원 task의 로컬 규칙 | raw credential·session/auth token·원문 계좌번호·주문 실행 비밀·직접 식별자, cross-workspace 자료, 파생물 생성 권리 없는 Evidence는 호출 0 |

무료 key가 없으면 `api_required`, key가 있어도 표시 목적이 허용되지 않으면 `license_restricted`, 실제 결과가 없으면 `no_data`, 호출 장애는 `failed`다. 어떤 상태도 숫자를 포함하지 않는다. 유료 후보는 향후 참고 문서에만 남기고 현재 UI나 fallback chain에는 넣지 않는다.

### 합의한 테스트 seam

테스트는 caller와 사용자가 관측하는 Interface에서 수행한다. repository, reducer, worker 함수와 내부 호출 횟수를 직접 검증하지 않는다. true external 또는 비밀 보관처럼 별도 contract가 필요한 좁은 내부 seam만 예외로 둔다.

| Seam | 검증하는 observable | 테스트 구성 |
| --- | --- | --- |
| `FinancialInformation.read/follow` | 실제 bar·Evidence, 기간·interval, Data Freshness, License Scope, Information Outcome, stale fallback | 실제 module + protocol-level scripted HTTP/WS adapter + 주입 clock/calendar |
| `ResearchAssistant.run` | 모든 지원 자료 유형의 category parity, Viewer Context·최소화·redaction, Evidence 인용, 파생물 권리의 default-deny, Gemini 허용·차단, 외부 처리 불가·quota/key/timeout의 지원 task 로컬 폴백과 원인별 결과 | 실제 module + scripted Gemini adapter + 실제 local rule adapter |
| `TerminalView.open/changeLayout` | 빠른 initial, 독립 update, latest revision, chart 교체, 사용자별 layout 저장·복원 | 실제 application composition + PostgreSQL·Redis·worker + scripted provider |
| `Identity.resolve/requestAccountEmail/consumeAccountChallenge`와 `ProviderConnections` | guest/user 격리, account-security event/target/action material, cross-kind atomic challenge consume+session issuance, auth epoch 폐기, ownership, credential 비노출, revoke와 route 차단 | 실제 module + test session issuer + protocol stand-in |
| `ActualPortfolio.open/change` | source 보존, completeness, TWR·XIRR·P&L·FX·기업행동, Broker Sync Status | 실제 module + PostgreSQL·Redis·worker + scripted BrokerReadPort |
| `PaperTrading.open/prepare/change` | 세 상태축, Paper Reservation, Simulated Fill, idempotency, uncertainty, Actual과 격리 | 실제 Internal simulator + scripted Evidence/BrokerPaperExecutionPort |
| `NotificationCenter.open/changeRule/changeChannel/acknowledge`와 server-only account-security projection | Alert Occurrence·Account Security Event exactly-once, inbox, channel availability, purpose별 authorization epoch, consent, outbox, Delivery Fact, retention·erasure | 실제 PostgreSQL·outbox·worker + scripted clock/Web Push/Resend + Mailpit |
| 실제 브라우저 HTTP/UI | 탭 전환, chart 값 변화, drag·resize·split, 크게 보기, reload, responsive scroll, Paper 표시 | Playwright desktop/mobile + 실제 서버 composition |
| 외부 adapter contract | normalization, paging, cursor, entitlement/capability, idempotency horizon, lookup, rate limit과 redaction | 동일 contract suite를 protocol stand-in과 opt-in Alpaca Basic data·Paper 및 KIS personal data·Paper adapter에 적용 |

레이아웃 저장을 검증할 공개 Interface가 없던 점을 보완해 다음 command를 TerminalView Interface에 추가한다.

```ts
interface TerminalView {
  open(request: TerminalRequest, sessionProof: SessionProof): TerminalLoad;

  changeLayout(
    command: ChangeWorkspaceLayout,
    control: { idempotencyKey: string; expectedRevision: string },
    sessionProof: SessionProof,
  ): Promise<LayoutCommandOutcome>;
}
```

저장 성공은 DB를 직접 읽지 않고 같은 사용자로 `open`하거나 브라우저를 다시 접속해 확인한다. 다른 User Workspace에는 보이지 않아야 한다. guest layout은 browser local draft일 뿐 서버 사용자 설정으로 승격하지 않으며 로그인할 때 사용자가 명시적으로 채택해야 한다.

`CredentialVault`와 `AuthorizedTransport`는 server-only 내부 contract seam으로 인정한다. local AES-256-GCM과 managed KMS/Secret Manager adapter가 같은 vault contract를 사용한다. 공개 NIST AES-GCM known-answer vector, ciphertext/tag tamper, `workspace + provider connection + provider + credential type + paper/live environment` AAD field별 swap 실패, 주입한 nonce collision 거절, active/previous key version, old-key read/new-key write와 중단된 rewrap 재개를 literal oracle로 검증한다. local 32-byte KEK의 빈 값·길이 오류와 production 사용, KMS key ref/version mismatch는 startup reject여야 한다. sentinel credential은 `ProviderConnections`, adapter 오류, worker log와 진단 artifact를 수집하는 test log sink 어디에도 없어야 한다. transport contract는 allowlisted origin·route·schema·redirect·환경과 capability를 검증한다. 이 seam은 presentation에 export하지 않는다.

ChannelEndpointVault도 같은 envelope-vault contract를 쓰되 별도 key namespace를 사용한다. financial email AAD는 `workspace + endpoint + email/financial_alert + membership + financial-consent epoch + verified-address revision`, security email AAD는 `workspace + endpoint + email/security_account + membership/account-state revision + security-notice epoch + verified-address revision`, Web Push는 `workspace + device/endpoint + web_push + device-binding auth epoch`, pending target은 `pending identity + cause + purpose + request security epoch`다. purpose 또는 각 field swap, ciphertext/tag tamper, active/previous version과 중단 rewrap을 검증한다. financial/security variant 상호 복호화와 cross-workspace endpoint swap은 실패해야 한다. VAPID previous key의 `notAfter`와 emergency revoke 뒤에는 old subscription이 호출 0·비활성·재-opt-in 상태여야 한다.

DeliveryActionMaterialVault는 tagged variant별 AAD를 강제한다. AccountChallengeMaterial은 Account Security Event·purpose·pending identity·request/auth epoch, UnsubscribeMaterial은 workspace·endpoint·topic·consent lineage·Delivery Intent에 묶인다. 허용된 template renderer 외 resolve는 거절하고 raw token/code는 log·outbox·metadata에 없어야 한다. provider accepted, definite failure, challenge/Intent expiry와 accept-unknown reconciliation 뒤 purge 시점을 고정 clock으로 검증하며 purge 전 retry는 최초 payload hash와 정확히 같은 material만 해석한다.

### Fixture와 독립 oracle

기대값을 production 계산기로 다시 계산하지 않는다. `fixtures/spec/**`의 사람이 검토한 literal JSON/CSV를 독립 정본으로 사용한다.

- chart는 21개 `기간 × interval` 조합을 모두 contract test한다. 각 조합은 `range`, `interval`, 첫·마지막 시각, bar 수와 대표 OHLCV를 가진 literal manifest를 두고, `1W/1M` 집계값도 production 집계 함수를 import하지 않고 사람이 검토한 값으로 고정한다. 최소 상세 golden fixture는 `1M/1D` 22 bar와 `1Y/1W` 52 bar이며 선택 후 request key, 첫·마지막 시각, bar 수, 간격과 visible tooltip 또는 접근 가능한 chart summary 값이 달라야 한다. MA, Bollinger Band, RSI와 MACD는 같은 bar basis의 literal expected 값을 가진다.
- TWR은 `100 → 110`, 외부 입금 40 뒤 `150 → 165`의 결과 `21%`를 사용한다.
- XIRR은 `2025-01-01 -100`, `2026-01-01 +110`의 `10%`를 사용한다. 연속 연도 `-100, +230, -132`는 `10%`와 `20%`의 복수 해가 있으므로 unavailable다.
- FX는 USD 자산 `$100 → $110`, `USD/KRW 1000 → 1200`에서 가격 10%, FX 20%, interaction 2%, Reporting Currency Return 32%가 정확히 조정돼야 한다.
- gross 이익 20, fee 2, tax 1, source net realized P&L 17은 최종 17이며 fee·tax를 다시 차감하지 않는다.
- 2:1 split은 `10주 × $100 → 20주 × $50`으로 가치·원가가 보존되고 같은 event 재전달에도 한 번만 적용한다. 정책 fixture의 GTC `5주 @ $110`은 `10주 @ $55`와 reservation을 한 transaction에서 바꾼다.
- Portfolio Scope 내부 현물 이전은 external flow 0과 원가를 유지한다. scope 경계 이전은 고정 Price·FX Evidence의 fair value를 사용하며 근거가 없으면 관련 return을 unavailable로 둔다.
- flow 직전·직후 valuation 누락, Opening Position 또는 Broker Snapshot만 있는 과거 기간과 XIRR cash flow가 모두 같은 부호인 fixture는 Portfolio Return·Personal Return의 value가 없는 `unavailable`이어야 하고 known subtotal을 total로 표시하지 않는다.
- raw price와 원장 Corporate Action 조합 및 일관되게 restated된 split-adjusted series는 같은 가치·수익 결과를 내야 한다. total-return-adjusted series는 account P&L 입력에서 거절한다. lifecycle ingestion의 commit 전·후 named crash point에서 position, basis, GTC order와 reservation의 공개 view는 all-old 또는 all-new여야 한다.

Internal Paper의 초기 `simulation-v1` fixture는 계좌·instrument·observation별 활성 주문 전체가 incremental observed volume의 최대 10%만 사용한다. 같은 observation의 liquidity는 `acceptedAt`, Paper Order identity 순서로 결정론적으로 배분하고 서로 다른 Paper Account는 독립 simulation이다. reference price가 100, incremental volume이 1,000, remaining buy가 120이면 첫 fill은 최대 100이다. slippage는 `5 bps + 20 bps × participation`, 최대 25 bps이고 buy에는 더하고 sell에는 뺀다. 이 예의 participation은 10%, buy price는 100.07, sell price는 99.93이다. limit을 불리하게 넘으면 fill하지 않는다. 금액·수량은 instrument tick/lot rule로 반올림하고 policy version을 Evidence와 함께 보존한다.

모든 synthetic fixture에는 `provider: synthetic`, `isSynthetic: true`, `License Scope: internal_test_only`와 `SYNTHETIC TEST DATA` 표식을 넣는다. production composition은 synthetic adapter와 Evidence 등록을 실패시키고, fixture 화면을 최종 실데이터 스크린샷으로 사용할 수 없다.

### 필수 기능·안전성 검증

- chart range·interval 변경은 label만 바꾸는 것이 아니라 다른 request revision과 bar 집합을 만들며 오래된 응답은 paint하지 않는다.
- drag·resize·split, 내부 scroll, 단일 열 반응형, 크게 보기와 모든 전역·내부 tab의 화면 전환을 browser seam에서 검증한다.
- layout은 `changeLayout → open/reload`로 검증한다. 같은 idempotency key와 같은 payload는 같은 receipt, 같은 key와 다른 payload는 conflict, stale revision은 현재 revision과 함께 rejected, 다른 사용자의 mutation은 side effect 없이 차단돼야 한다. guest draft는 명시적 adoption command 전에는 로그인 Workspace에 병합되지 않는다.
- Paper fill 뒤 Actual Portfolio 공개 필드는 변하지 않고 Actual 변경 뒤 Paper cash·position은 변하지 않는다. wire에서 Actual ID를 Paper command로 위조하면 side effect 없이 rejected다.
- exported HTTP/OpenAPI와 generated client에는 Live submit operation이 없어야 한다. black-box Live 요청은 부작용 없이 404/405이고 `AuthorizedTransport` contract도 `LIVE_SUBMIT` capability와 route를 거절해야 한다. 내부 registry 모양을 oracle로 사용하지 않는다.
- Paper Order는 submission·execution·cancellation 조합, cancel rejection reservation 유지, confirmed cancel 뒤 late fill, duplicate event, same/different idempotency payload, concurrent overspend·oversell을 example+property test로 검증한다. checked-in literal trace는 event마다 세 상태축, reservation, cash와 position을 명시한다. property oracle은 `available cash + reservation` 보존, 음수 금지, fill만 position을 변경, terminal reservation 규칙과 duplicate convergence 같은 독립 invariant만 사용하고 production reducer나 transition table을 import하지 않는다. seed와 최소 shrink trace는 CI artifact로 보존한다.
- accepted 전 Market Observation, hard-expired Evidence와 delayed feed data clock이 accepted 시각을 지나지 않은 관측은 Simulated Fill을 만들지 않는다.
- Broker Paper에는 `after-intent-commit`, `after-broker-accept-before-local-ack`, `after-local-commit-before-queue-ack`, `after-authorize-before-route-dispatch` named fault point를 둔다. 재시작 후 `PaperTrading.open`과 scripted broker의 공개 lookup/account order 목록에서 외부 주문 최대 1개, blind retry 0, reservation·Blotter 일치를 검증한다. revoke가 dispatch 전이면 외부 주문 0, dispatch 후면 `submission_unknown`과 reconciliation이어야 한다. lookup 또는 idempotency guarantee가 없으면 계속 `submission_unknown`이고 retry하지 않는다.
- Broker Sync는 사람이 검토한 literal event/page/snapshot trace와 기대 `ActualPortfolio.open` 결과로 fault injection한다. partial page와 cursor reset은 이전 complete snapshot 유지, correction·reversal permutation은 같은 최종 projection 수렴, divergent checksum은 Reconciliation Issue, projection gap은 partial/unavailable, 늦은 fence 결과는 revision 불변이어야 한다. administrative delete는 account·projection·후속 update가 영구 부재여야 한다. revoke/disconnect에서 retain을 선택하면 `Disconnected Broker Account`가 마지막 성공 시점의 frozen 상태로 남고 새 sync update는 없으며 current total에서 기본 제외한다. 같은 identity·fingerprint·`ProviderDataEpoch` 재연결만 기존 lineage와 dedupe를 이어가고, 다른 fingerprint·새 epoch 또는 삭제 완료 뒤 재연결은 새 lineage다.
- ProviderConnections는 cross-workspace ID, stale auth epoch, expired License Scope, missing credential, raw secret/error leakage와 forbidden redirect를 거절한다. `free_only + paid` key·registration은 adapter 생성 전 startup reject하고 paid route·schedule·request가 0인지 검증한다. guest가 `free_personal | free_developer` transport를 요구하면 `license_restricted`이고 provider call, public cache와 outbox write가 모두 0이어야 한다. env 기반 Alpaca/KIS 개인 key는 development의 immutable owner workspace 또는 scheduled contract에만 묶이고 guest·다른 workspace·multi-user production에서는 route, cache, stream, outbox와 AI 호출이 모두 0이어야 한다.
- AI 결과는 입력 자료보다 넓은 freshness·License Scope를 얻지 않고 source-owned AI Material Reference, 관련 Evidence Reference와 model/rule policy version이 바뀌면 무효화한다. 시장·뉴스·공시·차트·Actual/Paper Portfolio와 주문 문맥 fixture가 source-owned reference와 resolver를 거쳐 모두 scripted Gemini에 도달해야 하며 client raw payload는 거절한다. 개인 provenance reference는 원래 workspace에서만 해석하고 raw secret·원문 계좌번호·직접 식별자와 cross-workspace 자료는 호출 0이어야 한다. 개인 job/cache key에 workspace·auth epoch·AI Processing Consent·License Scope·redaction·model policy version을 포함하고 철회·workspace switch·credential rotation·administrative erasure 뒤 pending emit과 cache hit가 0인지 검증한다. `derivative_generation=false`면 Gemini와 local rule 호출이 모두 0인 `license_restricted`다. 파생물은 허용하지만 external processing이 금지되면 지원 local rule, 미지원이면 `license_restricted`다. key가 없으면 지원 local rule 또는 `api_required`, quota·timeout·5xx는 지원 local rule과 Provider Degradation 또는 원인별 `failed`, Evidence 자체가 없을 때만 `no_data`다.
- Alert evaluator는 source-owned `AlertObservationResolver`를 통해 typed Alert Observation만 받고 opaque reference나 raw provider payload를 직접 읽지 않는다. rule row를 직렬화하고 `conditionRevision + sourceObservationIdentity + transitionSequence`의 Alert Occurrence를 Notification Record와 원자적으로 만든다. 같은 transition의 stream/poll/replay와 동시 worker는 no-op이며 late/out-of-order observation이 state watermark를 되돌리지 않는다. false로 돌아간 더 새로운 관측 뒤에만 re-arm한다. 모든 external Intent는 `AlertOccurrence | AccountSecurityEvent` Delivery Cause를 가지며 `(causeId, channel, destinationFingerprint)`가 유일하다. template revision·payload hash는 최초 Intent의 immutable 속성이고 배포·fingerprint key rotation·Quiet Hours·external retry 뒤에도 cause/destination당 외부 side effect 최대 하나여야 한다.
- PushTransport contract는 exact host registry, HTTPS:443, DNS re-resolution, response/time bound와 redirect 0을 oracle로 둔다. loopback·RFC1918·ULA·link-local·reserved, alternate port, userinfo, public/private multi-answer, DNS rebinding과 redirect fixture는 provider call 0이어야 한다. accept-before-timeout은 stable RFC 8030 Topic, service-worker tag와 client notificationId dedupe로 화면 알림 최대 하나에 수렴한다.
- Notification delivery contract는 financial alert의 template render와 dispatch 직전에 source-owned reference의 external-delivery License Scope를 다시 해석한다. 회수 race에서는 제한 원문이 payload·subject·log에 0이고 generic metadata-only 또는 `suppressed/license_restricted`여야 한다. Delivery Intent의 `sourceReference?`와 `deliveryActionMaterialReference?`를 독립 필드로 두고 property test한다. financial email은 source+`UnsubscribeMaterial`+WorkspaceFinancialEmailEndpoint, financial Web Push는 source+WorkspaceWebPushEndpoint, MVP account challenge email은 no source+`AccountChallengeMaterial`+PendingAccountEmailTarget, allowlisted `authenticated_security_notice`는 `AccountSecurityEvent + email + WorkspaceSecurityEmailEndpoint + no source + no action material` 조합만 허용한다. authenticated notice 성공 fixture와 함께 missing reference, wrong action variant, wrong target, 비허용 notice purpose와 그 밖의 조합은 renderer/provider 호출 0이어야 한다. Financial endpoint는 membership·financial-consent epoch·verified-address revision, Security endpoint는 membership/account-state·security-notice epoch·verified-address revision, Web-Push endpoint는 workspace/device-binding auth epoch·consent, PendingAccountEmailTarget은 Account Security Event·pending identity·purpose·request security epoch·expiry에 묶인다. cause/target 조합을 property test해 pending target을 financial/Web Push/authenticated notice에 쓰거나 workspace endpoint를 account challenge에 쓰면 호출 0이며 keyed destination fingerprint 외 raw target은 outbox·webhook artifact에 없어야 한다.
- 목적별 authorization race를 분리해 검증한다. logout 뒤에도 membership·consent epoch·verified-address revision이 유효한 financial email은 전달되고 consent/address 변경·membership 종료 뒤에는 억제된다. authenticated security notice는 financial opt-out과 보통 logout 뒤에도 유효한 purpose/expiry·account state·security-notice epoch·address revision이면 전달되지만 address 변경, endpoint disable, stale security epoch, account 종료와 deletion fence 뒤에는 억제된다. cross-workspace endpoint swap, `channel=web_push`, financial/security endpoint 교환은 renderer/provider 호출 0이다. Web Push는 device binding auth epoch/logout policy, PendingAccountEmailTarget은 Account Security Event purpose·request security epoch·target/token expiry만 사용하며 서로의 조건을 요구하지 않는다.
- Resend quota suite는 request-rate header와 daily/monthly usage snapshot을 typed fixture로 분리한다. provider snapshot 이후 local accepted delta, outstanding reservation과 남은 security reserve를 계산해 provider usage가 local보다 큰 경우에도 optional mail이 account/security 최소분을 침범하지 않아야 한다. definite pre-accept failure만 반환하고 accept-unknown은 reconciliation까지 유지한다. 429 request-rate/daily/monthly, 401/403 circuit과 webhook-before-API-ack를 포함해 durable inbox→provider-message/`WorkspaceId | PendingIdentityId` owner/recipient/template bind, crash dedupe, replay/rotation과 unbound expiry를 별도 검증한다. stale Svix timestamp는 거절하지만 old event `created_at`+fresh valid signature의 수동 replay는 처리해 ordering에만 event time을 사용한다.
- security/account email suite는 주소 HMAC, device/session, IP-prefix와 미검증 익명·proof-verified recovery·authenticated notice의 분리된 전역 budget, 분산 공격 및 enumeration-safe 응답을 검증한다. 공격자가 untrusted budget을 소진해도 proof를 통과한 정상 recovery와 allowlisted 로그인/credential 변경 authenticated notice가 protected budget, `channel=email`과 WorkspaceSecurityEmailEndpoint로 성공해야 한다. 같은 notice를 PendingAccountEmailTarget, WorkspaceFinancialEmailEndpoint, WorkspaceWebPushEndpoint, 다른 workspace endpoint 또는 비허용 purpose로 계획하면 외부 호출이 0이어야 한다. magic-link token은 purpose·pending identity·request/auth epoch, unsubscribe token은 workspace·endpoint·topic·channel·consent lineage에 묶고 모두 256-bit 이상·hash-only이며 cross-scope replay를 거절한다. active consent lineage의 오래된 unsubscribe token은 현재 opt-in을 해지하고, opt-out 뒤 반복 POST는 일반 성공과 기존 상태를 유지하며, 명시적 re-opt-in의 새 lineage는 이전 token에 영향받지 않아야 한다. magic-link GET/prefetch는 소비하지 않고 CSRF-protected 동시 POST 중 한 개만 session을 만든다. portfolio alert의 source-owned reference와 reference 없는 account event Notification Record도 조회·보존·삭제 fixture에 포함한다. no-store/no-referrer/no-app-token-log와 Resend Free external content processing 고지를 검증한다. provider open/click과 notification click은 `seen`을 만들지 않고 foreground Viewer Context acknowledgement만 만든다.
- NotificationCenter의 administrative erasure는 Alert Rule·watermark/state·Alert Occurrence·Account Security Event·channel evaluation, Notification Record, Delivery Intent/Fact, WorkspaceChannelEndpoint·PendingAccountEmailTarget·DeliveryActionMaterial, webhook inbox, unsubscribe/magic-link token hash, per-user abuse/quota key, AI/alert cache와 pending queue를 fence 뒤 제거하고 backup expiry까지 restore suppression을 유지한다. category/License Scope retention보다 오래 보존하지 않으며 필요한 전역 quota는 비식별 aggregate, 감사는 허용된 비식별 tombstone만 남긴다. fence 뒤 action-material resolve와 challenge session issuance는 0이어야 한다.
- account 삭제/DSAR는 provider message id와 최소 암호화 target만 가진 Processor Erasure Intent를 만들고 Resend 삭제 API/support/DPA adapter의 requested·confirmed·unavailable-until-expiry·legal-exception 결과를 공개 삭제 상태에 반영한다. provider가 즉시 삭제를 보장하지 못해도 로컬 queue fence와 삭제는 지연하지 않는다. processor-side 즉시 삭제가 필수인 content fixture는 Resend Intent 0·in-app-only여야 한다.
- delete→erasure-tombstone HMAC key rotate→late signed webhook→old key retirement→backup restore fixture는 tombstone의 key version과 domain separation을 검증한다. active와 모든 unexpired previous key를 조회해 old-key tombstone이 살아 있는 동안 raw body·recipient·unbound inbox write가 0이고 bounded `dropped_after_erasure` counter만 증가해야 한다. 마지막 old-key tombstone TTL 전에는 key retirement를 거절하고 필요한 key가 손실되면 raw storage를 fail closed한다.
- 익명 Account Security Event에는 purpose별 address/device/IP-prefix pseudonym과 risk decision 외 raw actor data가 없어야 한다. terminal/token expiry+24시간에 PendingAccountEmailTarget과 account DeliveryActionMaterial, 30일에 식별 가능한 event·abuse key, 90일에 비식별 abuse aggregate가 각각 purge되는 fixed-clock fixture와 미가입 주소의 possession-verified DSAR를 검증한다. unsubscribe material은 provider accepted·확정 실패·Intent expiry 뒤 삭제하되 hash verifier는 consent-lineage 정책대로 보존한다.
- `Identity.consumeAccountChallenge`의 manual code는 별도 hash-only 10-character Crockford Base32 value, link와 같은 purpose/pending identity/request-auth epoch/10분 expiry를 가져야 한다. family 5회 실패, link/code kind의 동시 public command와 성공 뒤 replay를 fault-inject해 session 최대 하나, 어느 한 경로 성공·lockout·expiry 뒤 두 credential 모두 무효, raw code/log 0을 검증한다.
- public webhook ingress는 method/content-type, header 64개·16 KiB, body 256 KiB, 2초 deadline과 peer/global bucket을 buffering 전에 강제한다. unsubscribe는 URL 4 KiB, body 8 KiB, 같은 header/deadline과 IP/global bucket을 먼저 강제한 뒤 urlencoded 또는 multipart의 정확히 한 `List-Unsubscribe=One-Click` pair/text part만 허용한다. multipart file·추가/중복 field·nested part·invalid boundary는 상태 변경과 provider 호출 0이어야 한다. oversized·slow body와 unique random invalid-token flood에서 process memory/DB write가 고정 상한 안이어야 한다. invalid audit은 token-derived key 없이 allowlisted `route+reason+minute+edgeRegion` counter와 전역 20 samples/hour reservoir만 24시간 남기며, 24시간 durable row 수가 `routes × reasons × regions × 1,440 + 480`을 넘지 않는 oracle을 둔다.

### Data Freshness와 장애 기준

모든 Evidence는 `asOf`, `receivedAt`, `declaredDelay`, `softExpiresAt`, `hardExpiresAt`, calendar와 policy version을 가진다. `실시간 | 지연 | EOD`는 feed class이고, `오래됨`은 soft expiry 초과 상태다. `hardExpiresAt`은 feed, License Scope와 authorization expiry 중 가장 이른 시각이다.

| provider/feed와 목적 | soft expiry | hard expiry |
| --- | --- | --- |
| Alpaca IEX streaming display, venue open | residual lag 15초 | residual lag 60초 |
| KIS 개인 국내·해외 feed, provider manifest가 real-time으로 확인됨 | declared delay + residual lag 15초 | declared delay + residual lag 60초 |
| Internal Paper Fill용 streaming Evidence | residual lag 5초 | residual lag 30초 |
| delayed SIP 15분 | declared delay보다 1분 추가 지연 | declared delay보다 5분 추가 지연; fill 목적은 2분 |
| incomplete intraday bar | interval + declared lag + 15초 | 3 × interval + declared lag |
| Treasury·ECB daily | 다음 예상 공표 + 2시간 | 두 번의 예상 영업일 공표 누락 |
| KRX EOD | 다음 예상 거래일 공표 + 4시간 | 두 번의 예상 거래일 공표 누락 |
| SEC latest submissions | 2분 | 15분 |
| SEC companyfacts index | 15분 | 24시간 |
| DART latest list | 5분 | 60분 |
| 연결된 Broker Snapshot의 current 표시 | 마지막 complete sync + 60초 | 15분; 이후 current Information Outcome에는 value가 없고 last snapshot은 별도 historical/frozen evidence view에서만 표시 |

accession·rcept_no로 고정되고 integrity를 확인한 공시 원문과 finalized historical bar는 immutable Evidence로 보존하되 최신 목록 completeness와 License Scope는 별도로 갱신한다. 주말·휴장 자체를 stale로 만들지 않는다.

soft expiry 뒤 hard expiry 전에는 보존권이 있는 실제 cache만 `available + 오래됨 + Provider Degradation`으로 표시한다. hard expiry, 권리 만료, synthetic fixture 또는 목적 불일치 뒤에는 current value payload 자체가 없어야 한다. hard-expired Broker Snapshot은 별도 frozen evidence view의 source와 `asOf`로만 볼 수 있고 current total·P&L·rebalance·fill 입력에는 절대 사용하지 않는다. quota·429는 `retryAfter`, timeout·5xx는 normalized code, 401은 `reauthentication_required`로 만든다. 403은 adapter의 typed error/body와 route contract로 분류해 entitlement/display denial만 `license_restricted`, credential·account authorization denial은 `failed/reauthentication_required`, 그 밖의 forbidden은 `failed/forbidden_upstream`이다. malformed·future timestamp는 `invalid_response`과 quarantine을 만든다. 즉시 retry storm, paid fallback, partial Snapshot 교체와 cursor 선진행은 금지한다.

### 성능 합격 예산

제품 latency와 외부 Provider latency를 분리한다. `TerminalView.open`, 공개 HTTP ingress, 실제 browser paint, durable command 접수와 provider 응답 ingress 이후 update paint만 제품 합격 seam이다. 무료 공급자 대기와 sandbox 응답 시간은 initial critical path와 제품 percentile에 포함하지 않지만 pending·실패 상태를 예산 안에 표시해야 한다.

고정 release 환경은 app과 worker 각각 2 vCPU·4 GiB Docker, PostgreSQL 2 vCPU·4 GiB, Redis 1 vCPU·1 GiB이며 모두 같은 region에 둔다. 저사양 desktop은 고정 Chrome 1366×768, CPU 2배 slowdown, 10 Mbps·40 ms RTT이고 저사양 mobile은 Chrome 360×800, CPU 4배 slowdown, 1.6 Mbps·150 ms RTT다. cold는 새 browser profile, HTTP·static cache 없음과 TerminalView application cache miss이고 warm은 같은 build의 반복 navigation이다. 표준 fixture는 20 widget, 100 symbol, 5 account, 250 position, 20,000 Portfolio Activity, 2,000 Paper Order, 50 Alert Rule, 1,000 Notification Record, workspace당 5 Channel Endpoint, pending Delivery Intent 1,000건(push 600/email 400), Delivery Fact 5,000건과 webhook inbox 500건(50 unbound), 뉴스·공시 각 100건과 최대 2,520 candle이다. release performance gate는 internet이 차단되고 request/page마다 정확히 20 ms를 기다리는 fixed-delay scripted provider, 주입 clock·UUID와 고정 calendar만 사용한다.

| server/application seam | warm p95 | local cache miss p95 |
| --- | ---: | ---: |
| guest `TerminalView.open` initial HTTP | 250 ms | 550 ms |
| 로그인 Workspace initial HTTP | 350 ms | 700 ms |
| cached chart HTTP | 250 ms | 500 ms |
| Actual/Paper initial projection | 450 ms | 800 ms |
| NotificationCenter inbox open | 200 ms | 400 ms |
| alert rule·channel·acknowledge command | 300 ms | 500 ms |
| layout·manual activity·Internal Paper command | 350 ms | 600 ms |
| Broker Paper durable acceptance | 450 ms | 700 ms |

브라우저 cold p95는 저사양 desktop guest shell 2.0초, 로그인 Workspace 2.4초, 저사양 mobile guest 3.0초, 로그인 Workspace 3.4초다. warm p95는 각각 1.0초, 1.3초, 1.8초, 2.1초다. shell은 spinner만이 아니라 메뉴·명령창·지수 strip·tab과 각 panel의 실제 cache 또는 명시적 Information Outcome을 그리고 조작할 수 있어야 한다. `TerminalView initial emitted → 권한상 허용된 모든 background refresh intent의 durable enqueue` p95는 250 ms이며 외부 응답을 기다리지 않는다.

Web Vitals 실제 사용자 p75는 desktop/mobile 각각 `LCP ≤ 2.5초`, `INP ≤ 200 ms`, `CLS ≤ 0.1`, 보조 `TTFB ≤ 800 ms`다. 최근 7일 동안 device class별 eligible navigation이 200개 이상일 때만 field p75를 배포 후 판정에 쓰고, 표본 미달과 배포 전에는 고정 lab browser gate가 정본이다. field breach는 즉시 rollback 여부를 판단하고 후속 성능 ticket을 연다. 아래 interaction 숫자는 모두 p95다. cached tab 전환은 desktop 200 ms/mobile 300 ms, chart 선택 표시는 100 ms, cached chart paint는 450/800 ms, provider response 수신 뒤 chart paint는 650/1,000 ms, Portfolio 크게 보기는 250/400 ms다.

drag·resize·split의 input-to-next-paint p95는 desktop 80 ms/mobile 140 ms, 연속 frame time p95는 20/32 ms다. 각 동작은 고정된 5초·60 Hz pointer path와 최소 240개 frame sample로 측정한다. drop 뒤 local saved 표시 p95는 100 ms, server confirmation p95는 600/900 ms다. 저장 실패를 관측하면 1초 안에 `저장되지 않음`과 local draft·retry를 표시한다.

worker는 durable enqueue→first claim p95 1.5초, provider response ingress→normalized commit 500 ms, commit→TerminalView update 전달 가능 600 ms, resume catch-up 2초다. Alert Observation ingest→Alert Occurrence·Notification Record commit p95는 500 ms, commit→inbox browser paint p95는 desktop 750 ms/mobile 1,200 ms, eligible Delivery Intent commit→first claim p95는 1.5초다. 외부 전달 latency는 이 예산 밖이고 notification refresh는 TerminalView initial을 막지 않는다. 명목 부하에서 일반 `DB/outbox commit → 같은 revision의 browser paint`도 desktop 750 ms/mobile 1,200 ms이며 Playwright mark로 commit·update identity를 대응시킨다. 표준 Broker Sync는 fixed-delay scripted `BrokerReadPort`의 1 account, 10 page × 100 activity, 250 position, 5 currency fixture에서 `enqueue → Broker Sync Status browser paint` p95 5초다. deep rebuild는 20 account, 100,000 activity, 2,000 position의 최대 fixture에서 `enqueue → rebuilt projection visible` p95 20초이며 initial을 막지 않고 진행 상태를 표시한다.

명목 부하는 10분 동안 100 stream, mixed HTTP 25 RPS, normalized source event 200/s 중 alert condition transition 10/s, 평균 payload 1 KiB·p95 4 KiB, 평균 fan-out 5와 총 browser delivery 1,000/s, worker 10 concurrent다. 모든 transition은 인앱을 만들고 독립적으로 20%는 평균 1개 Web Push endpoint, 10%는 email에 eligible하며 나머지는 설정/동의/권리 조건으로 external Intent가 없다. HTTP mix는 guest initial 20%, 로그인 initial 15%, chart 20%, Actual/Paper projection 15%, local mutation 10%, notification inbox open 8%, alert rule/channel/acknowledge command 7%, Broker Paper acceptance 5%이며 각 route는 최소 500개의 성공 또는 예상된 결과 sample을 가져야 한다. 각 stream은 평균 20 symbol과 4 panel을 구독하고 coalescing 뒤 전송한다. push claim, email claim과 webhook processing은 각각 최소 500개 성공/예상 결과 sample을 요구한다. 이때 위 HTTP·browser·worker p95 예산을 그대로 만족하고, 예상된 4xx와 주입 failure를 제외한 HTTP error는 0.1% 미만이며 event loss, duplicate side effect와 revision 역전은 0건이어야 한다. 5분 stress는 같은 HTTP/eligibility mix에서 250 stream, 50 RPS, source event 500/s 중 alert transition 25/s, 같은 payload 분포·평균 fan-out 5와 총 delivery 2,500/s, worker 25 concurrent이며 HTTP route와 각 delivery worker별 최소 250 sample을 요구한다. 안전성 오류는 0건이고 각 명목 p95 예산의 2배 이내여야 한다. 무료 외부 API에는 load test를 실행하지 않는다.

cache miss는 즉시 pending, 2초 뒤 `공급자 응답 대기`를 추가한다. external deadline은 시장·chart·뉴스·공시 10초, AI 20초, Broker Sync 30초이며 이후 무한 spinner 대신 normalized failed와 retryability를 표시한다.

### CI와 sandbox gate

- PR-fast는 typecheck·lint, public seam example과 짧은 fixed-seed property test를 실행한다.
- PR-integration은 Docker PostgreSQL·Redis, 실제 worker·Next server와 scripted HTTP/WS/Web Push/Resend provider 및 Mailpit으로 transaction·outbox·alert occurrence·webhook·race를 검증한다.
- PR-browser는 Playwright desktop/mobile의 guest shell, chart, layout, Paper, notification inbox·channel permission 상태와 responsive tracer를 실행한다.
- 모든 PR-fast/integration/browser는 provider credential을 주입하지 않고 localhost와 선언한 Docker network 밖의 egress를 deny한다. 외부 hostname 접근은 즉시 실패하고, network 허용은 분리된 opt-in/scheduled smoke job만 가능하다.
- nightly/release는 긴 property seed, 모든 fault point, projection rebuild, browser matrix, k6 load와 고정 runner 성능을 실행한다. OS/container image, Node와 Chrome major·exact revision을 고정하고 다른 job이 없는 dedicated runner, monotonic clock과 scenario당 5회 warm-up을 사용한다. cold 40회, warm 100회에서 outlier를 제거하지 않으며 p50은 추세 경고용, p95와 Web Vitals p75만 release pass/fail gate다. metric 초과를 retry로 숨기지 않고 runner termination, clock invalidity 또는 선언된 resource 불일치가 artifact로 입증될 때만 전체 suite를 invalid 처리한다.
- 외부 data/sandbox contract는 일반 PR·fork와 분리한다. 개인 데이터는 `RUN_ALPACA_BASIC_DATA_CONTRACT=1`, `RUN_KIS_PERSONAL_DATA_CONTRACT=1`, Paper read는 `RUN_ALPACA_PAPER_READ_CONTRACT=1`, `RUN_KIS_PAPER_READ_CONTRACT=1`, order mutation은 별도의 `RUN_ALPACA_PAPER_ORDER_CONTRACT=1`, `RUN_KIS_PAPER_ORDER_CONTRACT=1`로 명시적으로 켠다. env 개인 key는 scheduled contract 또는 명시적 development owner workspace에서만 authorize한다. key가 없으면 pass가 아니라 `not_run/api_required` artifact를 남긴다.
- sandbox는 paper hostname allowlist와 live route 0개를 먼저 assert하고 account·cash·position read smoke를 실행한다. order smoke는 provider별 capability manifest에서 stable identity, idempotency, lookup과 cancel을 먼저 검증한다. Alpaca는 `client_order_id`, KIS는 확인된 broker-order lookup만 사용하고 보장되지 않은 capability는 `unsupported` artifact를 남긴다. timeout 뒤 stable lookup이 없으면 `submission_unknown`, blind retry 0이다. 지원되는 provider만 far-from-market DAY limit을 fixed max `1 share` 또는 `USD 10 notional` 중 더 작은 값으로 `submit → lookup → cancel → confirmed`하고, stream·poll dedupe와 reconnect를 rate limit에 맞춰 직렬 검증한다. open order를 정리하고 public display entitlement가 아님을 metadata에 고정한다.
- SEC·Treasury·ECB는 key 없는 scheduled smoke, DART·KRX EOD는 무료 key·승인이 있을 때만 scheduled contract로 실행한다. 외부 latency는 기록만 하고 release 성능 gate로 쓰지 않는다.

### TDD vertical tracer 순서

각 단계는 한 public behavior를 red로 만든 뒤 최소 implementation으로 green을 만들고 다음으로 넘어간다. 내부 module별 테스트를 먼저 쌓지 않는다.

1. guest가 빠른 shell에서 무료 실제 Evidence 또는 정확한 `API 필요/표시 권한 없음`을 본다.
2. `1M/1D → 1Y/1W` 변경이 실제 bar와 화면 값을 바꾼다.
3. 사용자 A의 layout 변경이 reload 뒤 유지되고 사용자 B와 guest에는 보이지 않는다.
4. FinancialInformation의 available·stale·hard-expired·failed와 ResearchAssistant의 모든 자료 Gemini 경로·source-owned reference·consent·redaction·local fallback을 완주한다.
5. Alert Rule 한 개의 exactly-once occurrence, 인앱 inbox와 Web Push/email channel fact를 scripted adapter로 완주한다.
6. Opening Position을 Actual에 표시하고 Paper 변경이 Actual을 바꾸지 않는다.
7. TWR worked example부터 XIRR·FX·gross/net·transfer·기업행동을 한 사례씩 추가한다.
8. Internal Paper Order 하나의 reservation·volume/slippage fill을 완주한 뒤 상태축과 property를 추가한다.
9. Broker Paper timeout→lookup tracer 뒤 outbox·revoke fault를 추가한다.
10. complete Broker Snapshot tracer 뒤 paging·ordering·late event·delete race를 추가한다.
11. 마지막에 전체 browser matrix, 성능·부하와 opt-in sandbox/provider contract를 release gate로 확장한다.

## Review

2026-07-14에 testing·correctness, performance·UX, free-only provider·license·security·reliability 세 관점으로 병렬 검수했다. 중복 finding은 합치고 iterative re-review에서 발견한 항목까지 총 Critical 0, High 10, Medium 15, Low 1을 반영했다. 세 reviewer의 최종 spot re-review에서 미해결 finding과 새 회귀가 없음을 확인했다. 통합 결과는 [테스트·성능·무료 운영 검수 보고서](../../../docs/reviews/2026-07-14-ticket-05-design.md)에 기록했다.
