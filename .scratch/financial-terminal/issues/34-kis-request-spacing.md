# 34 - KIS 동시 호출 레이트리밋 게이트

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 26, 31
Blocked by: None
Owner: main
Claimed at: 2026-07-21T09:05:00Z
Last heartbeat: 2026-07-21T10:00:00Z

## Resolution (2026-07-21)

### Answer

① `withRequestSpacing(inner, {minIntervalMs, clock})` — 모든 KIS 트래픽(토큰 포함)이 통과하는
`KisHttp` 경계에서 호출을 직렬화한다. 실패한 호출이 큐를 막지 않고, 대기는 주입 clock이라
network-off 결정론 유지.

② **간격은 문서가 아니라 실측으로 정했다.** 실 모의 서버에 8콜씩:

| 간격 | 결과 |
|---|---|
| 500ms | EGW00201 발생 (초당 2건 경계에 딱 걸림) |
| 700ms | 8콜 중 **2건** EGW00201 |
| 1100ms | **0건**, 7.7s |
| 1500ms | 0건이지만 7콜만 전송 — 8번째가 10s 데드라인 초과 |

→ 모의 지속 한도는 **초당 ~1건**(순간 버스트만 2건). `minIntervalMs: 1_100` 채택.

③ **오분류 root cause**: KIS는 유량 초과를 HTTP 200이 아니라 **500 + rt_cd=1/EGW00201**로 준다.
코드는 상태코드를 먼저 보고 5xx→`upstream`으로 끝냈기 때문에 `quota` 특례가 죽어 있었다.
실측된 유량 코드만 상태코드보다 우선하게 고정(인증 상태코드 의미는 불변).

### Changed files

`kis-market-information.ts`(전송 데코레이터 + 유량 코드 우선), `market-server.ts`(1100ms 주입),
`tests/kis-request-spacing.test.ts`(5), `tests/kis-market-information.test.ts`(+1 반례).

### Validation

- network-off 6 green(간격·순서·불필요 대기 없음·실패 격리·데드라인, HTTP 500 유량 반례).
- `npm run check` 전 레인 green(1,356).
- **실 KIS 라이브**: 동시 3심볼 × 3라운드 연속 **9/9 available**(수정 전에는 매 라운드 1건 실패).
  실브라우저 `/workspace`도 코스피 6,747.95 · 코스닥 753.34 · 삼성전자 259,000 동시 표시 확인.

### Residual risks

- 직렬화는 프로세스 내부 한정. 인스턴스가 여러 개면 합산 유량이 다시 한도를 넘는다(단일 dev/single_owner
  전제에서만 성립).
- 심볼 8개 초과 화면은 간격만으로 10s 데드라인을 넘긴다 — 티켓 36에서 짧은 TTL 캐시/배치가 선행돼야
  한다(간격을 더 줄이는 방향은 오답).
- 리뷰는 self 1-pass(개인 read 경로, 돈·인증 경로 아님). 적대 리뷰 미실시.

## Context

사용자 QA(2026-07-21, 실 KIS 부팅): workspace 위젯이 마운트에서 3심볼(005930·KOSPI·KOSDAQ)을
동시에 호출하는데 **매번 그중 1건이 `failed: upstream`** 으로 떨어져 화면에 "일시적으로 불러올
수 없음"이 뜬다. 순차 호출은 3/3 available — 즉 우리 파싱·스코프가 아니라 **KIS 모의 API의
초당 호출 제한**이다(모의 2건/초).

티켓 36에서 로그인 터미널을 본체로 만들면 한 화면에서 나가는 KIS 호출은 더 늘어난다. 화면을
늘리기 전에 전송 경계를 먼저 고쳐야 한다(선행 필수).

## Owned scope

- `src/modules/financial-information/data/kis-market-information.ts` (전송 데코레이터)
- `src/composition/market-server.ts` (주입)
- `tests/kis-request-spacing.test.ts`

## Approach

`KisHttp`는 이미 주입 경계다. **모든 KIS 호출(토큰 발급 포함)이 한 함수를 통과**하므로 호출부
(위젯·라우트)마다 흩뿌리지 않고 그 한 곳에 최소 간격 게이트를 건다 — 호출자가 몇 개로 늘어도
동일하게 보호된다. 대기는 주입된 `KisClock.sleep`으로 하여 network-off 결정론 테스트가 가능하다.

## Acceptance

- 동시 3요청이 전부 성공한다(inner 호출 시각 간격 ≥ minInterval).
- 하나가 reject돼도 큐가 막히지 않는다(다음 요청이 계속 진행).
- 총 대기가 §11.3 10s self-guarantee 안에 들어간다.
- network-off 결정론 테스트(가짜 clock)로 간격·순서·실패 격리를 고정한다.
- 실 KIS 부팅에서 3심볼 동시 요청 → 3/3 available 실측.
