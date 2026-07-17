# 14 - F5 알림·외부 전달 tracer 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 12, 13
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-16T03:46:16+09:00
Last heartbeat: 2026-07-17T11:57:01+09:00
Resolved at: 2026-07-17T11:57:01+09:00

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

## Answer

F5 알림·외부 전달 tracer를 scripted(network-off) lane에서 end-to-end로 완주했다. exactly-once Alert Occurrence spine(serial watermark, 100-concurrent → occurrence/record 1) → 5-tuple Delivery Intent allowlist(Prevent, 판별합집합) → fenced durable outbox(idempotent uniqueKey commit) → SEC-06 dispatch-직전 재검사(worker dispatcher가 B2 resolve를 매 attempt 재호출) → scripted email/push adapter(외부 호출 채널당 ≤1, 동기 임계구역 claim) → append-only Delivery Fact(승격 0) → 정본 인앱 inbox(presenter, promotion-free 라벨) 체인이 모두 실제 모듈로 연결되어 있고, SEC-09 erasure는 실제 IdentityService coordinator(fence-first) 아래에서 occurrence spine + outbox + fact log + webhook inbox + unsubscribe token hash + sealed material + per-user quota + dispatch retry queue를 한 fence로 shred하며 late SIGNED webhook은 erasure tombstone에 흡수된다. 전 과정 배치별 계획(`progress/f5-plan.md` B1~B7c)에 게이트 기록.

## Changed files

- `src/modules/notification-center/`: contracts, occurrence-engine(+acknowledge), fenced-store, delivery-intent, delivery-outbox, delivery-authorization, delivery-fact, channel-availability, push-transport, retry-schedule, email-quota, email-circuit, email-throttle, webhook-ingress, webhook-signature, webhook-inbox, unsubscribe, notification-erasure, dispatch-loop, inbox-presenter.
- `src/platform/delivery/`: delivery-aad, delivery-vault, index.
- `src/app/f5-inbox/page.tsx` (dev-only synthetic 표면), `playwright.performance.config.ts`(perf spec 등록).
- tests: `f5-*.test.ts` 20개(author+blind), `tests/browser/f5-inbox.spec.ts`, `tests/performance/notification-performance.spec.ts`.
- 커밋 체인: 4b8277b→3b7e5ec→3ae246a→5c39436→7414233→44dbfe8→f0ab14c→34298d4→938731c→e6b344b→85fb108→9a28b0b→8532aca→802877c.

## Validation

- `npm run check` green: **782 tests / 59 files** + public/server seam. pre-commit 훅(typecheck+전체 테스트+secret 스캔)을 매 커밋 통과.
- browser: `tests/browser/f5-inbox.spec.ts` 10/10(desktop 1366+mobile 360, 외부 origin 차단·reduced-motion). perf: vitest 예산 3(observe→commit 500ms·commit→first claim 1.5s·inbox open 200/400ms) + playwright paint 2 lanes(750/1200ms) green.
- AT-10: 100-concurrent 동일 전이 → occurrence/record 1·허용 조합만 Intent·외부 호출 채널당 정확히 1 (unit+integration+blind+DOM 4중).
- AT-11: vault NIST/tamper/AAD/rotation(B3.5 blind 28), webhook signature/tombstone rotation·fail-closed(B5 blind 92), coordinator 실통합 receipt=공개 fence(B7c author 5+blind 45). secret sentinel 0(런타임 조립 scripted secret만).
- mutation 게이트 누적: B5 10, B6 5(+blind 3), B7a 5, B7b 3, B7c 2(+blind-단독 3) 전부 kill.

## Review

- 배치별 blind test-authorship(별도 Sonnet, 구현·author 테스트 미열람): B1 33 / B2 54 / B3.5 28 / B5 92 / B6 26 / B7 45 — 각각 import 검사로 blindness 확인, blind-단독 mutation kill로 비공허성 확인. B7 blind가 보고한 후보 버그 3건은 판정 결과 전부 계약 문서 문구 모호성(구현 무결) — 단언 3곳을 판정대로 수정(plan B7c에 공개).
- 자가 발견 결함 2건 수정: quota 시도당 예약(retry가 user 5/day 고갈)→메시지당 1회, cooldown rule 키 콜론 뭉개짐(전역 30분 동결)→seq 벗기기. 둘 다 회귀 테스트 동반.

## Residual risks

- **실 egress 미검증**: 전 lane scripted. 실제 Resend/VAPID/browser push·Mailpit smoke는 opt-in flag 구성 시에만(미구성 시 인앱만 정상 = spec Out of scope 준수). worker 프로세스 상주 dispatch loop·durable DB store·`.secrets` DeliveryKeyring 실로딩은 opt-in 배선 시 composition(F0/main owner) 통합 필요.
- **pending-identity account-scope 매핑 부재**: pending subject의 erasure는 workspace subject 기준으로 동작하나 pending→account 승격 경로의 subject 매핑은 identity 측 협업 필요(cross-module).
- **quota 전역 집계는 in-memory**: 프로세스 재시작 시 리셋(installation-wide 카운터의 durable 저장은 DB store 도입 시).
- **acknowledge 상호작용의 브라우저 검증 없음**: store API+vitest로 검증(F5 AC의 perf 표에는 미포함), 실 UI command 표면은 후속.
