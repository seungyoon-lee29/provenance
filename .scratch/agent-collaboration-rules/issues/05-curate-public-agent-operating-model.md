# 05 - 포트폴리오용 운영 모델 정리

Type: docs
Status: resolved
Triage: ready-for-agent
Depends on: 04
Blocked by: None
Owner: codex-public-harness-curation
Claimed at: 2026-07-21T14:36:18+09:00
Last heartbeat: 2026-07-21T14:42:11+09:00

## Question

에이전트 하네스와 반복 검증 설계를 포트폴리오 신호로 공개하면서도 특정 도구의 로컬 실행 세부, 원시 학습 메모와 작업 기록의 노이즈를 줄이고 실제 강제 장치까지 어떻게 보여줄 것인가?

## Acceptance criteria

- `CLAUDE.md`는 공유 규칙을 가리키는 짧은 호환 진입점으로 유지한다.
- `AGENTS.md`와 협업 규칙에서 모델 제품명, 로컬 push 우회 방법과 개인 환경 경로를 제거한다.
- README에서 운영 모델, 반복 검증 흐름과 실제 CI·릴리스 강제 장치를 찾을 수 있다.
- 학습 메모를 문제, 설계, 관찰 결과와 상시화 결과가 드러나는 공개 사례 연구로 정리한다.
- `.scratch/`는 내부 작업 정본임을 명시하고 공개 설명에서는 정제된 문서와 완료된 증거를 우선한다.
- Markdown 링크, whitespace와 금지된 로컬·credential 패턴 검사를 통과한다.

## Answer

- `CLAUDE.md`는 `@AGENTS.md` 한 줄의 호환 진입점으로 유지했다.
- `AGENTS.md`와 협업 규칙에서 특정 모델 제품명, 개인 환경의 push 우회법과 토큰 예산 표현을 제거하고 위험 기반 실행 tier로 일반화했다.
- README에 dependency map → frontier claim → ownership → deterministic gates → adversarial review → human gate 흐름과 상세 문서 링크를 추가했다.
- 기존 학습 메모를 일회성 검수의 vacuous pass를 상시 property·mutation·network-off 검증으로 전환한 사례 연구로 다시 작성했다.
- `.scratch/README.md`에서 raw 작업 기록과 현재 제품 사실의 경계를 설명하고 릴리스 패키지 제외 정책을 연결했다.

## Changed files

- `AGENTS.md`
- `README.md`
- `docs/agents/collaboration.md`
- `docs/notes/harness-and-loop-engineering.md`
- `.scratch/README.md`
- `.scratch/agent-collaboration-rules/spec.md`
- `.scratch/agent-collaboration-rules/map.md`
- `.scratch/agent-collaboration-rules/issues/05-curate-public-agent-operating-model.md`

## Validation

- `npm run check:release-docs`: 31 docs, 0 problems.
- `npm run check`: typecheck 통과, lint 오류 0(기존 `stryker.config.mjs` warning 1), Vitest 114 files passed/6 skipped와 1,298 tests passed/27 skipped, public/server seam 통과.
- `git diff --check`: 통과.
- 공개 진입 문서의 `/Users/`, home-relative path, push 우회 변수, 특정 모델 제품명과 이전 토큰 측정값 검색: 잔여 없음.
- 사례 연구의 네 불변식을 `tests/property/`, `scripts/verify-network-off.ts`와 `stryker.config.mjs`에 직접 대조했다.
- 최초 `npm run check-release-docs`는 존재하지 않는 script 이름을 입력해 실행 전 실패했고, 실제 script인 `npm run check:release-docs`로 즉시 교정했다.
- `project-wayfinder` 범용 validator는 기존 맞춤 구조 때문에 실패했다: `docs/agents/workflow.md`, ADR 템플릿과 marker block 부재, 규칙 도입 전 resolved 티켓 01~03의 legacy metadata. `docs/agents/issue-tracker.md`가 legacy metadata 보존을 허용하므로 이번 공개 문서 티켓에서 소급 개조하지 않았다.

## Review

작업은 문서-only이고 결과가 결정적이므로 서브에이전트를 사용하지 않았다. 메인 에이전트가 공개 진입점, 상대 링크, 실제 검증 파일과 최종 diff를 직접 대조했다. 다른 세션이 수정 중인 재무부 데이터 기능과 `next-env.d.ts`는 보존하고 이번 소유 파일에 포함하지 않았다.

## Residual risks

`.scratch/` 작업 이력은 GitHub에서 탐색할 수 있으므로 중간 가설이 완성된 제품 사실로 오인될 수 있다. README와 `.scratch/README.md`에서 경계를 명시했고 릴리스 패키지에서는 fail-closed로 제외하지만, 향후 공개 저장소의 기록량이 커지면 대표 resolved 티켓만 별도 case study로 승격하는 정기 큐레이션이 필요하다. 범용 Wayfinder validator와 현재 맞춤 구조의 차이는 별도 setup 호환성 티켓에서만 해소해야 한다.
