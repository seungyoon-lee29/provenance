# 40 - 주문별 confirm token

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 17, 18
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

F8/F9의 주문 경로는 default-off flag · idempotency key · reconciliation으로 contain된다.
하지만 **"사용자가 확인한 주문 intent"와 "실제로 실행되는 주문 intent"가 같다는 증명이 없다.**
호출자(UI든 에이전트든)가 preview 후 파라미터를 바꿔 전송해도 게이트는 전부 통과한다.

idempotency key는 *같은 요청의 중복 실행*을 막고, confirm token은 *다른 요청의 무단 실행*을 막는다.
지금은 앞의 것만 있다.

선례: `tossinvest-cli` 는 config 토글(영속)과 `--execute`(런타임) 위에 **preview에서 발급된
주문별 `--confirm <token>`** 을 둔다. preview를 보지 않으면 토큰을 얻을 수 없으므로 의도하지 않은
주문은 토큰 불일치로 차단된다. 저자도 "진짜 안전장치는 confirm token"이라고 명시한다.

지금은 Paper 원장뿐이라 급하지 않지만, **에이전트가 우리 API를 호출하는 미래를 대비한
가장 싼 보험**이고 Live를 열 때 그대로 재사용된다.

## Owned scope

- `src/modules/paper-trading/` intent 정규화 + token 파생
- `tests/property/`
- `src/modules/actual-portfolio/`는 건드리지 않는다(읽기 전용 · Actual/Paper 격리 불변식)

## Acceptance

- preview가 **정규화된 order intent에서 결정론적으로 파생된** token을 함께 반환한다.
- 실행은 token 없이 거부한다. token이 현재 intent와 불일치하면 거부한다.
- token 파생은 순수 함수이며 property test로 증명한다:
  같은 intent → 같은 token, **어느 필드든 바뀌면 다른 token**.
- 기존 idempotency key와 역할이 겹치지 않음을 코드와 티켓 양쪽에 명시한다
  (idempotency = 중복 방지, confirm = intent 일치 증명).
- token은 권한 증명이 아니다 — 세션·워크스페이스 인가를 대체하거나 우회하지 않는다.
- **No Live Trading 불변식 유지.** 이 티켓은 Live 경로를 열지 않는다.
