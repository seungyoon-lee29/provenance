# F5 (ticket 14) 진행 — 알림·외부 전달 tracer

Owner: main-agent. Claimed 2026-07-16T03:46:16+09:00. 기준 규칙: `docs/agents/collaboration.md`(프로젝트 내부 규칙), spec §10~12·F5·UF-08·SEC-05/06/09·AT-10/11.

## Blast-radius 프레이밍 (docs/agents/collaboration.md "검증 깊이와 blast radius")
- **되돌릴 수 없는 위험**: (1) 외부 egress(email/push가 실수신자에게), (2) exactly-once 위반 → 중복 외부 side effect(더블 email/push), (3) erasure 미완주 → 삭제 뒤 개인 delivery state 재생성.
- **Contain(핵심, blast radius 축소)**: 전 external adapter를 network-off scripted lane으로(실 Resend/VAPID/browser push는 opt-in flag-default-off, 미구성 시 인앱만 정상). Delivery Intent는 durable commit 후에만 발사 + `(causeId, channel, destinationFingerprint)` unique → idempotency. Delivery Fact append-only. Erasure fence + restore suppression(F4 `PersonalCacheStore`·F3 `ErasureParticipant` 패턴 재사용). → 최상위 자동승격이지만 contain 후 High-tier(blind test-authorship)로 충분.
- **Prevent(타입으로 불법상태 제거)**: 5-tuple Delivery Intent allowlist를 판별합집합으로 → 허용된 5개 (cause,channel,source?,action-material?,target) 외 조합은 표현 불가(typecheck 강제). 결과는 shared `InformationOutcome`/전용 outcome. endpoint/target/action-material/keyring/cause는 branded reference. exactly-once = serial rule watermark + unique 제약.
- **Detect(독립 oracle)**: `fixtures/spec/f5/**` 사람 검토 literal이 정본(고정 clock). **blind test-authorship**: exactly-once(100-concurrent, AT-10)과 erasure(SEC-09) acceptance는 구현 미열람·spec만으로 별도 에이전트가 작성. 내가 이번 변경에서 쓴 테스트는 decorrelation 근거로 안 침.

## 추론 강도 (collaboration.md "추론 강도")
- exactly-once/idempotency·동시성·삭제/복구·vault(credential material)·외부 egress 경로 = **XHigh**. 5-tuple allowlist·capability 합성·presentation = **High**. fixture·문구 = Medium.

## Tier (collaboration.md 표)
- **최상위 자동승격**: DeliveryActionMaterialVault/DeliveryKeyring(credential material), durable inbox/outbox(migration 경계), 외부 side-effect. → **contain(scripted+flag-off)으로 blast radius 낮춘 뒤 High 방법(blind test-authorship)로 충분**. contain 불가한 실 egress는 opt-in gate 뒤로 미루고 이번 PR엔 부재.
- money 산술 없음(전달 tracer). 실 provider/browser/email smoke는 opt-in contract flag+allowlist에서만(SEC-05/기밀 가드).

## 핵심 invariant (확정 시 사람 1회 검증)
1. rule별 직렬 false→true 전이 1개당 Alert Occurrence 1 + Notification Record 1(같은 transaction). stream/poll/replay·늦은 관측은 재생성 0·watermark 되돌림 0. (AT-10)
2. 100 concurrent same transition에서 occurrence/record 1, 허용 조합만 Intent, 외부 side effect ≤1.
3. Delivery Intent는 정확히 5개 (cause,channel,source?,action-material?,target) 조합만 생성. 그 외 variant는 Intent·renderer·provider 호출 0.
4. Delivery Fact는 append-only. provider accepted/open/click을 delivered/seen으로 승격 0. `sent` 추정 0.
5. Delivery Authorization Context(financial/challenge-pending/challenge-workspace/security-notice)는 render·dispatch 직전 purpose epoch·membership·address revision·deletion fence 재검사. stale/cross-purpose는 value 없는 rejected. (SEC-06)
6. PushTransport: exact host HTTPS:443·DNS 재검사·redirect 0·≤5 endpoint·≤4096B. (SSRF)
7. 비밀·원문 target·action material은 outbox/log/error/screenshot/AI prompt에 0(sentinel/secret pattern scan). (SEC-05)
8. administrative erasure 뒤 개인 delivery state(record/intent/fact/endpoint/material/webhook inbox/token hash/quota/abuse/cache/pending) 재생성 0, 늦은 queue/webhook/provider·backup restore도 재생성 0. module/processor receipt = coordinator 공개 상태. (SEC-09/AT-11)

## 검증 oracle
- `npm run check`(typecheck·lint·vitest·seam), worker/integration/browser test(범위 맞으면 check:f* / verify:network-off), spec §10~12 대조.
- fixed-clock fixture로 circuit/quota/half-open/Quiet Hours 결정성 확보.

## 배치 (각 = 체크포인트, npm run check green 후 다음)
- [x] **B1 Alert Occurrence exactly-once spine (AT-10 core)** — `notification-center/{contracts,occurrence-engine}.ts`. serial watermark(monotonic sourceObservationIdentity) + condition-revision 리셋 → false→true 1건당 Occurrence 1 + Notification Record 1. 단일 await 뒤 동기 atomic critical section이라 replay/late/out-of-order(identity ≤ watermark)는 stale로 무시, watermark rollback 0, 100-concurrent same transition도 exactly 1. Delivery Cause(`cause:alert:{rule}:{seq}`)가 dedupe/audit 정본. `tests/f5-occurrence.test.ts` 7 green(author oracle). **blind AT-10 검증 완료**: 별도 Sonnet 에이전트가 구현 미열람·spec만으로 `tests/f5-occurrence-acceptance.test.ts` 33 작성 → 33/33 green, 후보 버그 0, 3 mutation red→green(non-vacuous). durable DB unique 제약은 B7 실store로.
- [~] **B2 Delivery Intent 5-tuple allowlist (Prevent) + Auth Context 재검사**
  - [x] **Prevent allowlist**: `notification-center/delivery-intent.ts` — `planDeliveryIntent`가 정확히 5행(financial_email/financial_web_push/pending_account_challenge/workspace_account_challenge/authenticated_security_notice)만 planned, 그 외 조합은 생성 전 rejected(8개 사유). `uniqueKey=(causeId,channel,destinationFingerprint)`. `tests/f5-delivery-intent.test.ts` 19 green(5 허용 + 14 금지 매트릭스).
  - [ ] **미완(재배치됨)**: durable outbox `(causeId,channel,destinationFingerprint)` idempotent commit + Delivery Authorization Context 4종 *resolve*(발급). **SEC-06 dispatch-직전 재검사는 dispatch loop 필요 → B4로 이동.**

### 수정 시퀀스 (2026-07-16, 사용자 승인 — 우선순위 조정 4건)
조정 근거: (1) erasure fence는 구조적이어야 함(B6 bolt-on 금지) → substrate 앞으로, (2) B4 push/email 독립 slice 분리·병렬화, (3) vault=AT-11 명시 슬라이스·B4 선행, (4) SEC-06 재검사는 dispatch 경로로. B1 records가 지금 plain array라 fence-aware 아님 = 이미 쌓이는 부채.

- [x] **B2.5 fenced durable-store substrate (Prevent for SEC-09)** — `notification-center/fenced-store.ts`: `SubjectFence`(subject=workspace|pending identity monotonic fence) + `FencedKeyedStore<T>`(write/writeIfAbsent idempotent/list/erase, atEpoch ≤ fence write 억제) + `notificationErasureParticipant`(복합, 스토어별 receipt line = SEC-09 coordinator용 module receipt). `tests/f5-fenced-store.test.ts` 5 green(fence 억제·idempotent·subject 격리·participant). **미완**: B1 records/occurrences를 이 위로 이관(occurrence-engine 리팩터, epoch 배선) → B2.5b.
- [~] **B2 잔여**
  - [x] **durable outbox**: `delivery-outbox.ts` `DeliveryOutbox.commit`이 planned Intent를 `uniqueKey`로 idempotent commit(replay/100회 반복 → committed 1·duplicate 99), fence-aware(erased subject commit suppressed). `tests/f5-delivery-outbox.test.ts` 4 green(plan→commit 통합 포함).
  - [x] **B2.5b occurrence-engine 이관**: `occurrence-engine`의 records/occurrences를 `FencedKeyedStore`(subject=workspace)로 이관 + `writeEpoch` factory 배선(기본 1, 기존 인자 변경 0) + `eraseWorkspace(ws,fence)`(records·occurrences shred + rule state/watermark 삭제) + `registerRule` fence 가드(restore 재등록 차단). exactly-once 임계구역은 동기 fenced write로 보존. `tests/f5-occurrence-erasure.test.ts` 4 green, blind 33 + author 7 회귀 green(=44), mutation 2건(등록 fence 제거·occurrence 미shred) red 확인.
  - [x] **Delivery Authorization Context 4종 resolve**: `delivery-authorization.ts` — `resolveFinancialDelivery` / `resolveAccountChallengeDelivery`(pending·workspace 2 variant) / `resolveSecurityNoticeDelivery`가 durable record + Identity 현재 state에서 purpose-tagged context를 발급하고, spec §12(254/338/339)대로 deletion fence·membership/account state·stale epoch(financial=account-auth, notice=security-notice epoch 독립)·verified-address revision·financial channel consent(financial 전용)·pending identity(pending 전용)·expiry·**cross-purpose(pending↔workspace 교환, notice↔challenge)**를 재검사, 불일치는 전부 **value 없는 rejected**(target/endpoint 미유출). dispatch-직전 recheck는 B4가 동일 resolve 재호출. author oracle `tests/f5-delivery-authorization.test.ts` 21 green + **blind acceptance** `tests/f5-delivery-authorization-acceptance.test.ts` 54 green(별도 Sonnet 에이전트, 구현 미열람·spec+Interface Contract만, public API만 import 확인). mutation: 실제 보안 체크 전부 red(등가 mutation 1건은 fall-through로 동일 동작 확인), blind 파일 단독으로 3 mutation red. → **B2 완료.**
- [x] **B3 Delivery Fact append-only + Alert Channel Availability** — `delivery-fact.ts`: `DeliveryFactLog`이 11개 kind(queued/provider_accepted/delayed/delivered/seen/bounced/complained/provider_suppressed/suppressed/failed/expired)를 fresh sequence key로 fenced substrate에 append(update/promote API 부재 = 구조적 append-only), `projectDeliveryStatus`는 실제 기록된 kind만 precedence-max로 투영(accepted→delivered/seen 승격 0, `sent` 추정 0, terminal failure는 progress 위). erased subject append suppressed + shred(SEC-09). `channel-availability.ts`: 4축(supported/deploymentReady/consentAndAddressReady/permissionGranted/quotaAvailable)을 `unsupported>configuration_required>permission_denied>quota_blocked>ready` 우선순위로 합성. author oracle `tests/f5-delivery-fact.test.ts` 8 + `tests/f5-channel-availability.test.ts` 6 green. mutation: M1(accepted=delivered tie)이 갭 노출 → "accepted→delivered 진행" 테스트 보강 후 red 확인, append-overwrite·availability 2축 mutation red. Medium tier(순수 로직·append 기계, auth/egress 아님) → author+mutation 게이트.
- [ ] **B3.5 vault (AT-11)** — `composition/local-delivery-keyring.ts` stub 위에 ChannelEndpointVault·DeliveryActionMaterialVault·DeliveryKeyring(purpose별 AAD·active/new write·rotation·plaintext fallback 금지) + SEC-05 secret sentinel scan. B4/B5가 소비. (secret leak = 최고 비가역 → 리뷰 최상위)
- [ ] **B4a Push transport(SSRF/TTL/Topic)** — exact host HTTPS:443·DNS 재검사·redirect 0·≤5 endpoint·≤4096B. accepted/400/401/403/404/410/413/429/accept-before-timeout/5xx→retry/subscription/TTL. **+ SEC-06 dispatch-직전 재검사**(여기로 이동). (AT-10) ‖ 병렬 가능
- [ ] **B4b email circuit** — Resend scripted: quota reserve(security 25/일·750/월)·bounce 3%/complaint 0.05% circuit+half-open·token bucket 5rps·30분 cooldown·Quiet Hours. **+ SEC-06 재검사**. (AT-10) ‖ 병렬 가능
- [ ] **B5 Webhook inbox + RFC 8058 unsubscribe** — signature/timestamp parse 전 검증, `(provider,environment,svix-id)` dedupe inbox(FencedStore), Fact를 서버 저장 owner에 bind(webhook 주장 불신). unsubscribe one-click POST만·GET 미소비·token hash-only lineage·flood 상한. (AT-11)
- [ ] **B6 Erasure coordinator + restore suppression (SEC-09)** — NotificationCenter erasure participant가 전 개인 delivery state를 fence 뒤 제거(스토어는 B2.5~B5에서 이미 fence-aware) + module/processor receipt = coordinator 공개 상태, backup restore·late webhook 재생성 0. **blind test-authorship**: erasure 재생성 0 oracle.
- [ ] **B7 presentation/browser + worker 배선 + perf** — NotificationCenter inbox 표면, worker durable Intent dispatch(scripted), deadline(inbox 200/400ms·occurrence commit 500ms·Intent first claim 1.5s)·browser paint 예산, AT-10/11 integration.

## 진행 로그
- B1 완료(commit 예정). exactly-once spine green(7 test). 다음: blind AT-10 concurrency oracle 위임 → B2 Delivery Intent 5-tuple allowlist.
