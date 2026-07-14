# 티켓 06 무료 알림 설계 검수

- 검수일: 2026-07-14
- 범위: 무료 알림 전달, provider 환경변수, Gemini/KIS/Alpaca 정책 변경과 관련 module/test contract
- 결과: Critical 없음. 모든 High와 Medium finding을 설계·합격 기준에 반영했고 최종 spot re-review를 수행했다.

## 운영 방식

메인 에이전트가 의존성과 통합 결정을 소유하고 security/privacy/data-rights, correctness/reliability, architecture/config/UX 세 관점에 읽기 전용 병렬 검수를 배정했다. reviewer는 파일·라인 근거가 있는 finding만 보고했고, 같은 원인은 하나로 합쳐 높은 severity를 적용했다. High는 모두 수정하고 Medium도 연기하지 않고 같은 설계 ticket에서 해결했다. 수정 뒤에는 같은 reviewer에게 잔여·회귀만 묻는 spot re-review를 반복했다.

## 해결한 High

1. process-global Alpaca/KIS 개인 credential이 다른 workspace에 사용될 수 있던 경계를 local contract 또는 immutable single-owner로 제한하고 multi-user production에서 거절했다.
2. Web Push endpoint를 범용 URL fetch처럼 취급하던 SSRF 위험을 exact host registry, DNS 재검증, private/reserved 주소 차단, redirect 0인 전용 PushTransport로 닫았다.
3. 외부 email/Web Push 전에 source-owned reference의 목적별 License Scope를 render와 dispatch 양쪽에서 다시 확인한다.
4. security email, magic link와 unsubscribe의 최소 payload, token hash·binding·replay와 enumeration 방어를 명시했다.
5. Alert Occurrence와 rule watermark, Notification Record를 한 transaction에서 exactly once로 만들고 public NotificationCenter seam을 추가했다.
6. provider 2xx와 `email.sent`를 전달 완료로 오인하지 않고 append-only Delivery Fact로 정규화했다.
7. Resend usage snapshot, local accepted delta, outstanding reservation과 security reserve를 원자 quota ledger로 계산한다.
8. account email의 address/device/IP 및 전역 abuse 경계를 두고 untrusted, proof-verified recovery와 authenticated notice budget을 격리했다.
9. ResearchAssistant가 portfolio/order raw payload를 받지 않고 source-owned AI Material Reference와 resolver, workspace consent/cache identity를 사용하게 했다.
10. NotificationCenter와 portfolio 계산도 각각 AlertObservationResolver와 PortfolioEvidenceResolver를 사용해 범용 Evidence getter를 만들지 않게 했다.
11. Delivery Intent identity에서 template revision을 제거하고 `(causeId, channel, destinationFingerprint)`를 고정해 배포 뒤 중복 발송을 막았다.
12. AlertOccurrence와 AccountSecurityEvent를 Delivery Cause union으로 만들고 익명 계정 메일도 같은 outbox·idempotency·quota 경계를 통과시켰다.
13. WorkspaceChannelEndpoint와 PendingAccountEmailTarget을 Delivery Target Reference로 분리해 가짜 workspace·verified address 생성을 막았다.
14. financial email, Web Push와 pending account email의 authorization 수명주기를 각각 consent/address, device binding, request security epoch로 분리했다.
15. Resend Free가 본문과 token을 처리·저장할 수 있음을 고지하고 즉시 processor 삭제가 필요한 content는 인앱-only로 제한했다.
16. Identity가 account email request와 magic-link consume/session issuance를 소유하고 durable account-security projection만 NotificationCenter에 넘기게 했다.

## 해결한 Medium과 Low

- raw destination 복제를 없애고 keyed fingerprint의 version rotation, endpoint envelope encryption과 AAD·rewrap contract를 추가했다.
- webhook을 서명 검증 뒤 durable inbox에 저장하고 provider message/workspace/recipient/template binding, webhook-before-ack와 crash dedupe를 정의했다. Svix timestamp freshness와 event ordering 시각도 분리했다.
- AI 무료-tier 처리 고지와 철회를 workspace별 감사 가능한 consent로 만들고 source-owned provenance를 보존했다.
- one-click unsubscribe는 active consent lineage 동안 과거 token도 실제 해지하며 re-opt-in은 새 lineage로 격리한다.
- push Topic/service-worker tag/client dedupe, typed 429, 401/403 circuit, Quiet Hours ordering, destination request cap과 `seen` acknowledgement를 명시했다.
- VAPID·Resend·fingerprint·endpoint key의 local/production source를 DeliveryKeyring 하나로 통합하고 previous-key `notAfter`와 emergency revoke를 추가했다.
- CredentialVault는 기본 disabled, local 32-byte KEK 또는 production KMS/Secret Manager를 명시하며 plaintext fallback을 금지했다.
- 익명 actor context를 purpose-bound pseudonym으로 최소화하고 target/event/abuse TTL, 미가입 주소 DSAR와 processor erasure 상태를 정의했다.
- manual fallback code의 entropy, attempt cap, link와의 원자적 상호 폐기 및 session 최대 하나를 고정했다.
- Alert Channel Availability를 deployment/workspace/device/category 축으로 분리하고 설정·permission·quota 상태를 개별 Delivery Fact와 섞지 않았다.
- notification inbox/command/occurrence latency 예산, alert fixture와 nominal/stress load mix를 추가했다.
- permission, iOS fallback, preferences, unsubscribe, magic-link와 email HTML까지 접근성 합격 기준에 포함했다.
- Low finding인 이동하는 Mailpit tag 사용을 제거하고 `v1.30.0`과 compose lock digest pin을 요구했다.
- Delivery Intent의 source reference와 action-material reference를 독립 필드로 고정하고 financial email, Web Push와 account challenge의 허용 조합을 property test로 닫았다.
- erasure tombstone 전용 domain-separated HMAC key/version과 모든 unexpired previous-key lookup을 추가해 rotation 뒤 late webhook 재적재를 막았다.
- RFC 8058 one-click POST의 urlencoded/multipart 두 형식을 엄격한 단일 field·크기 제한으로 허용하고, invalid token 감사는 고정 cardinality counter와 전역 reservoir 상한으로 바꿨다.
- source/action material이 없는 authenticated security notice를 Account Security Event와 purpose-tagged WorkspaceSecurityEmailEndpoint의 allowlisted purpose로만 허용하고 pending/financial target·다른 purpose를 거절했다. 전용 AAD와 SecurityNoticeDeliveryContext가 financial opt-out과 독립적으로 address/security revision·account state·deletion fence를 재검사한다.
- MVP account challenge는 Identity가 같은 transaction에 만드는 PendingAccountEmailTarget만 허용해 workspace endpoint용 별도 AAD·retry 문맥이 암묵적으로 열리지 않게 했다.

## 검증 결론

관련 설계는 [무료 알림 전달 조사](../research/free-alert-delivery.md), [공급자 환경변수 계약](../configuration/provider-credentials.md), [CONTEXT](../../CONTEXT.md), 티켓 03~06과 테스트 seam에 동기화했다. 실제 Resend/Web Push/provider smoke는 일반 PR이 아니라 secret과 egress를 명시적으로 허용한 scheduled contract에서만 실행한다.
