# 03 - 데이터와 사용자 모듈의 인터페이스 설계

Type: grilling
Status: resolved
Depends on: 01
Blocked by: None

## Question

시장 데이터 공급자, 뉴스 번역, AI 분석, 사용자 인증과 Provider Credential을 작은 인터페이스 뒤에 숨기면서 실제·지연·실패 상태를 일관되게 다루는 깊은 모듈과 seam은 무엇인가?

## Answer

다음 여섯 모듈을 경계로 채택한다. 각 모듈은 작은 공개 interface 뒤에 공급자 선택, 정책, 캐시와 폴백을 숨기는 깊은 module이며, 공급자별 구현은 내부 adapter로만 둔다.

1. `FinancialInformation`
   - `read(query, viewer)`와 `follow(query, viewer)`만 공개한다.
   - 시장 데이터, 뉴스 원문과 공시를 공통 Evidence로 정규화하고 공급자 선택, 캐시, Data Freshness와 License Scope 판정을 내부에 둔다.
   - `EvidenceResolver.resolve(reference, purpose, viewer)`는 ResearchAssistant에만 주입하는 server-only collaboration interface다. 화면 route와 공급자 adapter에는 export하지 않는다.
   - `PortfolioEvidenceResolver.resolve(reference, calculationPurpose, viewer)`는 ActualPortfolio/PaperTrading에만 주입해 가격·FX·배당·기업행동 Evidence를 typed calculation input으로 해석한다. ResearchAssistant용 resolver와 권한·목적을 공유하거나 범용 getter로 노출하지 않는다.
   - 별도 `AlertObservationResolver.resolve(reference, condition, viewer)`는 NotificationCenter에만 주입한다. purpose-bound reference를 현재 Viewer Context·freshness·License Scope로 재검사해 typed Alert Observation을 반환하고 raw provider payload를 노출하지 않는다. ActualPortfolio도 포트폴리오 조건용 같은 interface를 소유한다.
2. `ResearchAssistant`
   - `run(task, materialReferences, viewer)`를 공개해 번역, 요약과 분석을 수행한다. `materialReferences`는 source module이 발급한 `AI Material Reference[]`만 허용하고 client가 만든 raw Evidence·portfolio·order payload는 거절한다.
   - Gemini와 로컬 규칙 엔진은 adapter다. Gemini를 선택하고 key가 있으면 시장·뉴스·공시·차트·Actual/Paper Portfolio와 주문 문맥을 포함한 모든 지원 task와 자료 유형에 우선 사용한다. 자료 유형만으로 Gemini를 차단하지 않는다. key 부재, quota·timeout·5xx에는 지원 task의 로컬 규칙으로 폴백하고, 지원하지 않으면 원인에 맞는 `api_required` 또는 `failed`를 반환한다.
   - FinancialInformation의 `EvidenceResolver`와 ActualPortfolio/PaperTrading이 소유한 purpose-bound `AiMaterialResolver`를 composition root에서 server-only로 주입한다. 각 resolver가 Viewer Context, source ownership, AI Processing Consent와 License Scope를 다시 확인한 뒤 최소화·redaction된 AI Material Envelope만 만든다. Provider Credential, session/auth token, 원문 계좌번호, 주문 실행 비밀과 직접 식별자는 포함하지 않는다.
   - 개인 자료 job/result/cache identity는 `workspace + auth epoch + task + material hash + License Scope/redaction/consent/model policy version`을 포함한다. commit과 emit 직전에 다시 검사하고 철회·workspace switch·credential rotation·administrative erasure 때 pending job과 개인 cache/result를 무효화한다. 개인 결과를 public/shared cache에 넣지 않는다.
   - License Scope가 파생물 생성을 허용하지 않으면 Gemini와 로컬 규칙을 모두 호출하지 않고 value 없는 `license_restricted`를 반환한다. 파생물은 허용하지만 외부 모델 처리만 금지된 경우에는 지원 가능한 로컬 규칙을 사용하고, 지원하지 않으면 `license_restricted`다.
   - 결과 provenance는 입력한 source-owned AI Material Reference와 그 자료가 인용한 Evidence Reference를 함께 보존한다. 개인 reference는 원래 User Workspace와 auth/consent epoch 안에서만 해석하고 파생 결과는 입력보다 넓은 License Scope를 가질 수 없다.
3. `Identity`
   - presentation용 interface는 `resolve(sessionProof)`, `requestAccountEmail(command, clientProof)`와 `consumeAccountChallenge(command: { kind: "link" | "manual_code"; proof: string }, clientProof)`다. request command는 이메일 확인·복구 목적만 받고 enumeration-safe outcome을 반환하며, consume command는 두 challenge 종류 모두 같은 family row·attempt counter를 사용해 CSRF-protected POST에서 compare-and-consume와 session issuance를 한 transaction으로 처리한다.
   - 비로그인 방문자는 즉시 guest 문맥을 받고, 로그인 사용자의 User Workspace 접근은 검증된 세션에서만 부여한다.
   - requestAccountEmail은 최소화된 Account Security Event, PendingAccountEmailTarget, hash-only verifier와 별도의 envelope-encrypted `DeliveryActionMaterialReference<AccountChallengeMaterial>`을 같은 transaction에 저장하고 durable internal event를 낸다. NotificationCenter의 server-only `AccountSecurityDelivery.plan(eventReference)`가 이를 exactly-once Delivery Intent로 투영하고 account-security renderer만 server-only resolver로 action material을 해석한다. provider 수락·확정 실패·expiry 뒤 material을 삭제하며 다른 module은 원문 주소·token/code 또는 session issuer에 접근하지 않는다.
   - 공개 수집 worker는 FinancialInformation 내부 구현으로 둔다. 사용자별 작업은 queue에 Viewer Context를 직렬화하지 않고 Identity가 발급한 만료 가능한 `JobContextReference`만 저장하며, Identity의 server-only collaboration interface인 `resolveJob(reference)`가 실행 시점의 최소 권한 Viewer Context를 다시 만든다.
   - 지속형 financial email worker에는 transient session이 아니라 server-only `resolveFinancialDelivery(reference)`가 workspace membership, financial-consent epoch와 verified-address revision을 재검사해 FinancialEmailDeliveryContext를 발급한다. `resolveSecurityNoticeDelivery(eventReference, endpointReference)`는 별도로 allowlisted Account Security Event purpose/expiry, workspace membership/account active, security-notice epoch, verified-address revision과 deletion fence를 재검사해 SecurityNoticeDeliveryContext를 발급한다. 둘 다 보통 logout만으로 폐기되지 않지만 financial context는 consent/address/membership 변경, security context는 address/security revision/account state 변경과 administrative deletion에 폐기된다.
4. `ProviderConnections`
   - 모든 `list`, `save`, `verify`, `revoke` 명령은 Viewer Context를 필수로 받고 User Workspace를 내부에서 파생한다. 외부 `userId` 또는 `workspaceId`를 권한 근거로 받지 않으며 연결 소유권과 capability를 명령마다 다시 검사한다.
   - Provider Credential을 반환하는 getter는 만들지 않는다. `ProviderAuthorization.authorize(connection, purpose, viewer)`는 공급자 adapter 조립 코드에만 주입하는 server-only collaboration interface다.
   - 이 interface가 발급하는 `AuthorizedTransport`는 Viewer Context, Provider Connection, 공급자, Paper/Live 환경, capability, credential version과 만료에 묶인다. adapter는 등록된 route와 정제된 payload만 요청할 수 있고 임의 origin, 인증 header 또는 cross-origin redirect를 지정할 수 없다. 응답, 오류와 로그에는 비밀 redaction을 적용한다.
   - 연결 검증 adapter는 ProviderConnections가 소유하며 FinancialInformation이나 ResearchAssistant를 역호출하지 않는다.
5. `NotificationCenter`
   - `open(request, viewer)`, `changeRule(command, control, viewer)`, `changeChannel(command, control, viewer)`와 `acknowledge(command, control, viewer)`를 공개해 Alert Rule, Alert Channel Availability, Notification Record와 Delivery Fact를 관리한다.
   - Alert evaluator는 FinancialInformation 또는 ActualPortfolio가 발급한 purpose-bound reference를 주입된 `AlertObservationResolver`로 해석한 typed Alert Observation과 clock만 사용한다. opaque Evidence Reference 내부나 raw provider payload를 직접 읽지 않는다. rule 상태 전이와 Alert Occurrence를 하나의 transaction에서 직렬화하고 같은 occurrence의 stream·poll·worker replay는 unique identity로 no-op한다.
   - Delivery Intent의 `sourceReference?`와 `deliveryActionMaterialReference?`는 독립 필드다. financial email Intent를 만들 때 source reference, consent-lineage-bound unsubscribe token의 hash verifier, `DeliveryActionMaterialReference<UnsubscribeMaterial>`과 WorkspaceFinancialEmailEndpoint를 같은 transaction에 만들고 하나라도 없으면 거절한다. financial Web Push는 source reference와 WorkspaceWebPushEndpoint만, MVP account challenge는 `channel=email`과 `AccountChallengeMaterial`·PendingAccountEmailTarget만 허용한다. allowlisted `authenticated_security_notice`는 `AccountSecurityEvent + channel=email + WorkspaceSecurityEmailEndpoint`에 한해 두 reference 없이 허용하고 pending/financial/push endpoint·다른 purpose는 거절한다. renderer는 provider 수락 전 retry에서 같은 material/payload hash를 재사용하고 accepted·확정 실패·expiry 뒤 원문 material만 삭제한다.
   - 외부 adapter는 Delivery Intent가 durable commit된 뒤 worker에서만 호출한다. financial email은 workspace membership·financial consent epoch·verified-address revision·License Scope·expiry, Web Push는 device binding auth epoch·consent·License Scope·expiry, pending account email은 Account Security Event purpose·request security epoch·target expiry, authenticated security notice는 purpose/expiry·workspace/account state·security-notice epoch·verified-address revision·deletion fence를 dispatch 직전에 다시 검사한다. transient login session epoch를 지속형 financial email consent나 security-notice epoch로 사용하지 않는다.
6. `TerminalView`
   - 위 다섯 모듈을 조합하는 application module이다.
   - `open(request, sessionProof)`는 공개 캐시와 로컬 읽기만 기다린 `initial` 화면과 시장 갱신, 개인화, 뉴스, 공시, AI 결과를 전달하는 `updates` 스트림을 반환한다. 느린 한 패널이 다른 패널을 막지 않는다.
   - `changeLayout(command, control, sessionProof)`는 로그인 User Workspace의 widget 위치·크기와 panel 폭을 revision·idempotency 조건으로 저장한다. guest layout은 browser local draft이며 로그인 후 사용자가 명시적으로 채택하기 전에는 사용자 설정에 병합하지 않는다.
   - `initial`의 각 패널은 `pending` 또는 `ready(InformationOutcome)`다. cache miss는 `pending`을 즉시 반환하고 독립적인 시장 refresh를 예약한다. 오래된 cache는 즉시 표시한 뒤 같은 방식으로 revalidate한다.
   - 각 update는 `panelKey`, `requestRevision`과 Information Outcome을 포함한다. 패널 사이의 순서는 독립적이며 TerminalView가 merge, dedupe, completion, retry와 최신 revision 교체를 소유한다. 새 요청이나 연결 종료는 superseded 작업을 취소한다.
   - Viewer Context의 인증 epoch가 바뀌면 기존 stream을 종료하고 다시 `open`한다. 개인화 작업은 결과를 내보내기 직전에 epoch와 권한을 재검사한다.

모든 정보 interface는 하나의 `InformationOutcome<T>` seam을 사용한다.

- `available`: 실제 값, Evidence Reference, `provider`, `feed`, 선택적 `venue`, 기준·수신 시각, Data Freshness와 License Scope를 포함한다. Data Freshness는 이 provenance와 feed 계약을 기준으로 계산한다.
- `unavailable`: 값 없이 `api_required`, `no_data`, `license_restricted` 이유를 포함한다.
- `failed`: 값 없이 정규화된 Provider Degradation을 포함한다.
- Provider Degradation에는 `provider`, `feed`, 정규화된 `code`, 발생 시각, 재시도 가능 여부, 선택적 `retryAfter`와 불투명한 진단 참조가 있다.
- 사용 가능한 캐시가 있으면 실패 대신 `available`로 반환하되 Data Freshness를 `오래됨`으로 표시하고 같은 Provider Degradation을 붙인다. 원시 공급자 예외나 가짜 값은 interface 밖으로 내보내지 않는다.

캐시의 soft expiry, hard expiry와 stale-if-error 허용 범위는 provider/feed의 공표 주기, 계약과 rate limit에 따라 정한다. 동일 cache-fill은 합치고, hard expiry가 지난 값은 장애 시에도 표시하지 않는다. 구체적인 시간과 성능 합격 기준은 티켓 05에서 확정한다.

모듈 간 seam은 단방향이다. `TerminalView`만 공개 모듈들을 조합하고, `ResearchAssistant`는 각 source module의 server-only resolver로 AI Material Reference를 다시 해석한다. NotificationCenter는 FinancialInformation·ActualPortfolio가 주입한 AlertObservationResolver로 purpose-bound reference를 typed Alert Observation으로 해석하고 provider SDK를 직접 호출하지 않는다. 데이터·AI·delivery adapter는 `ProviderConnections` 또는 전용 allowlisted transport만 사용하며 서로 직접 호출하지 않는다. server-only collaboration interface는 composition root에서 주입하고 presentation layer import를 금지한다. UI와 백그라운드 작업은 공급자 SDK가 아니라 이 module interface에만 의존한다. 이 구조는 교체 가능한 adapter의 유연성을 유지하면서 정책과 실패 처리의 locality, module depth와 interface leverage를 높이고 Identity·자격증명·콘텐츠 권리의 보안 경계를 한곳에 둔다.

## Review

2026-07-14에 architecture, security·data rights, performance·operations 세 관점으로 병렬 검수했다. 중복 finding은 합치고 높은 심각도를 적용했으며, 발견된 구조적 문제는 위 결정에 반영했다. 수치 성능 예산, 암호 구현과 장애 주입 검증은 티켓 05의 테스트 seam에서 확정한다. 통합 결과는 [설계 검수 보고서](../../../docs/reviews/2026-07-14-ticket-03-design.md)에 기록했다.
