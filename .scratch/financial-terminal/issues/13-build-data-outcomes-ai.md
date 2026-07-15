# 13 - F4 정보 outcome·AI tracer 구축

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 11, 12
Blocked by: 11, 12
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
