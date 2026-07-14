# 02 - 단계별 에이전트 팀 운영 패턴 적용

Type: docs
Status: resolved
Depends on: 01
Blocked by: None

## Question

설계, 구현, 통합과 오류 해결 단계마다 어떤 팀 구성, 작업 분해, 검수와 통신 규칙을 적용해야 병렬 작업의 이점을 얻으면서 충돌과 중복을 막을 수 있는가?

## Answer

- 설계는 `task-coordination-strategies`로 의존성 그래프를 만들고 `team-composition-patterns`로 최소 팀을 구성한 뒤, `multi-reviewer-patterns`로 서로 다른 관점을 병렬 검수한다.
- 구현은 `parallel-feature-development`로 module·vertical slice·directory 중 결합도가 가장 낮은 단위로 나누고 한 파일에 한 owner만 둔다. 공유 interface contract는 메인 에이전트나 지정 owner만 수정한다.
- 통합과 오류 해결은 `parallel-debugging`으로 서로 다른 가설을 조사하고 직접 근거와 confidence를 비교해 root cause를 중재한다.
- `team-communication-protocols`에 따라 routine 메시지는 직접 전송하고 broadcast는 critical blocker와 공유 contract 변경에만 사용한다. integration point를 알리고 완료된 에이전트는 검증 근거를 보존한 뒤 종료한다.
- 메인 에이전트는 모든 단계에서 범위, critical path, finding 중복 제거, 통합과 최종 검증에 책임을 진다.

상세 운영 규칙은 `docs/agents/collaboration.md`에 기록했다. 티켓 03 설계에는 3인 review team을 실제 적용했고 통합 결과는 `docs/reviews/2026-07-14-ticket-03-design.md`에 남겼다.
