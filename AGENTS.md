## 모든 에이전트 공통 하한

아래 상세 문서를 읽지 않았어도 이 하한은 항상 적용된다.

- frontier 티켓은 claim(`Status`/`Owner`/heartbeat) 후 작업하고, 커밋 체크포인트마다 heartbeat를 갱신한다.
- dirty worktree는 다른 세션의 작업으로 간주해 보존한다. 한 파일의 owner는 언제나 한 명.
- 커밋은 파일 allowlist로 stage한다. pre-commit 훅(whitespace·secret 스캔·typecheck·test)을 `--no-verify`로 우회하지 않는다.
- `.env.local`·`.secrets`·credential 원문은 읽기·출력·stage 금지.
- push·`reset --hard`·`clean -f` 등 파괴적 git은 훅이 차단하며, 배정 없이 시도하지 않는다.
- 서브에이전트 위임 시 탐색·조사·기계적 작업은 하위 모델(`sonnet`/`haiku`)을 명시한다. 판단·고위험 에이전트만 메인 모델.
- 위임 프롬프트에는 작업에 필요한 스킬을 이름으로 지목해 호출을 지시하고, 해당 작업에 걸리는 하한 규칙을 인라인한다. 검수 시 실제 호출 여부를 확인한다.

## Agent skills

### Issue tracker

작업은 `.scratch/<feature>/`의 로컬 Markdown 파일로 관리한다. 자세한 규칙은 `docs/agents/issue-tracker.md`를 참고한다.

### Triage labels

기본 트리아지 역할명을 그대로 사용한다. 자세한 매핑은 `docs/agents/triage-labels.md`를 참고한다.

### Domain docs

단일 컨텍스트 구조를 사용한다. 도메인 문서 규칙은 `docs/agents/domain.md`를 참고한다.

### Agent collaboration

메인 에이전트가 최종 판단과 결과에 책임을 지며, 독립적으로 수행할 수 있는 작업은 서브에이전트에게 위임한다. 추론 강도, 역할 분담, 보고, 검수, 비밀·외부 실행 가드와 재작업 규칙은 `docs/agents/collaboration.md`를 참고한다.
