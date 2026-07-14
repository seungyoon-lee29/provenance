# 06 - 무료 알림 전달과 운영 이메일 경로 조사

Type: research
Status: resolved
Depends on: 05
Blocked by: None

## Question

구독비 `USD 0/월` 제약에서 인앱·브라우저·이메일 알림 중 어떤 채널을 MVP에 제공하고, 운영 이메일·rate limit·실패·재시도·사용자 동의와 해지 정책을 어떤 무료 또는 자체 호스팅 경로로 검증할 것인가?

## Answer

- 로그인 User Workspace의 인앱 Notification Record를 모든 alert의 durable source of truth로 제공한다. rule watermark, exactly-once Alert Occurrence와 Notification Record를 같은 transaction에 만들고, 동의·설정·권리·만료 검사를 통과한 외부 채널의 Delivery Intent만 만든다. Web Push·email 실패나 해지가 인앱 기록을 삭제하지 않는다.
- 표준 Web Push를 HTTPS·service worker·앱 소유 VAPID 기반의 선택형 best-effort 채널로 제공한다. 최초 화면에서 permission을 요청하지 않고 직접 사용자 동작 뒤 opt-in한다. iOS/iPadOS의 Home Screen 제약, endpoint 만료, TTL, generic lock-screen payload와 per-workspace 구독 격리를 합격 기준에 포함한다.
- 저용량 운영 email은 Resend Free, 로컬/CI capture는 Mailpit을 사용한다. 현재 Resend 무료 한도 100건/일·3,000건/월 중 25건/일·750건/월을 account/security mail에 예약하고 financial alert는 전역 75건/일·2,250건/월과 사용자 5건/일·60건/월 cap을 적용한다. 소유 domain/DNS 또는 key가 없으면 인앱은 정상이고 email만 `configuration_required`다.
- financial email/Web Push는 채널별 명시적 opt-in이다. dispatch 직전 financial email은 workspace membership·consent epoch·verified-address revision, Web Push는 device binding auth epoch·consent·endpoint, pending account email은 purpose·request security epoch·target/token expiry를 재검사한다. email은 preferences link와 RFC 8058 one-click unsubscribe를 제공하고 bounce·complaint 뒤 자동 재활성화하지 않는다. marketing channel은 MVP에 등록하지 않는다.
- `provider_accepted`, `delayed`, `delivered`, `seen`, `bounced`, `complained`, `provider_suppressed`, `suppressed`, `failed`, `expired`를 immutable Delivery Fact로 기록한다. API 2xx와 `email.sent`는 provider 수락일 뿐이고 foreground의 인증된 inbox acknowledgement만 seen이다.
- 모든 외부 전달은 `AlertOccurrence | AccountSecurityEvent` Delivery Cause를 갖고 `(causeId, channel, destinationFingerprint)` DB unique key, outbox와 provider idempotency를 함께 사용한다. timeout/network/5xx와 request-rate 429만 동일 payload로 TTL 안에서 재시도한다. daily quota는 TTL이 reset 뒤까지 유효할 때만 기다리고 monthly quota는 억제·만료하며 401/403은 provider circuit을 연다. 영구 4xx, Push 404/410과 invalid config는 재시도하지 않는다. Quiet Hours·cooldown도 외부 채널만 명시적으로 suppress하고 인앱 기록은 유지한다.
- PushTransport는 허용된 HTTPS push service만 전송하고 private/loopback/alternate-port/redirect/DNS-rebinding SSRF를 차단한다. email·magic-link·unsubscribe는 최소 payload, hash-only token, workspace/purpose/epoch 바인딩과 replay 방지를 적용한다.
- Delivery Intent는 source reference와 action-material reference를 독립 필드로 저장한다. financial email은 source+unsubscribe material+WorkspaceFinancialEmailEndpoint, Web Push는 source+WorkspaceWebPushEndpoint, account challenge는 `channel=email`+account action material+PendingAccountEmailTarget만 허용한다. allowlisted authenticated security notice는 `AccountSecurityEvent + channel=email + WorkspaceSecurityEmailEndpoint`에 한해 두 reference 없이 허용하며 financial consent와 독립된 security-notice authorization을 매 retry 재검사한다. RFC 8058의 urlencoded/multipart one-click POST를 제한적으로 지원하고 invalid-token audit은 고정 cardinality로 제한한다.
- processor erasure tombstone은 domain-separated versioned HMAC을 사용하고 active와 아직 유효한 모든 previous key로 조회한다. old key는 해당 version의 마지막 tombstone TTL까지 read-only로 남겨 rotation 뒤 late webhook이 삭제 데이터를 다시 적재하지 못하게 한다.
- 일반 PR은 외부 egress와 실제 secret 없이 scripted Web Push/Resend adapter와 Mailpit API로 검증한다. 실제 browser·Resend smoke는 opt-in/scheduled job으로 분리한다.

채널별 구조, 상태, retry matrix, consent, rate limit과 16개 합격 기준은 [무료 알림 전달 조사](../../../docs/research/free-alert-delivery.md)에 기록했다.

## Review

security/privacy/data-rights, correctness/reliability, architecture/config/UX 세 관점으로 병렬 검수하고 반복 spot re-review했다. Critical은 없었고 모든 High/Medium finding을 설계와 테스트 기준에 반영했다. 통합 결과는 [티켓 06 설계 검수 보고서](../../../docs/reviews/2026-07-14-ticket-06-design.md)에 기록했다.
