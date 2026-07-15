# F4 (ticket 13) 진행 — 정보 outcome·AI tracer

Owner: main-agent. Claimed 2026-07-16T00:41:26+09:00.

## Blast-radius 프레이밍 (새 규칙 적용)
- **되돌릴 수 없는 위험 = 외부 egress**(private/paid 자료·secret을 Gemini/provider로 전송) + erasure 미완주.
- **Contain(핵심)**: 전 provider·AI를 network-off scripted lane으로. `free_only`, egress-0 property. → blast radius 낮춤 → 최상위 자동승격이지만 contain 후 High-tier 방법으로 충분.
- **Detect**: `fixtures/spec/f4/**` 사람 검토 literal이 정본(production 계산기 import 금지). **blind test-authorship**: 도메인 짠 주체와 acceptance 테스트 저자를 분리.
- **Prevent**: outcome은 shared `InformationOutcome<T>` 판별합집합(값은 available에만 — 타입으로 강제). Evidence/AI material은 opaque branded reference.

## 배치 (각 = 체크포인트, npm run check green 후 다음)
- [x] **B1 Market Observation freshness/error 매트릭스 (AT-01 spine)** — freshness 분류(§5.1 soft/hard 표: residual+cadence), error 분류(401/403 3분기/429 retryAfter/timeout/5xx/malformed/future), scripted `MarketInformation.read`. F2 chart idiom 미러. **blind test-authorship 적용**: 도메인은 main, AT-01 acceptance 테스트는 별도 에이전트가 구현 미열람·spec §5.1만으로 작성.
- [x] **B2 news/filing Evidence** — 같은 outcome 머신 재사용(`classifyObservationFreshness`+`classifyProviderFailure`), Evidence value(title/source/time/link/snippet, 전문·이미지 금지 §5.3), `EvidenceResolver` seam(§6.1, purpose-bound, raw getter 없음).

### B1/B2 결함 기록 (tier-miss 회고, 새 규칙)
- **순환 import → policyVersion undefined**: `observation-freshness` ↔ `outcome-classification` 상호 import로 `outcome-classification`의 최상위 `const POLICY = OBSERVATION_POLICY_VERSION`가 init 시 undefined 캡처 → 모든 non-available outcome이 `policyVersion: undefined`(타입 계약 위반). freshness 경로만 call-time 참조라 생존 → 내부 불일치.
- **왜 놓쳤나**: 내 단위 oracle은 status/freshness/code 중심이라 `policyVersion` 필드를 단언 안 함(작성자 블라인드스팟). **blind 에이전트의 `toEqual(expected)` + policyVersion 명시 단언이 11/18 red로 잡음** → decorrelation이 값을 함. 수정: 상수를 leaf(`outcome-classification`)로 이동해 순환 제거. 교훈: outcome 계약 필드 전량을 acceptance에서 deep-equal.
- [x] **B3 ResearchAssistant + AI Material Envelope (AT-04)** — `AiMaterialResolver`(→가벼운 `AiMaterialOutcome`), 최소화 envelope + redaction 백스톱(prompt secret 가드 fail-closed), category policy(derivative/external-processing forbidden→호출 0), scripted Gemini(호출 기록) + local rule fallback, consent 재검사(SEC-06 pre-dispatch epoch bump 차단), license-scope narrowing(입력보다 안 넓게). main TDD 13 oracle + blind AT-04 acceptance(위임 중).
- [x] **B4 erasure participants (SEC-09) + deadline (bullet 6)** — `PersonalCacheStore`(monotonic fence·shred·restore suppression)+`personalCacheErasureParticipant`(F3 `ErasureParticipant` 호환, financial+research receipt), `withDeadline`(data 10s/AI 20s, 타이머 정리)+`deadlineTimeoutOutcome`. **SEC-04 transport는 F0가 이미 완증**(`provider-transport`: exact route/schema/env/capability·redirect 금지·pinned executor·generation/fence 재검사) → F4는 그 primitive 소비. data/AI route registry 선언 + deadline 실배선은 B5/composition으로.
- [ ] **B5 presentation/browser 통합 (미완, 게이트 open)** — 비-chart 패널 surface, **AT-01 DOM 일치(bullet 1의 절반)**, explicit-unavailable 상태, deadline을 read 경로에 배선. Playwright 필요.

### B3 blind AT-04 결과 (mutation-checked)
- 16/16 pass, **0 disagreements**. blind 에이전트가 스스로 mutation-check(happy callCount 1→0, SEC-06 0→1, narrowing personal→public 각 red→green) = 새 규칙 "믿기 전 측정" 이행.
- **정직한 gap(blind가 표시)**: (1) SEC-05의 "log" 절반은 seam hook 없음 — prompt/provider egress만 관측(callCount 0로 보장). (2) redaction 케이스는 egress 자체가 0이라 prompt-loop는 vacuous, 실보장은 callCount===0+value-less. (3) cross-workspace material 거절은 전용 fixture 없음 → B5/후속.

## 완료 게이트
- `npm run check`(+ 변경 범위 맞는 check:f2), Playwright 무회귀, spec §5.1/§5.4/§6.1/§7(SEC-04/05/06/09) 대조.
- residual: 실제 provider 미배선(opt-in), presentation 범위는 F1 shell 재사용 최소.
