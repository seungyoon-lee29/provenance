# 04 - 추론 강도와 실행 가드 보정

Type: docs
Status: resolved
Triage: ready-for-agent
Depends on: 03
Blocked by: None
Owner: codex-side-conversation
Claimed at: 2026-07-15T02:15:11+09:00
Last heartbeat: 2026-07-15T02:17:09+09:00

## Question

금융 터미널의 설계와 구현에 적합한 추론 강도를 어떻게 조절하고, ticket claim, 병렬 구현, 검수 수렴, 비밀과 실제 provider·broker 실행을 어떤 운영 규칙으로 안전하게 제한할 것인가?

## Acceptance criteria

- 작업 위험별 `Low | Medium | High | XHigh` 사용 기준을 정의한다.
- dependency와 active blocker, claim owner·lease·heartbeat를 구분한다.
- 티켓 완료 증거와 티켓별 commit checkpoint를 정의한다.
- 병렬 구현과 반복 review의 적용·종료 조건을 명시한다.
- `.env.local`, provider smoke, Paper broker mutation과 Live Trading의 실행 gate를 명시한다.

## Answer

- 프로젝트 기본 추론 강도를 `High`로 정하고, 인증·비밀·데이터 권리·거래·회계·삭제·동시성 같은 되돌리기 어려운 경계와 반복 실패한 복합 디버깅에만 `XHigh`를 사용한다.
- `Depends on`과 현재 `Blocked by`를 분리하고 open ticket에 triage, owner, claim 시각과 heartbeat를 기록한다. stale claim은 메인 에이전트가 worktree와 보고를 확인한 뒤에만 회수한다.
- 독립 vertical slice가 둘 이상이고 파일 ownership이 겹치지 않을 때만 병렬 구현한다. 첫 end-to-end tracer와 움직이는 공유 contract는 순차적으로 완주한다.
- 기본 review 1회와 affected scope targeted re-review 1회를 검수 단위로 삼고, 새 직접 근거나 잔여 Critical/High가 있을 때만 추가 review한다.
- secret 파일과 원문 credential은 stage하지 않고 provider smoke, Paper order mutation과 Live Trading에 단계별 명시적 실행 gate를 요구한다.
- 티켓별 Answer, 변경 파일, 검증, review와 잔여 위험을 남기고 가능한 한 티켓 하나를 커밋 하나로 끝낸 뒤 같은 세션에서 다음 frontier를 계속한다.

## Changed files

- `AGENTS.md`, `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`, `collaboration.md`
- `.scratch/agent-collaboration-rules/` spec, map과 티켓 01~04
- `.scratch/financial-terminal/issues/01~07`의 dependency/blocker metadata와 티켓 07 claim metadata

## Validation

- `git diff --check`
- 전체 tracked/untracked Markdown 상대 링크 검사
- 변경 diff의 secret prefix/private-key 패턴 검사
- `.scratch/`의 non-None `Blocked by` 잔여와 티켓 04·07 metadata 확인

## Review

현재 저장소의 협업·이슈·트리아지·도메인 규칙과 다음 frontier를 메인 에이전트가 직접 대조했다. 이번 보정은 문서와 metadata만 변경하며 서브에이전트는 사용하지 않았다.

## Residual risks

규칙 준수 여부는 실제 구현과 통합 티켓에서 검증해야 한다. claim lease와 review 종료 조건이 작업을 성급하게 중단시키지 않는지 첫 vertical slice 완료 뒤 다시 점검한다.
