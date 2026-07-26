# T10 — 전략 정의 층 + CLI 완성 + MCP (착수 2026-07-26)

상태: **claimed** (2026-07-26). Owner: main(Opus 5). Claimed at: 2026-07-26. Last heartbeat: 2026-07-26 (착수 선언).

> Stage형 예외(AGENTS.md 2026-07-24 명문화): 번호 티켓 대신 이 문서로 갈음. 정식 티켓(42~)은 Stage 3 뒤.
> 선행 티켓 초안: [40 confirm token](../issues/40-order-confirm-token.md) · [41 MCP 카탈로그](../issues/41-mcp-readonly-catalog.md) (둘 다 v2).
> 정본 문맥: pivot 메모 §6 "이후 — 엔진" T10 + 에이전트 인터페이스 설계 메모(2026-07-22).

## Blast radius / 검증 tier 선언 (AGENTS.md 하한 — 착수 전 필수 절)

- **Tier: 최상위** — 두 경로가 각각 독립적으로 승격을 요구한다.
  ① `src/modules/paper-trading/backtest/**` 는 tier-gate guarded 경로.
  ② **MCP 서버는 신규 외부 표면**이다 — 에이전트가 우리 프로세스를 띄우고 호출한다.
  경로 tier 표(collaboration.md:120)의 `order` 축은 아직 안 열리지만(write 미포함),
  "임의 코드 실행"이라는 보안 축이 새로 생긴다. 아래 결정 4 참조.
- **요구 게이트** (resolve 전): blind test-authorship + 적대 반박 패널(다른 계열 우선) +
  Standards 축 1패스 + mutation 실증. 커밋 트레일러 `Tier: top (...)` — 중간 체크포인트는 `pending`.
- **Contain**:
  - 전략 정의 층은 러너의 **입력** 층이다 — money 산술 무접촉. 전략이 뱉는 주문은 전부
    `prepare`/`validateSystemBody`/`#covered` 를 통과해야 하고, 그 경계는 T8 재게이트까지 끝난 상태다.
    즉 **악의적 전략이 만들 수 있는 최악은 "거절 기록이 남는 것"**이지 원장 오염이 아니다.
  - MCP 카탈로그는 **read/compute 만**. write(주문·설정·erasure) 0 — 티켓 41 원칙 유지.
  - Live 경로 부재 불변식 유지. 새 network egress 목적지 0.

## 착수 전 결정 (기록 — 티켓 41 "착수 전 결정 필요" 응답)

1. **MCP 구현체 = 공식 SDK `@modelcontextprotocol/sdk`** (사용자 결정 2026-07-26).
   사유: 이 슬라이스의 목적이 "실제 에이전트 클라이언트가 붙는다"인데, 직접 구현은
   `protocolVersion`·capabilities 협상을 우리가 관리하게 된다 — 스펙 개정 시 **테스트는 통과하고
   실 클라이언트에서만 드러나는** 드리프트가 생긴다. 이 저장소가 반복해 금지해온 "두 정의가
   must match" 상황. 공식 패키지라 임의 npm 의존성과 공급망 등급도 다르다.
   비용: runtime dep +1 (현 7개 → 8개; Stage 3에서 next/react/react-dom 제거되면 5개).
2. **컨텍스트 모델 = 로컬 stdio single_owner env** (티켓 41 권장 채택).
   웹 세션 어휘는 Stage 3에서 사라지는 표면이라 쓰지 않는다. 어댑터의 personal scope guard
   (viewer-context 타입 기반 2차 방어)는 그대로 유효하게 유지한다.
3. **티켓 40(confirm token)은 T11로 이월.** 사유: 40이 방어하는 것은 *write 경로*인데
   티켓 41이 카탈로그에서 write 를 명시적으로 배제했고, 현재 CLI 에도 주문 명령이 없다
   (`paper open`/`paper account` 뿐). 실시간 피드 없이 durable 계정에 주문만 넣는 것은
   반쪽이라 **T11(실시간 모의투자)이 주문 경로의 자연스러운 집**이다. 40 의 owned scope 문서
   ("T10 소비자 배선은 T10 몫")는 *주문 명령이 존재할 때* 성립하는 서술이므로 그 시점으로 미룬다.
4. **모듈 경로 전략(`--strategy <file.ts>`)은 off-by-default 플래그 뒤로.**
   현재 CLI 는 임의 TS 모듈을 동적 import 한다. 사람이 로컬에서 쓰면 정상이지만,
   **에이전트가 CLI 를 구동하는 것이 SKILL.md 의 전제**(tossinvest-cli 선례: CLI+SKILL.md 만으로
   에이전트 대응 성립)이므로 MCP 카탈로그에서 빼는 것만으로는 봉쇄가 안 된다 — 에이전트가
   그냥 `--strategy /tmp/evil.ts` 를 쓰면 된다. `PUBLIC_MARKET_ENABLED` 선례대로 명시 opt-in
   플래그로 내리고, 기본 경로는 선언형 전략만 통하게 한다.

## 실측 기반 설계 확인 (2026-07-26 코드 정독 — **내장 전략이 조용히 무체결이 되는 함정 2개**)

착수 전 정독에서, 순진하게 짠 내장 전략이 **에러 없이 0 체결**로 끝나는 경로 둘을 확인했다.
둘 다 "그럴듯한 거짓 성과"(T8 blast radius 선언의 바로 그 위험)를 만든다.

- **함정 ① DAY 주문은 일봉에서 절대 체결되지 않는다.**
  `simulator.ts:117` 이 `utcDay(observation.eventTime) <= utcDay(order.acceptedAt)` 일 때만
  만료를 건너뛴다. 일봉 시리즈에서 다음 bar 는 **다른 UTC 일**이므로, bar N 종가에 접수된 DAY
  주문은 bar N+1 의 pass 1 에서 **체결 시도 전에 만료**된다. 한편 체결은 `eventTime > acceptedAt`
  (strict)을 요구하므로 같은 bar 로는 절대 못 채운다. → **일봉에서 DAY = 무조건 만료.**
  (분봉 시리즈에서는 같은 날 다음 bar 가 있으므로 정상 동작한다 — 버그가 아니라 의미론이다.)
  → **내장 전략은 GTC 고정.** `timeInForce` 를 스펙 파라미터로 노출하지 않는다(함정을 초대하는 노브).
- **함정 ② 가용현금 전액 매수는 affordability 에서 통째로 탈락한다.**
  `simulator.ts:259` 의 `#covered` 는 **슬리피지가 적용된 체결가**로 판정하고,
  모자라면 부분 체결이 아니라 **배분 전체를 건너뛴다**(`ponytail:` 주석에 명시된 의도).
  따라서 `floor(cash / close)` 로 사이징하면 매수 슬리피지(+최대 25bps)만큼 초과해 **0 체결**.
  → 사이징 분모에 `SIMULATION_V1.maxSlippageBps` 헤드룸을 곱한다. 상수 25 를 복제하지 않고
  **`SIMULATION_V1` 을 import** 한다(정의 둘 = 드리프트 금지 원칙).
  매도측은 세금이 붙지만(S3) 세금은 대금에서 차감되므로 수량 사이징에 헤드룸 불필요.
- **참고**: 체결량은 bar 거래량의 10%(`volumeParticipationCap`)로 상한이라 큰 주문은 여러 bar 에
  걸쳐 채워진다. GTC 고정이 이것과도 정합한다.

## 슬라이스

- **S1 — 전략 정의 층**: 선언형 `StrategySpec`(데이터) → `BacktestStrategy` 컴파일.
  zod 파라미터 스키마 + 내장 전략 레지스트리. 이것이 MCP `compute` 오퍼레이션의 안전한 입력이다.
  (MCP 가 임의 모듈 경로를 받으면 에이전트 호출 = 임의 코드 실행 — 이것이 전략 정의 층이
  CLI·MCP 보다 **먼저**인 이유다.)
- **S2 — 오퍼레이션 카탈로그 + CLI 완성**: 카탈로그 정의는 **하나**, CLI 가 첫 소비 표면.
  `strategy list`/`strategy describe`, `backtest run --strategy <name> --params <json>`,
  모듈 경로는 결정 4의 플래그 뒤로. `--dry-run`.
- **S3 — MCP stdio 서버**: 같은 카탈로그 위 3툴(`list_operations`/`describe_operation`/
  `call_operation`). outcome 타입 평탄화 0.
- **S4 — 에이전트 온보딩**: SKILL.md + README "이 프롬프트를 복사해줘" 블록
  (pivot 에이전트 인터페이스 메모 ①②).

## 진행

- 2026-07-26: 착수. 위 결정 4건 기록 + 함정 2건 실측 확인. S1 시작.
- **S1 완료** — `backtest/strategy-catalog.ts` + 회귀 13. check **721 green**(708 → +13), tsc clean.
  - 선언형 `{name, params}` → `compileStrategy(spec, context)` → `BacktestStrategy`.
    거절은 throw 가 아니라 타입 outcome(`unknown_strategy` / `invalid_params`) — 에이전트가
    "그런 전략 없음"과 "파라미터 틀림"을 구분해 행동할 수 있어야 한다(티켓 41 논거의 확장).
    파라미터는 **파싱된 값(기본값 적용 후)을 echo** 한다 — 리포트는 입력된 것이 아니라
    **실제로 돈 것**을 공시해야 한다.
  - 내장 2종: `buy_and_hold`(기준선) · `sma_cross`(fast/slow 교차, 데드크로스에서 잔여 주문
    취소 후 전량 청산). zod `.strict()` 라 오타 키(`cashFractoin`)도 거절.
  - **함정 ② 가 예상보다 깊었다 (실측 교정)**: 착수 선언에 적은 "슬리피지 헤드룸만 곱하면 된다"는
    **틀렸다**. 실제 예약가는 `roundUpToTick(close × (1+maxSlippageBps/10000))` 이고,
    틱 반올림을 뺀 근사는 주당 최대 1틱 모자라 `prepare` 가 `insufficient_cash` 로 거절한다
    (sma_cross 첫 구현이 정확히 이 이유로 **0 체결**, 디버그로 재현). 게다가 거절 지점이 둘
    (`prepare` 예약 + `#covered` 체결)이라 어느 쪽이든 조용히 빈 리포트가 된다.
  - **근본 수정**: 근사식을 고치는 대신 `service.ts` 의 예약가 계산을 `marketReservationUnitPrice()`
    로 **추출·export** 하고 `#reservationUnitPrice` 와 전략 사이징이 **같은 함수**를 부르게 했다.
    상수 복제도, 공식 복제도 남기지 않는다(저장소의 "정의 둘 = 드리프트" 금지). 순수 추출이라
    기존 돈 경로 테스트 전건 불변으로 확인.
  - 회귀의 무게중심은 **체결 여부**다: 액션 모양이 아니라 `fillCount > 0` 을 실 러너로 검증한다 —
    두 함정 모두 "액션은 옳은데 체결이 0"으로 실패하기 때문.
- **S2 완료** — `src/operations/catalog.ts` + CLI 전면 개편 + 회귀 12. check **733 green**(721 → +12).
  - **카탈로그가 유일 정의, CLI 는 transport.** CLI 는 파일 읽기·플래그 파싱·envelope·exit code 만
    소유하고 "오퍼레이션이 무엇인가"는 전부 카탈로그가 소유한다. MCP(S3)가 같은 카탈로그를 소비한다.
  - 오퍼레이션 4종: `strategy.list`·`strategy.describe`(read) · `backtest.run`(compute) ·
    `paper.account`(read). **`paper open` 은 카탈로그에 없다** — 돈 genesis = write, 티켓 41 원칙.
  - **평탄화 0 실증**: 거절된 백테스트는 오퍼레이션 층에서 `ok` 이고 값 안에 `{status:"refused",
    reason:"empty_series"}` 가 그대로 산다. 오퍼레이션 층이 거절하는 것은 자기 소관(모르는 이름·
    잘못된 입력)뿐이고, 이유를 `unknown_operation`/`unknown_strategy`/`invalid_params`/`invalid_input`/
    `unavailable` 로 구분해 준다.
  - `strategy.describe` 는 zod → JSON Schema(`io:"input"` — 기본값 있는 필드는 optional)로 발행.
    **한계 명시**: 교차 필드 refinement(`fast < slow`)는 JSON Schema 로 표현 불가라 스키마에
    안 나타난다. 실행 시엔 그대로 집행되므로 발행 스키마는 유효성의 **하한**이지 상한이 아니다.
  - `--strategy <이름>` / `--params '<json>'` / `--dry-run` 추가. 모듈 경로는 `--strategy-module`
    로 분리하고 `BACKTEST_STRATEGY_MODULE_ENABLED=true` 뒤로 — **정확히 이 문자열만** 통과
    (`"1"`·`"TRUE"`·`"true "` 전부 거부). 게이트는 **모든 IO 앞**이다(비활성 시 시리즈 파일조차
    읽지 않는다 — 첫 구현이 파일 읽기 뒤에 있어 회귀가 잡았다).
  - **함정 ③ 발견 (실 CLI 스모크에서만 드러남)**: 단위 테스트는 전건 green 인데 실제 CLI 실행이
    `fills: 0` 이었다. 근인은 **시장가 주문이 bar N 종가에 접수되고 bar N+1 가격에 체결**된다는 것.
    그 가격은 사이징 시점에 알 수 없고(look-ahead 금지 — 한계가 아니라 보증이다), 가격이
    슬리피지 천장 이상으로 오르면 예약이 모자라 `#covered` 가 배분 전체를 건너뛴다. 주문은 남은
    구간 내내 열린 채 현금만 묶이고 **fillCount 0 · 거절 0 · 리포트 green**.
    (실측: 70,000 → 72,000 한 칸 상승이면 현금 100% 투입은 절대 체결 안 됨.)
    → `cashFraction` 기본값을 **0.95** 로. 모델링 선택이지 법칙이 아님을 doc 에 명시하고,
    헤드룸보다 큰 갭은 여전히 미체결로 남되 **리포트의 "열린 주문 + 묶인 현금"으로 보인다**고 기록.
    회귀는 상승 시리즈에서 기본값=체결 1 / `cashFraction:1`=체결 0 을 **둘 다** 고정한다.
  - **함정 ③ 의 교훈**: 단위 테스트를 평탄한 시리즈로만 짜면 이 계열은 전부 통과한다.
    실 프로세스 스모크가 잡았다 — T8 의 "실 KIS 렌더 확인" 관행이 여기서도 값을 했다.
  - **블라인드 스위트 취급**: `t8-blind.test.ts` 는 **호출 시그니처만** 적응
    (`strategy`→`strategyModule`, `seed`→`cash`, 게이트 플래그 stub). **단언은 한 줄도 안 고쳤다.**
    T8 재게이트의 `WindowValue` 선례와 동일 취급. 빈 시리즈 → `refused`/exit 1 블라인드 계약을
    지키려고 `seriesSchema` 에 `.min(1)` 을 넣지 않았다 — 스키마는 shape, 엔진은 도메인 거절.
- **의도적 비범위 (기록)**: `market.quote` 오퍼레이션. `market-server.ts` 가 `server-only` +
  Next alias 라 CLI/MCP 에서 소비하면 seam 규칙을 건드리고, Stage 3 가 이 층을 재작성한다.
  게다가 에이전트 표면에 새 IO 경로를 붙이는 일이라 꼬리에 얹을 게 아니라 자기 게이트가 필요하다.
  → 카탈로그는 read 오퍼레이션을 받을 형태로 열어두고, 배선은 Stage 3 이후 별도 슬라이스.
- **S3 완료** — `src/mcp/{server,main}.ts` + `provenance call` + 회귀 8. check **741 green**(733 → +8).
  - **3툴 고정**(`list_operations`/`describe_operation`/`call_operation`)이 카탈로그에 대해
    제네릭이다 — 오퍼레이션이 늘어도 에이전트 상주 컨텍스트 비용은 3개로 고정.
    `describe_operation` 은 zod → JSON Schema 를 그 자리에서 뽑으므로 **툴 스키마를 손으로
    쓰는 곳이 없다**.
  - **isError 경계선**: 오퍼레이션 층 거절(모르는 이름·잘못된 입력)은 `isError:true` — 호출이
    틀렸으니 에이전트가 고쳐 재시도해야 한다. **도메인 거절**(백테스트가 못 돈 것)은 `isError`
    없이 `ok` 안에 이유를 달고 간다 — 호출은 정상이고 답이 "거절, 사유는 이것"이다.
    둘을 합치면 이 표면이 존재하는 이유인 구분이 사라진다.
  - `provenance call [--list] | call <op> --input '<json>'` 추가 — CLI 도 카탈로그에 제네릭이 됐다.
    **exit code 계약을 의도적으로 분리**: `call` 은 오퍼레이션이 성공하면 안의 도메인 결과가
    거절이어도 exit 0(호출은 성공, 사유는 envelope 안)이고, 전용 `backtest run` 만 거절을
    exit 1 로 접는다. 셸 스크립트용 설탕과 범용 표면을 섞지 않는다.
  - **실 프로세스 stdio 핸드셰이크 확인** (in-memory transport 가 감추는 층):
    `initialize` → `protocolVersion 2025-06-18` 에코 · `tools/list` → 3툴 ·
    `tools/call list_operations` → 4 오퍼레이션. **ready 메시지는 stderr, stdout 은 순수 JSON-RPC**
    (stdout 오염은 클라이언트 파싱 오류로 즉사하므로 CLI `--json` 보다 실패가 가혹하다).
  - 회귀는 **실 MCP Client** 를 SDK linked in-memory transport 로 붙여서 돌린다 —
    우리 객체에 대한 단언이 아니라 프로토콜 구현이 핸드셰이크·툴 목록·호출 프레이밍을 검증한다.
- **SDK 도입 실측 (사용자 재확인 후 진행)**: 착수 선언의 "runtime dep +1" 은 **틀렸다**.
  실제 `@modelcontextprotocol/sdk@1.29.0` 은 lockfile 620 → **681 (+61 패키지)** 이고
  `express`·`hono`·`cors`·`jose`·`eventsource`·`pkce-challenge` 등 **HTTP/OAuth 트랜스포트
  기계 전체**를 끌고 온다. `npm audit` 에 **moderate 1건**(`@hono/node-server <2.0.5` 경로 순회)이
  뜨고, SDK 가 `^1.19.9` 로 고정해 override 로는 못 푼다(수정본은 2.0.5+).
  - **판정(사용자, 2026-07-26)**: stdio 경로에 도달 불가한 권고이고 +61 은 서사 비용이지
    동작 비용이 아니므로 그대로 진행.
  - **"도달 불가"를 주장에서 검증으로**: `stdio.js`·`server/index.js` 의 import 그래프에
    hono/express 가 없음을 직독 확인했고(권고 대상은 `streamableHttp.js`·`sse.js`·`express.js`
    전용), `tests/t10-mcp-server.test.ts` 가 **`src/mcp/server.ts` 의 SDK import 목록에
    streamableHttp/sse/express 가 없음을 상시 단언**한다. 우리가 통제 가능한 실제 위험은
    "나중에 누가 HTTP 트랜스포트를 import 하는 것"이고 그것이 이 테스트가 막는 것이다.
  - **잔여**: SDK 가 hono 를 2.0.5+ 로 올릴 때까지 `npm audit` moderate 1건은 남는다.
    릴리스 문서(Stage 3 재작성 대상)에 잔여 위험으로 명시할 것.
- **벤더 중립성 (설계 기록)**: `src/operations/catalog.ts` 에 MCP import 가 **0** 이다.
  lock-in 은 transport 층에만 있고 그 층이 제일 얇다(MCP 서버 ~140줄). 다른 규격이 뜨면
  transport 를 하나 더 얹고, 규격 없이 붙이려는 에이전트는 이미 `call --json` 으로 쓸 수 있다.
- **S4 착수 전 계약 정리 (2026-07-26)** — SKILL.md 를 쓰기 **전에** 오퍼레이션 거절 이유를 갈랐다.
  - **왜 지금인가**: SKILL.md 를 발행하는 순간 "에이전트에게 분기하라고 알려준 것" 이 계약으로 굳는다.
    `configuration_required`(설정하고 재시도)와 `unavailable`(의존성 장애, 대기)은 **다음 행동이 다른데**
    둘 다 `unavailable` 이었고 차이는 message 문자열뿐이었다. 문서에 "message 가 `/no database/` 면
    DATABASE_URL 을 설정하라" 고 쓰면 그 산문이 계약이 된다 — 참조 CLI 가 stdout 을 오염시켜
    `--json` 파이프를 깨뜨린 것을 반명제로 삼은 이 저장소가 할 일이 아니다. 발행 전이 유일하게 싼 시점.
  - **← 정정 (착수 전 기각 이력 조회 중 발견, `prior-decisions=` 규칙의 첫 실사용)**:
    이 변경을 "티켓 41 결정을 뒤집는 것" 으로 판단하고 사용자 승인을 받았는데, **원문을 읽으니 반대였다.**
    `issues/41-mcp-readonly-catalog.md:66,111` 은 "크리덴셜이 없으면 해당 오퍼레이션이 **`api_required`**
    outcome 을 반환하고, 서버는 계속 뜬다" 라고 적는다 — 즉 41 은 기계 판독 가능한 "설정 필요" 이유를
    **이미 요구했고**, S2 구현이 그걸 `unavailable` 로 평탄화한 것이 이탈이었다.
    이 변경은 41 을 뒤집는 게 아니라 **복원한다.** 전제를 확인하지 않고 "뒤집는다" 고 보고한 것이 오류다.
  - **이름은 `api_required` 대신 `configuration_required`**: 이 저장소에서 `api_required` 는 공급자 API
    권한을 뜻한다(`outcome-classification.ts:49` 의 `requiredCapability`·`configurationRoute`). 여기서
    빠진 것은 데이터베이스지 공급자 API 가 아니다. 41 의 의도를 지키되 이름은 사실에 맞춘다.
  - **도달 표면은 MCP 하나**: `mcp/server.ts:133-138` 이 `DATABASE_URL` 미설정 시 pool 을 일부러 안 넣는다.
    CLI 는 `databaseUrl()` 이 `DEFAULT_DATABASE_URL` 로 폴백하고 `catalogFor` 가 항상 pool 을 주입하므로
    이 arm 에 **도달할 수 없다** — 그래서 CLI 매핑은 "그날을 위한" 것이지 지금 도는 경로가 아니다.
  - **부수 수정**: `fromOperation` 의 `reason === "unavailable" ? api : usage` 삼항을
    `Record<OperationRefusalReason, CliErrorCode>` 로 교체. 새 이유를 추가하면서 exit code 를 안 정하면
    **컴파일 에러**가 된다. 옛 형태는 모든 미래 이유를 조용히 `usage`(exit 1, 호출자 입력 오류)로
    분류했는데, 새 이유는 호출자 오타보다 환경 문제일 가능성이 훨씬 높다 — 기본값이 틀려 있었다.
  - **blind 저자 지적과 그에 대한 판정 (AGENTS.md "서브에이전트 결론은 재현 후 채택" 첫 실사용)**:
    저자가 "CLI 는 분리를 못 받아서, 사람이 configure-and-re-call 문제에 retry-forever 답을 받는다" 고
    보고했다. 실측으로 재현했고 — `DATABASE_URL` 없이 `paperAccountCommand()` → `api` / `"database
    unavailable"` / exit 2 — **관측은 맞지만 프레이밍은 채택하지 않는다.**
    `DEFAULT_DATABASE_URL`(`defaults.ts:1`)이 `postgresql://…@127.0.0.1:5432/provenance` 라
    CLI 는 기본값으로 **실제 연결을 시도하고 실패**한다. 그 메시지는 거짓이 아니라 정확한 관측이다.
    CLI 가 `configuration_required` 를 내려면 "DATABASE_URL 미설정 = 미구성" 이라고 **단정**해야 하는데,
    그건 호스트 개발에서 기본값이 실제로 동작하는 경로를 깨뜨리고 알 수 없는 것을 지어내는 것이다.
    **두 표면은 아는 것이 다르다** — 카탈로그는 "pool 이 주입되지 않았다" 는 사실을 알고, CLI 는
    "연결이 실패했다" 만 안다. 관측 불가능한 구분을 표면에 만들지 않고, S4 의 에러표가 그 차이를
    정직하게 적는다: CLI 의 exit 2 = "설정되거나 기본값인 URL 로 DB 에 닿지 못했다 — 기동 여부와
    DATABASE_URL 을 확인하라", MCP 의 `configuration_required` = "설정하고 다시 불러라".
  - **드리프트 1건 동시 수정**: `mcp/server.ts:128` 의 `main()` doc 이 아직 "`paper.account` 는
    `unavailable` 을 답한다"고 적고 있었다. 코드가 아니라 주석이지만 이 파일이 곧 SKILL.md 가
    인용할 근거라 같은 커밋에서 고친다 — 정의 둘 금지는 주석에도 걸린다.
  - 게이트: typecheck 0 · lint 0 error · **768 통과 / 56 skip** · seam 2종.
- **S4 완료** — `SKILL.md` + README 온보딩 절 + 드리프트 가드 3. check **771 green**(768 → +3).
  - **모든 예시를 실행해서 확인한 뒤 적었다.** 치트시트·에러표·리포트 필드는 전부 실제 출력에서
    옮긴 것이고, 추측으로 쓴 명령은 없다. 실측이 문서를 바꾼 지점: MCP 기동 명령을 `npm run` 으로
    쓸 수 없다 — npm 이 스크립트 배너를 **stdout** 에 찍는다(실측: `npm run cli … --json 2>/dev/null`
    첫 줄이 배너). CLI 에선 `--json | jq` 가 깨지는 정도지만 MCP 에선 JSON-RPC 스트림 오염이라
    클라이언트가 즉사한다. 그래서 두 문서 모두 `node --import tsx <파일>` 형태만 발행한다.
  - **문서를 계약으로 취급 — `tests/t10-skill-doc.test.ts`**: SKILL.md 가 카탈로그의 모든 오퍼레이션
    이름과 `OperationRefusalReason` 전 멤버를 언급하는지, 두 문서가 stdout 안전한 기동 형태를 싣는지
    상시 단언한다. 이유 목록은 새로 만들지 않고 `OPERATION_REASON_TO_CLI`(타입상 exhaustive)의 키를
    쓴다 — 정의 셋째를 만들지 않기 위해서다.
    **이 가드가 첫 실행에서 실제 결함을 잡았다**: SKILL.md 가 `backtest.run` 을 한 번도 이름으로
    적지 않았다. CLI 명령형(`backtest run`, 공백)만 있었으므로 **MCP 에이전트는 `call_operation` 에
    넣을 문자열을 알 수 없었다.** 오퍼레이션 이름 ↔ CLI 명령 대응표를 추가해 해소.
  - **doc 게이트 오탐 1건 근본 수정**: `check-release-docs.ts` 의 `npm run ([a-z0-9:_-]+)` 가
    `npm run --silent` 의 `--silent` 를 "존재하지 않는 스크립트"로 신고했다. 플래그는 스크립트 이름이
    될 수 없으므로 선행 `-` 토큰을 건너뛴다. 산문을 비틀어 피하지 않은 이유는, 이 오탐이 **npm 플래그를
    문서화하는 것 자체를 불가능하게** 만들고 하필 그 플래그가 위의 stdout 함정과 직결되기 때문이다.
    판별력 실증: 플래그는 통과, 진짜 stale 참조(`npm run no-such-script-xyz`) 주입 시 red 로 확인.
  - **의도적 비범위**: `docs/installation.md` 를 새로 만들지 않고 README 안에 결정론적 체크리스트로
    두었다(피벗 ②는 별도 파일을 상정). 사유: 설치 경로가 3단계뿐이고 `docs/release/setup.md` 와
    상당 부분 겹치는데, Stage 3 가 패키징(`package-release.ts`·manifest)을 재정의하면서 두 문서를
    모두 다시 쓴다. 지금 파일을 가르면 그때 합칠 것이 하나 늘 뿐이다.
  - **주문 전 체크리스트의 정직한 각색**: 피벗 ①은 "주문 전 안전 체크리스트"를 요구하지만 이 표면에
    주문 명령이 없다(티켓 40 → T11 이월). 없는 명령의 체크리스트를 지어내는 대신 **실제로 존재하는
    상태 변경 셋**으로 적었다 — `paper open`(돈 genesis, 카탈로그 밖), `--strategy-module`(사실상 RCE,
    플래그 뒤), 시리즈 파일 경로. 에이전트에게 "이 플래그를 켜지 마라, 켜는 것은 사람의 손"을 명시한다.
- **적대 리뷰 1라운드 (codex, 2026-07-26)** — 이번엔 **다른 계열로 정규 수행**했다.
  arch-1 에서 토큰 부재로 같은 계열 차선책을 썼던 것이 이번 슬라이스에서 해소됐다.
  BLOCKER 0 · HIGH 1 · MEDIUM 4 · LOW 1. **6건 전부 메인이 직접 재현한 뒤 판정했다.**
  - **HIGH `configuration_required` 가 `isError:true` 로 나간다 — 관측 채택, 프레이밍 기각.**
    저자는 "티켓 41 의 outcome 평탄화 금지 위반" 으로 규정했다. 41 원문(`:60-66`)을 다시 읽은 결과
    41 이 금지하는 것은 **이유의 소실**이고, `{"error":"configuration_required","message":…}` 는
    이유를 온전히 싣고 도착한다 — 평탄화가 아니다. 서버의 `isError` 판단은 유지한다.
    **그러나 저자가 가리킨 결함 자체는 진짜였고 내 문서에 있었다**: SKILL.md 가
    "`isError: true` 면 **호출이 틀렸다**" 라고 적고 바로 아래 표에 `configuration_required`·
    `unavailable` 을 같이 넣었다. 여섯 이유 중 둘에 대해 **거짓인 문장**이다. 표에 "무엇이
    잘못됐나(호출/환경)" 열을 넣고 서두 문장을 사실에 맞게 고쳤다.
  - **MEDIUM "쓰기는 이 표면에 없다" 가 CLI 에 대해 거짓 — 채택.** 가장 안전 관련이 큰 건이다.
    SKILL.md 서두가 표면을 둘(CLI·MCP)로 선언한 뒤 "최악은 거절 기록이지 원장 변경이 아니다" 라고
    적었는데, CLI 에는 `paper open`(돈 genesis)과 `--strategy-module`(임의 파일 실행)이 있다.
    뒤쪽 체크리스트가 완화하지만 **서두의 불변식 선언 자체가 거짓**이었고, 서두만 읽고 행동하는
    에이전트에게는 완화가 도달하지 않는다. MCP/CLI 를 갈라 다시 적었다.
  - **MEDIUM `unavailable` 이 프로그래밍 오류까지 삼킨다 — 채택(문서 측).** 재현:
    `pool` 팩토리가 `TypeError` 를 던져도 `unavailable`/"database unavailable". 즉 우리 버그가
    "의존성이 죽었으니 기다려라" 로 나간다. 코드에서 가르려면 드라이버 내부 문자열을 판별해야 하는데
    SEC-05(연결 문자열 유출 금지)와 정면 충돌한다 → **문서가 과장을 거뒀다**: "의존성이 죽었다" 를
    "저장소 읽기가 실패했다, 원인은 이 표면 밖에서 알 수 없다" 로 바꾸고 재시도를 1~2회로 못 박았다.
  - **MEDIUM doc 게이트에 내가 만든 구멍 — 채택.** 앞서 넣은 `startsWith("-") → continue` 는
    오탐은 없앴지만 **플래그 뒤의 진짜 스크립트 이름까지 검사를 건너뛰게** 했다.
    재현: `npm run --silent no-such-script-xyz` 가 0 problem 으로 통과.
    정규식이 플래그 접두를 소비하고 **스크립트 이름을 캡처**하도록 고쳤다.
    판별력 재실증 4종: 정상 0 · 맨 stale red · **플래그 뒤 stale red** · 실사용형(`--silent cli`) 0.
    (1라운드 수정이 원 문제보다 나빴던 arch-1 의 재판이다 — 그래서 이 규칙이 있다.)
  - **MEDIUM installation.md 부재를 피벗 메모에 안 적었다 — 채택.** 진행 문서와 커밋에는 적었으나
    피벗 메모 자신이 "전제와 갈리면 결과가 더 나아도 이 메모에 남긴다" 를 요구한다. T10 ①②에
    `← 정정` 절을 추가했다(①의 주문 체크리스트 각색 포함).
  - **LOW 드리프트 테스트의 기동형 단언이 약하다 — 채택.** 재현: SKILL.md 에 `npm run mcp` 를
    덧붙여도 green. 안전한 형태의 **존재**만 봤기 때문이다. 알려진 위험 철자를 금지하고
    (`npm run mcp`·`"command": "npm"`) argv 벡터 전체를 고정하도록 강화했으며, 주석에서
    "정확한 형태가 고정된다" 는 과장을 빼고 **블록리스트이지 증명이 아니라고** 적었다.
    판별력 실증 2종(unsafe 대안 추가 → red, argv 흐림 → red).
- **자체 재공격 (2라운드 대기 중 메인이 발견 — 1라운드 수정 둘 다 불충분했다)**:
  - **정규식이 여전히 오탐을 냈다.** `-{1,2}[a-z0-9-]+` 는 `=` 를 모르므로
    `npm run --workspace=x build` 에서 **`--workspace` 를 스크립트 이름으로 캡처**한다 —
    내가 없앴다고 선언한 바로 그 오탐이 다른 철자로 살아 있었다. 또 `[a-z0-9:_-]` 는 대문자를
    빼서 `npm run Build` 가 **아무것도 매치하지 않는다**(오탐보다 나쁜 조용한 누락).
    `(?:-\S+\s+)*` + `[A-Za-z0-9:_-]+` 로 교체. 판별력 6종 실증: stale 4종(맨·`--silent` 뒤·
    `--workspace=` 뒤·대문자) 전부 red, 실사용형 2종(`--silent cli`·`--workspace=x db:migrate`) green.
  - **드리프트 테스트의 1라운드 수정이 실제로는 아무것도 안 잡았다.** "독립 토큰" 방식
    (`--import`·`tsx`·`src/mcp/main.ts` 각각 존재)으로 고쳤는데, **같은 토큰들이 페이지의 CLI
    예시에도 있다.** MCP 설정에서 로더를 지우는 뮤테이션이 **green 으로 통과**했다 — codex 가
    1라운드에서 지적한 "무관한 부분 문자열만 본다" 를 다른 형태로 재생산한 것이다.
    공백을 모두 제거한 문서에 대해 argv 시퀀스(`"--import","tsx","src/mcp/main.ts"`)를 단언하도록
    바꿨다. 정확하면서 재포맷에 견딘다. 판별력 4종: 로더 제거(README/SKILL 각각)·`command:npm`
    전환 red, 무해한 JSON 재포맷 green.
  - **교훈**: 두 건 다 **뮤테이션 실증을 돌렸기 때문에** 드러났다. "고쳤다" 는 선언과 "고쳐졌다" 는
    실증 사이의 간격이 이번 슬라이스에서만 두 번 나왔다.
- **Standards 축 1패스 (메인, 2026-07-26)** — 세션 diff 전체를 저장소 관례 기준으로 재독.
  - **발견 1건 (자기 지적)**: SKILL.md 의 `unavailable` 과장은 고쳤는데 **그 문장이 유래한
    `catalog.ts` 의 타입 doc 주석에는 그대로 남아 있었다** ("the dependency is down, waiting may
    help"). 문서만 고치고 정본 주석을 놔두면 다음 사람이 주석을 근거로 문서를 되돌린다 —
    이 저장소가 금지하는 "정의 둘" 의 주석판이다. 주석을 사실에 맞추고, 왜 liveness 주장을
    되살리면 안 되는지(SEC-05 와의 충돌)를 함께 적어 되돌림을 막았다.
  - 드리프트 테스트의 헤더 주석이 "MENTION 만 검사한다" 고 적었는데 셋째 케이스는 그보다 강해졌다.
    범위 서술을 실제에 맞췄다 — 과장된 가드는 없는 가드보다 나쁘다.
  - 나머지: `OPERATION_REASON_TO_CLI` export 는 테스트를 위한 확대지만 `STRATEGY_MODULE_FLAG`
    선례와 같은 형태라 관례 이탈 아님. lint 경고 1건은 `stryker.config.mjs` 로 이 세션 무관(기존).
- **트레일러 정정 (자기 지적)**: 앞선 세 커밋이 `blind=tests/t10-skill-doc.test.ts` 라고 적었는데
  **그 테스트는 내가 썼다 — blind 가 아니다.** blind test-authorship 은 "구현을 열지 않은 별도
  저자" 를 뜻하고(arch-1 선례), S4 에는 그런 저자가 없었다. 정확한 표기는 `waived` 다.
  사유: S4 산출물은 문서이고, 그 문서가 참인지는 **codex 가 계약만 보고 실행으로 검증**했다
  (명령형·exit code·JSON 필드·기동 형태를 직접 돌려 확인). 별도 blind 저자가 더 얹을 것이
  구조적으로 적은 슬라이스다. 이 정정 자체를 기록으로 남긴다.
- **적대 리뷰 2라운드 (codex, 2026-07-26)** — 채택분 재공격. BLOCKER 0 · MEDIUM 4 · LOW 1.
  저자가 `7553784` 블롭에 고정해 리뷰했으므로 `e56e29c`(자체 재공격) 이후 상태와 대조해 판정했다.
  - **MEDIUM 시리즈 파일 내용이 실패 메시지로 샌다 — 채택, 이번 라운드 최대 수확.**
    재현: `--series` 를 비-JSON 파일로 겨누면 `Unexpected token 'D', "DATABASE_U"... is not valid
    JSON`. **`JSON.parse` 는 실패 지점의 원문을 인용한다** — 즉 이 플래그가 "파일을 지목하라" 에서
    "그 파일을 출력하라" 로 바뀐다. V8 이 조각을 잘라서 1회 유출량은 작지만 **내용은 내용이고,
    이 플래그를 모는 것은 에이전트**다. 저장소가 이미 드라이버 오류에 대해 써 둔 SEC-05 와 정확히
    같은 계열인데 파서 오류에는 적용이 안 되어 있었다(T10 S2 부터 있던 것 — 내가 넣은 건 아니지만
    내가 닫는 표면 안이다). 읽기 실패와 파싱 실패를 갈라 파싱 실패는 **고정 문자열**로 바꿨다.
    읽기 실패(ENOENT)는 호출자가 준 경로만 담으므로 그대로 둔다 — 진단 능력을 잃지 않는다.
    회귀 `t8-cli-commands.test.ts` 에 추가(추적 중인 비-JSON 파일을 프로브로 재사용, 새 픽스처 0).
    판별력: 옛 동작으로 되돌리면 red.
  - **MEDIUM CLI 에러표만 여전히 "DB 가 죽었다" 로 단정 — 채택.** MCP 표의 `unavailable` 은
    1라운드에서 정직하게 고쳤는데 **같은 조건을 서술하는 CLI 표(`api`/exit 2)는 그대로 두었다.**
    Standards 패스에서 스스로 잡은 "문서만 고치고 주석은 놔둠" 과 똑같은 실수를 표 사이에서 반복한
    것이다. "저장소 읽기가 실패했다 + postgres/DATABASE_URL 은 **첫 확인 대상이지 확정된 원인이
    아니다**" 로 교체하고, 핸드오프 절도 "DB 가 죽었다고 보고하지 말라" 로 맞췄다.
  - **MEDIUM 정규식이 아직 반만 고쳐졌다 — 채택.** `e56e29c` 가 `--workspace=x`·대문자는 닫았으나
    저자가 짚은 나머지가 남아 있었다: `\s` 가 **줄바꿈을 넘어가서** 줄 끝 `npm run --if-present` 가
    **다음 줄 첫 단어를 스크립트 이름으로 캡처**했고, 그게 안 되면 플래그 자신을 캡처했다.
    수평 공백(`[^\S\n]`)으로 좁히고 스크립트 이름이 영숫자로 시작하도록 했다.
    **잔여 1건은 고치지 않고 명시**: `npm run --workspace pkg build`(값이 별도 토큰인 플래그)는
    `pkg` 를 신고한다. npm 의 플래그 arity 표가 필요한데 이 저장소엔 workspace 가 없고, 실패 양상이
    조용한 누락이 아니라 시끄러운 오탐이라 값을 안 한다.
  - **LOW 블록리스트 우회 — 채택.** `npm  run mcp`(공백 둘)·`{"command":"npm"}`(공백 없음)·
    YAML `command: npm` 이 전부 통과했다. raw 문자열 비교였기 때문. 블록리스트도 공백 제거본에
    걸도록 옮기고 YAML 형태를 추가했다. 3종 우회 전부 red 확인.
  - **MEDIUM 시리즈 크기 무제한 — 관측 채택, 수정은 기각(기록).** 실측 50만 bar ≈ +100MB.
    상한을 걸지 **않는다**: 1년치 분봉이 약 52만 bar 라 그럴듯한 상한은 정당한 사용을 깨뜨린다.
    피해 범위도 로컬 CLI 프로세스 하나이고 돈·데이터가 아니다. 대신 SKILL.md 안전 체크리스트에
    실측값과 함께 명시해 에이전트가 출처 불명의 거대 파일을 먼저 확인하게 했다.
  - **해소 확인된 것(저자 보고)**: MCP 표면의 durable write 부재는 실증됨 — `paper.account` 는
    `BEGIN`/`READ ONLY`/`SELECT`×5/`COMMIT` 만 실행했고 `backtest.run` 은 주입된 pool 을 아예
    건드리지 않았다. 무한 재시도 루프도 재현되지 않았다.
- **2라운드의 값**: 1라운드 채택분 중 **셋이 불완전했다**(정규식·블록리스트·`unavailable` 서술).
  AGENTS.md 의 "채택분을 같은 tier 로 재공격" 규칙이 이 슬라이스에서만 **두 번** 값을 했다.
- **사용자 지적 (2026-07-26, 게이트 통과 후)** — SKILL.md 의 "이 엔진이 하지 않는 것" 절이 거짓.
  "시세·뉴스·공시 조회 없다"·"모의 주문 제출 아직 없다(T11)" 를 짚었고, **둘 다 맞는 지적이다.**
  - **실측**: 시세는 `kis-market-information.ts`·`scripted-market-information.ts`·`treasury`·
    `ecb-fx` 가 있고, 공시는 `dart-filings-information.ts`+`publicFilingsServer()`, 캔들 생성은
    `chart/buildChartSeries` 가 있다. 모의 주문 제출은 `PaperTradingService.prepare()`→`change()`
    로 **실재하고, 백테스트 러너가 `backtest-runner.ts:397-402` 에서 바로 그 seam 을 쓴다.**
    없는 것은 *오퍼레이션/명령*이지 *기능*이 아니었다. (뉴스만 어댑터 부재로 참이었다.)
  - **이것은 이 세션 세 번째 같은 실수다.** codex 가 서두의 "쓰기는 이 표면에 없다" 를 잡았고,
    Standards 패스에서 내가 "문서만 고치고 정본 주석은 놔뒀다" 를 잡았는데, **문서 맨 끝 절에
    같은 계열이 그대로 남아 있었다.** 앞의 둘을 고치면서 같은 축으로 문서 전체를 훑지 않았다 —
    지적된 인스턴스만 고치고 클래스를 안 본 것이 근인이다.
  - **왜 위험한가**: 이 거짓은 에이전트를 통해 **사용자에게 제품에 대한 오정보**로 나간다.
    "이 제품은 시세를 못 가져옵니다" 는 표면 한계가 아니라 제품 능력에 대한 진술이고, 사용자가
    다른 도구를 찾아 떠나게 만든다. 표면 한계와 제품 한계는 사용자에게 전혀 다른 말이다.
  - **수정**: "없는 것" 을 **두 종류로 갈랐다** — ① 표면에 배선 안 된 것(제품엔 있음; 저장소 실체와
    왜 안 열렸는지를 표로 명시) ② 구조적으로 없는 것. ②에 드는 것은 **실거래 주문 하나뿐**이고,
    그것만 `runtime-policy.ts:96` 이 throw 로 강제한다. 패턴 1·핸드오프 절·체크리스트 서두의
    같은 계열 표현 4곳도 함께 고쳤다.
  - **회귀 추가**: ②의 유일한 항목을 코드에 묶었다 — SKILL.md 가 인용한 throw 문자열이 그대로 있고
    `ENABLE_LIVE_TRADING=true` 가 실제로 throw 하는지 단언한다. 문서가 "구조적으로 불가능" 이라고
    단정하는 유일한 지점이라 가장 높은 stakes 에서 거짓이 될 수 있는 자리다. 판별력: 가드 제거 시 red.
  - **남은 한계(정직하게)**: 표면/제품 혼동은 **산문 문제라 테스트가 못 잡는다.** 오퍼레이션 이름과
    거절 이유는 가드가 있지만, "없다" 의 범위를 잘못 적는 것은 리뷰만이 잡는다. 이번엔 사용자가 잡았다.
- 다음: T10 종료 판정 → 정식 티켓(42~) 또는 Stage 3.
