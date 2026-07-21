# 37 - 명령·티커 검색 실작동

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 36
Blocked by: 36
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

사용자 QA(2026-07-21): "종목검색도 안 되고".

사실이다. `guest-terminal-shell.tsx:99-102`의 `handleCommand`는 submit을 가로채 "명령 실행은
다음 단계에서 제공됩니다"라는 문구만 세팅한다. 터미널의 핵심 동작(티커를 쳐서 종목을 본다)이
통째로 stub이다.

## Owned scope

- 셸 명령창 + 종목 화면(라우트/패널), 심볼 해석
- `tests/`

## Acceptance

- 티커 입력 → 해당 종목의 시세(+차트)가 실제로 표시된다(로그인 시 KIS 실값).
- 알 수 없는 심볼은 정직하게 "찾을 수 없음"이며, 값을 만들어내지 않는다.
- 비로그인은 로그인 유도로 끝나고 개인 데이터 경로를 건드리지 않는다.
- 키보드(⌘K·Enter)와 스크린리더 안내가 동작한다.
