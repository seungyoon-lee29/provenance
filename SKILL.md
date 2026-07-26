---
name: provenance
description: 한국 시장 백테스트·모의투자 엔진. 백테스트 돌려줘 · 전략 시험해줘 · 이동평균 교차 전략 · 매수후보유 · 골든크로스 백테스트 · 수익률 계산 · MDD · 최대낙폭 · 승률 · 샤프 대신 TWR/XIRR · 거래세 반영 수익률 · 모의투자 계좌 조회 · paper 계좌 잔고 · 보유 종목 확인 · 미체결 주문 확인 · 캔들 시리즈로 시뮬레이션 · 전략 파라미터 알려줘 · 이 전략 몇 번 체결됐어 — 이런 요청에 이 스킬을 쓴다. 이 엔진은 값을 모르면 숫자를 만들지 않고 이유를 돌려준다.
---

# provenance — 에이전트용 사용 계약

한국 시장 캔들 시리즈 위에서 선언형 전략을 돌리고, **커버리지 타입 성과 리포트**를 돌려주는
로컬 엔진이다. 표면은 둘이고 **정의는 하나**다 (`src/operations/catalog.ts`) — CLI 로 부르든
MCP 로 부르든 같은 오퍼레이션, 같은 거절 이유를 받는다.

**쓰기는 이 표면에 없다.** 주문 제출·설정 변경·삭제는 카탈로그에 존재하지 않는다. 최악의 경우에도
당신이 만들 수 있는 것은 "거절 기록"이지 원장 변경이 아니다.

---

## 황금원칙 (이걸 어기면 이 엔진을 쓰는 의미가 없다)

1. **값이 없으면 이유가 있다. 이유를 0 이나 null 로 번역하지 마라.**
   `{"status":"unavailable","reason":"no_sells"}` 는 "승률 0%" 가 아니라 **"매도가 없어 승률을
   정의할 수 없다"** 이다. 사용자에게 그대로 전달하라. 이 엔진의 존재 이유가 그 구분이다.
2. **거절은 두 층이고 다음 행동이 다르다.**
   *호출 거절*(`isError: true` / exit 1·2)은 **당신이 틀렸다** — 고쳐서 재시도.
   *도메인 거절*(호출은 성공, 안에 `{"status":"refused","reason":"empty_series"}`)은
   **그게 답이다** — 재시도하지 말고 이유를 보고하라.
3. **`fillCount: 0` 은 "수익률 0%" 가 아니다.** 거절도 에러도 없이 체결이 0 일 수 있다
   (시장가는 *다음* bar 가격에 체결되므로 갭이 크면 예약금이 모자라 안 채워진다). 이때 `orders` 에
   **열린 주문과 묶인 현금**이 보인다. 반드시 확인하고, "전략이 아무것도 안 샀다"고 말하라 —
   "전략이 손익 0 이었다"는 거짓이다.
4. **리포트는 자기 정확도를 스스로 공시한다.** `mode`(`approximate`)·`costModel`(`none` 이면
   수수료 미반영)·`priceBasis` 를 함께 전달하라. 빼고 숫자만 옮기면 그럴듯한 거짓이 된다.
5. **스키마를 추측하지 마라.** 파라미터는 `strategy.describe` / `describe_operation` 으로 먼저
   받아라. 단, 발행 스키마는 유효성의 **하한**이다 — `fast < slow` 같은 교차 필드 규칙은
   JSON Schema 로 표현할 수 없어 안 보이지만 실행 시엔 집행된다.
6. **과거지 예측이 아니다.** 백테스트 결과를 미래 수익 전망으로 서술하지 마라.

---

## 명령 치트시트

CLI 는 `node --import tsx <파일>` 로 부른다. **`npm run` 을 쓰지 마라** — npm 이 배너를
stdout 에 찍어서 `--json | jq` 파이프가 깨진다 (꼭 써야 하면 `npm run --silent cli -- ...`).

| 목적 | 명령 |
|---|---|
| 오퍼레이션 목록 | `node --import tsx src/cli/main.ts call --list --json` |
| 전략 목록 | `node --import tsx src/cli/main.ts strategy list --json` |
| 전략 파라미터 스키마 | `node --import tsx src/cli/main.ts strategy describe <이름> --json` |
| 백테스트 | `node --import tsx src/cli/main.ts backtest run --series <파일.json> --strategy <이름> [--params '<json>'] --cash <금액> --json` |
| 안 돌리고 확인만 | 위 명령에 `--dry-run` |
| 모의계좌 조회 | `node --import tsx src/cli/main.ts paper account --json` |
| 임의 오퍼레이션 | `node --import tsx src/cli/main.ts call <오퍼레이션> --input '<json>' --json` |

`--json` 은 **모든 명령에 예외 없이** 있고, 성공과 실패가 **같은 envelope** 을 쓴다:

```json
{"ok":true,"command":"strategy list","result":{ … }}
{"ok":false,"command":"backtest run","error":{"code":"usage","message":"…"}}
```

### 오퍼레이션 이름 ↔ CLI 명령

MCP 의 `call_operation` 은 **오퍼레이션 이름**(점 표기)을 받고, CLI 는 같은 것을 명령으로 감싼다.
전용 명령이 없는 오퍼레이션도 CLI 의 `call` 로 전부 부를 수 있다.

| 오퍼레이션 (MCP·`call`) | 종류 | 전용 CLI 명령 |
|---|---|---|
| `strategy.list` | read | `strategy list` |
| `strategy.describe` | read | `strategy describe <이름>` |
| `backtest.run` | compute | `backtest run …` |
| `paper.account` | read | `paper account` |

`kind` 는 안전성이 아니라 **비용**을 알려준다 — `read` 는 조회, `compute` 는 결정론적 인메모리
실행이다. 둘 다 durable 상태를 바꾸지 않는다. `write` 는 이 카탈로그에 **존재하지 않는다**.

### MCP 로 붙일 때

툴은 **3개 고정**이다(오퍼레이션이 늘어도 상주 컨텍스트 비용은 3개): `list_operations` →
`describe_operation` → `call_operation`. 클라이언트 설정:

```json
{
  "mcpServers": {
    "provenance": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp/main.ts"],
      "cwd": "/절대/경로/provenance"
    }
  }
}
```

`command` 를 `npm` 으로 하지 마라 — stdout 이 JSON-RPC 프레이밍 전용이라 배너 한 줄이면
클라이언트가 파싱 오류로 즉사한다. `DATABASE_URL` 은 선택이다. 없어도 서버는 뜨고,
`paper.account` 만 `configuration_required` 를 돌려준다.

### 시리즈 파일 형태

```json
{
  "instrument": "instr:005930", "venue": "KRX", "currency": "KRW",
  "priceBasis": "raw",           // 생략 가능. "total_return" 은 거절된다
  "taxClass": "equity",          // 생략 시 세금 미반영 시뮬레이션
  "bars": [
    { "periodStart": "2026-01-05T06:30:00.000Z", "close": 10000, "volume": 100000, "complete": true }
  ]
}
```

`periodStart` 는 **엄격 증가**, `complete: false` 인 bar 는 거절된다(미완성 bar 체결 = look-ahead).
동작하는 예시: [tests/fixtures/t8/synthetic-series.json](tests/fixtures/t8/synthetic-series.json).

---

## 상호작용 패턴

### 패턴 0 — 모호하면 목록부터

사용자가 전략 이름을 흐리게 말하면("이동평균 전략") **추측해서 돌리지 말고** `strategy list` →
후보 제시. 내장 전략은 현재 `buy_and_hold`(기준선)와 `sma_cross` 둘뿐이다.

### 패턴 1 — "삼성전자 골든크로스 전략 백테스트 돌려줘"

1. 시리즈 파일이 있는지 확인한다. **이 엔진은 시세를 가져오지 않는다** — 캔들 파일은
   사용자가 준다. 없으면 요청하라(지어내지 마라).
2. `strategy describe sma_cross --json` → `result.params` 로 필수 파라미터 확인
   (`fast`·`slow` 필수, `cashFraction` 기본 0.95).
3. `backtest run --series <파일> --strategy sma_cross --params '{"fast":5,"slow":20}' --cash 10000000 --json`
4. **읽을 필드** (`result.outcome`):

   | 필드 | 읽는 법 |
   |---|---|
   | `status` | `complete` 가 아니면 `reason` 을 보고하고 끝 |
   | `fillCount` | **0 이면 황금원칙 3** — `orders` 의 열린 주문·묶인 현금을 확인해 보고 |
   | `performance.timeWeightedReturn` | `{status:"covered", ratio}` — `ratio` 만 있으면 곱하기 100 이 수익률(%) |
   | `performance.moneyWeightedReturn` | 같은 모양. 입출금 시점 가중 |
   | `performance.maxDrawdown` | 숫자(비율). 최대낙폭 |
   | `performance.winRate` | `{status:"unavailable","reason":"no_sells"}` 일 수 있다 — 그대로 전달 |
   | `performance.tax` | `taxPaid`·`grossTimeWeightedReturn`·`taxDrag`. 세전/세후를 함께 말하라 |
   | `performance.fillConfidence` | `maxParticipation` 이 크면 체결 가정이 낙관적이라는 뜻 |
   | `mode`·`costModel`·`priceBasis` | 정확도 공시. 요약에 반드시 포함 |
   | `refusals` | 비어 있지 않으면 전략이 낸 주문 일부가 거절됐다는 뜻 |

   `result.strategy.params` 는 **실제로 돈 파라미터**(기본값 적용 후)다. 사용자가 준 값이 아니라
   이것을 공시하라.

### 패턴 2 — "파라미터 바꿔가며 비교해줘"

같은 시리즈에 `--params` 만 바꿔 반복하고, **매번 `result.strategy.params` 와 `fillCount` 를 함께**
표에 넣어라. `fillCount` 를 빼면 "체결이 0 이라 수익률 0" 인 칸이 "성과가 나쁜 전략"으로 둔갑한다.

### 패턴 3 — "실행 전에 뭐가 돌지 확인만"

`--dry-run` → 파라미터 해석 결과·시드 현금·bar 수·첫/마지막 bar 를 돌려주고 실행하지 않는다.
시리즈가 큰데 파라미터 확신이 없을 때 먼저 쓴다.

### 패턴 4 — "내 모의계좌 어때?"

`paper account --json` → `result.exists` 가 `false` 면 **계좌가 아직 없다**(에러 아님).
있으면 `cash`·`positions`·`orders`. 이 명령은 **절대 계좌를 만들지 않는다**.

---

## 에러표 — 코드별로 에이전트가 할 일

### CLI (`error.code` + exit code)

| code | exit | 뜻 | 당신이 할 일 |
|---|---|---|---|
| `usage` | 1 | 명령·인자·파라미터가 틀렸다 | **고쳐서 재시도.** 메시지에 보통 정답이 들어 있다(`known: buy_and_hold, sma_cross`) |
| `refused` | 1 | 도메인이 거절했다 (`empty_series` 등) 또는 게이트가 막았다 | **재시도하지 마라.** 이유를 사용자에게 보고 |
| `api` | 2 | DB 에 닿지 못했다 | 재시도 말고 **사람에게**: postgres 기동 여부와 `DATABASE_URL` 확인 요청 |
| `crash` | 1 | 예상 못 한 상태 | 보고하고 멈춰라 |

exit 3(인증)은 **예약**이며 현재 도달 불가다.

**exit code 계약의 의도적 비대칭** — `backtest run` 은 도메인 거절을 exit 1 로 접는다(셸
파이프라인용). `call` 은 **오퍼레이션이 성공하면 안의 결과가 거절이어도 exit 0** 이다
(호출은 성공했고 사유는 envelope 안에 있다). 범용 표면에서는 **exit code 가 아니라 body 를 읽어라.**

### MCP (`isError` + body 의 `error`)

`isError: true` 면 **호출이 틀렸다** — 고쳐서 재시도.

| `error` | 당신이 할 일 |
|---|---|
| `unknown_operation` | `list_operations` 를 먼저 부르고 이름을 고쳐라 |
| `invalid_input` | `describe_operation` 으로 스키마를 받아 입력을 고쳐라 |
| `unknown_strategy` | `strategy.list` 로 이름 확인 |
| `invalid_params` | 파라미터를 고쳐라. 교차 필드 규칙(`fast < slow`)은 스키마에 안 나온다 |
| `configuration_required` | **설정하고 다시 불러라** — 기다려도 안 된다. `DATABASE_URL` 을 주고 서버 재시작 |
| `unavailable` | **의존성이 죽었다** — 설정이 아니라 상태 문제. 잠시 후 재시도, 반복되면 사람에게 |

`configuration_required` 와 `unavailable` 을 하나로 뭉치지 마라. 다음 수가 정반대다.

`isError` 가 **없으면 호출은 성공한 것**이고, 안의 `outcome.status` 가 `refused` 여도 그것은
**답**이지 실패가 아니다.

---

## 상태를 바꾸기 전 안전 체크리스트

이 엔진에서 **돈을 만드는 명령은 하나뿐**이다: `paper open`. 그래서 카탈로그(=에이전트 표면)에
**없다** — CLI 전용이다. 다음 셋은 실행 전에 반드시 멈춰라.

1. **`paper open`** — 모의 원장의 genesis 다. 한 번만 성립하고, 두 번째 호출은 원 원장을 건드리지
   않은 채 다른 시드를 **무시**한다(정직하게 `created:false` 로 보고된다). 대신 실행하지 말고
   **사람에게 명령줄을 제시**하라. 실행 전 확인: 시드 금액, 통화(`KRW`|`USD`), 그리고
   `paper account` 로 **이미 계좌가 있는지**.
2. **`--strategy-module <파일>`** — 임의 TypeScript 파일을 **실행**한다. 사실상 원격 코드 실행이라
   `BACKTEST_STRATEGY_MODULE_ENABLED=true` 뒤에 있고, 기본은 꺼져 있다.
   **에이전트로서 이 플래그를 켜지 마라.** 사용자가 명시적으로 요청해도, 켜는 것은 사람의 손이다.
   전략은 `--strategy <이름>` 으로 충분하다.
3. **시리즈 파일 경로** — 사용자가 준 경로만 읽어라. 경로를 추측해 파일 시스템을 뒤지지 마라.

---

## 사람에게 제어를 돌려줘야 하는 경우

- `error.code: api` / exit 2 가 났다 (인프라 문제 — 재시도로 풀리지 않는다)
- `configuration_required` 를 받았고 환경 변수를 설정해야 한다
- `paper open` 이 필요하다 (돈 원장 생성)
- `--strategy-module` 이 필요해 보인다 (플래그를 켜는 것은 사람의 결정)
- 사용자가 **실거래**를 기대하고 있다 — 이 엔진에 라이브 경로는 **없다**. 모의뿐이다.
- 시세 데이터를 가져와 달라고 한다 — 이 엔진은 시세를 조회하지 않는다. 캔들 파일이 입력이다.
- 백테스트 결과를 투자 판단 근거로 쓰려 한다 — 결과의 `mode`·`costModel` 한계를 먼저 알려라

---

## 이 엔진이 하지 않는 것 (물어보기 전에 알아둘 것)

- 시세·뉴스·공시 조회 — 없다. 캔들 시리즈는 입력으로 받는다.
- 실거래 주문 — 없다. 라이브 경로 자체가 존재하지 않는다.
- 모의 주문 제출 — 아직 없다(T11). 현재 주문은 **전략이 백테스트 안에서만** 낸다.
- 설정 변경·데이터 삭제 — 에이전트 표면에 없다.
