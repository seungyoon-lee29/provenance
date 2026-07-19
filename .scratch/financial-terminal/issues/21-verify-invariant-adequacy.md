# 21 - 불변식 검증 adequacy: property test + mutation

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: None
Blocked by: None
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-19 (resolved)
Resolved at: 2026-07-19

## Objective

example 기반 스위트가 실제로 도메인 불변식 위반을 잡는지 보장한다. `docs/agents/collaboration.md`의 "검증 깊이와 blast radius" > 예산 시퀀싱을 이행하는 cross-cutting 품질 backlog다. 토큰/시간 예산이 회복되면 착수한다.

## Owned scope

- 도메인 불변식을 `CONTEXT.md`/ADR에서 도출한 property test로 상시화.
- 스위트 adequacy를 mutation testing으로 측정.

## Requirements

- 불변식 property test(초기 세트, 프로젝트 결정과 정합):
  - **no-Live-route**: Live Trading 전송 경로가 존재·호출되지 않는다(map Decisions·spec out-of-scope, ADR 0004).
  - **egress-off**: scripted 모드 외부 egress 0 — 기존 `verify:network-off`를 property/상시 게이트로 승격·보강.
  - **actual/paper 격리**: Actual과 Paper 원장이 섞이지 않는다(ADR 0004). 회계·paper 원장이 붙는 F6~F8에서 돈 보존(차변=대변) 속성으로 확장.
- mutation testing 도입(예: Stryker) — 핵심 module(identity/vault/portfolio/accounting)에 주입 결함 생존율(mutation score) 기준선과 게이트.
- property lib(예: fast-check) 미설치 시 추가. `check`/CI lane에 편입.

## Interface contract

- 기존 독립 oracle·seam 규칙을 유지하고 property는 public interface에 건다.

## Acceptance criteria

- 명시된 불변식마다 반례를 생성·검증하는 property test가 있고 green.
- 핵심 module의 mutation score 기준선이 기록되고, 기준 미만이면 실패하는 게이트가 있다.
- `npm run check`(또는 신규 lane)에 편입돼 회귀 시 실패한다.

## Out of scope

- 과거 F0~F3 코드의 소급 재작성. 이 티켓은 standing oracle을 심어 과거·미래를 동시에 검증하는 것이지 버그 사냥이 아니다.
- UI/표시(display tier) property 커버리지.

## Notes

- 예산 게이트: `docs/agents/collaboration.md` 예산 시퀀싱에 따라 토큰 여유 회복 시 착수. 그 전에는 needs-triage backlog로 둔다.
- 관련 후속(ticket 12 F3 residual): `workspace-server.ts` `devWorkspaceProof()` self-guard, dual `SessionProof` 통합은 F11(ticket 20 store 통합)이 소유.

## Dry-run 2026-07-16 (workflow 팬아웃 점검)

`parallel()` 워크플로(run `wf_9919d221`)로 3개 불변식을 읽기전용 점검한 스냅샷 — 전부 성립(high), 위반 0:

- **no-live-route**: fail-closed boot 가드(`runtime-policy.ts` `ENABLE_LIVE_TRADING`→throw), `manifest.ts` liveSubmit*=[], 주문 전송 라우트 0, 회귀 테스트(`runtime-policy.test.ts:38`).
- **egress-off**: 유일 HTTP 클라이언트(`https-executor.ts`) dormant(app/composition에서 미생성), client `fetch` 전부 same-origin `/api`, `verify-network-off.ts` 컨테이너 경계 차단.
- **actual-paper-isolation**: branded type 분리(`brands.ts:20-21`), 인터페이스 분리(ADR 0004), 혼용 코드 grep 0.

**단서(이 티켓이 존재하는 이유)**: no-live·actual-paper가 성립하는 건 부분적으로 **F6~F10 미구현이라 위반할 코드가 아직 없어서**다(provisional). storage/route 격리는 해당 모듈이 지어질 때 재점검해야 하므로, 일회성 점검이 아니라 **standing property test**로 승격해야 한다.

**적대 검증(pipeline run `wf_147d7f31`)에서 나온 정정**: actual-paper 불변식 문구 "shared calculation logic 없음"은 설계 보장보다 **과하다** — issue 04:7은 *순수 계산 규칙 구현의 재사용은 허용*하고, 금지하는 건 공유 **ledger/aggregate/storage/mode/order-interface**다. 따라서 standing property test는 후자(공유 저장·집계·mode·주문 인터페이스 없음)를 assert해야 하며, "shared calc 없음"을 걸면 설계가 의도적으로 허용한 것에 오탐이 난다. (이 항목만 verify confidence medium.)

## Progress (property 축 — 2026-07-19)

fast-check 4.9.0 devDep 추가. 불변식 4종을 standing property test로 상시화(`tests/property/`, `tests/**/*.test.ts`라 `npm run check`에 자동 편입 = AC3):

- **egress-off** (`egress-off.property.test.ts`, 4): 임의 사설/예약 IPv4·IPv6 → `isPublicNetworkAddress` false, 임의 non-HTTPS origin·사설 resolve(DNS SSRF) → `assertPublicRoute` throw. 컨테이너 레벨 `verify:network-off`를 순수함수 property로 승격·보강.
- **no-live-route** (`no-live-route.property.test.ts`, 3): 임의 environment에서 `ENABLE_LIVE_TRADING=true`·비어있지 않은 paid adapter/route/schedule → `loadRuntimeConfig` throw(baseline은 4 env 전부 clean load).
- **money-conservation** (`money-conservation.property.test.ts`, 2): broker book 파생 예약 항등(reserved == Σ accepted cost, balance 불변, refuse는 상태변화 0) + seed 초과 단일 buy는 refuse·reserved 0(overspend 없음).
- **actual/paper 격리** (`actual-paper-isolation.property.test.ts`, 2): 두 모듈 트리 상호 import 0(구조 불변; 적대 정정대로 공유 ledger/storage/mode/order-interface 금지이지 순수 계산 재사용 금지 아님). branded type 비호환은 tsc가 컴파일 게이트로 추가 강제.

검증: 11 property test green, `npm run check` 1,233 tests / 109 files green. **물리 mutation으로 load-bearing 확인**: isPublicNetworkAddress 무력화→egress 3 RED, ENABLE_LIVE_TRADING throw 제거→no-live 1 RED, submitLocal overspend 가드 무력화→money 1 RED(초기 항등 property는 랜덤이 seed 경계를 못 쳐 survive→명시적 seed-초과 property 추가로 kill). 전부 restore green.

## 남은 것 (mutation 자동화 축)

AC2(핵심 module mutation score 기준선 + 미만 실패 게이트)는 Stryker 도입 필요. Stryker 전체 실행은 1,233 테스트 × mutant로 무거워(수십 분~시간) 예산 시퀀싱상 별도 판단 필요. 핵심 불변식은 위 수동 물리 mutation으로 이미 adequacy 실증. → 사용자와 스코프 확인 후 진행(좁은 범위 도입 vs CI/nightly 이관).

## Progress (mutation 축 — 2026-07-19) + resolve

Stryker 9.6.1 + vitest-runner 도입(사용자 스코프 결정: 좁은 범위). `stryker.config.mjs`로 안전 최상위 순수 정책 2파일을 mutate 대상으로:
- `src/composition/runtime-policy.ts` (no-live/paid fail-closed 부팅 게이트)
- `src/platform/provider-transport/network-policy.ts` (egress/SSRF 가드)

**baseline mutation score 67.17%** (runtime-policy 68.36 / network-policy 63.39, 313 killed / 120 survived / 33 no-cov, 21초). `thresholds.break=60`으로 **회귀 게이트**(안전 가드 약화 시 score 하락→exit 1). `npm run test:mutation` lane(무거운 전체 실행이라 로컬 `check`엔 미편입, CI/nightly 적합).

Stryker가 실제 gap 검출: `network-policy.ts:57` `addresses.some(!public)`→`.every(!public)` mutant survive = 내 SSRF property가 단일 사설 IP만 쳐서 "공인+사설 혼합(DNS rebinding)" 케이스 미커버 → 혼합-address property 추가로 kill. fast-check 전역 seed 고정(`tests/setup/fast-check.ts`, seed 0x5eed)으로 mutation score 결정론화(랜덤 seed면 게이트 flaky).

survived 120 대부분은 runtime-policy.ts의 인접 정책(vault/identity/delivery/credential) — 이 티켓의 no-live 불변식 범위 밖(F0 unit-test 영역).

## Answer

example 스위트의 불변식 adequacy를 standing oracle로 상시화했다. **property 축**: no-live-route·egress-off·money-conservation(broker book 파생 예약 항등+overspend 0)·actual/paper 격리(구조 import 0) 4종을 fast-check property로 걸고(11→12 tests, `check` 자동 편입), 각 가드를 물리 mutation으로 kill 실증. **mutation 축**: Stryker를 안전 최상위 2 module(no-live·egress)에 좁게 도입, baseline 67.17% 기록+break=60 회귀 게이트+seed 고정 결정론화. Stryker가 내 SSRF property의 rebinding gap을 검출해 보강까지 유도.

## Changed files

- `tests/property/{egress-off,no-live-route,money-conservation,actual-paper-isolation}.property.test.ts` (12 property).
- `tests/setup/fast-check.ts`(seed 고정) + `vitest.config.ts`(setupFiles).
- `stryker.config.mjs`(좁은 범위 mutate+break 게이트) + `package.json`(fast-check·stryker devDep, `test:mutation`).
- 커밋: 3bacf86(property 축) → <mutation 축>.

## Validation

- `npm run check` 1,234 tests / 109 files green(property 12 포함).
- `npm run test:mutation` 67.17% > break 60 → exit 0. 결정론(seed 고정) 확인.
- 물리 mutation load-bearing: isPublicNetworkAddress 무력화→egress RED, ENABLE_LIVE_TRADING throw 제거→no-live RED, overspend 가드 무력화→money RED(약한 초기 항등 property는 seed-초과 property 추가로 kill), some→every mutant→혼합 property로 kill. 전부 restore green.

## Review

- 자가 적대: Stryker가 property의 실제 gap(SSRF rebinding, some→every)을 검출 → property 보강. 초기 money 항등 property가 랜덤이 seed 경계를 못 쳐 mutation survive → 명시적 경계 property 추가.
- 티켓 dry-run(2026-07-16)의 적대 정정(actual/paper "shared calc 없음"은 과함) 반영 — 구조 import 격리만 assert.

## Residual risks

- **mutation 범위 좁음**: AC 예시 module(identity/vault/portfolio/accounting) 미포함. 안전 최상위(no-live·egress)만 도입. 확장은 후속(전체 Stryker는 무거워 CI/nightly lane 적합). baseline 67.17%도 인접 정책 미커버로 낮음(불변식 자체는 property로 커버).
- **mutation 게이트 로컬 미편입**: `test:mutation`은 별도 lane(21초). CI 도입(ticket 22)에서 nightly 편입 권장.
- property numRuns 100(fast-check 기본): 더 넓은 탐색은 numRuns 상향 여지(seed 고정 유지).
