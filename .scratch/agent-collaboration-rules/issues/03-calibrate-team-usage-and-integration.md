# 03 - 팀 사용과 통합 규칙 보정

Type: docs
Status: resolved
Blocked by: 02

## Question

멀티에이전트 운영이 단순 작업에 과도하게 적용되거나 공유 worktree와 Git 상태를 손상하지 않도록 어떤 적용 기준과 통합 책임을 추가해야 하는가?

## Answer

- 독립 작업이 둘 이상이거나 서로 다른 검수 관점이 품질을 실질적으로 높일 때만 멀티에이전트를 사용한다.
- 3인 review team은 인증, Provider Credential, 거래, 데이터 권리와 핵심 아키텍처 같은 고위험 결정에 적용하고, 작고 되돌리기 쉬운 결정은 메인 에이전트 또는 1~2명이 검수한다.
- `parallel-debugging`은 plausible한 원인이 둘 이상이거나 여러 module·환경에 걸친 문제에만 사용한다. 결정적인 typecheck, lint와 단일 테스트 실패에는 사용하지 않는다.
- 공유 worktree에서는 branch 전환을 금지하고 sub-branch는 별도 Git worktree가 있을 때만 사용한다. 기본 stage, commit과 push 책임은 메인 에이전트가 가진다.
- Critical·High finding은 반드시 해결하고, Medium은 해결하거나 연기 사유와 후속 티켓을 기록한다. Low는 영향이 없으면 backlog로 남길 수 있다.
- 통합은 변경 파일 검수, 관련 테스트, 전체 검증, 최종 diff 검토와 명시적 commit 순서로 수행한다.
