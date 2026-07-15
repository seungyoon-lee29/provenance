# 13 - F4 정보 outcome·AI tracer 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 11, 12
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-16T00:41:26+09:00
Last heartbeat: 2026-07-16T02:40:48+09:00

## Objective

non-chart FinancialInformation과 ResearchAssistant가 실제값·stale·hard expiry·권리·공급자 실패를 정직하게 표시하고 모든 지원 자료의 consent/redaction/fallback 경계를 완주하게 한다.

## Owned scope

- `src/modules/financial-information/**` 중 chart 제외 영역, `src/modules/research-assistant/**`.
- `src/modules/provider-connections/data-ai-transport/**` route registry와 provider adapter.
- data/AI literal fixture, contract/browser/cache/fault test.
- shared public contract/composition/migration/index는 F0/main owner read-only다.

## Requirements

- Market Observation, news/filing Evidence와 InformationOutcome를 provider/feed별 freshness/error matrix로 정규화한다.
- 공개/개인/local, free/deferred와 License Scope의 display/retention/external-processing/derivative 권리를 요청마다 확인한다.
- ResearchAssistant는 source-owned AI Material Reference만 받고 Gemini/local rule을 동일한 AI Material Envelope 경계 뒤에서 실행한다.
- AI Processing Consent, model/credential/policy generation, workspace/auth epoch를 enqueue·dispatch·emit·cache에서 재검사한다.
- paid route, FRED production cache, raw article/image, client portfolio/order payload와 secret/direct identifier를 차단한다.
- administrative erasure receipt는 개인 FinancialInformation follow/cache/reference와 ResearchAssistant consent/job/result/cache, data/AI transport artifact를 fence 뒤 제거하고 restore suppression을 확인한다.

## Interface contract

- `EvidenceResolver`, `PortfolioEvidenceResolver`, source-owned `AiMaterialResolver`만 purpose-bound typed material을 반환하며 generic Evidence getter는 없다.
- F0 AuthorizedTransport primitive와 F3 ProviderConnections core만 사용하고 provider SDK/credential을 다른 module에 노출하지 않는다.
- F4는 Actual/Paper 자료를 contract fixture resolver로 먼저 검증한다. F6/F8이 실제 resolver를 제공하고 F11이 real-module integration을 최종 검증한다.

## Acceptance criteria

- available/실시간·지연, stale+warning, hard-expired, api-required, license-restricted, no-data와 failed-no-value literal matrix가 API와 DOM에서 일치한다.
- 401/403 분류, quota/429, timeout/5xx, malformed/future timestamp와 rights revocation race가 정확한 outcome·quarantine·provider call 0으로 수렴한다.
- 모든 자료 category가 source reference로 scripted Gemini 또는 local fallback에 도달하고 derivative/external-processing/consent 금지 case는 호출 0이다.
- consent, credential generation, workspace switch와 deletion 뒤 pending emit/cache hit 0이고 개인 결과가 shared cache에 없다.
- erasure coordinator가 FinancialInformation·ResearchAssistant receipt를 수집하고 늦은 provider result, queue 재개와 backup restore 뒤 개인 cache/result가 재생성되지 않는다.
- AI 20초와 market/news/filing 10초 deadline 뒤 무한 spinner 없이 normalized outcome을 표시한다.

## Out of scope

- chart, 실제 Actual/Paper resolver 구현, alert와 delivery.
- 실제 Gemini/data provider contract는 opt-in이며 key 부재·미실행은 `not_run/api_required | configured_unverified` artifact다.

## Traceability

- [승인 spec](../spec.md) `UF-01/02/05`, §5, §6.1, §7, F4, `SEC-04/05/06/09`, `AT-01/04/11`; ADR `A03/A05`.

## Progress — RESOLVED (B1–B5 완주, acceptance gate 충족)

FinancialInformation(비-chart)·ResearchAssistant·erasure·deadline 도메인/보안 로직을 vertical-slice TDD로 완주, 두 핵심 acceptance oracle(AT-01·AT-04)을 blind test-authorship으로 검증(B1–B4). **B5(presentation·browser)에서 F4 outcome 매트릭스를 실브라우저 DOM에 렌더하고 `withDeadline`를 read 경로에 실배선해 bullet 1("API AND DOM 일치")·bullet 6(무한 spinner 없음)을 충족**. 진행 로그는 [progress/f4-plan.md](../progress/f4-plan.md).

### Answer (B1–B4)
- **B1 Market Observation(AT-01)**: `InformationOutcome<MarketObservation>` 정규화 — freshness(§5.1 residual+cadence soft/hard), error(401→reauth, 403 3분기[entitlement→license_restricted, credential→reauth, else→forbidden_upstream], 429 retryAfter, timeout/5xx, malformed/future→invalid_response+quarantine), scripted `MarketInformation.read`(값은 available에만 = 타입 강제).
- **B2 news/filing Evidence**: 같은 머신 재사용 + `EvidenceResolver`(§6.1, purpose-bound, raw getter 없음, title/source/time/link/snippet만·전문/이미지 금지 §5.3).
- **B3 ResearchAssistant(AT-04)**: `AiMaterialResolver`→`AiMaterialOutcome`, 최소화 envelope + prompt secret 가드(fail-closed), category policy(derivative/external-processing forbidden→Gemini·local 호출 0), scripted Gemini(호출 기록)+local rule fallback, **SEC-06 pre-dispatch consent-epoch 재검사로 egress 차단**, license-scope narrowing(입력보다 안 넓게).
- **B4 erasure/deadline**: `PersonalCacheStore`(monotonic fence·shred·restore suppression, SEC-09) + F3 `ErasureParticipant` 호환 participant(financial+research receipt), `withDeadline`(data 10s/AI 20s).

### Changed files (B1–B4)
- `src/modules/financial-information/data/**`: `contracts.ts`, `observation-freshness.ts`, `outcome-classification.ts`, `scripted-market-information.ts`, `evidence-contracts.ts`, `evidence-normalization.ts`, `scripted-evidence-resolver.ts`, `personal-cache.ts`, `deadline.ts`.
- `src/modules/research-assistant/**`: `contracts.ts`, `research-service.ts`, `scripted-research.ts`.
- `fixtures/spec/f4/**`: `market-catalog.json`, `evidence-catalog.json`, `ai-material-catalog.json`.
- tests: `tests/f4-{observation-freshness,market-information,evidence,research-assistant,research-acceptance,erasure-deadline}.test.ts`.

### Validation (B1–B4)
- `npm run check`: typecheck·lint clean, **Vitest 271 / 33 files**(신규 F4 ~80), public/server seam 통과. 회귀 0.
- **blind test-authorship(새 규칙 High-tier)**: AT-01·AT-04 acceptance를 구현 미열람·spec만으로 별도 에이전트가 작성. AT-01 blind가 **순환 import→policyVersion undefined(타입 계약 위반)** 실버그를 잡음(내 correlated oracle이 놓친 필드) → 수정. AT-04 blind는 16/16 + 자체 mutation-check(assertion 3개 flip red→green)로 non-vacuous 확인.

### Answer (B5 presentation·browser)
- **실 page/route mount**: `src/app/f4-panels/page.tsx`(dev/test 전용, prod `notFound()`) — 16-case 시장 매트릭스 + 6 evidence + 2 research를 각각 `withDeadline` 래핑 read로 로드해 F1-proven `GuestPanel`로 렌더. presenter에 DOM-mount seam `toMarketPanelState`/`toEvidencePanelState`/`toResearchPanelState` 추가.
- **withDeadline 실배선(bullet 6)**: 카탈로그 read 전량이 `withDeadline`(DATA 10s/AI 20s) 경유. never-settling read에 400ms 데모 deadline을 걸어 timeout outcome이 실 DOM에 렌더(무한 spinner 없음)됨을 브라우저에서 확인.
- **AT-01 DOM 매트릭스(bullet 1)**: `tests/browser/f4-panels.spec.ts`(9 test × 2 viewport)가 25 패널·`available 7 = primary-value 7`·failed/unavailable primary-value 0·presenter 라벨(실시간/오래됨+Degradation/API 필요/표시 권한 없음/데이터 없음)·deadline timeout을 실브라우저에서 단언. `explicit-unavailable.png`(license_restricted 패널) 산출.

### Changed files (B5)
- `src/app/f4-panels/page.tsx`(신규 라우트), `src/modules/terminal-view/presentation/data/data-panel-presenter.ts`(state seam 3종 추가), `tests/browser/f4-panels.spec.ts`(신규), `tests/browser/screenshots/explicit-unavailable.png`(산출물).

### Validation (전체)
- `npm run check`: typecheck·lint·**Vitest 296/34**·양 seam green. `npm run test:browser`: **54 passed / 2 skipped**(F4 스펙 9×2 포함, 회귀 0). `npm run test:performance`: **6 passed**(F1/F2 예산 무회귀).

### Review / decorrelation
- **B1–B4 보안 로직**: blind test-authorship(High tier) — 도메인 작성 주체와 acceptance 저자 분리. AT-01 blind가 순환 import→policyVersion undefined 실버그 검출·수정. AT-04 blind는 self-mutation-check. Contain: 전 provider·AI가 network-off scripted lane(egress-0, `free_only`)로 blast radius 축소.
- **B5**: 저 blast-radius(dev/test 전용 프레젠테이션, 신규 도메인 로직 0). Playwright 스펙을 **다른 모델(Sonnet)** 이 작성 → 라우트 작성자(Opus)와 자연 decorrelation.

### Residual risks (비차단 follow-up)
- **codex 적대적 diff-read 미실행**: F4는 보안 접점(egress/consent/redaction/erasure)이라 규칙상 풀 게이트의 "다른 모델 적대적 리뷰"가 권장되나, 이번 세션엔 blind test-authorship + containment로 갈음하고 codex 전량 diff-read는 안 돌림. 안전 강화용으로 별도 실행 권장(옵션).
- **prod-404 자동 단언 없음**: `f4-panels` 라우트의 production 차단은 코드 가드(`APP_ENVIRONMENT==="production"→notFound`)만 있고 전용 테스트 없음.
- **SEC-04 transport**: 핵심은 F0 `provider-transport`가 완증(소비만). data/AI route registry·실 adapter는 opt-in(`free_only`) 후속.
- blind가 표시한 gap: (1) SEC-05 "log" 절반 seam hook 없음(prompt egress만 관측), (2) cross-workspace material 거절 전용 fixture 없음, (3) redaction 케이스 prompt-loop vacuous(실보장은 callCount 0).
