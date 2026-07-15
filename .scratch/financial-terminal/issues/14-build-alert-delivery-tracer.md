# 14 - F5 알림·외부 전달 tracer 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 12, 13
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-16T03:46:16+09:00
Last heartbeat: 2026-07-16T03:55:30+09:00

## Objective

Alert Rule 한 개의 exactly-once Alert Occurrence, durable inbox와 허용된 Web Push/email Delivery Fact를 scripted adapter로 end-to-end 완주한다.

## Owned scope

- `src/modules/notification-center/**`, `src/platform/delivery/**`, service worker notification code.
- ChannelEndpointVault, DeliveryActionMaterialVault와 DeliveryKeyring의 delivery 전용 구현.
- alert/email/push/webhook/unsubscribe fixture, worker/integration/browser test.
- shared contract/composition/migration/index는 F0/main owner가 변경 요청을 통합한다.

## Requirements

- rule watermark, Alert Occurrence와 Notification Record를 한 transaction에 만들고 stream/poll/replay를 dedupe한다.
- exact 다섯 Delivery Intent cause/channel/source/action/target 조합 외 모든 variant를 생성 전에 거절한다.
- financial/pending/workspace/security purpose별 delivery resolver, License Scope와 deletion fence를 render/dispatch 직전에 재검사한다.
- PushTransport SSRF, Topic/tag dedupe, TTL/retry; Resend quota/reserve/abuse/retry/quality circuit; webhook inbox/tombstone과 RFC 8058 unsubscribe를 구현한다.
- Delivery Fact는 append-only이고 provider accepted/open/click을 delivered/seen으로 승격하지 않는다.
- NotificationCenter erasure receipt는 Alert Rule·watermark/state·Occurrence·Account Security Event·channel evaluation, Notification Record, Intent/Fact, endpoint/target/action material, webhook inbox, token hash, per-user quota/abuse key, alert cache와 pending queue를 fence 뒤 제거하고 restore suppression을 유지한다.

## Interface contract

- `NotificationCenter.*`, injected AlertObservationResolver와 `AccountSecurityDelivery.plan`만 source/Identity와 협업한다.
- raw Evidence/provider payload/target/action token/session issuer를 읽지 않는다.
- 실제 external adapter는 durable Intent commit 후 worker에서만 호출한다.

## Acceptance criteria

- 100 concurrent same transition에서도 occurrence/record 1, 허용 조합만 Intent, 외부 side effect 최대 1이다.
- Push accepted/400/401/403/404/410/413/429/accept-before-timeout/5xx가 retry/subscription/TTL/Topic 규칙에 수렴한다.
- email bounce 3%, complaint 0.05%, half-open, quota reserve, Quiet Hours와 exact financial/account retry를 고정 clock으로 검증한다.
- account challenge action material, webhook signature/inbox/erasure rotation, unsubscribe ingress/flood/lineage와 purge race가 `AT-10/11`을 통과한다.
- administrative deletion 뒤 action-material/session delivery resolve, webhook inbox write, retry/dispatch와 Notification Record 조회가 0이며 module/processor receipt가 coordinator 공개 상태와 일치한다. backup restore와 late signed webhook도 개인 delivery state를 재생성하지 않는다.
- inbox open 200/400 ms, occurrence commit 500 ms, eligible Intent first claim 1.5초와 browser paint 예산을 통과한다.

## Out of scope

- SMS, messenger, marketing과 주문/kill-switch 전달.
- PR은 scripted Web Push/Resend와 Mailpit `v1.30.0`; 실제 Resend/VAPID/browser push는 opt-in이며 미구성 시 인앱만 정상이다.

## Traceability

- [승인 spec](../spec.md) `UF-08`, `WS-06`, §10~12, F5, `SEC-05/06/09`, `AT-10/11`; `T06`.
