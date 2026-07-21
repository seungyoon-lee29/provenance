# 35 - 패널 provenance 노이즈 정리 (기본 숨김 + 토글)

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 10, 13
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

사용자 QA(2026-07-21): "Required capability 이런 것들 왜 표시하는 거야, 사용하는 사람 입장에서는
전혀 불필요한 정보인데."

정확한 지적이다. `guest-panel.tsx:51-60`이 `Required capability` / `Configuration route` /
`Policy Version` / `Evidence Reference` / `Feed` / `Venue`를 패널 본문 `<dl>`로 렌더하고, 패널
헤더는 `market-overview` 같은 **내부 패널 키**(`:24`)를 그대로 노출한다. 즉 디버그·계약 정보가
사용자 화면의 1급 콘텐츠 자리에 올라와 있다. 값이 붙으면 이 줄들은 사라지지만(available outcome
에는 provenance 목록이 비어 있음), 데이터가 없는 패널에서는 화면 대부분이 이 노이즈다.

사용자 결정(2026-07-21): **기본 숨김 + 토글**. 정직성 설계(출처·정책 추적)는 유지하되 평소
화면에는 값과 "출처 · 시각"만 보인다.

## Owned scope

- `guest-panel.tsx`, `guest-panel-presenter.ts`, `guest-terminal-shell.module.css`
- `tests/` 해당 프리젠터·패널 테스트

## Acceptance

- 평상시 패널에는 값(또는 상태 한 줄) + `출처 · 신선도 · 시각` 한 줄만 보인다.
- provenance 전체는 토글(details/버튼)로 펼칠 때만 보이며, 접근성(키보드·aria-expanded) 유지.
- 패널 헤더의 내부 키 노출 제거(또는 토글 안으로 이동).
- 기존 정직성 불변식 회귀 0: 값 없는 outcome에 값이 생기지 않고, 상태 문구는 그대로 남는다.
