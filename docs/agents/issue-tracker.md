# Issue tracker: Local Markdown

스펙과 티켓은 `.scratch/`에 저장한다.

- 스펙: `.scratch/<feature>/spec.md`
- 티켓: `.scratch/<feature>/issues/<NN>-<slug>.md`
- 티켓은 의존성 순서로 번호를 매긴다.
- 상태와 댓글은 각 파일 안에 기록한다.
- Wayfinder 지도는 `.scratch/<effort>/map.md`에 저장한다.
- 새 Wayfinder 티켓은 `Type`, `Status`, `Triage`, `Depends on`, `Blocked by`, `Owner`, `Claimed at`, `Last heartbeat` 필드를 사용한다. 이 규칙 도입 전에 해결된 티켓은 기존 metadata를 유지할 수 있다.

```md
Type: spec | research | prototype | docs | implementation | bug
Status: open | claimed | resolved
Triage: needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix
Depends on: 01, 02 | None
Blocked by: None | <현재 해소되지 않은 티켓 또는 외부 blocker>
Owner: unclaimed | <agent/task name>
Claimed at: - | <ISO 8601>
Last heartbeat: - | <ISO 8601>
```

- `Depends on`은 선행 작업 이력을 보존한다. 참조한 티켓이 모두 `resolved`면 현재 blocker가 아니다.
- `Blocked by`에는 아직 해결되지 않은 blocker만 기록하고 해소되면 `None`으로 되돌린다.
- `Triage`는 `docs/agents/triage-labels.md`의 상태만 사용한다.

## Wayfinding operations

- **Map**: `.scratch/<effort>/map.md`
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`
- **Blocking**: unresolved dependency나 외부 결정을 `Blocked by`에 기록한다. 해결된 선행 관계는 `Depends on`에만 남긴다.
- **Frontier**: `Status: open`, `Triage: ready-for-agent`, 모든 `Depends on`이 resolved, `Blocked by: None`, `Owner: unclaimed`인 첫 번호의 티켓이다.
- **Preflight**: claim 전에 `git status --short --branch`로 기존 변경을 확인한다. 다른 작업의 변경을 덮거나 임의로 stage하지 않는다.
- **Claim**: 작업 전에 `Status: claimed`, `Owner`, `Claimed at`, `Last heartbeat`를 원자적으로 갱신한다. 2시간 이상 heartbeat가 없으면 메인 에이전트가 작업 트리와 보고를 확인한 뒤에만 stale claim을 회수할 수 있다. 동시 claim 경쟁이 없는 단일 메인 세션의 순차 작업에서는 `Status`/`Owner`만 갱신하고 `Claimed at`/`Last heartbeat`는 `-`로 둘 수 있으며, heartbeat 만료 회수 규칙은 여러 에이전트가 실제로 동시에 claim할 때만 적용한다.
- **Heartbeat**: 중요한 checkpoint(커밋 체크포인트 포함), blocker 발견, 장시간 도구 실행 전후에 갱신한다. routine 메시지를 위한 heartbeat는 만들지 않는다. 커밋은 이미 티켓 파일을 만지는 시점이므로 같은 편집에서 함께 갱신한다.
- **Resolve**: `## Answer`, `## Changed files`, `## Validation`, `## Review`, `## Residual risks`를 기록하고 `Status: resolved`, 완료 시각의 `Last heartbeat`로 변경한 뒤 지도에 링크를 추가한다.
- **Commit checkpoint**: 가능한 한 티켓 하나를 검증 가능한 커밋 하나로 끝낸다. 커밋과 clean-worktree 확인 뒤 같은 세션에서 다음 frontier를 계속 진행할 수 있으며, 세션 경계를 작업 경계로 취급하지 않는다. 체크포인트가 나중에 틀린 것으로 드러나면 되돌릴 수 없는 데이터·외부 영향이 있을 때 revert를 우선하고, 순수 코드 결함이면 회귀 테스트를 추가한 fix-forward로 처리한다. 원인과 조치는 티켓에 기록한다.
