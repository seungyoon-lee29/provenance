# 한국어 금융 터미널

미국 주식 투자자가 미국 및 한국 금융시장 정보, 공시, 뉴스, 포트폴리오와 거래 시뮬레이션을 한 화면에서 이해하고 조작하기 위한 도메인이다.

## Language

**Paper Trading**:
실제 자금이나 실제 브로커 주문을 사용하지 않는 모의 거래 모드. 모든 주문 화면의 기본 모드다.
_Avoid_: 모의 주문, 가상 실주문

**Live Trading**:
사용자가 설정에서 명시적으로 활성화하고 이중 확인을 통과한 뒤 실제 브로커로 전송되는 거래 모드. 초기 산출물에서는 주문 전송이 비활성화된다.
_Avoid_: 실제 모드, 일반 주문

**Paper Blotter**:
Paper Trading 주문의 접수, 체결, 취소와 거절 이력을 시간순으로 보여주는 기록. Live Trading 주문은 포함하지 않는다.
_Avoid_: 주문 내역, 거래 로그

**Actual Portfolio**:
로그인 사용자의 실제 자산을 나타내는 포트폴리오. Broker Position과 Manual Position을 화면에서 합산할 수 있지만 각 보유는 원천 계좌와 출처를 유지하며 Paper Portfolio를 포함하지 않는다.
_Avoid_: 내 포트폴리오, 실계좌

**Paper Portfolio**:
Paper Trading의 현금, 보유 종목, 주문과 체결로만 구성되는 독립된 모의 자산. Actual Portfolio의 평가금액, 손익이나 비중에는 포함되지 않는다.
_Avoid_: 모의 자산, 가상 실계좌

**Internal Paper Account**:
터미널 자체 체결 규칙으로 운영되는 기본 Paper Trading 계좌. 외부 브로커 샌드박스의 주문이나 잔고를 포함하지 않는다.
_Avoid_: 기본 계좌, 가상 브로커

**Broker Paper Account**:
Alpaca Paper나 KIS 모의투자처럼 Broker Connection의 샌드박스에서 주문과 체결 상태를 관리하는 Paper Trading 계좌. Internal Paper Account와 원장 및 주문을 공유하지 않는다.
_Avoid_: 모의 계좌, 브로커 계좌

**Paper Order**:
하나의 Internal Paper Account 또는 Broker Paper Account에 제출되는 안정적인 client order identity를 가진 Paper Trading 지시. 작성할 때 선택한 대상 계좌와 환경은 제출 이후 변경되지 않는다.
_Avoid_: 주문, 가상 주문

**Paper Reservation**:
접수됐지만 아직 완전히 체결되지 않은 Paper Order를 위해 사용 가능한 현금 또는 매도 가능 수량에서 분리한 금액·수량. submission 거절, 확인된 취소, 만료 또는 최종 체결 뒤 남은 부분만 해제하며 취소 요청 거절에는 유지한다.
_Avoid_: 체결 금액, 주문 증거금

**Submission Uncertainty**:
Broker Paper Account가 Paper Order의 접수나 거절을 아직 확인하지 못한 상태. 실패로 단정하거나 같은 주문을 재전송하지 않고 client order identity로 결과를 대조한다.
_Avoid_: 주문 실패, 재시도 대기

**Simulated Fill**:
Paper Order 제출 이후 관측한 실제 Market Observation과 공개된 슬리피지·수수료 가정으로 Internal Paper Account가 만든 체결 결과. 실제 거래소나 브로커 체결을 의미하지 않는다.
_Avoid_: 체결, 예상 체결

**Broker Position**:
Broker Connection을 통해 외부 증권사 계좌에서 동기화한 실제 보유 상태. 원천 증권사 계좌가 기준이며 사용자가 직접 수정하지 않는다.
_Avoid_: 연동 보유종목, 가져온 종목

**Broker Snapshot**:
외부 증권사가 특정 기준 시각에 보고한 계좌의 보유 종목과 현금 상태. 현재 상태의 근거이며 그 자체가 과거 Portfolio Activity를 대체하지 않는다.
_Avoid_: 계좌 원장, 실시간 잔고

**Broker Sync Status**:
Broker Connection 동기화의 진행, 마지막 성공, 최신 아님, 실패 또는 재인증 필요 상태와 기준 시각. 마지막 Snapshot을 현재 값처럼 오인하지 않도록 표시한다.
_Avoid_: Data Freshness, 연결 여부

**Disconnected Broker Account**:
Broker Connection의 Provider Credential이 폐기된 뒤 사용자가 보존하기로 한 정규화 이력. 마지막 동기화 시점에 고정되며 현재 브로커 상태로 취급하지 않는다.
_Avoid_: 연결된 계좌, 삭제된 계좌

**Manual Position**:
Broker Connection이 아닌 사용자의 직접 입력으로 관리되는 실제 보유 상태. Broker Position을 덮어쓰거나 보정하는 용도로 사용하지 않는다.
_Avoid_: 임시 보유, 수정 보유

**Opening Position**:
이전 Portfolio Activity가 없을 때 알려진 기준일의 종목, 수량, 평균단가와 통화를 하나의 synthetic aggregate lot으로 기록한 시작 상태. 기준일 이전의 거래 시점, 실제 tax lot이나 성과를 추정하지 않는다.
_Avoid_: 최초 매수, 과거 거래 복원

**Portfolio Activity**:
특정 포트폴리오 계좌의 증권 또는 현금을 변화시키는 매수·매도, 배당, 수수료, 세금, 입출금, 환전이나 기업행동 기록. 원천, 계좌와 발생 시각을 유지한다.
_Avoid_: 거래 내역, 변경 로그

**Portfolio Transfer**:
같은 소유자의 계좌 사이에서 현금이나 증권을 이동하는 연결된 두 개의 Portfolio Activity. 조회하는 Portfolio Scope 안에서는 외부 입출금이나 매매가 아니며 현물의 원가 출처를 유지한다.
_Avoid_: 입출금, 매수·매도

**Corporate Action Adjustment**:
공식 공시 또는 브로커 근거가 있는 분할, 병합, 종목코드 변경, 합병, 분사, 상장폐지나 현금 대가를 반영하는 Portfolio Activity. 기존 이력을 덮어쓰지 않고 변경 전후 상태와 Evidence를 보존한다.
_Avoid_: 수동 보정, 종목 수정

**Performance Coverage**:
고정된 Portfolio Scope의 시작·종료와 모든 외부 현금흐름 경계에서 Portfolio Activity, 평가 가격과 환율 근거가 충분한 기간. 범위 밖의 수익률은 추정하지 않고 데이터 없음으로 취급한다.
_Avoid_: 조회 기간, 보유 기간

**Portfolio Scope**:
평가와 성과 계산에 포함하는 계좌·자산 집합과 그 membership timeline. 연결 해제나 계좌 추가로 범위가 바뀌면 같은 성과 시계열로 조용히 이어 붙이지 않는다.
_Avoid_: 계좌 필터, 조회 대상

**Reporting Currency**:
여러 통화의 포트폴리오 금액과 성과를 함께 표시할 때 사용자가 선택하는 표시 통화이며 기본값은 KRW다. 원래 거래 통화와 원가는 변경하지 않는다.
_Avoid_: 기준 환율, 계좌 통화

**FX Contribution**:
증권과 현금을 포함한 원통화 가치에 환율 변화가 미쳐 Reporting Currency 기준 성과에 생긴 부분. 자산 가격 성과와 교호항을 조정해 전체 성과와 일치시키며 세무상 환차손익을 의미하지 않는다.
_Avoid_: 환차익, 환율 수익률

**Portfolio Return**:
외부 입출금의 영향을 제거한 시간가중수익률로 나타내는 대표 포트폴리오 성과. Performance Coverage 안에서만 계산하며 FX Contribution을 구분한다.
_Avoid_: 총 수익률, 계좌 수익률

**Personal Return**:
사용자의 입출금 시점과 금액을 반영한 금액가중수익률. 전체 현금흐름이 있는 Performance Coverage에서만 계산한다.
_Avoid_: 실제 수익률, 내 수익률

**Portfolio P&L**:
실현·미실현손익, 배당, 수수료, 세금과 FX translation을 중복 없이 조정한 손익. 원통화와 Reporting Currency 결과를 구분하며 외부 입출금은 포함하지 않는다.
_Avoid_: 계좌 증감액, 총 입출금

**Source Cost Basis**:
외부 증권사가 평균단가 또는 tax lot으로 보고한 원가 정보. source observation은 보존하고 current projection은 명시적인 correction으로만 갱신하며 터미널의 자체 계산으로 덮어쓰지 않는다.
_Avoid_: 분석 원가, 세무 원가

**Source Realized P&L**:
외부 증권사가 gross 또는 net 기준, 포함된 수수료·세금과 계산 기간을 함께 보고한 실현손익. 동일 항목을 Portfolio Activity에서 다시 차감하지 않는다.
_Avoid_: Source Cost Basis, 분석 손익

**Analytic Cost Basis**:
수동 Portfolio Activity에 사용자가 선택한 FIFO 또는 이동평균 방식을 적용한 분석용 원가. 세무 신고 자료가 아니며 Source Cost Basis와 다르면 두 값을 구분해 표시한다.
_Avoid_: 취득가액, 세금 원가

**Declared Dividend**:
회사가 실제 발표해 금액, 통화와 일정의 출처를 확인할 수 있는 배당. 지급 전에는 확정 예정으로, 지급 후에는 실제 Portfolio Activity와 대조한다.
_Avoid_: 예상 배당, 배당 전망

**Dividend Entitlement**:
Declared Dividend의 ex-date·record-date 규칙과 당시 계좌별 보유 이력으로 판단한 받을 권리. declaration의 정정·취소와 별도로 추적하며 보유 이력이 부족하면 금액을 추정하지 않는다.
_Avoid_: 현재 보유 배당, 예상 배당

**Estimated Dividend**:
실제 지급 이력 또는 정식 공급자 전망을 근거로 계산한 미발표 배당 추정치. 계산 방법, 기준일과 데이터 범위를 밝히며 Declared Dividend와 합쳐 확정 금액처럼 표시하지 않는다.
_Avoid_: 확정 배당, 보장 배당

**Target Allocation**:
사용자가 종목 또는 ETF별로 정한 목표 비중과 허용 편차. 설정된 경우에만 리밸런싱 필요 여부를 판단한다.
_Avoid_: 추천 비중, 적정 비중

**Exposure Guardrail**:
섹터, 국가 또는 통화 노출에 사용자가 정한 최소·최대 허용 범위. Target Allocation을 대신해 자동으로 주문 수량을 결정하지 않는다.
_Avoid_: 목표 비중, 투자 제한

**Rebalancing Proposal**:
Target Allocation, Exposure Guardrail과 사용 가능한 실제 시세·환율을 근거로 계산한 매수·매도 제안. 주문이 아니며 사용자의 별도 확인 없이 Paper Trading이나 Live Trading으로 전달되지 않는다.
_Avoid_: 리밸런싱 주문, 자동 매매

**Reconciliation Issue**:
원천 증권사 계좌의 보유·현금 상태와 터미널이 마지막으로 반영한 상태 사이의 확인이 필요한 불일치. Broker Position의 값을 임의로 덮어쓰지 않는다.
_Avoid_: 동기화 오류, 수동 보정

**Broker Connection**:
Provider Connection 중 외부 증권사의 계좌, 보유 종목과 주문 기능을 연결하는 사용자별 연결 정보.
_Avoid_: 브로커 계정, 증권사 로그인

**Data Freshness**:
사용 가능한 시장 데이터가 `실시간`, `지연`, `오래됨` 중 어떤 상태인지 나타내며 출처와 기준 시각을 포함하는 품질 정보. `API 필요`, `데이터 없음`과 공급자 실패는 Information Outcome으로 구분한다.
_Avoid_: 데이터 상태, 업데이트 상태

**License Scope**:
Market Observation 또는 뉴스 콘텐츠를 내부 개발, 사용자 개인 조회, 공개 화면 표시, 재배포 중 어디까지 사용할 수 있는지와 보존, 외부 모델 전송·처리, 번역·요약 같은 파생물 생성을 허용하는지를 요청 목적별로 나타내는 공급자 권리 범위.
_Avoid_: API 권한, 데이터 플랜

**Market Observation**:
특정 시점과 출처에서 관측된 가격, 거래량, 금리, 환율 또는 지표 값. 항상 Data Freshness와 License Scope를 함께 제공한다.
_Avoid_: 시세 숫자, 현재가 데이터

**Price Basis**:
가격 Market Observation이 원시 가격, 분할 조정 가격 또는 배당을 포함한 총수익 조정 가격 중 무엇인지 나타내는 근거. position·cash·basis 원장은 Corporate Action Adjustment를 별도로 적용하고, Price Basis는 일관된 시계열 입력을 선택해 중복 수익을 막는다.
_Avoid_: 수정주가, 종가 종류

**Evidence**:
출처, 기준 시각, License Scope를 추적할 수 있는 Market Observation, 뉴스 원문 또는 공시. AI 번역, 요약과 분석은 사용한 Evidence를 인용한다.
_Avoid_: AI 자료, 참고 데이터

**Evidence Reference**:
Evidence 원문 대신 전달하는 불투명한 참조. 해석할 때마다 Viewer Context, 요청 목적, Data Freshness와 License Scope를 다시 확인하며 Provider Credential이나 원문을 포함하지 않는다.
_Avoid_: 원문 ID, 데이터 URL

**AI Material Reference**:
FinancialInformation, ActualPortfolio 또는 PaperTrading이 자신의 자료를 직접 노출하지 않고 발급하는 purpose-bound 불투명 참조. ResearchAssistant는 클라이언트 raw portfolio·order payload를 받지 않고 각 source module의 server-only resolver로만 해석한다.
_Avoid_: Evidence Reference, 포트폴리오 JSON

**AI Material Envelope**:
Viewer Context, AI Processing Consent와 License Scope를 통과한 AI Material Reference에서 AI task에 필요한 최소 필드만 모은 서버 내부 입력. 모든 지원 자료 유형을 담을 수 있지만 Provider Credential, session/auth token, 원문 계좌번호, 주문 실행 비밀과 직접 식별자는 포함하지 않는다.
_Avoid_: AI 원문 묶음, 비민감 데이터

**AI Processing Consent**:
User Workspace가 선택한 AI provider·model tier, 무료 tier data-use 고지와 약관 버전, 동의 시각·출처와 철회 epoch를 기록한 처리 동의. 자료 유형을 금지하는 분류가 아니라 외부 처리 선택과 철회를 실행 시점에 검증하는 경계다.
_Avoid_: Gemini 설정, AI 허용 여부

**Alert Rule**:
사용자가 정한 조건, 근거 데이터와 freshness 요구, cooldown, 채널과 만료 정책을 가진 알림 규칙. 조건이 실제 Market Observation 또는 Evidence에서 확인될 때만 발화하며 숫자나 사건을 추정하지 않는다.
_Avoid_: 알림 설정, 자동 신호

**Alert Occurrence**:
하나의 Alert Rule condition revision이 이전 false 상태에서 실제 Evidence로 true가 된 전이를 나타내는 durable 사실. rule별 직렬 상태 전이와 source observation identity를 사용해 stream·poll 중복과 늦은 관측이 같은 전이를 다시 만들지 못하게 한다.
_Avoid_: 알림 이벤트, 발송 건

**Alert Observation**:
FinancialInformation 또는 Portfolio module이 Alert Rule의 purpose-bound reference를 Viewer Context로 다시 해석해 제공하는 typed 조건 입력. 비교값, 기준 시각, freshness, License Scope와 source identity를 포함하며 NotificationCenter가 raw 공급자 payload나 opaque reference 내부를 직접 읽지 않게 한다.
_Avoid_: 알림 가격, Evidence 원문

**Account Security Event**:
이메일 확인, magic link, 로그인 또는 credential 변경처럼 Alert Rule과 무관하게 외부 계정 알림을 일으키는 안정적이고 idempotent한 원인. 요청 목적, 익명 요청의 request security epoch 또는 인증 사건의 auth epoch, 만료와 최소화된 purpose-bound actor pseudonym/risk decision만 보존하고 raw IP·전체 user-agent·원문 email을 넣거나 가짜 Alert Occurrence로 표현하지 않는다.
_Avoid_: 보안 알림, Alert Occurrence

**Delivery Cause**:
외부 전달의 원인이 되는 Alert Occurrence 또는 Account Security Event의 tagged identity. Delivery Intent의 중복 제거와 감사 정본이며 원인 종류를 숨기기 위해 synthetic occurrence를 만들지 않는다.
_Avoid_: notificationId, 발송 이벤트

**Notification Record**:
Alert Occurrence 또는 Account Security Event가 만든 User Workspace별 durable 인앱 기록. 있는 경우 FinancialInformation·ActualPortfolio 같은 source module이 발급한 purpose-bound reference를 trigger/as-of 시각, deep link와 읽음·해제 상태와 함께 보존한다. reference 없는 계정 사건도 허용하며 외부 채널 전달 실패나 해지로 삭제되지 않지만 category retention, License Scope 만료와 administrative erasure를 따른다.
_Avoid_: 푸시 알림, 이메일 알림

**Alert Channel Availability**:
deployment provider readiness, User Workspace의 consent·verified address, 현재 device/install의 permission·subscription, category quota·circuit을 별도 축으로 보존하고 요청 문맥에서 `ready`, `configuration_required`, `unsupported`, `permission_denied`, `quota_blocked` 중 하나로 합성한 capability. 다른 device의 Web Push 상태를 전역 상태로 덮어쓰지 않고 개별 Delivery Fact와 혼합하지 않는다.
_Avoid_: 알림 상태, Provider Degradation

**Workspace Channel Endpoint Reference**:
User Workspace의 외부 목적지를 나타내는 `WorkspaceFinancialEmailEndpoint | WorkspaceSecurityEmailEndpoint | WorkspaceWebPushEndpoint` purpose-tagged 불투명 참조. financial email variant는 membership·financial-consent epoch·verified-address revision, security email variant는 membership/account-state·security-notice epoch·verified-address revision, Web Push variant는 device-binding auth epoch·consent version과 credential/key version에 각각 묶인다. security variant는 financial opt-in/opt-out과 독립적이다. 원문 target은 전용 암호화 테이블 밖으로 복사하지 않고 outbox·로그에는 reference와 keyed fingerprint만 사용한다.
_Avoid_: 이메일 주소, push endpoint

**Pending Account Email Target**:
아직 User Workspace나 verified address가 없는 이메일 확인·복구 요청을 위해 Account Security Event, pending identity, purpose와 request security epoch에 묶어 짧게 보존하는 암호화 대상 참조. financial alert에는 사용할 수 없고 원문 주소는 outbox·로그에 복사하지 않는다.
_Avoid_: 임시 이메일, Workspace Channel Endpoint Reference

**Delivery Action Material Reference**:
비동기 email template에 필요한 원문 action secret을 hash-only verifier와 별도로 delivery 전용 envelope vault에 암호화해 가리키는 불투명 참조. `AccountChallengeMaterial | UnsubscribeMaterial` tagged variant이며 전자는 Account Security Event·purpose·expiry와 `pending identity + request security epoch` 또는 `workspace + security endpoint + account authorization epoch`에, 후자는 workspace·endpoint·topic·consent lineage·Delivery Intent에 묶인다. 허용된 renderer만 해석하고 provider 수락·확정 실패·expiry 또는 accept-unknown reconciliation 뒤 원문 material을 삭제한다.
_Avoid_: magic link token, 인증 코드, unsubscribe token

**Delivery Target Reference**:
외부 전달 목적지를 나타내는 `WorkspaceFinancialEmailEndpoint | WorkspaceSecurityEmailEndpoint | WorkspaceWebPushEndpoint | PendingAccountEmailTarget` tagged reference. dispatch는 cause·purpose와 target variant의 허용 조합을 검증하며 익명 보안 메일 때문에 가짜 workspace나 verified address를 만들지 않는다.
_Avoid_: targetReference, 이메일 주소

**Delivery Authorization Context**:
Identity가 transient Viewer Context 없이 발급하는 purpose-tagged `FinancialEmailDeliveryContext | AccountChallengeDeliveryContext | SecurityNoticeDeliveryContext`. 첫째는 User Workspace membership, financial-consent epoch, verified-address revision과 purpose를 확인하고 consent/address 변경, membership 종료와 administrative deletion에 폐기된다. 둘째는 `pending | workspace` tagged context다. pending variant는 pending identity, Account Security Event purpose, request-security epoch, target/action-material expiry와 deletion fence를 확인하고, workspace variant는 검증된 기존 계정의 로그인·복구 purpose/expiry, WorkspaceSecurityEmailEndpoint, account authorization epoch, membership/account active, verified-address revision과 deletion fence를 확인한다. 셋째는 allowlisted authenticated security notice의 event purpose·expiry, workspace membership/account active, security-notice epoch와 verified-address revision을 확인한다. account challenge와 security notice context는 financial consent와 transient login session에는 의존하지 않지만 목적을 서로 바꿀 수 없고 해당 epoch, address/account revision 변경과 deletion fence에는 즉시 폐기된다. Web Push는 별도의 device-binding auth epoch를 사용한다.
_Avoid_: Viewer Context, 로그인 세션

**Delivery Intent**:
Delivery Cause를 Web Push 또는 email로 전달하기 위해 durable outbox에 기록한 idempotent 작업. `(causeId, channel, destinationFingerprint)`로 유일하며 Delivery Target Reference, 적용 가능한 채널 동의, 서로 독립적인 `sourceReference?`와 `deliveryActionMaterialReference?`, 목적별 License Scope snapshot/version, 최초 template revision·payload hash, 만료와 retry policy를 immutable하게 고정하고 외부 호출 전에 저장한다. financial email은 `AlertOccurrence + channel=email + source + unsubscribe material + WorkspaceFinancialEmailEndpoint`, financial Web Push는 `AlertOccurrence + channel=web_push + source + WorkspaceWebPushEndpoint`만 허용한다. account challenge는 `AccountSecurityEvent + channel=email + no source + account action material`에 `PendingAccountEmailTarget` 또는 검증된 기존 계정의 `WorkspaceSecurityEmailEndpoint`를 purpose에 맞게 조합한다. allowlisted `authenticated_security_notice`는 `AccountSecurityEvent + channel=email + WorkspaceSecurityEmailEndpoint`에 한해 두 reference 없이 허용하며, 다른 cause·channel·누락·variant·purpose·target 조합은 거절한다.
_Avoid_: 발송 요청, 알림 queue

**Delivery Fact**:
외부 전달의 queued, provider accepted, delivery delayed, delivered, bounced, complained, provider suppressed, policy/rate/quota suppressed, seen, failed와 expired 시각을 각각 관측 근거와 append-only로 기록한 사실. 앞선 상태를 추정하거나 provider 수락·open/click telemetry를 사용자 열람으로 승격하지 않는다.
_Avoid_: 발송 상태, 성공 여부

**Information Outcome**:
정보 요청의 결과를 `available`, `unavailable`, `failed`로 구분하는 공통 상태. 실제 값은 `available`에만 존재하고, `unavailable`은 `API 필요`, `데이터 없음`, `표시 권한 없음`을, `failed`는 공급자 장애, 제한 초과 또는 잘못된 응답을 나타낸다. 오래된 캐시를 사용할 수 있으면 `available`과 `오래됨` Data Freshness 및 장애 경고를 함께 제공한다.
_Avoid_: 빈 데이터, 임시 값

**Provider Degradation**:
공급자 또는 feed가 정상 결과를 제공하지 못한 원인, 발생 시각, 재시도 가능 여부와 안전한 진단 참조를 담는 정규화된 운영 정보. 원시 공급자 오류나 Provider Credential은 포함하지 않는다.
_Avoid_: API 에러, 예외 메시지

**Provider Credential**:
데이터, AI 또는 브로커 공급자에 접근하기 위한 서버 공용 또는 사용자별 비밀 정보. 사용자별 값은 암호화되어 저장되고 원문은 브라우저로 반환되지 않는다.
_Avoid_: API 설정, 인증 토큰

**Provider Connection**:
데이터, AI 또는 브로커 공급자에 대한 사용자별 연결로, 공급자 종류, Paper 또는 Live 환경, 허용된 용도와 검증 상태를 포함한다. Provider Credential 원문은 연결 정보에 노출하지 않는다.
_Avoid_: API 키, 외부 계정

**Viewer Context**:
요청자가 비로그인 방문자인지 로그인 사용자이며 어떤 User Workspace에 접근할 수 있는지를 나타내는 신뢰된 실행 문맥. Identity만 생성하고 불변의 인증 epoch에 묶으며, 클라이언트가 임의의 사용자 ID로 대체할 수 없다. 로그인, 로그아웃 또는 User Workspace 전환은 기존 문맥을 폐기한다.
_Avoid_: userId, 로그인 여부

**User Workspace**:
로그인한 사용자의 포트폴리오, 관심종목, 레이아웃, 알림과 Provider Credential을 함께 소유하는 개인화 영역.
_Avoid_: 사용자 설정, 내 계정
