# `.scratch/` 작업 기록

이 디렉터리는 기능별 스펙, dependency map, 티켓, 중간 가설과 검증 결과를 보존하는 저장소 내부 작업 정본이다.

- `spec.md`는 해당 effort가 검증할 계약을 정의한다.
- `map.md`는 destination, 결정 기록과 현재 frontier를 연결한다.
- `issues/`는 claim, owner, dependency, 검증과 잔여 위험을 기록한다.
- `progress/`와 `qa/`는 일시적인 계획과 관찰 증거를 보존할 수 있다.

중간 가설이나 open/claimed 티켓의 문장은 완료된 제품 사실이 아니다. 현재 동작은 코드, 테스트와 `resolved` 티켓의 `Validation`을 함께 확인한다. 정제된 공개 설명은 루트 [README](../README.md)의 "에이전트 운영 모델"과 [`docs/agents/`](../docs/agents/)를 우선한다.

이 디렉터리는 릴리스 패키지에 포함되지 않으며 비밀, credential 원문과 개인 환경 경로를 저장하지 않는다.
