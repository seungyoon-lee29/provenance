# provenance — 한국 시장 백테스트 · 모의투자 엔진

한국 시장 규칙(증권거래세·휴장일·KRX 세션) 위에서 도는 결정론 백테스트 엔진. 얼굴은
**CLI + MCP** 라서 사람보다 에이전트가 먼저 쓴다. 백테스트와 모의계좌가 같은 체결
엔진(`InternalPaperSimulator` + append-only `PaperJournal`)을 공유한다.

[**빠른 시작**](#설치--생략-금지-체크리스트) · [**명령 목록**](#명령-목록) · [**아키텍처**](#아키텍처) ·
[**안전 불변식**](#안전-불변식-standing-invariants) · [**로드맵**](#프로젝트-상태-정직한-로드맵) ·
[**에이전트 계약(SKILL.md)**](SKILL.md)

**값을 모르면 숫자를 만들지 않는다.** 이건 표어가 아니라 리턴 타입이다:

```console
$ node --import tsx src/cli/main.ts backtest run \
    --series tests/fixtures/t8/synthetic-series.json --strategy buy_and_hold --cash 1000000 --json
```
```jsonc
// 실제 응답에서 cash·positions·orders·fills 를 생략한 발췌 (그대로 재현된다)
{"ok":true,"result":{
  "outcome":{ "status":"complete", "mode":"approximate", "priceBasis":"raw",
              "costModel":"none", "barCount":3, "fillCount":1, /* … */
  "performance":{
    "timeWeightedReturn":  {"status":"covered","ratio":-0.000564},
    "winRate":             {"status":"unavailable","reason":"no_sells"},   // 0% 가 아니다
    "fillConfidence":      {"fills":1,"maxParticipation":0.00094},         // 이 체결을 믿어도 되나
    "tax":{"status":"covered","taxPaid":0,"taxDrag":{"status":"covered","ratio":0}}
  }}}}
```

지표마다 `covered` / `unavailable` + 이유가 붙는다. 매도가 없으면 승률은 **0% 가 아니라 없는
것**이고, 세금 총액을 믿을 수 없으면 gross·net·drag **블록 전체**가 `unavailable` 로 내려간다 —
반쪽 숫자가 투자 판단에 쓰이느니 없는 편이 낫다.

## 무엇이 어려웠나

이 저장소가 실제로 값을 한 지점만 — 전부 코드로 확인 가능하게 적는다.

- **미래를 못 보게 만드는 것.** 전략에 넘기는 뷰는 커서까지만 열려 있고, 그 너머를 읽으면
  `RangeError` 다 (`backtest-runner.ts:368`). 미완성 bar 에서의 체결도 거부한다 — 백테스트에서
  가장 흔한 거짓말이 look-ahead 라서, 규율이 아니라 **타입과 예외**로 막았다.
- **정직함을 타입으로 만드는 것.** 위 출력의 `covered`/`unavailable` 은 서식이 아니라 유니언
  타입이다. 계산할 수 없는 지표는 `null` 로 직렬화될 자리가 애초에 없다.
- **돈을 정수로 유지하는 것.** 원장은 minor-unit 정수 fold 이고, 2^53 을 넘길 수 있는 곱은
  BigInt 로 간다. float 누적 드리프트가 실제로 한 번 났고, 같은 구조의 쌍둥이가 다른 경로에
  남아 있던 것을 나중 감사에서 또 잡았다.
- **모르는 세율을 거부하는 것.** 증권거래세는 체결연도 키로 시행령 부칙까지 대조했고, 연중에
  세율이 바뀐 2019 이전은 **연도 키로 확정 불가라 fail-closed** 다 — 시리즈가 `taxClass` 를
  선언한 경우에 한해서다. 생략하면 세금 없는 시뮬레이션이고 결과에 `costModel:"none"` 으로
  공시된다. 어느 쪽이든 그럴듯한 값을 지어내지는 않는다.
- **가드가 진짜 살아 있는지 실증하는 것.** no-live·egress 모듈은 Stryker mutation 으로 "가드를
  물리적으로 부수면 테스트가 죽는지" 까지 회귀 게이트를 건다.

## 왜 이 각도인가

선행 연구는 QuantConnect Lean · NautilusTrader 다. 그쪽이 채운 칸(멀티에셋 백테스트·저지연)을
다시 만들지 않고 **비어 있는 교차점**을 겨냥한다 — *한국 시장 규칙 × 에이전트 인터페이스(MCP) ×
데이터 정직성*. 체결 모델도 "Lean 과 동일" 이 아니라 한국 리테일 현실에 맞춘 **선형
재파라미터화**(거래량 참여 상한 10%, 슬리피지 5bps + 20bps × 누적참여율, 상한 25bps)다.

---

## 에이전트로 쓰기 (현행 표면 — CLI · MCP)

백테스트 엔진은 두 표면을 갖는다. 정의는 하나(`src/operations/catalog.ts`)이고 CLI 와 MCP 는
그 위의 transport 다. 에이전트용 사용 계약 전문: **[SKILL.md](SKILL.md)**.

### 설치 — 생략 금지 체크리스트

에이전트가 그대로 따라 실행할 수 있게 결정론적으로 적는다. 순서를 바꾸거나 건너뛰지 말 것.

**필요한 것**: Node.js ≥ 22 (그게 전부다 — 백테스트는 DB 없이 돈다).
모의계좌(`paper open`·`paper account`)를 쓸 때만 **Docker + Docker Compose** 가 추가로 필요하다.

```bash
# 1. 클론 후 저장소 루트에서
npm install

# 2. 확인 — 아래 두 줄이 그대로 나오면 엔진은 동작한다
node --import tsx src/cli/main.ts strategy list --json
node --import tsx src/cli/main.ts backtest run \
  --series tests/fixtures/t8/synthetic-series.json \
  --strategy buy_and_hold --cash 1000000 --json

# 3. (선택) 모의계좌(`paper account`/`paper open`)를 쓸 때만 — PostgreSQL 이 필요하다
npm run compose:up     # postgres + 루프백 ingress 까지 함께 뜬다
npm run db:migrate     # 기본값 127.0.0.1:5432 로 붙는다
```

네 가지 디테일이 실제로 사람을 걸리게 한다:

- **`npm run` 으로 부르지 마라.** npm 이 스크립트 배너를 **stdout** 에 찍어서 `--json | jq`
  파이프가 깨지고, MCP 로 쓰면 JSON-RPC 스트림이 오염돼 클라이언트가 즉사한다.
  `node --import tsx <파일>` 로 직접 부른다 (부득이하면 `npm run --silent cli -- …`).
- **`SKILL.md` 는 로컬 파일로 읽어라** — 원격 fetch 도구로 가져오지 말고 클론한 저장소에서
  직접 읽는다. 표면의 진실은 이 워킹 트리이지 어딘가의 캐시가 아니다.
- **PostgreSQL 은 모의계좌 명령(`paper open`·`paper account`)에만 필요하다.** 둘 다 durable 이고
  DB 없이는 exit 2 다. 백테스트(`backtest run`·`strategy *`)는 DB 없이 완전히 돈다.
- **`POSTGRES_HOST_PORT` 를 바꾸면 `DATABASE_URL` 도 같이 바꿔야 한다** — 앞의 것은 compose 가
  발행하는 포트고, CLI 는 `DATABASE_URL`(기본 `…@127.0.0.1:5432/…`)을 본다. 한쪽만 바꾸면
  ECONNREFUSED 다.

### MCP 서버 등록

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

`DATABASE_URL` 이 없어도 서버는 뜬다 — `paper.account` 만 `configuration_required` 를
돌려주고 나머지 오퍼레이션은 정상 동작한다. 툴은 3개 고정(`list_operations` ·
`describe_operation` · `call_operation`)이라 오퍼레이션이 늘어도 상주 컨텍스트 비용은 그대로다.

### 이 프롬프트를 에이전트에게 복사해줘

```text
이 저장소(provenance)는 한국 시장 캔들 시리즈 위에서 선언형 전략을 돌리는 로컬 백테스트
엔진이다. 시작하기 전에 저장소 루트의 SKILL.md 를 읽어라 — 사용 계약이 거기 있다.

핵심만 미리 말하면:
- 명령은 `node --import tsx src/cli/main.ts <…> --json` 으로 부른다. `npm run` 은 stdout 을
  오염시키니 쓰지 마라.
- 무엇이 있는지는 `call --list` 로 물어라. 스키마는 `strategy describe <이름>` 으로 받아라.
  추측하지 마라.
- 이 엔진은 값을 모르면 숫자를 만들지 않는다. `{"status":"unavailable","reason":…}` 를
  0 이나 null 로 번역하지 말고 이유를 그대로 전달해라.
- `fillCount: 0` 은 "수익률 0%" 가 아니라 "체결이 없었다" 이다. 열린 주문을 확인해서 보고해라.
- 쓰기 오퍼레이션은 없다. 모의계좌 생성(`paper open`)과 `--strategy-module` 플래그는
  사람이 한다 — 대신 실행하지 말고 명령줄을 제시해라.
- 시세를 가져오지 않는다. 캔들 시리즈 파일은 사용자가 준다. 없으면 지어내지 말고 요청해라.
```

전체 설치·운영(웹 스택 포함)은 [docs/release/setup.md](docs/release/setup.md).

---

## 명령 목록

CLI 는 여섯 그룹이다. 전부 `--json` 을 받고, 성공은 exit 0 · 사용법 오류는 exit 1 ·
설정 문제는 exit 2 다. **호출이 성공해도 그 안이 거절(`refused`)일 수 있으니 봉투를 읽어라.**

```bash
# 짧게 쓰려고 함수 하나만 정의한다 (bash·zsh 공통).
# `CLI="node --import tsx …"` 뒤에 `$CLI` 를 쓰는 형태는 zsh 에서 깨진다 — 단어 분할을 안 한다.
pv() { node --import tsx src/cli/main.ts "$@"; }

# 무엇이 있는지 물어보기 — 오퍼레이션 카탈로그가 정본이다
pv call --list                                   # 오퍼레이션 전부 나열
pv call <operation> [--input '<json>'] [--json]  # 아무 오퍼레이션이나 직접 호출

# 전략
pv strategy list [--json]
pv strategy describe <name> [--json]             # 파라미터 스키마까지

# 백테스트 (DB 불필요)
pv backtest run --series <파일.json> --strategy <이름> \
   [--params '<json>'] --cash <금액> [--dry-run] [--json]

# 모의계좌 (PostgreSQL 필요)
pv paper open --cash <금액> --currency <KRW|USD> [--json]
pv paper account [--json]
```

내장 전략은 둘이다 — `buy_and_hold`(기준선), `sma_cross`(`--params '{"fast":5,"slow":20}'`).

### `--series` 파일 형태

시세를 가져오지 않는다. 캔들 시리즈는 **직접 준다.**

```jsonc
{
  "instrument": "instr:005930", "venue": "KRX", "currency": "KRW",
  "priceBasis": "raw",   // 생략 가능. "total_return" 은 거절된다
  "taxClass": "equity",  // 생략하면 세금 미반영 (결과에 costModel:"none" 으로 공시)
  "bars": [
    { "periodStart": "2026-01-05T06:30:00.000Z", "close": 10000, "volume": 100000, "complete": true }
  ]
}
```

`periodStart` 는 **엄격 증가**여야 하고, `complete:false` 인 bar 는 거절된다 — 미완성 봉에서의
체결이 곧 look-ahead 라서다. 돌아가는 예시: [tests/fixtures/t8/synthetic-series.json](tests/fixtures/t8/synthetic-series.json).

### 직접 만든 전략 돌리기

내장 둘로 부족하면 TS 파일 하나를 넘긴다. 함수 하나가 계약의 전부다:

```ts
// my-strategy.ts — default 또는 `strategy` 로 export 하면 된다
import type { BacktestStrategy } from "./src/modules/paper-trading/backtest/backtest-runner";

const strategy: BacktestStrategy = (view) =>
  view.cursor === 0
    ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }]
    : [];

export default strategy;
```

`view` 는 `cursor`(방금 닫힌 봉) · `bar(i)` · `cash` · `positions` · `orders` 를 준다.
**`bar(i)` 는 `i > cursor` 면 `RangeError` 다** — 미래를 읽는 순간 타입이 아니라 예외로 막힌다.
돌려주는 것은 `{kind:"submit"|"cancel"}` 액션 배열이다.
돌아가는 예시: [tests/fixtures/t8/buy-once.strategy.ts](tests/fixtures/t8/buy-once.strategy.ts).

```bash
BACKTEST_STRATEGY_MODULE_ENABLED=true pv backtest run \
  --series <파일.json> --strategy-module ./my-strategy.ts --cash 1000000 --json
```

플래그 없이 부르면 실행하지 않고 거절한다 — 실측:
`{"ok":false,...,"code":"refused","message":"--strategy-module executes an arbitrary file and is disa…"}`

> ⚠️ `--strategy-module` 은 **임의 TS 파일을 실행한다 — 사실상 RCE**다. 그래서 환경변수 없이는
> 꺼져 있고, **에이전트가 아니라 사람이 켠다.** 에이전트에게는 명령줄만 제시하게 하라.

---

## 이 표면에 없는 것 — 두 종류를 구별한다

"제품에 없다" 와 "이 CLI·MCP 표면에 배선하지 않았다" 는 사용자에게 전혀 다른 말이다.
전자로 잘못 적으면 사용자가 있는 기능을 찾아 떠난다.

- **표면에 없을 뿐, 제품에는 있는 것** — 시세 조회(KIS·국채·ECB FX 어댑터), 공시 조회(Open DART),
  캔들 생성, 모의 주문 제출(`PaperTradingService`, 백테스트 러너가 쓰는 바로 그 seam).
  웹 층(`server-only` alias)에 묶여 있어 Stage 3 재작성 뒤 별도 슬라이스로 연다.
  주문 제출은 confirm token(티켓 40)이 선행이라 **의도적으로 안 열었다**.
- **불변식으로 금지한 것 — 실거래 주문 하나뿐.** `src/composition/runtime-policy.ts` 가
  `ENABLE_LIVE_TRADING=true` 를 throw 로 거부하고, 그 문자열을 테스트가 상시 단언한다.
- **구현 자체가 없는 것 — 뉴스.** 금지된 게 아니라 어댑터를 아직 안 만들었다.

정본 표는 [SKILL.md](SKILL.md) §"없는 것".

---

## 데이터 정직성 모델 — 시세 쪽

성과 지표가 `covered`/`unavailable` 로 갈리듯, 시장 정보는 세 축을 함께 운반한다. 백테스트가
쓰는 것과 같은 원칙을 데이터 수집 쪽에 적용한 층이다.

| 축 | 값 | 의미 |
|---|---|---|
| **Information Outcome** | `available` / `unavailable` / `failed` | 값은 오직 `available`에만 존재. 나머지는 `api_required`·`license_restricted`·`no_data`·공급자 실패로 *이유*를 표시 |
| **License Scope** | `public` / `personal` / `internal_test_only` | 데이터를 누구에게 보여줄 권리가 있는가. `personal`은 절대 공개 feed로 재배포되지 않는다 |
| **Data Freshness** | `realtime` / `delayed` / `stale` | 출처·기준 시각(as-of)과 함께, 값이 얼마나 신선한지 정직하게 노출 |

> 예: 장 마감 후 KIS 시세를 조회하면 위젯은 전일 종가를 `stale · eod`로 표기한다.
> 개장 시간(09:00–15:30 KST)에만 `realtime · trade`가 되며, **휴장일(설날·추석·대체공휴일·
> 지방선거·연말 폐장)에는 실시간으로 위장하지 않는다.**

---

## 아키텍처

**Ports & Adapters** 기반 모듈형 모놀리스. 각 도메인 모듈은 공개 인터페이스(port)만 노출하고,
조합 계층(`src/composition`)이 런타임 정책에 따라 어댑터를 조립한다.

핵심은 **오퍼레이션 정의가 한 곳**이라는 것이다. CLI 와 MCP 는 같은 카탈로그 위의 두 transport 라
표면이 늘어도 정의는 갈라지지 않는다:

```
  사람                     에이전트
   │                          │
   ▼                          ▼
┌──────────┐          ┌───────────────┐
│   CLI    │          │  MCP (stdio)  │  툴 3개 고정
│ src/cli  │          │   src/mcp     │  list · describe · call
└────┬─────┘          └───────┬───────┘
     └──────────┬─────────────┘
                ▼
     ┌─────────────────────────┐
     │  오퍼레이션 카탈로그      │   ← 단일 정의 (zod 스키마 + 거절 이유)
     │  src/operations/catalog │
     └────────────┬────────────┘
                  ▼
     ┌─────────────────────────┐
     │  composition            │   ← 런타임 정책 · 어댑터 조립 · 라이브 거래 차단
     └────────────┬────────────┘
                  ▼
  ┌────────────────────────────────────────┐
  │  paper-trading                         │
  │  ┌──────────────┐   ┌────────────────┐ │
  │  │  backtest/   │──▶│   internal/    │ │  ← 같은 체결 엔진
  │  │ 시간축 커서   │   │ 시뮬레이터·원장 │ │    (백테스트도 모의계좌도)
  │  │ look-ahead✕  │   │ 거래세·정수 fold│ │
  │  └──────────────┘   └───────┬────────┘ │
  └───────────────────────────┬─┴──────────┘
                              ▼
                   PostgreSQL (append-only 원장)
                   └ 모의계좌만. 백테스트는 메모리로 끝난다
```

시리즈 파일은 **왼쪽 끝에서 사용자가 넣는다** — 이 엔진은 시세를 가져오지 않는다.

```
src/
├── operations/        오퍼레이션 카탈로그 — 두 표면의 단일 정의
├── cli/ · mcp/        transport (CLI 명령 · MCP stdio 서버 툴 3개)
├── modules/
│   ├── paper-trading/
│   │   ├── internal/            체결 엔진 · append-only 원장 (돈의 유일 변경 경계)
│   │   │                        + 증권거래세 · Postgres 원장 store
│   │   └── backtest/            시간축 커서 러너 · 전략 카탈로그 · 성과 리포트
│   ├── financial-information/   시장·공시·차트 + InformationOutcome 정규화
│   ├── actual-portfolio/        calculation/ 만 — TWR · XIRR · P&L 분해 (순수 함수)
│   ├── identity/                세션·계정 (hash-only, fence-first erasure)   ← Stage 3 컷 대상
│   ├── provider-connections/    사용자별 Provider Credential (AES-256-GCM)   ← Stage 3 컷 대상
│   └── terminal-view/           게스트 터미널 뷰 계층                        ← Stage 3 컷 대상
├── composition/       런타임 정책 · 싱글턴 조립 · 크리덴셜 게이팅
├── platform/          영속성(unit-of-work) · credential-vault · provider-transport
├── shared/            공유 계약 (InformationOutcome · brands)
├── app/               Next.js App Router (게스트 터미널 · API 라우트)        ← Stage 3 컷 대상
└── worker/            헬스 엔드포인트 (스케줄 작업 없음)
```

`research-assistant`·`notification-center`·`actual-portfolio` 의 실계좌 트랙, F9 브로커 전송
경로는 피벗에서 **삭제됐다**(Stage 1 ~8,400줄 + Stage 2 ~16,400줄). 옛 문서에 완료로 적힌 항목이라도 위 트리에
없으면 지금은 없는 것이다.

### 두 데이터 트랙 — 재배포 경계 (웹 층)

라이선스가 다르면 대상 사용자도 다르다. 이 경계는 코드로 강제되며, 웹 층과 함께 Stage 3 에서
존치 여부를 결정한다.

- **개인용 (KIS 한국투자증권 · `personal`)** — 로그인한 owner 본인에게만. 개인 API 키로 받은
  국내주식·업종지수 시세. `personal` 라이선스는 owner 외 조회 시 `api_required`로 차단되며
  **공개 feed·다른 사용자 캐시로 절대 재배포되지 않는다.**
- **게스트용 (공개 소스 · `public`)** — 비로그인 누구나. 재배포 권리는 소스마다 다르고, 그
  차이를 뭉뚱그리지 않는다(정본: [rights.md](docs/release/rights.md)).
  - 미 재무부 수익률 곡선 — public domain. `PUBLIC_MARKET_ENABLED=true` 로 열린다.
  - ECB 파생 USD/KRW — public domain 이 아니라 **출처 표기 조건부 재사용**이다. 같은 플래그.
  - Open DART 공시 — 플래그에 더해 `DART_API_KEY` 가 있어야 열린다.

  게스트 KOSPI/S&P/NASDAQ 은 **재배포 가능한 무료 소스가 없어** 정직하게 `api_required` 로 남는다.

---

## 안전 불변식 (Standing Invariants)

틀리면 비싼 경로는 단위 테스트를 넘어 **상시 property로 검증**한다. 아래 네 불변식은
`fast-check` 기반 standing property로 `npm run check` 에 들어 있고, 그 스크립트가 pre-commit
훅과 CI 양쪽에 배선돼 있다.

> **Stryker mutation testing 은 상시 게이트가 아니다.** `runtime-policy`·`network-policy` 2개
> 모듈을 대상으로 수동 실행(`npm run test:mutation`)만 한다 — CI·훅 어디에도 안 걸려 있다.
> 이 사실은 [gate-ledger.txt](scripts/gates/gate-ledger.txt) 에 `unwired` 사유와 함께 적혀 있고,
> `gate-liveness.sh` 가 "선언만 있고 안 도는 게이트"를 커밋 시점에 잡는다.

| 불변식 | 강제 내용 |
|---|---|
| **No Live Trading** | 초기 산출물은 실제 브로커로 주문을 전송하지 않는다. Paper 경로만 실행 |
| **No Redistribution / Egress** | 개인 키 데이터가 공개 feed로 새지 않는다. 외부 전송 목적지는 허용목록으로 pin |
| **Money Conservation** | append-only 원장 fold에서 돈은 생성·소멸하지 않는다 (§8 trio). 메모리·실 Postgres 두 러너로 |
| **Actual / Paper Isolation** | 두 모듈 트리가 서로를 import 하지 않는다 (순수 계산 규칙 재사용은 허용) |

---

## 검증 전략

- **Network-off 결정론 TDD** — 모든 단위·통합 테스트는 네트워크 없이 결정론적으로 돈다.
  외부 공급자는 저수준 HTTP 주입(seam)으로 대체하고, 실제 API는 **opt-in contract test**로 분리.
- **Contract tests** — 실 KIS 등 외부 API 계약은 환경변수 게이트(`KIS_CONTRACT=1`)로만 실행.
- **Property + Mutation** — `fast-check`(불변식 property) + `@stryker-mutator`(가드 kill 실증,
  범위는 `runtime-policy`·`network-policy` 2개 모듈).
- **적대적 리뷰** — 고위험 산출물(돈·크리덴셜·인증 경로)은 구현과 다른 계열 모델의 blind 검수와
  독립적인 test-authorship로 반례를 찾고, 직접 재현된 지적만 수정한다. **채택해 반영한 수정은
  같은 등급으로 다시 공격한다** — 1라운드 수정이 원 문제보다 나빴던 사례가 실제로 있었다.
- **문서 드리프트 가드** — 에이전트가 행동 근거로 삼는 문장은 테스트가 붙잡는다. `SKILL.md` 는
  카탈로그의 모든 오퍼레이션·거절 이유를 담아야 하고, 호스트 DB 엔드포인트는 기본값·`.env.example`·
  compose 세 곳이 일치해야 하며, 문서가 "구조적으로 불가능" 이라 단정한 지점은 코드에 묶여 있다.
- **Browser / A11y** — Playwright + `@axe-core/playwright`로 실 DOM·접근성·성능 예산 검증(웹 층).
- **CI parity** — 로컬 pre-commit 훅과 동일한 게이트를 GitHub Actions에서 원격 강제.

```bash
npm run check                 # typecheck + lint + test   — pre-commit·CI 양쪽 배선
npm run build                 # Next 번들. check 에 없다 — Dockerfile 이미지 빌드로 CI 에서 돈다
npm run verify:network-off    # compose 레인
npm run test:persistence-pg   # 실 Postgres 필요 (compose:up)
npm run test:mutation         # Stryker — 수동 전용, 게이트 아님 (위 주의 참고)
```

---

## 에이전트 운영 모델

이 저장소는 에이전트에게 기능 구현만 맡기지 않고 **작업 선택 → 소유권 → 검증 → 통합** 루프도 저장소 안에서 관리한다. 도구별 진입점은 짧게 유지하고, 프로젝트 상태와 안전 규칙은 모든 에이전트가 공유하는 Markdown 정본에 둔다.

```text
dependency map → frontier claim → single-file ownership
               → implementation → deterministic gates
               → adversarial review → resolve or human gate
```

- [공통 하한](./AGENTS.md): dirty worktree 보존, 단일 파일 owner, allowlist staging, 비밀·외부 실행 제한
- [로컬 티켓 루프](./docs/agents/issue-tracker.md): dependency-aware frontier, claim, heartbeat, 검증 증거와 resolve
- [협업·검수 등급](./docs/agents/collaboration.md): Prevent → Detect → Contain, blast-radius 기반 검증, 고위험 경로의 사람 게이트
- [하네스 사례 연구](./docs/notes/harness-and-loop-engineering.md): 일회성 다중 검수를 property·mutation·network-off 상시 검증으로 바꾼 과정
- [릴리스 게이트](./docs/release/release.md): credential pattern, `.scratch/`와 미분류 파일을 fail-closed로 차단하는 재현 가능한 패키징

`.scratch/`는 스펙·티켓·중간 가설을 포함하는 작업 정본이다. 이 저장소를 소개할 때는 위의 정제된 문서를 기준으로 하고, 현재 사실 여부는 코드·테스트와 `resolved` 티켓의 검증 결과로 확인한다.

---

## 보안

- **크리덴셜 원문은 어디에도 평문 금지** — 코드·문서·설정·권한 allowlist 어디에도. 서버 환경변수
  또는 **AES-256-GCM 암호화 저장소**에만 둔다. 사용자별 키는 마스킹되어 저장·조회된다.
  (vault 구현은 있고 로컬 KEK keyring 은 디스크에 있다. 다만 **CLI 의 브로커 키 저장은 아직
  없다** — credential 오퍼레이션이 없고 T11 범위다. vault 를 Stage 3 이후에도 남기는 이유가
  그 예정된 소비자다.)
- **egress 허용목록** — 외부 전송 목적지는 호스트명으로 pin 되고 리다이렉트를 거부한다. 공개 소스
  어댑터는 기본 off 플래그 뒤에 있다.
- **`--strategy-module` 은 사실상 RCE** — 임의 TS 파일을 실행하므로
  `BACKTEST_STRATEGY_MODULE_ENABLED=true` 없이는 비활성이고, 에이전트가 아니라 사람이 켠다.
- 아래 셋은 웹·인증 층 소속이라 Stage 3 컷 대상이다: **Hash-only 세션**(generation·authorization
  epoch·deletion fence), **fence-first erasure(SEC-09)**, **enumeration-safe 이메일 로그인**.

---

## 기술 스택

| 영역 | 사용 |
|---|---|
| 언어·런타임 | TypeScript, Node.js ≥ 22 (`tsx` 로더로 직접 실행) |
| 에이전트 표면 | `@modelcontextprotocol/sdk` (MCP stdio) |
| 데이터 | PostgreSQL (`pg`) · Redis (웹 층 시세 캐시) |
| 검증 | zod (런타임 스키마) |
| 테스트 | Vitest, fast-check, Stryker, Playwright, axe-core |
| 웹 (컷 대상) | Next.js 16 (App Router), React 19 |
| 인프라 | Docker Compose, GitHub Actions, Husky |

---

## 실행 — 웹 스택

엔진만 쓸 거라면 위의 「에이전트로 쓰기」 절이 전부다. 아래는 Stage 3 에서 존치 여부를 결정할
웹 층이다.

```bash
npm run dev            # http://localhost:3000 — scripted 공급자 (실 API 불필요)
npm run compose:up     # 풀 스택 (app + PostgreSQL + Redis + 루프백 ingress)
npm run compose:down   # named volume 은 남는다 (원장 보존)
```

실 KIS 개인용 시세(single_owner) 부팅 환경과 게스트 공개 소스 플래그는
[docs/release/setup.md](docs/release/setup.md) 에 있다. **비밀은 `.env.local` 에만, 코드·로그·
문서에는 절대 노출하지 않는다.**

---

## 프로젝트 상태 (정직한 로드맵)

2026-07-22 피벗 이후의 실행 단위다. 정본 계획은
[피벗 메모](docs/notes/2026-07-22-pivot-backtest-strategy-engine.md) §6.

| 단계 | 내용 | 상태 |
|---|---|---|
| **Stage 0–1** | 체크포인트 + 죽은 코드 절단 (workspace·dev 페이지·AI·F9 브로커·Alpaca) | ✅ |
| **Stage 2** | Postgres 영속화(paper 원장·마이그레이션 0005/0006) · notification-center 삭제 · actual-portfolio 축소 | ✅ |
| **Stage 2-c** | 원장 minor-unit 정수 전환 · money-conservation property 를 PG 러너로 | ✅ |
| **T8** | 백테스트 엔진 — 시간축 커서(look-ahead 차단) · 증권거래세 · TWR·XIRR·MDD·승률·체결신뢰도 | ✅ |
| **T9** | gross vs net + tax drag 공시 (coverage 유니언 — 총액 불신 시 블록 전체 unavailable). 무세 재실행이 아니라 세금을 terminal value 에 되더하는 **1차 근사**이고, 절약분 재투자는 가정하지 않는다 | ✅ |
| **T10** | 전략 정의 층 + 오퍼레이션 카탈로그 + CLI + MCP + `SKILL.md` | 🔶 종료 판정 대기 |
| **Stage 3** | 웹·인증 컷 (identity·provider-connections·terminal-view·auth 라우트) | ⬜ |
| **T11** | 실시간 모의투자 — 같은 엔진에 실시간 피드 + 주문 confirm token(티켓 40) | ⬜ |
| **T12** | 호가 수집기 — 돌린 시점부터 정밀 체결 모드 데이터가 쌓인다 | ⬜ |

다음 순서는 **아직 정하지 않았다** — T10 종료 판정 뒤 정식 티켓(42~)이냐 Stage 3(웹 컷)이냐가
열려 있다. v1 의 완결 조건은 기능 목록이 아니라 **공개 + 배포**다(피벗 메모 §3).

**피벗 이전(F0–F11)의 결과**: 남은 것은 체결 엔진·회계 계산·KIS/공개 소스 어댑터·영속성 seam·
불변식 property/mutation·CI parity 다. 알림·실계좌 동기화·브로커 전송·AI 트랙은 삭제됐다.
F11 릴리스 통합은 웹 ZIP 패키징 전제라 **Stage 3 에서 npm publish 체제로 재정의할지 결정**한다.

**아직 없는 것 (과대 서술 금지)**: 호가단위 라운딩·상하한가·VI 는 미구현이다 — 구현된 한국 규칙은
증권거래세(연도별·ETF 면제·2020 이전 fail-closed)와 KRX 휴장일·세션 판정이다. 해외주식 시세 경로는
조사만 확정(피벗 메모 §4)했고 어댑터는 없다. 휴장일 커버 연도는 2026 뿐이고 임시공휴일은 미포함이다.

---

## 면책

- 초기 산출물은 실제 브로커로 **Live Trading 주문을 전송하지 않는다**.
- 이 프로젝트는 학습·연구 목적이며, 어떤 화면·수치도 **투자자문이 아니다**.
- 외부 데이터는 각 공급자의 라이선스가 허용하는 범위에서만 사용한다.

---

## 라이선스

**이 저장소의 코드**는 MIT — [LICENSE](LICENSE).

**외부 시장 데이터는 별개다.** 코드 라이선스가 데이터 재사용 권리를 주지 않는다. 공급자마다
조건이 다르고(미 재무부 public domain · ECB 출처 표기 조건부 · KIS 개인 키 데이터는 재배포 금지),
그 경계는 코드로 강제된다 — 위 [두 데이터 트랙](#두-데이터-트랙--재배포-경계-웹-층) 절과
[docs/release/rights.md](docs/release/rights.md) 를 볼 것.
