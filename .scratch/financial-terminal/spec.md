# 한국어 금융 터미널 MVP 구현 스펙

상태: 구현 기준선
통합 기준일: 2026-07-15
제품 단계: 설계 완료, 구현 전

## 1. 목적과 규범

미국 주식 투자자가 미국·한국 금융시장 정보, 공시, 뉴스, Actual Portfolio와 Paper Trading을 한 화면에서 이해하고 조작할 수 있는 한국어 금융 터미널을 만든다. 공개 화면은 로그인 없이 사용할 수 있고, 개인 데이터와 Provider Connection은 User Workspace 안에서만 사용한다. 초기 릴리스의 주문 기능은 Paper Trading뿐이며 Live Trading 전송 경로는 존재하지 않는다.

이 문서의 `필수`와 `금지`는 구현·테스트·배포 합격 조건이다. 공급자 key 존재, API 호출 성공과 무료 비용은 표시·재배포·외부 모델 처리 권리를 뜻하지 않는다. 세부 도메인 용어는 [CONTEXT](../../CONTEXT.md), 되돌리기 어려운 결정은 [ADR](../../docs/adr/)이 정본이다.

### 1.1 추적성 키

| 키 | 정본 |
| --- | --- |
| `T01` | [공급자 지원 범위](./issues/01-research-provider-capabilities.md) |
| `T02` | [고밀도 Workspace 프로토타입](./issues/02-prototype-terminal-workspace.md) |
| `T03` | [데이터·Identity module interface](./issues/03-design-data-identity-modules.md) |
| `T04` | [Actual/Paper Portfolio와 거래 모델](./issues/04-design-portfolio-trading-model.md) |
| `T05` | [테스트 seam과 성능 예산](./issues/05-define-testing-seams.md) |
| `T06` | [무료 알림 전달](./issues/06-research-free-alert-delivery.md) |
| `A01` | [TypeScript 모듈형 모놀리스](../../docs/adr/0001-typescript-modular-monolith.md) |
| `A02` | [Provider Credential 암호화](../../docs/adr/0002-encrypt-provider-credentials.md) |
| `A03` | [Evidence와 Provider Credential 격리](../../docs/adr/0003-isolate-evidence-and-provider-credentials.md) |
| `A04` | [Actual/Paper 원장 격리](../../docs/adr/0004-separate-actual-and-paper-books.md) |
| `A05` | [모든 지원 자료에 Gemini 사용](../../docs/adr/0005-use-gemini-for-all-supported-materials.md) |
| `CFG` | [공급자 환경변수와 보안 경계](../../docs/configuration/provider-credentials.md) |

## 2. 범위와 공개 수준

| 실행 범위 | 허용하는 기능과 데이터 | 금지하거나 보류하는 범위 | 근거 |
| --- | --- | --- | --- |
| 비로그인 공개 화면 | 한국어 shell, 공개 관심종목·차트·뉴스/공시·금리/FX 패널, SEC EDGAR, 미국 재무부, ECB, server key와 목적 승인이 확인된 Open DART, 공개 목적 승인이 확인된 KRX EOD | 개인 Alpaca/KIS key, 미국 전 시장 실시간 시세·실제 지수·OPRA 옵션·선물, 권리 없는 공개 뉴스 전문·번역 | `T01`, `T05` |
| 로그인 User Workspace | 공개 범위 + 관심종목·layout·알림·AI 동의·Actual Portfolio·Paper Portfolio·사용자 자신의 Alpaca Basic/KIS capability | 다른 Workspace 데이터, 개인 결과의 shared/public cache, Live Trading 주문 | `T01`, `T03`, `T04` |
| 로컬 development | 위 범위 + 명시적 single-owner 또는 contract job에 묶인 개인 key, News API Developer 같은 localhost 전용 평가 adapter, Mailpit | staging/production으로 결과 승격, 개인 key를 guest/public feed로 사용 | `T05`, `T06`, `CFG` |
| 일반 PR/CI | 실제 module + scripted provider, synthetic fixture, PostgreSQL·Redis·worker·Mailpit, 외부 egress 차단 | 실제 secret, 실제 provider/browser email smoke, broker order mutation | `T05`, `T06` |
| 보류 | 유료 data/news/AI, 공개 미국 full-market·지수·OPRA·CME, 한국 실시간/지연 시세 계약, SMS·메신저·marketing, CSV/API/raw WebSocket 재배포, Live Trading | 계약·예산·권리·별도 안전 검토 전 adapter/route/schedule 등록 | `T01`, `T05`, `T06`, `A04` |

`free_only`는 비용 분류이지 권리 판정이 아니다. capability manifest는 source, environment, purpose, plan/feed, billing class, License Scope, entitlement, quota/rate, 관측 시각과 `validUntil`을 보존하고 drift·만료 시 fail closed한다.

## 3. 사용자 흐름

### `UF-01` 공개 시장 조회

비로그인 방문자는 인증 없이 한국어 terminal shell을 연다. 공개 License Scope가 허용된 실제 Market Observation 또는 Evidence만 값으로 보고, 나머지는 숫자 없이 정확한 Information Outcome을 본다. 모든 값에는 provider/feed, 선택적 venue, 출처, `asOf`, `receivedAt`, Data Freshness와 License Scope가 따라야 한다. (`T01`, `T02`, `T03`)

### `UF-02` 차트와 종목 리서치

사용자는 기간·interval을 바꾸고, 실제로 다른 request revision과 bar 집합을 확인한다. 종목 리서치의 근거 패널은 뉴스·공시·차트 Evidence 링크와 기준 시각을 보여주며 AI 결과가 어떤 Evidence를 사용했는지 추적할 수 있어야 한다. (`T02`, `T03`, `T05`)

### `UF-03` 계정과 User Workspace

사용자는 email challenge, Google 또는 GitHub로 로그인할 수 있다. 로그인 전에는 guest Viewer Context만 발급한다. current logout과 Workspace 전환은 해당 session generation, all-session revoke와 membership/account-state 변경은 account authorization epoch를 바꿔 해당 범위의 stream, job, 개인 cache 접근을 폐기한다. 관심종목, layout, 알림, Provider Connection과 portfolio는 현재 User Workspace만 소유한다. (`T03`, `T05`)

### `UF-04` Workspace 편집

사용자는 widget을 drag·resize하고 좌·중앙·우 panel 폭을 조절한다. 로그인 사용자의 layout은 revision과 idempotency를 적용해 저장하고 reload 뒤 복원한다. guest layout은 browser local draft이며 로그인 후 명시적 adoption 전에는 User Workspace에 합치지 않는다. (`T02`, `T03`, `T05`)

### `UF-05` Provider Connection과 AI

로그인 사용자는 자신의 data/AI/broker 연결을 저장·검증·폐기한다. 브라우저에는 Provider Credential 원문을 다시 주지 않는다. AI를 선택한 Workspace는 무료-tier data-use 고지와 약관 version을 포함한 AI Processing Consent를 기록하고, source module이 발급한 AI Material Reference만 분석에 사용한다. (`T03`, `T05`, `A02`, `A03`, `A05`)

### `UF-06` Actual Portfolio

사용자는 Manual Position, Opening Position, Portfolio Activity와 read-only Broker Position을 별도 원천으로 관리한다. Reporting Currency, Portfolio Scope, completeness와 Performance Coverage가 충분한 경우에만 total, Portfolio Return, Personal Return과 Portfolio P&L을 본다. 근거가 없으면 known subtotal을 total로 승격하거나 과거 수익률을 추정하지 않는다. (`T04`, `T05`)

### `UF-07` Paper Trading

모든 주문 화면은 Paper Trading이 기본이다. 사용자는 Internal Paper Account, Alpaca Paper 또는 KIS Paper 중 한 계좌를 선택하고, opaque PaperOrderIntent를 준비한 뒤 Paper Order를 제출·취소한다. 화면과 Paper Blotter에는 노란 Paper Trading 식별자와 account source를 유지한다. Actual Portfolio와 Live Trading 기록은 섞지 않는다. (`T02`, `T04`, `T05`, `A04`)

### `UF-08` 알림과 계정 보안 메일

로그인 사용자는 Alert Rule과 인앱 inbox를 사용하고 Web Push·financial email을 채널별로 opt-in한다. 인앱 Notification Record가 정본이며 외부 전달 실패나 해지가 이를 지우지 않는다. 익명 email challenge와 허용된 계정 보안 사건은 Alert Rule을 가장하지 않고 Account Security Event에서 시작한다. (`T03`, `T05`, `T06`)

## 4. Workspace와 화면 요구사항

| ID | 필수 동작 | 기계적 합격 조건 | 근거 |
| --- | --- | --- | --- |
| `WS-01` | desktop은 한 줄 header·명령창·AI 버튼, index strip, 좌측 시장/관심종목/공시, 중앙 chart/widget, 우측 Paper/AI/data-quality, 하단 확장 Paper Blotter를 갖는다. | 1366×768 fixture에서 각 landmark와 현재 상태가 동시에 식별된다. | `T02`, `T05` |
| `WS-02` | 모든 widget은 pointer drag와 양방향 resize, panel은 divider resize를 지원한다. | 고정 pointer path 뒤 geometry와 revision이 바뀌고 새 paint가 성능 예산 안에 온다. | `T02`, `T05` |
| `WS-03` | keyboard/touch 사용자는 drag 전용 동작과 동등한 이동·크기 조절 control을 쓸 수 있다. | keyboard-only와 360×800 touch fixture에서 focus, 순서, 크기, 저장 결과를 확인한다. | `T02`, `T05` |
| `WS-04` | mobile은 단일 열, panel별 내부 scroll, 가로 overflow 없는 구조다. | 360×800에서 한 열, 내부 scroll, header/menu/state 접근과 page-level horizontal overflow 0을 확인한다. | `T02`, `T05` |
| `WS-05` | tab·기간·interval·크게 보기 전환은 label만 바꾸지 않고 표시 데이터와 request revision을 바꾼다. | stale response가 최신 chart를 덮지 않고 tooltip 또는 접근 가능한 chart summary가 literal fixture와 일치한다. | `T03`, `T05` |
| `WS-06` | 상태는 색만으로 구분하지 않고 접근 가능한 이름·announcement·focus 복귀를 제공한다. | Playwright+axe, keyboard, reduced-motion과 `aria-live` fixture를 통과한다. | `T05`, `T06` |

## 5. 정보·권리·AI 요구사항

### 5.1 Information Outcome와 표시 규칙

| 결과 | 값 | 사용자 표시 | 필수 metadata |
| --- | --- | --- | --- |
| `available` | 실제 값만 허용 | `실시간`, `지연` 또는 `오래됨`; `EOD`, `IEX`, `indicative`는 별도 feed/cadence badge | Evidence Reference, provider/feed/venue, as-of/received-at, Data Freshness, License Scope, 선택적 Provider Degradation |
| `unavailable/api_required` | 없음 | `API 필요` 또는 configuration 안내 | 필요한 capability, 안전한 설정 route |
| `unavailable/license_restricted` | 없음 | `표시 권한 없음` | source/purpose와 redacted policy version |
| `unavailable/no_data` | 없음 | `데이터 없음` | 조회 범위와 기준 시각 |
| `failed` | 없음 | 정규화된 장애와 retry 가능 여부 | Provider Degradation; raw provider error/secret 금지 |

`연결 대기`는 Provider Connection setup/verification UI 상태이지 Information Outcome의 새 이유가 아니다. soft expiry 뒤 hard expiry 전의 보존 가능한 실제 cache만 `available + 오래됨 + Provider Degradation`으로 표시한다. hard expiry, 권리 만료, 목적 불일치 또는 synthetic payload에는 current value가 없어야 한다. (`T03`, `T05`)

| provider/feed와 목적 | soft expiry | hard expiry |
| --- | --- | --- |
| Alpaca IEX open display | residual lag 15초 | residual lag 60초 |
| KIS confirmed real-time personal feed | declared delay + residual 15초 | declared delay + residual 60초 |
| Internal Paper Fill | residual lag 5초 | residual lag 30초 |
| delayed SIP 15분 | declared delay +1분 | declared delay +5분; fill 목적 +2분 |
| incomplete intraday bar | interval + declared lag +15초 | 3×interval + declared lag |
| Treasury·ECB daily | 다음 예상 공표 +2시간 | 두 번의 예상 영업일 공표 누락 |
| KRX EOD | 다음 예상 거래일 공표 +4시간 | 두 번의 예상 거래일 공표 누락 |
| SEC latest submissions / companyfacts | 2분 / 15분 | 15분 / 24시간 |
| DART latest list | 5분 | 60분 |
| complete Broker Snapshot current | 마지막 성공 +60초 | 15분 |

quota/429는 typed `retryAfter`, timeout/5xx는 normalized code, 401은 `reauthentication_required`다. 403은 entitlement/display denial만 `license_restricted`, credential/account authorization denial은 `failed/reauthentication_required`, 그 밖은 `failed/forbidden_upstream`이다. malformed payload와 future timestamp는 `invalid_response`과 quarantine을 만들며 cache/snapshot watermark를 전진시키지 않는다. (`T05`)

### 5.2 실제 데이터와 synthetic data

- production composition은 `provider: synthetic`, `isSynthetic: true` 또는 `internal_test_only` Evidence 등록을 거절한다.
- 모든 test fixture는 `SYNTHETIC TEST DATA`를 명시하고 production 계산·cache·screenshot과 섞이지 않는다.
- 숫자가 없는 상태를 sample 숫자, 임의 index 값 또는 추정 portfolio로 채우지 않는다.
- 공개 screenshot은 권리가 허용된 실제 정본과 provenance를 보여주며 synthetic fixture 화면을 실데이터 증거로 사용하지 않는다. (`T02`, `T05`)

### 5.3 공급자별 최소 계약

| 공급자/원천 | MVP 사용 | 표시·격리 조건 |
| --- | --- | --- |
| SEC EDGAR | 공개 미국 공시·XBRL | server-side, rate control·User-Agent·accession/as-of 보존 |
| Open DART | 승인된 공개 한국 공시·재무 | key와 API별 활용 목적 승인이 확인된 capability만 활성 |
| 미국 재무부·ECB | 공개 일별 금리·참조 FX | 실시간 호가로 표현하지 않고 공표 주기·원출처 표시 |
| KRX Open API | 승인된 EOD 통계 | `EOD` badge, 실시간 feed로 표현하지 않음 |
| Alpaca Basic | 개인 IEX·15분 지난 SIP history·indicative option·Paper | 개인 Workspace만; IEX를 미국 전체 SIP로 표현하거나 공유하지 않음 |
| KIS Open API | 개인 시세·차트·계좌·Paper | endpoint별 capability/지연 확인; 공용 cache·guest/다른 Workspace 사용 금지 |
| News API Developer·개인 Alpaca News | local/private 평가 | News entitlement probe, title/source/time/link/허용 snippet만; 전문·이미지 재게시 금지 |
| Gemini 무료 tier | 모든 지원 자료 유형 | Viewer Context, AI Processing Consent, License Scope, 최소화/redaction을 매 실행 확인; paid tier 보류 |

FRED는 현재 production 정본·cache·archive·AI 입력으로 등록하지 않고, 원기관 데이터가 없는 internal exploration도 해당 series 권리 확인 뒤에만 사용한다. (`T01`, `T05`)

### 5.4 ResearchAssistant

- `run`은 시장·뉴스·공시·차트·Actual/Paper Portfolio와 주문 문맥 등 모든 지원 자료 유형에 같은 category policy를 적용한다.
- client가 만든 raw Evidence·portfolio·order payload는 거절하고 FinancialInformation, ActualPortfolio 또는 PaperTrading의 AI Material Reference만 받는다.
- source-owned resolver가 Viewer Context, source ownership, AI Processing Consent, 외부 모델 처리와 파생물 License Scope를 재검사하고 최소화된 AI Material Envelope를 만든다.
- Provider Credential, session/auth token, 원문 계좌번호, 주문 실행 비밀, 직접 식별자와 cross-workspace 자료는 provider 호출·log·cache에 없어야 한다.
- 파생물 생성 금지는 Gemini와 local rule 호출 0인 `license_restricted`, 외부 처리만 금지는 지원 local rule 또는 `license_restricted`, key 부재는 local rule 또는 `api_required`, quota/timeout/5xx는 local rule과 Provider Degradation 또는 `failed`, Evidence 부재만 `no_data`다.
- 결과는 source-owned AI Material Reference, 관련 Evidence Reference, workspace/auth/consent epoch, model/rule/redaction policy version과 생성 시각을 보존하며 입력보다 넓은 License Scope를 얻지 않는다. (`T03`, `T05`, `A05`)

## 6. 공개 module interface

caller와 test는 다음 interface만 제품 seam으로 사용한다. 타입 이름은 canonical contract이며 repository, reducer, provider SDK와 worker 함수는 presentation에 export하지 않는다.

```ts
interface FinancialInformation {
  read(query: FinancialQuery, viewer: ViewerContext): FinancialLoad;
  follow(query: FinancialQuery, viewer: ViewerContext): FinancialUpdates;
}

interface ResearchAssistant {
  run(
    task: ResearchTask,
    materialReferences: AiMaterialReference[],
    viewer: ViewerContext,
  ): Promise<InformationOutcome<ResearchResult>>;
}

interface Identity {
  resolve(sessionProof: SessionProof): ViewerContext;
  requestAccountEmail(
    command: AccountEmailCommand,
    control: { idempotencyKey: string },
    clientProof: ClientProof,
  ): Promise<AccountEmailOutcome>;
  consumeAccountChallenge(
    command: { kind: "link" | "manual_code"; proof: string },
    clientProof: ClientProof,
  ): Promise<SessionOutcome>;
  beginFederatedSignIn(
    command: { provider: "google" | "github"; returnRoute: InternalRoute },
    clientProof: ClientProof,
  ): Promise<FederatedSignInIntent>;
  consumeFederatedSignIn(
    command: { provider: "google" | "github"; callbackProof: FederatedCallbackProof },
    clientProof: ClientProof,
  ): Promise<SessionOutcome>;
  revokeSession(
    command: { scope: "current" | "all" },
    control: MutationControl,
    sessionProof: SessionProof,
  ): Promise<SessionOutcome>;
  requestAdministrativeErasure(
    command: { scope: "workspace" | "account"; confirmationProof: ReauthenticationProof },
    control: MutationControl,
    sessionProof: SessionProof,
  ): Promise<ErasureCommandOutcome>;
}

interface ProviderConnections {
  list(viewer: ViewerContext): Promise<ProviderConnectionView[]>;
  save(command: SaveProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  verify(command: VerifyProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  revoke(command: RevokeProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
}

interface ActualPortfolio {
  open(request: ActualPortfolioRequest, viewer: ViewerContext): PortfolioLoad<ActualPortfolioView>;
  change(command: ActualPortfolioCommand, control: MutationControl, viewer: ViewerContext): Promise<ActualCommandOutcome>;
}

interface PaperTrading {
  open(request: PaperPortfolioRequest, viewer: ViewerContext): PortfolioLoad<PaperPortfolioView>;
  prepare(request: PreparePaperOrder, viewer: ViewerContext): Promise<InformationOutcome<PaperOrderIntent>>;
  change(command: SubmitOrCancelPaperOrder, control: MutationControl, viewer: ViewerContext): Promise<PaperCommandOutcome>;
}

interface NotificationCenter {
  open(request: NotificationRequest, viewer: ViewerContext): NotificationLoad;
  changeRule(command: AlertRuleCommand, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
  changeChannel(command: ChannelCommand, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
  acknowledge(command: AcknowledgeNotification, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
}

interface TerminalView {
  open(request: TerminalRequest, sessionProof: SessionProof): TerminalLoad;
  changeLayout(
    command: ChangeWorkspaceLayout,
    control: MutationControl,
    sessionProof: SessionProof,
  ): Promise<LayoutCommandOutcome>;
}

type MutationControl = { idempotencyKey: string; expectedRevision: string };
```

email challenge는 `verify_email | recover | sign_in` purpose를 명시적으로 지원한다. 새 account 확인과 아직 verified address가 없는 recovery는 PendingAccountEmailTarget, 검증된 활성 계정의 sign-in/recovery는 WorkspaceSecurityEmailEndpoint를 사용한다. 존재하지 않거나 eligible하지 않은 sign-in 요청은 같은 status/body/timing class를 반환하되 target, action material과 외부 Intent를 만들지 않는다. 같은 idempotency key·canonical request는 기존 challenge receipt, 같은 key·다른 request는 side effect 없는 conflict다. eligible request transaction은 최소화된 Account Security Event, purpose에 맞는 target, link/code hash verifier와 envelope-encrypted AccountChallengeMaterial을 all-old/all-new로 함께 저장한 뒤 durable event를 낸다.

Federated sign-in은 Identity가 발급한 one-time intent와 정확한 provider/callback/return-route allowlist, state·PKCE, OIDC를 쓰는 경우 nonce, client proof, request-security epoch, 10분 이하 expiry와 replay 방지를 사용한다. callback은 canonical `APP_PUBLIC_ORIGIN`에서만 받고 authorization code/token 교환은 Identity-owned adapter 안에서 server-side로 끝낸다. OIDC adapter는 허용 algorithm의 signature, exact issuer, audience/`azp`, `exp`/`iat`, nonce와 JWK rotation을 검증한다. GitHub adapter는 exact allowlisted HTTPS token/user endpoint, redirect 0과 bounded response에서 인증된 stable subject를 얻고 email response를 identity key로 쓰지 않는다. forged signature, algorithm confusion, wrong issuer/audience/nonce, expired assertion, endpoint redirect와 malformed response는 session/workspace 0이다. identity key는 안정적인 `issuer + subject`이고 같은 email도 기존 계정과 자동 병합하지 않는다. account linking은 MVP에서 보류하며 도입하려면 재인증된 명시적 command와 별도 검수가 필요하다. raw authorization response, access/id token과 code는 DB, presentation log, URL, analytics, ProviderConnections 또는 다른 module에 남기지 않는다. 로그인·credential 변경은 idempotent Account Security Event를 낸다.

SessionProof는 무작위 opaque 값의 hash-only server record와 production의 `HttpOnly; Secure; SameSite=Lax` host-only cookie를 사용한다. OAuth transient state/PKCE/nonce cookie는 purpose-bound, 10분 이하, one-time이며 callback 뒤 즉시 삭제한다. issuance·rotation은 per-session generation을 갱신하고 absolute/idle expiry를 정책 version과 보존한다. `scope=current` revoke는 그 session row/generation만 폐기해 다른 session을 유지하고, `scope=all`, membership/account-state 변경은 account authorization epoch를 증가시켜 모든 session의 resolve·emit·commit을 막는다. Workspace switch는 해당 session generation과 Viewer Context만 교체한다. CSRF가 가능한 모든 state-changing command는 same-origin proof와 CSRF 방어를 요구한다. 이 계약은 `UF-03`의 email/Google/GitHub 요구와 기존 email-only interface 사이의 구현 공백을 닫는다.

ProviderConnections의 `save/verify/revoke`는 connection-scoped `MutationControl`, canonical payload hash와 단조 증가 connection revision/generation을 사용한다. 같은 key·payload는 기존 receipt, 다른 payload는 side effect 없는 conflict다. revoke는 credential generation과 authorization fence를 먼저 증가시킨 뒤 secret/transport를 폐기하고, 이미 dispatch됐을 수 있는 Paper call은 Submission Uncertainty와 reconciliation로 전환한다.

### 6.1 server-only collaboration interface

| 소유 module | interface/seam | 허용 caller와 불변식 |
| --- | --- | --- |
| FinancialInformation | `EvidenceResolver.resolve(reference, purpose, viewer)`, `PortfolioEvidenceResolver.resolve(reference, calculationPurpose, viewer)`, `AlertObservationResolver.resolve(reference, condition, viewer)` | 각각 ResearchAssistant, Actual/Paper, NotificationCenter 전용; raw Evidence getter 금지 |
| ActualPortfolio/PaperTrading | `AiMaterialResolver.resolve(reference, purpose, viewer)`, portfolio `AlertObservationResolver.resolve(reference, condition, viewer)` | purpose-bound typed material만 반환; presentation export 금지 |
| Identity | `resolveJob(reference)`, `resolveFinancialDelivery(reference)`, `resolveAccountChallengeDelivery(eventReference, targetReference)`, `resolveSecurityNoticeDelivery(eventReference, endpointReference)` | queue에 Viewer Context를 넣지 않고 실행/dispatch 직전 purpose별 epoch·membership·account/address state를 재검사 |
| Identity/application | `AdministrativeErasureCoordinator.execute(reference)` | Identity가 monotonic deletion fence와 durable intent를 먼저 commit한 뒤 module receipt, retry, processor erasure와 restore suppression을 조정 |
| ProviderConnections | `ProviderAuthorization.authorize(connection, purpose, viewer) → AuthorizedTransport` | connection, viewer, provider, paper/live environment, capability, credential version, expiry와 allowlisted route에 바인딩 |
| Identity→NotificationCenter | `AccountSecurityDelivery.plan` | durable Account Security Event를 exactly-once Delivery Intent로 투영 |
| vault | `CredentialVault`, `ChannelEndpointVault`, `DeliveryActionMaterialVault`, `DeliveryKeyring` | purpose별 AAD, active/new write, unexpired previous read, transactional rewrap, plaintext fallback 금지 |
| portfolio | `BrokerReadPort`, `BrokerPaperExecutionPort`, `PortfolioWorkQueue` | live read-only와 paper execution을 분리; queue에 secret/raw payload 금지 |

source-owned Evidence/AI/portfolio/alert resolver만 opaque source reference, allowlisted purpose와 현재 Viewer Context를 받고 typed envelope 또는 value 없는 Information Outcome을 반환한다. raw provider payload, generic getter와 cross-purpose result는 금지한다. `resolveJob(reference)`는 queue에 저장된 JobContextReference를 실행 시점의 최소 권한 Viewer Context로 해석한다. delivery resolver는 transient Viewer Context를 인자로 받지 않고 durable reference와 Identity-owned 현재 state에서 purpose-tagged Delivery Authorization Context를 만든다. `resolveAccountChallengeDelivery(eventReference, targetReference)`는 `pending(request-security epoch, pending identity, purpose, target/action-material expiry, deletion fence) | workspace(account authorization epoch, membership/account state, verified-address revision, purpose/expiry, deletion fence)`를 반환한다. `resolveFinancialDelivery`와 `resolveSecurityNoticeDelivery`도 각 purpose epoch를 재검사하며 stale epoch와 cross-purpose 사용은 value 없는 rejected outcome이다.

TerminalView는 FinancialInformation, ResearchAssistant, Identity, ProviderConnections, ActualPortfolio, PaperTrading과 NotificationCenter만 조합한다. `open`의 `initial`은 공개 cache와 local read만 기다리고 각 panel을 `pending | ready(InformationOutcome)`로 반환하며, `updates`는 `panelKey`, `requestRevision`, Information Outcome과 resume identity를 가진다. panel update 순서는 독립적이고 TerminalView가 merge, dedupe, retry, completion과 최신 revision 교체를 소유한다. 새 request·disconnect·session epoch 변경은 superseded 작업을 취소하고 emit 직전 권한을 재검사하며 오래된 update를 paint하지 않는다.

## 7. Identity·비밀·권한 불변식

| ID | 필수 불변식 | 합격 oracle | 근거 |
| --- | --- | --- | --- |
| `SEC-01` | Viewer Context는 Identity만 만들고 client `userId/workspaceId`를 권한 근거로 쓰지 않는다. | cross-workspace ID, stale auth epoch와 workspace switch가 side effect 0으로 거절된다. | `T03`, `T05` |
| `SEC-02` | email challenge는 enumeration-safe request, 10분 expiry, link+10-character Crockford code family, 5회 실패, CSRF-protected atomic consume/session issuance를 사용한다. | GET/prefetch 소비 0, 동시 POST session 최대 1, lockout/expiry/replay 뒤 두 proof 모두 무효다. | `T03`, `T05`, `T06` |
| `SEC-03` | 사용자 Provider Credential은 AES-256-GCM envelope encryption, server credential은 env/Secret Manager만 사용하고 browser로 원문을 반환하지 않는다. | NIST vector, AAD field swap, tamper, nonce collision, rotation/rewrap와 sentinel redaction suite를 통과한다. | `T05`, `A02`, `CFG` |
| `SEC-04` | AuthorizedTransport는 exact origin/route/schema/environment/capability에 묶고 arbitrary auth header·redirect를 금지한다. | SSRF, cross-origin redirect, forbidden route와 live submit 요청에서 provider call 0이다. | `T03`, `T05`, `A03` |
| `SEC-05` | 비밀·원문 target·action material은 outbox/log/error/screenshot/AI prompt에 복사하지 않는다. | staged/runtime artifact redaction scan에서 sentinel과 secret pattern이 0이다. | `T05`, `T06`, `CFG` |
| `SEC-06` | revoke, consent 철회, address/security revision, membership 종료와 administrative deletion fence는 commit/emit/dispatch 직전에 재검사한다. | 늦은 worker가 write/publish/resolve/session 발급을 하지 못하고 cache hit 0이다. | `T03`, `T04`, `T05`, `T06` |
| `SEC-07` | federated callback은 provider/state/PKCE/nonce/client proof/request-security epoch/redirect/expiry, provider assertion trust와 `issuer + subject`를 검증하고 암묵적 email account linking을 금지한다. | forged/mismatch·replay·동시 callback은 session/workspace 최대 0/1개, raw provider token artifact는 0이다. | `T03`, `CFG` |
| `SEC-08` | SessionProof는 opaque hash-only server record와 secure cookie이며 session generation, account authorization epoch, expiry, rotation, logout과 Workspace switch에 묶인다. | current revoke 뒤 다른 session은 유효하고 all revoke/switch/expiry의 해당 범위에서 resolve·emit·commit 0, CSRF command side effect 0이다. | `T03`, `T05` |
| `SEC-09` | administrative erasure는 Identity-owned public command, monotonic fence와 durable coordinator를 거쳐 모든 source module receipt를 수집한다. | 늦은 queue/webhook/provider result와 backup restore가 개인 데이터를 재생성하지 않고 공개 erasure 상태가 module/processor 결과를 정직하게 표시한다. | `T04`, `T05`, `T06` |
| `SEC-10` | ProviderConnections mutation은 revision·idempotency·canonical payload conflict와 generation-first revoke를 적용한다. | same/same receipt, same/different conflict, stale revision/revoke race에서 secret call과 late commit 0이다. | `T03`, `T04`, `T05` |

### 7.1 epoch·version 소유권

| 값 | owner | 증가/교체 원인 | stale일 때 금지되는 동작 |
| --- | --- | --- | --- |
| Viewer Context auth epoch | Identity | session generation + account authorization epoch + workspace membership revision의 immutable composite | 어느 component든 stale이면 resolve, personal read/cache, job emit/commit |
| session generation | Identity session | issuance/rotation, current logout, 해당 session의 Workspace switch | 해당 session proof resolve·stream emit |
| account authorization epoch | Identity account | all-session revoke, account state/security reset | 모든 session resolve·personal commit, 기존 계정 account challenge resolve/dispatch |
| request-security epoch | Identity pending challenge | 새 challenge family, abuse/risk reset, consume/lockout/expiry | pending target resolve, account session issuance |
| AI consent epoch | Identity/User Workspace AI Processing Consent | provider/tier/terms 동의 변경·철회 | AI dispatch, personal result emit/cache hit |
| financial-consent epoch | Identity/User Workspace channel consent | opt-in/out, new consent lineage | financial endpoint resolve/dispatch |
| verified-address revision | Identity verified address | verify, address change, hard bounce 후 재검증 | financial/security endpoint resolve/dispatch |
| membership/account-state revision | Identity | membership 종료, account suspend/close/reactivate | personal resolve, financial/security dispatch |
| security-notice epoch | Identity account security policy | address/security setting revision, account state 변경 | WorkspaceSecurityEmailEndpoint resolve/dispatch |
| device-binding auth epoch | Identity + NotificationCenter install binding | logout/switch/device rebind | Web Push endpoint resolve/dispatch |
| credential generation | ProviderConnections | save/rotate/revoke/connection environment 변경 | AuthorizedTransport 발급·route call·late commit |
| ConnectionLifecycleFence | ActualPortfolio/ProviderConnections | broker disconnect/reconnect/delete | sync/order commit·publish |
| ProviderDataEpoch | ActualPortfolio broker lineage | provider ledger reset·ID namespace 교체 | 과거 dedupe namespace 재사용 |
| policy/schema version | source module | calculation, simulation, redaction, template 또는 schema 변경 | old cache/result를 current로 승격 |
| vault KEK/key version | vault/DeliveryKeyring | key rotation/emergency revoke | 새 write에 old key 사용; `notAfter` 뒤 resolve |

credential generation, session/account authorization, membership/address, consent/fence와 암호화 key version은 서로 대체하지 않는다. 각 durable job/intent/cache는 필요한 값과 owner를 기록하고 resolve·dispatch·commit 직전에 current value를 비교한다. 개인 AI job/cache identity에는 source credential generation도 포함하고 rotate/revoke 뒤 pending emit과 cache hit를 0으로 만든다.

## 8. Actual Portfolio 요구사항

ActualPortfolio와 PaperTrading의 `PortfolioLoad`는 PostgreSQL·Redis의 마지막 정규화 상태만 기다린 `initial`과 valuation/performance/dividend/broker-sync 등 독립 `updates`를 갖는다. 각 update는 stream/session auth epoch, Portfolio Scope, request revision, section key, 단조 증가 per-section sequence, input account revision vector, Price/FX Evidence watermark, policy version, unique update ID와 resume cursor를 가진다. caller는 section watermark를 비교해 stale result를 버리고 느린 broker/FX/배당/history가 initial shell이나 최신 section을 막거나 덮지 못하게 한다.

두 module의 account 변경은 contiguous append-only revision과 sequence를 사용한다. source event/activity/fill을 덮어쓰지 않고 superseding/reversal을 추가하며 administrative erasure만 명시적 예외다. `(workspace, module, account, command kind, idempotency key)`와 canonical payload가 같으면 기존 receipt, 같은 key와 다른 payload는 side effect 없는 conflict, stale expected revision은 current revision을 가진 rejected outcome이다.

- ActualPortfolio는 Manual Position과 Broker Position만 포함하고 Paper Portfolio와 journal, account, cash, position, order, revision, projection을 공유하지 않는다.
- Opening Position은 기준일의 synthetic aggregate lot이며 과거 거래·보유기간·tax lot·realized P&L을 복원하지 않는다. Broker Position은 latest complete Broker Snapshot에서만 갱신하고 사용자가 수정하지 않는다.
- section은 Information Outcome와 `complete | partial | unavailable` completeness를 함께 반환한다. known subtotal, 누락 position과 원통화 값은 표시할 수 있지만 불완전한 total·비중·Rebalancing Proposal은 만들지 않는다.
- Reporting Currency 기본값은 KRW다. 현재 평가와 과거 성과는 각 시점의 실제 Price/FX Evidence를 사용한다. Portfolio Return은 TWR, Personal Return은 유일한 해가 있는 XIRR이고 Performance Coverage 밖에서는 값이 없다.
- Source Cost Basis/Source Realized P&L, fee·tax 포함 여부와 원천을 보존하고 double count하지 않는다. raw Price Basis와 Corporate Action Adjustment를 정확히 한 번 반영한다.
- Portfolio Transfer는 Portfolio Scope 안에서는 external flow가 아니고, scope 경계 현물은 evidence-based fair value가 있을 때만 return용 flow가 된다.
- option, short, margin debt와 미지원 instrument는 signed quantity, source type/value와 opaque source reference로 보존한다. 신뢰 가능한 valuation이 없으면 누락 목록을 만들고 total·비중·Rebalancing Proposal을 unavailable로 둔다.
- Broker Sync lineage는 `ExternalAccountIdentity + verified fingerprint + ProviderDataEpoch`로 식별한다. retained reconnect는 세 값이 모두 맞을 때만 기존 event namespace/dedupe를 잇고 provider ledger reset, 다른 fingerprint·epoch 또는 삭제 완료 뒤 provider ID 재사용은 새 lineage다.
- Broker Sync는 모든 page/component와 bounded skew·absence-vs-zero를 증명하는 CompleteBrokerSnapshot, comparable event/snapshot version, safe/provisional watermark, maximum lateness, fencing token, contiguous projection과 one-transaction commit을 사용한다. maximum lateness를 보장하지 못하면 periodic deep backfill/checksum audit 전 trailing history를 complete로 승격하지 않는다. partial/cursor/schema/re-auth 실패는 마지막 complete Snapshot을 교체하지 않는다.
- complete Broker Snapshot의 current 표시는 마지막 성공 +60초 soft expiry, 15분 hard expiry다. hard expiry 뒤 current Information Outcome은 value가 없고 별도 historical/frozen evidence만 source/as-of와 보여준다. current total·P&L·rebalance·Paper fill 입력에는 사용할 수 없다.
- raw+ledger와 일관되게 restated한 split-adjusted series는 같은 결과를 내고 `total_return_adjusted`는 account P&L 입력에서 거절한다. 합병·분사 basis 근거가 불완전하면 basis/Performance Coverage, 상장폐지 뒤 price가 없으면 valuation을 unavailable로 둔다.
- account 추가·제외·disconnect는 Portfolio Scope membership timeline 변경이며 기존 성과에 조용히 chain-link하지 않고 scope-change break 또는 새 series를 만든다.
- disconnect retain은 frozen Disconnected Broker Account로 남기고 current total에서 기본 제외한다. administrative erasure만 source, projection, cache, outbox/queue, export와 restore suppression까지 제거한다. (`T04`, `T05`, `A04`)

## 9. Paper Trading 요구사항

- Internal Paper Account가 기본이고 초기 상품은 미국·한국 현금 주식/ETF, market/limit, DAY/GTC, regular session이다. short, margin, leveraged borrowing, option order와 Live Trading은 지원하지 않는다.
- Actual, Internal Paper와 Broker Paper reference는 서로 다른 branded type이며 runtime에도 Workspace ownership, account kind, environment와 revision을 재검사한다.
- Paper Order는 submission(`draft | pending_submission | acknowledged | rejected | submission_unknown`), execution(`not_started | open | partially_filled | filled | expired`), cancellation(`none | requested | confirmed | rejected`)을 독립 축으로 보존한다.
- submit은 Paper Order와 Paper Reservation을 같은 account transaction에 만들고 account/order CAS로 overspend·oversell을 막는다. cancel rejection에는 reservation을 유지하고 confirmed cancellation 뒤 late valid fill도 identity로 한 번 반영한다.
- PaperOrderIntent는 browser가 조립할 수 없는 opaque one-time server record이며 Workspace, Viewer Context auth epoch, Paper account kind/id/revision, Provider Connection id/version, paper environment, canonical payload hash, simulation/provider policy, expiry에 묶인다. submit/cancel은 raw wire ID를 cast하지 않고 workspace-scoped repository에서 intent와 account를 다시 해석해 ownership, one-time 상태, cash/position, connection generation과 Evidence를 재검사한다.
- Internal Paper Account의 Simulated Fill은 `market event time > acceptedAt`, 동일 instrument/venue/regular session인 실제 Market Observation, Evidence Reference와 versioned `simulation-v1` policy만 사용한다. delayed feed는 data clock이 acceptedAt을 지난 뒤에만 평가하고 event time/receivedAt을 모두 표시한다. hard-expired/unavailable/failed Evidence에는 fill을 만들지 않는다.
- `simulation-v1`은 account/instrument/observation 활성 주문 전체에 incremental volume 10% 상한, `5 bps + 20 bps × participation` 최대 25 bps slippage, deterministic acceptedAt/order identity allocation과 tick/lot rounding을 사용한다. slippage 적용 가격이 limit을 불리하게 넘으면 fill 0이다.
- Broker Paper는 external stable client order identity와 transactional outbox를 먼저 저장한다. timeout/connection drop은 Submission Uncertainty이고 lookup-before-retry를 수행한다. provider가 lookup/idempotency horizon을 보장하지 않으면 blind retry 없이 `submission_unknown`을 유지한다.
- external order event는 `provider connection + paper account + order + event kind + external identity + revision`으로 durable unique다. 같은 revision의 다른 payload는 Provider Degradation/Reconciliation Issue로 quarantine한다. event append, reducer, reservation, cash/position journal과 outbox는 한 account transaction이고 stream/poll duplicate와 crash redelivery는 같은 공개 상태로 수렴한다.
- Paper Blotter는 account source, submit/fill/cancel/reject/expiry/uncertainty를 시간순으로 보여주고 Actual·Live record를 포함하지 않는다.
- exported HTTP/OpenAPI/generated client에 Live submit operation이 없어야 하고 black-box 요청은 side effect 0인 404/405다. (`T04`, `T05`, `A04`)

## 10. 알림 요구사항

- Alert Rule의 직렬 false→true 전이에서 rule watermark, exactly-one Alert Occurrence와 Notification Record를 같은 transaction에 만든다. stream/poll/replay와 늦은 관측은 같은 전이를 다시 만들거나 watermark를 되돌리지 못한다.
- 로그인 User Workspace의 Notification Record가 정본이다. Web Push/email 미설정·실패·해지에도 남고 read/dismiss는 foreground Viewer Context acknowledgement로만 바뀐다.
- Alert Channel Availability는 deployment readiness, Workspace consent/verified address, device permission/subscription, category quota/circuit을 별도 축으로 보존하고 `ready | configuration_required | unsupported | permission_denied | quota_blocked`로 합성한다.
- Web Push는 직접 사용자 동작 뒤 opt-in하고 HTTPS/service worker/VAPID, install별 binding과 최대 5 endpoint, exact host HTTPS:443, DNS 재검사, redirect 0인 PushTransport를 사용한다. payload는 4,096 bytes 이하의 일반화된 metadata이고 주문 실행/kill switch에 사용하지 않는다.
- Resend email은 소유 domain·완전한 keyring 설정이 있을 때만 선택적으로 활성화한다. 기본 plan 100건/일·3,000건/월 중 security reserve 25건/일·750건/월을 보호하고 optional financial email은 전역 75건/일·2,250건/월, 사용자 5건/일·60건/월 상한을 적용한다. 설정이 없으면 인앱은 정상이고 email만 `configuration_required`다.
- 외부 전달은 Delivery Cause, purpose에 맞는 Delivery Target Reference, immutable template/payload hash와 `(causeId, channel, destinationFingerprint)` unique identity를 가진 Delivery Intent를 durable commit한 뒤에만 시작한다.
- `sourceReference?`와 `deliveryActionMaterialReference?`는 독립 필드다. 허용 조합은 (1) `AlertOccurrence + email + source + UnsubscribeMaterial + WorkspaceFinancialEmailEndpoint`, (2) `AlertOccurrence + web_push + source + no action + WorkspaceWebPushEndpoint`, (3) `verify_email | pending_recovery`의 `AccountSecurityEvent + email + no source + AccountChallengeMaterial + PendingAccountEmailTarget`, (4) 검증된 기존 계정 `sign_in | recovery`의 `AccountSecurityEvent + email + no source + AccountChallengeMaterial + WorkspaceSecurityEmailEndpoint`, (5) allowlisted `authenticated_security_notice`의 `AccountSecurityEvent + email + no source + no action + WorkspaceSecurityEmailEndpoint`뿐이다. 다른 cause·channel·variant·purpose·target 조합은 Intent 생성, renderer와 provider 호출이 모두 0이다.
- WorkspaceSecurityEmailEndpoint account challenge는 AccountChallengeDeliveryContext의 purpose/expiry·account authorization epoch·workspace/account state·verified-address revision·deletion fence를, authenticated security notice는 별도 SecurityNoticeDeliveryContext의 purpose/expiry·security-notice epoch·workspace/account state·verified-address revision·deletion fence를 render와 dispatch 직전에 재검사한다. 두 context는 purpose를 서로 바꿀 수 없고 financial consent와 보통 logout에는 의존하지 않는다.
- PendingAccountEmailTarget challenge는 transient Viewer Context 없이 AccountChallengeDeliveryContext의 pending variant가 pending identity·purpose·request-security epoch·target/action-material expiry와 deletion fence를 render와 dispatch 직전에 재검사한다. pending/workspace variant 교환은 renderer/provider 호출 0이다.
- account challenge renderer만 AccountChallengeMaterial을 해석한다. provider accepted 전 retry는 최초 material/payload hash를 재사용하고 `provider_accepted | definite failure | expiry | accept-unknown reconciliation` 뒤 원문 material을 삭제한다. request/intent crash point마다 event, target, verifier와 material은 all-old/all-new다.
- `provider_accepted`, `delayed`, `delivered`, `seen`, `bounced`, `complained`, `provider_suppressed`, `suppressed`, `failed`, `expired`는 append-only Delivery Fact로만 표시하고 `sent`를 추정하지 않는다.
- financial email은 RFC 8058 one-click unsubscribe와 preferences link를 제공한다. token은 256-bit 이상, hash-only, workspace/endpoint/topic/channel/consent lineage에 묶고 GET은 소비하지 않으며 정확한 urlencoded/multipart POST만 idempotent하게 해지한다.
- Resend webhook ingress는 POST+JSON, header 64개/16 KiB, raw body 256 KiB와 2초 deadline을 buffering 전에 강제하고 peer 10 rps/burst 50, global 50 rps/burst 100을 적용한다. raw signature/timestamp를 parse 전에 검증하고 `(provider, environment, svix-id)` durable inbox로 dedupe한다. Fact는 서버가 저장한 provider message id의 owner(`WorkspaceId | PendingIdentityId`), recipient fingerprint와 template revision에 bind하며 webhook 주장 owner/address를 신뢰하지 않는다.
- erasure webhook fence는 raw provider id의 domain-separated versioned HMAC tombstone을 active와 모든 unexpired previous key로 raw 저장 전에 조회한다. 일치하면 raw body/recipient/inbox write 0과 bounded counter만 허용한다. 마지막 tombstone TTL 전 old key retirement를 거절하고 필요한 previous key가 없으면 raw storage를 fail closed한다.
- unsubscribe ingress는 URL 4 KiB, body 8 KiB, header 64개/16 KiB, 2초 deadline, IP-prefix 10/min·100/day와 global 50/s를 buffering 전에 적용한다. exactly-one urlencoded/multipart `List-Unsubscribe=One-Click` text field만 허용하고 invalid audit은 token-derived key 없이 `route+reason+minute+edgeRegion` counter와 global 20 samples/hour, 24시간 `routes×reasons×regions×1,440+480` row 상한을 지킨다.
- account email abuse limit은 address HMAC 5/15분·20/일, device/session 10/15분·30/일, IP-prefix 30/15분·100/일이다. security reserve 25/일은 untrusted anonymous 10, proof-verified recovery 10, authenticated notice 5의 보호 budget으로 분리하고 한 bucket의 미사용분을 다른 공격 bucket이 빌리지 못한다. 모든 익명 결과는 account 존재와 delivery 여부를 드러내지 않는다.
- in-app cap은 60/시간·300/일 뒤 화면 digest, Web Push는 Workspace 5/5분·20/시간·100/일과 destination 전역 10/s·1,000/일, financial email은 same rule/instrument 30분 cooldown, Resend token bucket은 5 rps다. Quiet Hours는 financial channel만 보류하고 최신 transition sequence와 TTL로 coalesce하며 account security mail과 인앱은 보류하지 않는다.
- financial retry는 즉시/30초/2분/10분/30분/90분 최대 6회와 TTL 또는 2시간 중 이른 시각, account retry는 즉시/5초/30초/2분/10분/30분/2시간/6시간 최대 8회와 token expiry 또는 24시간 중 이른 시각에서 끝난다. 429 request-rate만 Retry-After로 재시도하고 daily quota는 TTL이 reset 뒤까지 유효할 때만 대기하며 monthly quota는 suppress/expire한다. 401/403은 circuit을 열고 permanent 4xx는 재시도하지 않는다.
- PushTransport는 accepted, accept-before-timeout, `400 | 401 | 403 | 404 | 410 | 413 | 429 | 5xx`를 typed outcome으로 분류한다. 404/410은 subscription 비활성·retry 0, 400/413은 영구 payload/config 실패, 401/403은 VAPID circuit open, 429는 Retry-After, network/5xx는 TTL 안의 exponential backoff+jitter다. accept-before-timeout retry도 stable Topic/service-worker tag/notificationId로 화면 알림 최대 1개에 수렴한다.
- provider-accepted external email의 7일 rolling 표본이 200건 이상이고 hard bounce 3% 또는 complaint 0.05%에 도달하면 optional email quality circuit을 연다. 200건 미만의 complaint 1건은 경고와 수동 검토만 만들며, 수동 승인 또는 24시간 뒤 half-open probe로만 복구하고 사유/reset을 감사한다. hard bounce address는 재검증 전 전체 email 중지, complaint는 optional alert opt-out과 address suppression이며 provider suppression을 자동 해제하지 않는다.
- Notification Record 기본 보존 365일, Delivery Fact/webhook audit 90일, 암호화 raw webhook 30일이며 더 짧은 License Scope가 우선한다. account/workspace 삭제는 dispatch fence, processor erasure intent와 backup restore suppression을 포함한다. (`T03`, `T05`, `T06`)

## 11. 성능·신뢰성 예산

### 11.1 release 환경과 server p95

고정 환경은 app/worker 각각 2 vCPU·4 GiB, PostgreSQL 2 vCPU·4 GiB, Redis 1 vCPU·1 GiB, same-region이다. desktop은 Chrome 1366×768, CPU 2배 slowdown, 10 Mbps/40 ms RTT이고 mobile은 Chrome 360×800, CPU 4배 slowdown, 1.6 Mbps/150 ms RTT다. 인터넷을 차단하고 request/page마다 20 ms fixed-delay scripted provider를 사용한다.

표준 fixture는 widget 20, symbol 100, account 5, position 250, Portfolio Activity 20,000, Paper Order 2,000, Alert Rule 50, Notification Record 1,000, Workspace당 Channel Endpoint 5, pending Delivery Intent 1,000(push 600/email 400), Delivery Fact 5,000, webhook inbox 500(미결합 50), 뉴스·공시 각 100, candle 최대 2,520개다.

`cold`는 새 browser profile, HTTP/static cache 없음과 TerminalView application cache miss이고 `warm`은 같은 build의 반복 navigation이다. release runner는 OS/container image, Node와 Chrome major+exact revision을 고정한 전용 runner, monotonic clock과 scenario별 warm-up 5회를 사용한다. cold 40회, warm 100회에서 outlier를 제거하지 않는다. runner termination, clock invalidity 또는 선언 resource 불일치가 artifact로 증명될 때만 suite 전체를 invalid 처리하고 metric 초과를 retry로 숨기지 않는다.

| seam | warm p95 | local cache miss p95 |
| --- | ---: | ---: |
| guest `TerminalView.open` | 250 ms | 550 ms |
| 로그인 Workspace initial | 350 ms | 700 ms |
| cached chart | 250 ms | 500 ms |
| Actual/Paper initial projection | 450 ms | 800 ms |
| NotificationCenter inbox | 200 ms | 400 ms |
| alert/channel/acknowledge command | 300 ms | 500 ms |
| layout/manual activity/Internal Paper command | 350 ms | 600 ms |
| Broker Paper durable acceptance | 450 ms | 700 ms |

### 11.2 browser와 interaction p95

| 대상 | desktop | mobile |
| --- | ---: | ---: |
| cold guest / login shell | 2.0 s / 2.4 s | 3.0 s / 3.4 s |
| warm guest / login shell | 1.0 s / 1.3 s | 1.8 s / 2.1 s |
| cached tab | 200 ms | 300 ms |
| chart selection visible state | 100 ms | 100 ms |
| cached chart paint | 450 ms | 800 ms |
| provider ingress→chart paint | 650 ms | 1,000 ms |
| Portfolio 크게 보기 | 250 ms | 400 ms |
| drag/resize/split input→next paint | 80 ms | 140 ms |
| continuous frame time | 20 ms | 32 ms |
| DB/outbox commit→same revision paint | 750 ms | 1,200 ms |

Web Vitals p75는 LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1, 보조 TTFB ≤800 ms다. device class별 최근 7일 eligible navigation 200개 미만이거나 배포 전이면 고정 lab browser gate가 정본이다.

drag·resize·split은 고정 5초·60 Hz pointer path와 최소 240 frame으로 측정한다. drop→local saved 표시 p95는 100 ms, server confirmation은 desktop 600 ms/mobile 900 ms이며 저장 실패를 관측하면 1초 안에 `저장되지 않음`, local draft와 retry를 표시한다.

### 11.3 worker·deadline·load

- initial emit→권한상 허용된 refresh intent durable enqueue p95 250 ms, enqueue→first claim p95 1.5 s, provider ingress→normalized commit 500 ms, commit→update availability 600 ms, resume catch-up 2 s다.
- Alert Observation→Occurrence/Record commit p95 500 ms, commit→inbox paint p95 desktop 750 ms/mobile 1,200 ms다.
- 표준 Broker Sync는 1 account/10×100 activity/250 position/5 currency에서 browser-visible status p95 5 s, deep rebuild는 20 account/100,000 activity/2,000 position에서 p95 20 s다.
- cache miss는 즉시 pending, 2초 뒤 `공급자 응답 대기`를 추가한다. market/chart/news/filing deadline 10 s, AI 20 s, Broker Sync 30 s 뒤 normalized failure를 표시한다.
- 10분 nominal은 stream 100, mixed HTTP 25 RPS, source event 200/s 중 alert transition 10/s, 평균 payload 1 KiB/p95 4 KiB, fan-out 5, browser delivery 1,000/s, worker 10이다. HTTP mix는 guest 20%, login 15%, chart 20%, Actual/Paper 15%, local mutation 10%, inbox 8%, alert command 7%, Broker Paper 5%이며 route와 delivery worker별 최소 500 sample을 요구한다.
- 5분 stress는 stream 250, HTTP 50 RPS, source 500/s 중 transition 25/s, browser delivery 2,500/s, worker 25이며 route/worker별 최소 250 sample과 nominal p95의 2배 이내를 요구한다. event loss, duplicate side effect, revision reversal, 주문/권한 안전성 오류는 0이고 nominal HTTP error는 주입·예상 4xx 제외 0.1% 미만이다. 무료 외부 API에는 load test를 실행하지 않는다.

## 12. 테스트와 acceptance gate

### 12.1 독립 oracle

`fixtures/spec/**`의 사람이 검토한 literal JSON/CSV가 정본이며 production 계산기, reducer나 transition table을 expected value 생성에 import하지 않는다.

| ID | acceptance test | 필수 결과 | 추적 |
| --- | --- | --- | --- |
| `AT-01` | real-time/delayed/stale/api-required/license-restricted/no-data/failed matrix | 값은 available에만 있고 stale warning·provenance가 정확하다. | `T03`, `T05` |
| `AT-02` | 21개 chart range×interval manifest와 1M/1D 22 bar, 1Y/1W 52 bar golden | request, first/last, count, OHLCV와 접근 가능한 summary가 바뀐다. | `T05` |
| `AT-03` | `changeLayout → open/reload`, same/different key, stale revision, cross-user, guest adoption | idempotent receipt·conflict·rejected·Workspace 격리가 관찰된다. | `T05` |
| `AT-04` | AI material category, consent/rights/key/quota/timeout/redaction matrix | source reference 경로만 provider에 도달하고 forbidden case 호출 0이다. | `T03`, `T05`, `A05` |
| `AT-05` | TWR 21%, XIRR 10%/multi-root unavailable, security+cash FX 10%+20%+2%=32%, gross 20-fee2-tax1=17 | native/Reporting Currency의 시작·종료 가치, 외부 흐름과 P&L component reconciliation 및 incomplete coverage value 없음이 일치한다. | `T04`, `T05` |
| `AT-06` | 2:1 split, raw/restated Price Basis, total-return rejection, GTC/reservation atomicity, transfer, dividend/corporate action, scope add/remove/disconnect | public view가 all-old/all-new이고 중복 수익·event가 없으며 불완전 basis/delisting은 unavailable, scope change는 new series/break다. | `T04`, `T05` |
| `AT-07` | PaperOrderIntent replay/cross-workspace/stale epoch/revision, wire의 Actual account ID를 Paper command로 위조, Internal Paper volume/slippage/limit/data-clock, three-axis literal trace, duplicate/cancel/late fill/concurrent funds | forged Actual ID는 rejected+side effect 0이고, rejected/draft는 execution not_started, ack/valid fill만 open, fill만 position 변경, terminal reservation 규칙과 deterministic convergence를 만족하며 Paper↔Actual 공개 필드는 상호 불변이다. | `T04`, `T05` |
| `AT-08` | Broker Paper four fault points, lookup/idempotency/revoke, stream/poll duplicate, same-revision divergent payload와 crash | 외부 주문 최대 1, blind retry 0, event unique/quarantine와 reservation/cash/position/Blotter atomicity가 일치한다. | `T04`, `T05` |
| `AT-09` | Broker Sync partial component/absence-vs-zero/cursor/late event/correction-reversal/checksum/gap/fence/retained reconnect/new epoch/disconnect/delete와 fixed-clock Snapshot expiry | 이전 complete snapshot 보존, deterministic projection, 올바른 lineage, hard-expired current value 0과 deletion permanence를 보인다. | `T04`, `T05` |
| `AT-10` | 100 concurrent same alert transition, channel eligibility, Push accepted/400/401/403/404/410/413/429/accept-before-timeout/5xx, email bounce·complaint circuit/half-open, webhook/unsubscribe/account challenge | occurrence/record 1, 허용 조합만 Intent, 외부 side effect 최대 1이며 Push retry/subscription/TTL과 email circuit이 10절의 정확한 outcome에 수렴한다. | `T05`, `T06` |
| `AT-11` | vault NIST/tamper/AAD/rotation, auth/rights/deletion race, secret sentinel | fail closed, stale capability commit 0, secret leak 0이다. | `T05`, `T06`, `CFG` |
| `AT-12` | desktop/mobile browser, accessibility, performance/load | 화면 동작과 11절 예산을 모두 만족한다. | `T05`, `T06` |

### 12.2 CI와 외부 contract

- `PR-fast`: typecheck, lint, public seam examples, short fixed-seed property tests.
- `PR-integration`: Docker PostgreSQL·Redis, 실제 worker/Next server, scripted HTTP/WS/Web Push/Resend와 Mailpit, transaction/outbox/race.
- `PR-browser`: Playwright desktop/mobile guest shell, chart, layout, Paper, notification/permission, responsive/accessibility tracer.
- 모든 PR job은 provider secret 없이 localhost·선언 Docker network 밖 egress를 deny한다.
- nightly/release는 긴 property/fault/browser matrix, k6 nominal/stress와 고정 runner 성능을 실행한다. outlier를 제거하지 않고 p95/Web Vitals p75를 pass/fail로 쓴다.
- 실제 data contract는 `RUN_ALPACA_BASIC_DATA_CONTRACT=1`, `RUN_KIS_PERSONAL_DATA_CONTRACT=1`, paper read는 `RUN_ALPACA_PAPER_READ_CONTRACT=1`, `RUN_KIS_PAPER_READ_CONTRACT=1`, mutation은 별도 `RUN_ALPACA_PAPER_ORDER_CONTRACT=1`, `RUN_KIS_PAPER_ORDER_CONTRACT=1`에서만 실행한다. key가 없으면 pass가 아니라 `not_run/api_required` artifact다.
- order smoke는 paper host allowlist, live route 0, capability/idempotency/lookup/cancel을 먼저 검증하고 지원 provider에서 fixed max 1 share 또는 USD 10 notional 중 작은 far-from-market DAY limit만 submit→lookup→cancel→confirmed 후 cleanup한다.
- `free_only`는 paid adapter·route·background schedule을 composition에 등록하지 않고 accidental paid key/registration도 adapter 생성 전 startup reject한다. guest→`free_personal|free_developer`, cross-workspace와 multi-user production env-personal-key fixture는 provider request, public/shared cache, stream, outbox와 AI call이 모두 0이다.

## 13. configuration과 배포

### 13.1 runtime policy

- `APP_ENVIRONMENT`와 canonical `APP_PUBLIC_ORIGIN`, `PROVIDER_BILLING_MODE=free_only`는 필수다. `Host`/`Forwarded`/사용자 URL로 deep link를 조립하지 않는다.
- `LOCAL_PROVIDER_CREDENTIAL_MODE=contract_only`가 기본이다. interactive single-owner development만 `single_owner + LOCAL_PROVIDER_OWNER_WORKSPACE_ID`를 함께 요구하고 staging/production은 이 mode와 process-global Alpaca/KIS key를 startup reject한다.
- `CREDENTIAL_VAULT_PROVIDER=disabled`면 공개 기능은 동작하고 Provider Connection save는 `configuration_required`; development/test `local`, production `kms|secret_manager`만 허용한다.
- process-global Alpaca/KIS key는 scheduled contract 또는 immutable single-owner development만 허용하고 multi-user staging/production에서는 startup reject한다. paper/live secret과 배포 단위를 분리한다.
- `DELIVERY_KEYRING_PROVIDER=disabled`와 `EMAIL_DELIVERY_PROVIDER=disabled`가 안전 기본값이다. 부분 email/VAPID 설정은 adapter, schedule, UI intent와 외부 호출을 fail closed한다.
- Mailpit은 development/test에서만 `v1.30.0` image와 compose-lock digest를 pin하고 relay를 끈다. staging/production의 `EMAIL_DELIVERY_PROVIDER=mailpit`은 startup reject한다.
- Google/GitHub는 `GOOGLE_IDENTITY_* | GITHUB_IDENTITY_*`의 `ENABLED`, server-only `CLIENT_ID`, server-only secret `CLIENT_SECRET`, exact `CALLBACK_PATH`와 Identity adapter 설정이 모두 있어야 entry를 `ready`로 만든다. disabled 상태의 credential, enabled 상태의 누락·부분 설정과 다른 callback path는 startup에서 fail closed한다. 일반 PR은 scripted identity adapter, 실제 sign-in은 exact OAuth host allowlist와 별도 `RUN_GOOGLE_IDENTITY_CONTRACT=1` 또는 `RUN_GITHUB_IDENTITY_CONTRACT=1` opt-in job만 사용하며 raw code/token을 artifact에 남기지 않는다.
- `.env.local`, `.env`, `.secrets/`, Provider Credential, account identifier와 action token은 Git, ZIP, log, screenshot, browser bundle, analytics와 AI prompt에 포함하지 않는다.

### 13.2 배포 산출물

MVP의 배포 기준선은 특정 cloud vendor가 아니라 OCI/Docker 기반의 vendor-neutral production-like bundle이다. 실제 hosting 계정, domain 구매와 외부 배포는 별도 사용자 승인 대상이며, 그 부재가 local release bundle 검증을 막지 않는다.

| 산출물 | 완료 조건 |
| --- | --- |
| application | Next.js TypeScript 모듈형 모놀리스, PostgreSQL, Redis와 별도 worker가 Docker에서 구동된다. |
| local stack | app, worker, PostgreSQL, Redis와 Mailpit local profile을 한 명령으로 시작하고 health/readiness와 migration 절차가 문서화된다. |
| production image | digest-pinned base, immutable image/version, non-root runtime, health/readiness, migration/rollback, backup/restore drill, same-region dependency와 production startup validation을 제공한다. |
| configuration docs | `.env.example`, credential/delivery keyring, provider capability/License Scope, `free_only`, opt-in smoke와 secret rotation runbook이 일치한다. |
| release ZIP | tracked source, lockfile, Docker/compose, migration, docs와 verification manifest를 포함하고 `.git`, `.env*`(단 `.env.example` 제외), `.secrets`, cache/build/test report, raw data와 secret을 제외한다. version·SHA-256·file allowlist를 기록하고 clean temp directory에서 압축 해제→documented command→healthcheck를 검증한다. ZIP은 Git 밖의 release artifact다. |
| 실데이터 screenshot | `guest-desktop-public.png`, `guest-mobile-public.png`, `paper-workspace.png`, `explicit-unavailable.png`를 만든다. 앞의 두 화면은 허용된 실제 공개 정본 값/Evidence, provenance와 Data Freshness를 보여주고 나머지는 Paper 식별과 value 없는 outcome을 증명한다. synthetic fixture·secret·개인 account detail은 포함하지 않고 source/purpose의 screenshot sharing License Scope를 manifest에 기록한다. |
| 운영 문서 | setup, architecture/module seam, data rights/provider matrix, alert/email privacy, backup/restore deletion, test/release report, known deferred features를 제공한다. |

## 14. 구현 ownership과 통합 순서

첫 tracer와 공유 contract가 움직이는 동안 메인 owner가 순차 통합한다. public type, composition root, database migration, barrel/index와 이 spec은 한 명만 수정한다. interface가 고정된 뒤에만 아래 lane을 파일 ownership이 겹치지 않게 병렬화한다.

| ID | vertical slice | Depends on | 병렬 group | critical path | 단일 owned scope | 관찰 가능한 종점 |
| --- | --- | --- | --- | --- | --- | --- |
| `F0` | foundation/contract | None | sequential | yes | composition root, public types, migration, shared index | app/worker/DB/Redis health와 network-off test harness |
| `F1` | guest shell | F0 | sequential | yes | TerminalView presentation + public composition | public official Evidence 또는 정확한 unavailable 상태를 실제 browser에 표시 |
| `F2` | chart | F1 | sequential | yes | FinancialInformation chart + TerminalView chart adapter | 1M/1D→1Y/1W가 실제 bar·화면 값을 변경 |
| `F3` | Identity + layout | F2 | sequential | yes | Identity + TerminalView layout; shared session type는 F0 owner read-only | email/Google/GitHub session, A layout reload, B/guest 격리 |
| `F4` | data outcome + AI | F2,F3 | sequential | yes | FinancialInformation non-chart + ResearchAssistant | available/stale/hard-expired/failed와 모든 자료의 consent/redaction/fallback 완주 |
| `F5` | alert tracer | F3,F4 | P1 with F6 | no | NotificationCenter + delivery adapters | one occurrence, durable inbox, scripted Web Push/email fact 완주 |
| `F6` | Actual baseline | F2,F3 | P1 with F5 | no | ActualPortfolio | Opening Position 표시, Paper 변화로 Actual 불변 |
| `F7` | accounting | F6 | P2 with F8 | no | ActualPortfolio calculation/journal | TWR→XIRR→FX→gross/net→transfer→corporate action literal oracle 추가 |
| `F8` | Internal Paper | F2,F3,F6 | P2 with F7 | no | PaperTrading internal account/simulator | reservation·simulation-v1 fill·state/property 완주 |
| `F9` | Broker Paper | F8 | P3 with F10 | no | PaperTrading broker execution + ProviderConnections paper transport | timeout→lookup 뒤 outbox/revoke fault 완주 |
| `F10` | Broker Sync | F6 | P3 with F9 | no | ActualPortfolio broker sync + ProviderConnections read transport | complete Snapshot 뒤 paging/ordering/late/delete race 완주 |
| `F11` | release integration | F5,F7,F9,F10 | sequential | yes | testing/deployment artifacts; shared edits는 F0 owner | browser/accessibility/performance/load, Docker/ZIP/docs/screenshot gate 통과 |

critical path는 `F0→F1→F2→F3→F4→F11`의 contract/integration chain이며 F11은 P1~P3의 모든 결과도 기다린다. 병렬 group 안에서도 한 파일에는 한 owner만 둔다. public type, composition root, migration, barrel/index와 spec은 F0/main owner만 수정하고 다른 lane은 변경 요청만 보낸다. 각 lane은 source module의 public interface를 read-only contract로 사용하고 공유 contract 변경은 메인 owner 승인 뒤 모든 dependent owner에게 알린다. 기본적으로 메인 owner만 stage·commit한다.

## 15. Definition of Done

### 15.1 이 spec 티켓의 완료 조건

1. 사용자 흐름, 기능/NFR, 데이터 상태, 보안, provider·AI·broker·alert 설정, 배포·문서 산출물이 고유 ID 또는 명시적 section 계약과 source key에 연결된다.
2. public/personal/local과 free/deferred, actual/synthetic, PR network-off/opt-in contract가 서로 모순 없이 구분된다.
3. public/server-only interface, epoch/version owner, implementation ownership·critical path와 acceptance oracle이 후속 구현 ticket을 만들 수 있을 정도로 구체적이다.
4. Critical/High review finding은 0이고 Medium은 해결하거나 영향·연기 사유·후속 ticket을 기록한다.
5. spec, 관련 ADR, ticket/map과 내부 Markdown link·stale-contract·secret 검사가 통과하고 단일 검증 가능한 commit으로 끝난다.

### 15.2 MVP 구현 완료 조건

MVP 구현은 다음이 모두 참일 때만 완료다.

1. `UF-*`, `WS-*`, `SEC-*`, `AT-*`와 module 요구사항이 public interface와 실제 browser에서 관찰된다.
2. PR-fast/integration/browser, nightly/release, secret/redaction/link/stale-contract 검사가 통과한다.
3. Live submit operation·capability·route·generated client가 없고 Actual/Paper storage와 command가 격리된다.
4. 공개/개인/local과 free/deferred 경계, Information Outcome와 synthetic 정책이 production composition에서 fail closed한다.
5. 11절 성능·신뢰성 예산과 event loss/duplicate/revision safety 0건을 고정 release 환경에서 만족한다.
6. Docker local/production-like 실행, migration·rollback·healthcheck와 외부 egress/secret 정책을 검증한다.
7. secret-free ZIP manifest, 운영·구성·권리·테스트 문서와 허용된 실제 데이터 screenshot을 만든다.
8. 실제 provider contract가 실행되지 않은 capability는 `not_run/api_required | configured_unverified | unsupported | license_restricted` 중 정확한 artifact로 남고 가짜 성공으로 완료 처리하지 않는다.
9. 변경된 interface·저장 의미·용어가 CONTEXT와 ADR에 동기화되고 모든 내부 Markdown link가 유효하다.
10. 최종 diff, staged allowlist, `git diff --cached --check`, secret scan과 clean worktree를 확인한다.

## 16. 외부 gate와 잔여 위험

- KRX/Open DART key assignment는 구성됐지만 값·승인·API별 공개 목적 entitlement는 opt-in contract 전 `configured_unverified`다. 승인 전 KRX public value를 활성화하지 않는다.
- Alpaca News, KIS endpoint별 실전/모의 지원·지연, Gemini key/quota와 broker lookup/idempotency는 runtime capability artifact가 필요하다.
- Google/GitHub 운영 OAuth application, verified callback origin과 Identity-owned provider secret이 없으면 해당 로그인 entry는 `configuration_required`이며 email challenge와 guest 공개 화면은 정상 동작해야 한다. 이 token은 Provider Connection/Provider Credential로 저장하지 않는다.
- Resend domain/DNS/key 또는 VAPID가 없으면 인앱만 정상이고 외부 채널은 `configuration_required`다. 실제 push/email smoke는 opt-in/scheduled job에만 둔다.
- 유료 공급자, public redistribution, 실제 지수·옵션·선물, 한국 실시간 시세, 뉴스 전문/번역, export/API와 Live Trading은 사용자 승인·계약·필요 ADR 전까지 보류한다.
- 이 스펙은 구현 기준선이며 현재 저장소에는 아직 실행 가능한 앱, Docker image, ZIP 또는 실데이터 screenshot이 없다. 그 부재를 설계 완료와 혼동하지 않는다.
