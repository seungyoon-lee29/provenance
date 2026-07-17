# 22 - CI 게이트 도입 (로컬 훅과 동일 게이트의 원격 강제)

Type: implementation
Status: open
Triage: needs-info
Depends on: 09
Blocked by: 원격 저장소·CI 플랫폼 미정 (사용자 결정 필요)
Owner: unclaimed
Claimed at: -
Last heartbeat: -

## Objective

현재 품질 게이트는 전부 로컬 pre-commit 훅(whitespace·secret 스캔·typecheck·전체 vitest)이다. 훅을 거치지 않는 경로(다른 도구의 커밋, 훅 미설치 클론)가 생기면 뚫린다. 동일 게이트를 CI에서 두 번째 층으로 강제한다.

## Requirements

- CI 파이프라인이 pre-commit 훅과 **동일한 검사**를 실행한다: whitespace, secret 패턴 스캔, `.env.local`/`.secrets` 미추적 확인, typecheck, 전체 vitest, seams.
- 게이트 정의는 훅과 CI가 **한 소스를 공유**한다(스크립트 추출) — 두 벌 관리로 인한 드리프트 금지.
- CI에는 provider secret이 필요 없어야 한다(scripted lane만 실행, SEC-05 유지). secret을 CI 환경변수로 넣지 않는다.
- browser(Playwright)·perf 스펙은 별도 job으로 분리하고 필수/선택 여부를 명시한다(러너 비용 고려).
- push 차단 훅(ALLOW_PUSH=1)과의 관계를 문서화한다 — CI 도입이 push 정책을 약화하지 않는다.

## Needs-info (사용자 결정)

1. 원격 저장소를 만들 것인가, 어디에(GitHub/기타)? 현재 remote 없음.
2. CI 플랫폼(GitHub Actions 가정 가능 여부)과 러너 비용 한도.
3. browser/perf job을 CI 필수 게이트로 할지 선택 실행으로 할지.

## Out of scope

- 배포 파이프라인, 외부 provider contract 테스트(RUN_* 게이트), Live Trading 관련 어떤 경로도 포함하지 않는다.

## Traceability

- 발단: 2026-07-17 하네스 리뷰에서 "게이트 전부 로컬 훅 = CI 부재가 가장 약한 층" 지적. AGENTS.md 하한(훅 우회 금지)의 원격 집행 층.
