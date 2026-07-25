# 40 - 주문별 confirm token

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 17
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

> **v2 (2026-07-25)** — pivot(07-22)·Stage 1~2c·T8/T9 이후 재점검 반영.
> v1 대비 정정: ① F9 의존 제거(Stage 1 삭제 모듈) ② "preview 후 파라미터 스왑" 전제가
> 현 F8 intent 설계에서 이미 닫혀 있음을 명시하고 이 티켓이 **추가**하는 것을 재정의
> ③ §8 canonicalPayload 정규화 재사용 지시 ④ 토큰 바인딩·수명 설계 결정 명문화
> ⑤ T10(CLI/MCP) 소비자 관점 추가. v1 원문은 하단 보존.

## Context (v2)

idempotency key는 *같은 요청의 중복 실행*을 막고, confirm token은 *다른 요청의 무단 실행*을
막는다 — 이 구분(v1)은 유효하다. 단 v1의 "호출자가 preview 후 파라미터를 바꿔 전송해도 게이트는
전부 통과한다"는 전제는 **현 아키텍처에서 성립하지 않는다**: F8 submit은 `{account, intent}`만
보내고 payload는 서버 보관 레코드에 있다(one-time PaperOrderIntent). 파라미터 재전송 자체가
없으므로 스왑 공격 경로는 이미 닫혀 있다.

이 티켓이 실제로 **추가**하는 것:

1. **표시-실행 일치의 호출자 검증** — 에이전트가 사람에게 보여준 주문 plan과 서버가 실행할
   intent가 같다는 것을 호출자 쪽에서 검증할 수단. 불투명 intent reference로는 불가능하다
   (reference는 "무엇을" 실행하는지 아무것도 말하지 않는다). pivot 에이전트 인터페이스 메모의
   3단 권한 경계 ③("주문=자연어 plan 확인 후 실행")의 기계적 토대다.
2. **Live 개방 대비 이월 보험**(v1 논거 유지) — Live를 열 때 그대로 재사용된다.

선례(tossinvest-cli preview→`--confirm <token>`)는 v1 그대로 유효.

## 설계 결정 (v2 신규 — 착수 전 확정)

- **정규화 재사용**: token은 정규화된 intent 필드의 결정론 파생이며, 정규화는 §8 receipt의
  `canonicalPayload` 기계를 **재사용**한다. 새 정규화 정의를 만들지 않는다(정규화 정의가 둘이면
  드리프트 — 이 저장소의 "must match" 금지 원칙).
- **바인딩 범위**: 파생 입력에 최소 {workspace, account, instrument, venue, side, orderType,
  limitPrice?, quantity, timeInForce}를 포함한다. **intent reference 포함을 권장**(one-time
  성질과 정합 — intent 1:1 토큰, 재발급 intent는 재확인 요구). 미포함을 택하면 그 이유와
  재사용 의미론을 코드 doc에 남긴다.
- **수명**: intent TTL에 종속. 별도 수명 상태를 만들지 않는다(상태 없는 순수 파생 + intent
  소비가 수명을 대신한다).
- **검증 위치**: intent 소비 시점(한 경로). token 검증용 별도 저장·별도 게이트를 만들지 않는다.

## Owned scope

- `src/modules/paper-trading/` intent 정규화 재사용 + token 파생 + 소비 시 검증
- `tests/property/`
- T10 소비자 배선(CLI `--dry-run`/preview 출력, 실행 명령 `--confirm`)은 T10 몫 — 이 티켓은
  엔진 쪽 파생·검증 계약까지

## Acceptance

- preview(prepare)가 **정규화된 order intent에서 결정론적으로 파생된** token을 함께 반환한다.
- 실행은 token 없이 거부한다. token이 현재 intent와 불일치하면 거부한다 — 검증은 intent 소비
  시점에 **한 경로**로 수행한다.
- token 파생은 순수 함수이며 property test로 증명한다:
  같은 intent → 같은 token, **바인딩 필드 어느 것이든 바뀌면 다른 token**.
- 정규화는 §8 `canonicalPayload` 기계 재사용 — diff에 새 정규화 정의가 없어야 한다.
- 3자 역할 구분을 코드 주석과 티켓 양쪽에 명시한다:
  idempotency = 중복 방지 / intent = one-time 실행 자격 + 서버 보관 payload /
  confirm = 표시-실행 일치의 호출자 검증.
- token은 권한 증명이 아니다 — 세션·워크스페이스 인가를 대체하거나 우회하지 않는다.
- **No Live Trading 불변식 유지.** 이 티켓은 Live 경로를 열지 않는다.
- guarded money 경로 — **tier top** 4축 게이트(blind·codex·Standards·mutation) resolve 전 완주.

---

## v1 (2026-07-21, superseded — 이력 보존)

Depends on: 17, 18

### Context

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

### Owned scope

- `src/modules/paper-trading/` intent 정규화 + token 파생
- `tests/property/`
- `src/modules/actual-portfolio/`는 건드리지 않는다(읽기 전용 · Actual/Paper 격리 불변식)

### Acceptance

- preview가 **정규화된 order intent에서 결정론적으로 파생된** token을 함께 반환한다.
- 실행은 token 없이 거부한다. token이 현재 intent와 불일치하면 거부한다.
- token 파생은 순수 함수이며 property test로 증명한다:
  같은 intent → 같은 token, **어느 필드든 바뀌면 다른 token**.
- 기존 idempotency key와 역할이 겹치지 않음을 코드와 티켓 양쪽에 명시한다
  (idempotency = 중복 방지, confirm = intent 일치 증명).
- token은 권한 증명이 아니다 — 세션·워크스페이스 인가를 대체하거나 우회하지 않는다.
- **No Live Trading 불변식 유지.** 이 티켓은 Live 경로를 열지 않는다.
