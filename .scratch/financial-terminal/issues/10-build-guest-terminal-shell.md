# 10 - F1 비로그인 터미널 shell 구축

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 09
Blocked by: None
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
