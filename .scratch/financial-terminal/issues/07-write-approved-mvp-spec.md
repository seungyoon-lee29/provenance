# 07 - 승인 가능한 MVP 스펙 작성

Type: spec
Status: resolved
Triage: ready-for-agent
Depends on: 01, 02, 03, 04, 05, 06
Blocked by: None
Owner: /root
Claimed at: 2026-07-15T02:24:40+09:00
Last heartbeat: 2026-07-15T03:00:20+09:00

## Question

지금까지 확정한 무료 공급자 정책, 고밀도 Workspace, 모듈·Identity 경계, Actual/Paper Portfolio, 테스트·성능 예산과 알림 전달 결정을 하나의 구현 가능한 MVP spec과 명시적 범위·합격 기준으로 어떻게 통합할 것인가?

## Acceptance criteria

- `.scratch/financial-terminal/spec.md`에 사용자 흐름, 기능/비기능 요구, 데이터 상태, 보안, provider·AI·broker·alert config, 배포와 문서 산출물을 추적 가능한 요구사항으로 작성한다.
- 각 요구사항은 티켓 01~06의 결정 또는 ADR/CONTEXT 용어에 연결하고 공개/개인/로컬 실행 범위와 무료/보류 경계를 구분한다.
- 실제값·지연·API 필요·표시 권한 없음·데이터 없음·실패와 synthetic test data 정책을 acceptance test로 검증할 수 있게 쓴다.
- 구현 단계의 병렬 feature ownership과 통합 순서를 만들 수 있을 정도로 interface contract와 완료 정의를 명시한다.

## Answer

- [승인 MVP spec](../spec.md)에 티켓 01~06의 사용자 흐름, 공개/개인/로컬 범위, 무료/보류 경계, module interface, data/AI/portfolio/trading/alert/security contract, 성능·배포·문서 gate를 추적 가능한 요구사항으로 통합했다.
- Information Outcome, Data Freshness, License Scope와 synthetic-production 금지를 실제값 표시의 공통 경계로 고정하고 provider·broker·email·Web Push failure를 독립 fixture로 판정하게 했다.
- server-only source/job/delivery resolver, Viewer Context와 epoch/version 소유권, Actual/Paper 분리 원장, exact Delivery Intent 조합을 구현 가능한 signature와 acceptance oracle로 명시했다.
- 구현 lane F0~F11의 단일 ownership, dependency, parallel group과 critical path를 정해 다음 단계에서 코드보다 먼저 implementation ticket으로 분해할 수 있게 했다.

## Changed files

- `.scratch/financial-terminal/spec.md`: 승인 MVP spec과 F0~F11 구현 순서.
- `CONTEXT.md`, 티켓 03·05·06, `docs/research/free-alert-delivery.md`: email challenge, delivery context와 action-material 정본 동기화.
- `docs/adr/0003-isolate-evidence-and-provider-credentials.md`: AI Material Reference와 generation/fence-bound AuthorizedTransport.
- `.env.example`, `docs/configuration/provider-credentials.md`: Google/GitHub Identity와 provider/delivery canonical configuration.
- `docs/reviews/2026-07-14-ticket-06-design.md`, `docs/reviews/2026-07-15-ticket-07-spec.md`: 후속 결정과 반복 검수 기록.
- `.scratch/financial-terminal/map.md`, 이 티켓: 승인 spec 링크와 frontier 종료 상태.

## Validation

- changed Markdown 내부 링크가 모두 실제 파일로 resolve된다.
- `git diff --check`와 requirement definition uniqueness 검사가 통과한다.
- stale account-challenge/AI contract phrase와 secret-shaped diff scan 결과가 0이다.
- `.env.local`과 `.secrets`는 status/stage에 없고 `.env.local` 내용은 읽지 않았다.

## Review

architecture/security, spec quality/delivery, portfolio/trading 세 관점의 읽기 전용 병렬 검수와 같은 reviewer의 2차 표적 재검토를 완료했다. 최종 결과는 모두 Critical 0 / High 0 / Medium 0이며 quality Low도 0이다. 상세는 [티켓 07 승인 MVP 스펙 검수](../../../docs/reviews/2026-07-15-ticket-07-spec.md)에 기록했다.

## Residual risks

- KRX/Open DART와 개인 provider entitlement, Google/GitHub 운영 application, Resend/VAPID, production origin과 유료 표시·재배포 권리는 구현 시 opt-in contract 또는 외부 승인이 필요하다.
- 실행 앱, Docker image, ZIP과 실데이터 screenshot은 아직 없으며 spec의 F0~F11 구현·release gate에서 만들어 검증한다.
- 다음 단계는 spec을 implementation ticket으로 분해하는 것이며 아직 코드 frontier는 만들지 않았다.
