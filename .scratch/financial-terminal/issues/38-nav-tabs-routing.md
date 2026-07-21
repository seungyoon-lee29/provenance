# 38 - 상단 탭을 실제 페이지로

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 36, 37
Blocked by: 36
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

사용자 QA(2026-07-21): "상단 시장·관심종목·뉴스공시·Paper 탭이 안 눌린다".

`guest-terminal-shell.tsx:125-128`이 `href="#market"` 같은 **앵커 링크**다. 페이지가 없어 스크롤만
하고, 데스크톱에서는 대상 섹션이 이미 화면에 있어 "아무 일도 안 일어나는" 것으로 보인다.

라우팅만 먼저 만들면 빈 페이지가 4개 생길 뿐이다 — 36(개인 데이터)·37(검색)이 먼저다.

## Owned scope

- 셸 네비게이션, 신규 라우트, 활성 탭 표시
- `tests/`

## Acceptance

- 각 탭이 실제 경로로 이동하고, 현재 탭이 표시된다(aria-current).
- 각 페이지가 로그인 상태에서 실제 내용을 갖는다(빈 껍데기 금지).
- 비로그인은 각 페이지에서 로그인 유도 + 공개 데이터만.
- 모바일 메뉴(☰) 동작·포커스 관리 회귀 0.
