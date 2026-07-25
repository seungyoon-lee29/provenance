## 모든 에이전트 공통 하한

아래 상세 문서를 읽지 않았어도 이 하한은 항상 적용된다.

- frontier 티켓은 claim(`Status`/`Owner`/heartbeat) 후 작업하고, 커밋 체크포인트마다 heartbeat를 갱신한다.
  - **예외 (Stage형 저장소 재편 작업, 2026-07-24 명문화)**: 번호 티켓 대신 `.scratch/<feature>/progress/<stage>.md`로 갈음할 수 있다.
    단 그 문서는 **착수 전 첫 절에 Blast radius/검증 tier 선언**(collaboration.md의 tier 표 기준)을 반드시 포함한다 —
    T2-b에서 이 선언이 생략된 채 money 경로가 진행된 것이 이 규칙의 계기다. tier-gate(commit-msg 훅)가 커밋 레벨에서 이중으로 잡는다.
- dirty worktree는 다른 세션의 작업으로 간주해 보존한다. 한 파일의 owner는 언제나 한 명.
- 커밋은 파일 allowlist로 stage한다. pre-commit 훅을 `--no-verify`로 우회하지 않는다. 훅이 무엇을 검사하는지는 `.husky/`와 `scripts/gates/`가 정본이다 — 여기 나열하면 드리프트한다.
- `.env.local`·`.secrets`·credential 원문은 읽기·출력·stage 금지.
- push와 릴리스는 사람 소유 단계다. 에이전트는 배정 없이 push·`reset --hard`·`clean -f` 같은 외부·파괴적 Git 작업을 시도하지 않는다.
- 서브에이전트 위임 시 탐색·조사·기계적 작업은 비용이 낮은 실행 tier를 명시한다. 판단·고위험 작업만 주 실행 tier를 사용한다.
- 위임 프롬프트에는 작업에 필요한 스킬을 이름으로 지목해 호출을 지시하고, 해당 작업에 걸리는 하한 규칙을 인라인한다. 검수 시 실제 호출 여부를 확인한다.
- **서브에이전트의 결론은 메인이 직접 재현한 뒤에만 채택한다.** 재현하지 못한 주장은 "미검증"으로 표시해 보고하고, 그 주장 위에 파괴적 결정(삭제·범위 축소)을 세우지 않는다.
  - 계기 (2026-07-26, arch-1): blind 저자가 "vitest는 파일 간 순서를 강제할 수 없다"는 **거짓 근거**로 PG 테스트 블록을 삭제했다(`--no-file-parallelism`이 존재한다). 그 블록은 애초에 어떤 레인에도 안 걸려 있었다는 진짜 이유가 따로 있었는데, 거짓 근거가 그대로 기록으로 남을 뻔했다.
- **적대 리뷰에서 채택해 반영한 수정은 원 변경과 같은 tier로 다시 공격한다.** 한 라운드로 끝내지 않는다.
  - 계기 (2026-07-26, arch-1): 1라운드 지적을 반영한 수정이 원 문제보다 나빴다 — 거부를 매직 스트링으로 인코딩해, 그 값을 든 뷰어가 임의 워크스페이스를 읽고 genesis까지 열 수 있었다. 2라운드가 실행으로 증명했다. 1라운드에서 멈췄으면 그대로 나갔다.

## Agent skills

### Issue tracker

작업은 `.scratch/<feature>/`의 로컬 Markdown 파일로 관리한다. 자세한 규칙은 `docs/agents/issue-tracker.md`를 참고한다.

### Triage labels

기본 트리아지 역할명을 그대로 사용한다. 자세한 매핑은 `docs/agents/triage-labels.md`를 참고한다.

### Domain docs

단일 컨텍스트 구조를 사용한다. 도메인 문서 규칙은 `docs/agents/domain.md`를 참고한다.

### Agent collaboration

메인 에이전트가 최종 판단과 결과에 책임을 지며, 독립적으로 수행할 수 있는 작업은 서브에이전트에게 위임한다. 추론 강도, 역할 분담, 보고, 검수, 비밀·외부 실행 가드와 재작업 규칙은 `docs/agents/collaboration.md`를 참고한다.
