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
- 다음: S2(오퍼레이션 카탈로그 + CLI 완성).
