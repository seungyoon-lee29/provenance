# 07 - 승인 가능한 MVP 스펙 작성

Type: spec
Status: open
Blocked by: 01, 02, 03, 04, 05, 06

## Question

지금까지 확정한 무료 공급자 정책, 고밀도 Workspace, 모듈·Identity 경계, Actual/Paper Portfolio, 테스트·성능 예산과 알림 전달 결정을 하나의 구현 가능한 MVP spec과 명시적 범위·합격 기준으로 어떻게 통합할 것인가?

## Acceptance criteria

- `.scratch/financial-terminal/spec.md`에 사용자 흐름, 기능/비기능 요구, 데이터 상태, 보안, provider·AI·broker·alert config, 배포와 문서 산출물을 추적 가능한 요구사항으로 작성한다.
- 각 요구사항은 티켓 01~06의 결정 또는 ADR/CONTEXT 용어에 연결하고 공개/개인/로컬 실행 범위와 무료/보류 경계를 구분한다.
- 실제값·지연·API 필요·표시 권한 없음·데이터 없음·실패와 synthetic test data 정책을 acceptance test로 검증할 수 있게 쓴다.
- 구현 단계의 병렬 feature ownership과 통합 순서를 만들 수 있을 정도로 interface contract와 완료 정의를 명시한다.
