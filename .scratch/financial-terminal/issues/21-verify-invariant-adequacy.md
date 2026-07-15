# 21 - 불변식 검증 adequacy: property test + mutation

Type: implementation
Status: open
Triage: needs-triage
Depends on: None
Blocked by: None
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
