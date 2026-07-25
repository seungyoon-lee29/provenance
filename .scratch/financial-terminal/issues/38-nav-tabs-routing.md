# 38 - 상단 탭을 실제 페이지로

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 36, 37
Blocked by: 36
Owner: unassigned
Claimed at: -
Last heartbeat: 2026-07-25

## Answer (2026-07-25 — 무효 처분, 코드 변경 없음)

**pivot(2026-07-22) 배너의 "UI 트랙 이월/백로그 무효" 범주에 해당해 집행 없이 닫는다.**
이 티켓의 수용 기준 전부(탭 라우트·로그인 상태 페이지·비로그인 로그인 유도·모바일 메뉴)가
Stage 3(웹·인증 컷)에서 제거될 표면이다. Status: ready로 방치돼 있어 미래 세션이 집을 수
있었던 것이 유일한 위험이었고, 이 처분이 그것을 닫는다. Stage 3 뒤 CLI/MCP가 얼굴이 되면
"탭"이라는 개념 자체가 없다. 웹 셸 잔존분(게스트 쇼케이스)의 처분은 Stage 3 존치-조건
(pivot §4 복원분: 하드코딩 게이트·Blotter 제거)이 정본이다.

## Changed files
- 이 티켓 파일만 (상태 처분)

## Validation
- 해당 없음 (문서 처분)

## Residual risks
- 없음 — 웹 표면 처분은 Stage 3 티켓이 소유

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
