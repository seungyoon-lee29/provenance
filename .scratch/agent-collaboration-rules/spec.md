# 에이전트 협업 규칙

## Goal

메인 에이전트와 서브에이전트의 책임, 위임 기준, 작업 보고, 검수와 재작업 절차를 명확히 정의한다.

## Acceptance criteria

- 메인 에이전트가 사용자 의도 해석, 범위와 위험 판단, 최종 승인에 책임을 진다.
- 서브에이전트에는 독립적이고 경계가 분명한 작업만 위임한다.
- 위임 시 목표, 범위, 산출물과 완료 기준을 제공한다.
- 서브에이전트의 보고 항목과 메인 에이전트의 검증 절차를 정의한다.
- 검수 실패와 반복 실패에 대한 재작업 원칙을 정의한다.
- 병렬 작업 시 파일 충돌과 무단 범위 확장을 방지한다.
- 설계, 구현, 통합·오류 해결 단계별 팀 구성과 적용할 agent-team skill을 정의한다.
- 작업마다 의존성, 파일 ownership, interface contract와 검증 기준을 명시한다.
- 병렬 review의 관점 분리, 심각도 보정과 finding 중복 제거 규칙을 정의한다.
- 팀 통신, 공유 contract 변경 알림과 종료 절차를 정의한다.
- 위험도와 실제 병렬 가능성에 따라 팀 사용 여부와 reviewer 수를 조절한다.
- 공유 worktree의 branch 전환, Git 책임과 파일 ownership 안전 규칙을 정의한다.
- review finding의 필수 해결·연기 기준과 통합 검증 순서를 정의한다.
- 작업 유형과 위험에 따른 `Low | Medium | High | XHigh` 추론 강도 기준을 정의한다.
- ticket dependency와 현재 blocker, claim owner·lease·heartbeat를 구분한다.
- 비밀 파일, provider smoke, broker mutation과 Live Trading의 실행 gate를 정의한다.
- 기본 review와 targeted re-review의 종료 조건을 정의한다.
- 세션 경계가 아니라 검증된 티켓별 커밋을 작업 checkpoint로 사용한다.
