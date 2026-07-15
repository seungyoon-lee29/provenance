# 13 - F4 정보 outcome·AI tracer 구축

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 11, 12
Blocked by: None
Owner: main-agent
Claimed at: 2026-07-16T00:41:26+09:00
Last heartbeat: 2026-07-16T01:10:48+09:00

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

## Progress — 도메인 완료 (B1–B4), presentation gate open

Status는 `claimed` 유지. FinancialInformation(비-chart)·ResearchAssistant·erasure·deadline의 도메인/보안 로직을 vertical-slice TDD로 완주하고 두 핵심 acceptance oracle(AT-01·AT-04)을 blind test-authorship으로 검증했으나, **B5(presentation·browser: AT-01 DOM 절반=bullet 1, deadline read-경로 배선)가 남아 acceptance gate 미충족**. 진행 로그는 [progress/f4-plan.md](../progress/f4-plan.md).

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

### Residual risks / 미완 (B5 + gap)
- **B5 미착수**: 비-chart 패널·research 패널 presentation, **AT-01 DOM 일치(bullet 1)**, explicit-unavailable, deadline read-경로 배선. Playwright 필요 → gate open.
- **SEC-04 transport**: 핵심은 F0 `provider-transport`가 완증(소비만). data/AI route registry 선언·실 adapter는 opt-in(`free_only`) → B5/후속.
- blind가 표시한 gap: (1) SEC-05 "log" 절반 seam hook 없음(prompt egress만 관측), (2) cross-workspace material 거절 전용 fixture 없음, (3) redaction 케이스 prompt-loop vacuous(실보장은 callCount 0).
