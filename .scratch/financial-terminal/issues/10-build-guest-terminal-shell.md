# 10 - F1 비로그인 터미널 shell 구축

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 09
Blocked by: None
Owner: /root
Claimed at: 2026-07-15T16:59:50+09:00
Last heartbeat: 2026-07-15T18:26:06+09:00

## Objective

비로그인 사용자가 한국어 고밀도 Workspace를 실제 browser에서 열고, 공개 License Scope가 허용된 Evidence 또는 값 없는 정확한 Information Outcome을 빠르게 확인하게 한다.

## Owned scope

- `src/modules/terminal-view/presentation/guest/**`, public feature composition과 guest route/UI.
- F1 browser/contract fixture와 guest shell test.
- `src/composition/**`, shared public type/index와 migration은 F0/main owner read-only다.

## Requirements

- header·명령창·AI entry, 좌/중/우 grid, 하단 index strip과 panel별 `pending | ready(InformationOutcome)`을 구현한다.
- 데스크톱 1366×768과 모바일 360×800 단일 열·panel 내부 scroll·page 가로 overflow 0을 지원한다.
- `available`만 숫자를 표시하고 unavailable/failed는 한국어 상태, provenance와 재시도 가능성만 보여준다.
- initial은 공개 cache/local read만 기다리고 느린 refresh는 독립 update로 전달한다.
- guest 개인 panel은 로그인 요구를 표시하며 portfolio, Provider Connection, layout server save와 alert side effect를 만들지 않는다.

## Interface contract

- presentation은 `TerminalView.open`과 `FinancialInformation.read` public interface만 사용하고 provider SDK/repository를 import하지 않는다.
- F1 public feature factory가 필요한 root wiring은 F0/main owner에게 요청한다.
- synthetic fixture는 test에서 눈에 띄게 표시하고 production composition과 실데이터 screenshot 경로에서는 거절한다.

## Acceptance criteria

- 실제 browser에서 desktop landmark와 mobile 단일 열을 조작하고 keyboard focus, accessible name, status live region과 contrast가 통과한다.
- 공개 fixture는 provider/feed/as-of/received-at/Data Freshness/License Scope를 표시하고 unsupported fixture에는 가짜 값이 0이다.
- guest `TerminalView.open` initial은 warm p95 250 ms, local cache miss p95 550 ms 이내이며 shell cold/warm lane 예산을 측정한다.
- cache miss는 즉시 pending, 2초 뒤 공급자 대기 상태, 10초 deadline 뒤 normalized outcome으로 끝나 무한 spinner가 없다.

## Out of scope

- chart 상호작용, 로그인·layout 저장, AI, portfolio, Paper Trading과 alert 구현.
- 실제 공개 source smoke와 release screenshot은 F11이며 network-off scripted fixture가 이 lane의 정본이다.

## Traceability

- [승인 spec](../spec.md) `UF-01`, `WS-01/04/06`, §4, §5.1~5.2, §11, F1, `AT-01`, `AT-12`.

## Answer

비로그인 사용자가 데스크톱 3열·하단 Blotter와 모바일 단일 열 Workspace에서 공개 정보 outcome을 확인하는 F1 shell을 구현했다. `available`만 값과 전체 provenance를 표시하고, API 필요·권리 제한·데이터 없음·typed 실패는 값 없이 한국어 상태와 정책·재시도 정보를 표시한다. SSR initial과 SSE updates는 같은 `TerminalLoad`를 one-time 인계하며 cache miss는 open 기준 2초 provider wait와 10초 normalized deadline을 지킨다. 개인 기능은 로그인 gate만 제공하고 side effect는 만들지 않는다.

## Changed files

- `src/app/**`, `src/modules/terminal-view/presentation/guest/**`: guest route, shell, outcome presenter, 동일 load SSE handoff와 deadline/dedupe lifecycle.
- `fixtures/spec/f1/**`, `tests/guest-terminal-*.test.ts`, `tests/browser/**`, `tests/performance/**`: literal outcome, fixed-clock contract, browser/accessibility와 release-build performance oracle.
- `playwright.config.ts`, `playwright.performance.config.ts`, `package.json`, `package-lock.json`, `next.config.ts`: network-off browser와 fixed-lane performance 실행 구성.
- `.scratch/financial-terminal/design/**`, `.scratch/financial-terminal/qa/**`: 승인 콘셉트, 디자인 규칙, 최종 desktop/mobile 캡처와 fidelity 기록.

## Validation

- `npm run check:f1`: typecheck·lint, Vitest 14 files / 95 tests, public/server seam, Playwright desktop/mobile 10 passed / 중복 timing lane 2 skipped, performance 2 passed.
- local release-build p95: desktop cold/warm `169.14/126.78 ms`, mobile `570.40/500.62 ms`; viewport별 40 cold / 100 warm, 5 warm-up, outlier 제거 없음.
- axe critical/serious/color-contrast 0, desktop `1366x768` page overflow 0·columns `270/740/324`, mobile `360x800` page overflow 0·panel `x=8 width=344`·내부 scroll 5·최소 control 44 px.
- production smoke: `SYNTHETIC TEST DATA`, `101.25`, `fixture-realtime` 노출 0, value 없는 `API 필요` outcome 확인.
- 종료 시 local ports `3100/3101/3102` listener 0.

## Review

- spec과 standards 관점 병렬 review에서 실제 update 폐기, provenance, network-off flag, typed failure 설명, live announcement, deadline clock domain과 성능 증거 문제를 수정했다.
- 최종 affected-scope re-review에서 Critical/High/Medium finding 0을 확인했다.

## Residual risks

- SSR→SSE `TerminalLoad` handoff는 현재 단일 Next process의 짧은 one-time registry다. 다중 instance 배포에서 durable reconnect/replay가 필요하면 F11 release integration 전에 Redis-backed broker 또는 sticky routing을 결정해야 한다.
- 성능 값은 local release-build fixed-lane 증거이며 canonical 2 vCPU / 4 GiB pinned release runner 주장은 하지 않는다. F11에서 동일 표본을 전용 release runner로 재현해야 한다.
- 실제 공개 provider contract와 실데이터 screenshot은 이 티켓 범위가 아니며 F11 opt-in gate에 남아 있다.
