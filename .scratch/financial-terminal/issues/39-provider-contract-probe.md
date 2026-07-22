# 39 - 공급자 응답 계약 상시 프로브

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 28, 31, 32, 33
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

현재 검증은 전부 **내가 틀리는 것**만 잡는다. network-off 결정론 TDD·property·mutation은
저장소 코드의 회귀를 잡지, 외부 공급자가 응답 스키마를 바꾸는 것은 잡지 못한다.

계약 테스트는 있지만 `KIS_CONTRACT=1` 같은 opt-in env 게이트라 기본 실행 경로에서 빠진다.
즉 KIS·DART·Treasury·ECB 중 하나가 필드명이나 타입을 바꿔도 **아무도 돌리지 않으면 모른다.**
배선된 실공급자가 4개로 늘어난 지금 이 공백이 가장 크다.

선례: `tossinvest-cli` 의 `monitor api` — read-only 엔드포인트 스키마를 병렬 프로브하고
**exit code만 반환**한다. 알림 채널은 스크립트에 넣지 않고 cron 라인의 `|| <command>` 우항에서
사용자가 합성한다. 도구가 정책을 갖지 않는 이 분리를 그대로 가져온다.

## Owned scope

- `scripts/` 프로브 진입점 + `package.json` script
- 각 어댑터가 이미 가진 zod 스키마 **재사용** (프로브용 스키마를 새로 만들지 않는다)
- `tests/`

## Acceptance

- 단일 명령이 배선된 공급자별 read-only 엔드포인트를 실제 호출해 기존 스키마로 검증하고,
  통과 0 / 실패 1의 **exit code만** 반환한다. 알림·webhook 로직은 포함하지 않는다.
- 크리덴셜이 없는 공급자는 `skipped`로 분류하고 실패로 처리하지 않는다 —
  게스트 공개 소스만으로 CI에서 돌 수 있어야 한다.
- 출력에 크리덴셜·개인 데이터·응답 본문 원문이 포함되지 않는다. 스키마 위반 경로(`path`)와
  기대/실제 타입까지만 노출한다.
- `npm run check`와 `verify:network-off`를 오염시키지 않는다. 별도 script이며 기본 실행 경로에
  들어가지 않는다(네트워크가 필요한 유일한 레인).
- `personal` 라이선스 공급자의 프로브 결과는 공개 산출물·릴리스 패키지로 재배포되지 않는다.
- 유량 게이트(티켓 34 `withRequestSpacing`)를 우회하지 않는다.

## Residual (미리 기록)

- 프로브가 잡는 것은 **스키마 계약**이지 값의 정확성이 아니다. 공급자가 같은 모양으로 틀린 값을
  주면 이 레인은 통과한다.
