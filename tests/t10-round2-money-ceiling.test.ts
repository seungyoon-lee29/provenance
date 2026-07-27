import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { grossMinorOf, isExactMinor, isRepresentableSeedCash } from "../src/modules/paper-trading/internal/contracts";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { PaperJournal, foldAccountState, validateSystemBody } from "../src/modules/paper-trading/internal/journal";
import type {
  PaperAccountState,
  PaperCashState,
  PaperEntryBody,
  PaperJournalEntry,
  PaperOrderState,
  PaperPositionState,
} from "../src/modules/paper-trading/internal/journal";
import type {
  PaperCorporateActionReference,
  PaperFillIdentity,
  PaperInstrumentReference,
} from "../src/modules/paper-trading/internal/contracts";
import type { InternalPaperAccountReference, PaperOrderReference } from "../src/shared/contracts/brands";

/**
 * 라운드 2 — 돈 원장의 2^53 천장을 **합**에서도 집행하는지.
 *
 * 라운드 1 은 곱(`grossMinorOf`)에만 천장을 걸었고, 그 주석은 "seed cash 와 tax sum 에는
 * 이미 걸려 있다"고 적었다. 그 주장이 거짓이었다 — seed 검사는 `backtest-runner.ts:243`,
 * 즉 다른 모듈의 다른 경로에만 있었고 원장 경로(`provision → appendSystem →
 * validateSystemBody`)의 `account_opened` 는 seed 금액을 전혀 보지 않았다.
 * codex 적대 리뷰 #1 이 같은 구멍의 나머지(배당 곱·현금 잔고 합)를 지적했다.
 *
 * 여기서 고정하는 불변식 하나: **현금 총액은 안전정수 영역을 벗어나지 않는다.**
 * 잔고가 2^53 안에 있으면 그 아래 덧셈·뺄셈이 전부 정확하므로 적립 증발도 어포더빌리티
 * fail-open 도 성립하지 않는다. 예약 합은 별도 가드가 필요 없다 — service.ts 의
 * 어포더빌리티가 `required ≤ balance - reserved` 를 강제하므로 잔고를 막으면 예약도 막힌다.
 *
 * 왜 대부분이 `validateSystemBody` 직접 호출인가: 세 가드가 전부 그 함수 안에 있고
 * 원장의 모든 쓰기가 그리로 지난다. 상태를 합성하면 2^53 근처를 fill 로 쌓아 올리지
 * 않고도 정확히 그 경계를 겨눌 수 있다. 배선(진짜 append 가 이 함수를 거치는가)은
 * 마지막 describe 가 실제 저널로 확인한다.
 *
 * 이 테스트의 저자는 구현자 본인이다(메인). 라운드 2 의 blind 축은 **충족되지 않았다** —
 * .scratch/honesty-and-gates/progress/stage-1.md 와 커밋 트레일러에 pending 으로 적는다.
 */

const CEILING = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;
const ORDER = brandReference<string, "PaperOrderReference">("paper-order:ws:1") as PaperOrderReference;
const ACTION = brandReference<string, "PaperCorporateActionReference">("action:div:1") as PaperCorporateActionReference;

function state(overrides?: {
  cash?: Record<string, PaperCashState>;
  positions?: Record<string, PaperPositionState>;
  orders?: Record<string, PaperOrderState>;
}): PaperAccountState {
  return {
    cash: new Map(Object.entries(overrides?.cash ?? {})),
    positions: new Map(Object.entries(overrides?.positions ?? {})),
    orders: new Map(Object.entries(overrides?.orders ?? {})),
    realizedSales: [],
  };
}

function openSellOrder(quantity: number): PaperOrderState {
  return {
    order: ORDER,
    payload: {
      instrument: AAPL,
      venue: "XNAS",
      session: "regular",
      side: "sell",
      orderType: "market",
      quantity,
      timeInForce: "GTC",
    },
    submission: "acknowledged",
    execution: "open",
    cancellation: "none",
    acceptedAt: "2026-07-27T00:00:00.000Z",
    reservation: { kind: "quantity" },
    filledQuantity: 0,
    fills: [],
  };
}

/** fold 에 먹일 저널 엔트리. fold 는 검증하지 않으므로 상태를 직접 조립할 수 있다. */
function entry(revision: number, body: PaperEntryBody): PaperJournalEntry {
  return {
    entryReference: brandReference<string, "PaperJournalEntryReference">(`entry:${revision}`),
    account: brandReference<string, "InternalPaperAccountReference">("paper-account:ws:1") as InternalPaperAccountReference,
    revision,
    recordedAt: "2026-07-27T00:00:00.000Z",
    ...body,
  } as PaperJournalEntry;
}

function sellFill(quantity: number, amount: number) {
  return {
    kind: "fill_applied" as const,
    fill: {
      identity: brandReference<string, "PaperFillIdentity">("fill:1") as PaperFillIdentity,
      order: ORDER,
      quantity,
      price: { amount, currency: "USD" },
      eventTime: "2026-07-27T00:01:00.000Z",
      receivedAt: "2026-07-27T00:01:01.000Z",
      evidenceReference: "evidence:1",
      policyVersion: "simulation-v1",
    },
  };
}

// ---------------------------------------------------------------------------
// 전제 확인 — 이 파일이 겨누는 경계가 실제로 거기 있는지 먼저 못 박는다.
// 픽스처가 사실은 위반이 아니었다는 함정(2026-07-27 에 음성 대조군에서 한 번 밟았다)을
// 막는다. 아래 케이스들은 전부 이 전제 위에 서 있다.
// ---------------------------------------------------------------------------

describe("전제: 2^53 밖에서 정수 산술이 실제로 깨진다", () => {
  it("천장 위의 곱은 이웃 정수로 굴러가고, 천장 위의 +1 은 증발한다", () => {
    expect(isExactMinor(CEILING)).toBe(true);
    expect(isExactMinor(CEILING + 1)).toBe(false);
    // 곱: 천장 위에서는 결과가 이웃 정수로 굴러간다. 정확한 값을 리터럴로 못 적는 것
    // 자체가 근거다 — TS 가 2^53 이상 리터럴을 거부한다(80008). 그래서 판정으로 단언한다.
    expect(isExactMinor(grossMinorOf(CEILING, { amount: 3, currency: "USD" }))).toBe(false);
    // 합: 2^53 위에서 1 을 더해도 잔고가 그대로다 = 1원이 사라진다.
    expect(2 ** 53 + 1).toBe(2 ** 53);
  });
});

// ---------------------------------------------------------------------------
// 1) account_opened — genesis 의 seed 합
// ---------------------------------------------------------------------------

describe("account_opened: seed 현금이 안전정수 영역 안에 있어야 한다", () => {
  it("통화별 합으로 본다 — 각각은 안전한데 합이 아닌 두 seed 를 거절한다", () => {
    // seed 는 major 단위로 들어와 통화 스케일(USD=100)로 환산된 뒤 합산된다.
    // 각각 천장의 1/4 이면 합이 천장의 절반 — 아직 안전하다 (양성 대조군).
    const quarter = Math.floor(CEILING / 4 / 100);
    expect(
      validateSystemBody(state(), {
        kind: "account_opened",
        seedCash: [
          { amount: quarter, currency: "USD" },
          { amount: quarter, currency: "USD" },
        ],
      }),
    ).toBe(undefined);

    expect(
      validateSystemBody(state(), {
        kind: "account_opened",
        seedCash: [
          { amount: CEILING / 100, currency: "USD" },
          { amount: CEILING / 100, currency: "USD" },
        ],
      }),
    ).toBe("invalid_seed_cash");
  });

  it("서로 다른 통화는 합산하지 않는다 — 각각 천장 아래면 통과한다", () => {
    expect(
      validateSystemBody(state(), {
        kind: "account_opened",
        seedCash: [
          { amount: CEILING / 100, currency: "USD" },
          { amount: CEILING / 100, currency: "EUR" },
        ],
      }),
    ).toBe(undefined);
  });

  it("비유한 금액은 NaN 으로 반올림돼 같은 검사에 걸린다", () => {
    for (const amount of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        validateSystemBody(state(), { kind: "account_opened", seedCash: [{ amount, currency: "USD" }] }),
      ).toBe("invalid_seed_cash");
    }
  });

  it("평범한 seed 는 통과한다 (양성 대조군)", () => {
    expect(
      validateSystemBody(state(), { kind: "account_opened", seedCash: [{ amount: 100_000, currency: "USD" }] }),
    ).toBe(undefined);
  });

  it("이미 열린 계정은 seed 검사 이전에 already_opened 로 거절된다 (순서 고정)", () => {
    expect(
      validateSystemBody(state({ cash: { USD: { balance: 1, reserved: 0 } } }), {
        kind: "account_opened",
        seedCash: [{ amount: Number.NaN, currency: "USD" }],
      }),
    ).toBe("already_opened");
  });
});

// ---------------------------------------------------------------------------
// 2) dividend_applied — 적립 곱과 그 결과 잔고
// ---------------------------------------------------------------------------

describe("dividend_applied: 적립 곱과 적립 후 잔고가 모두 정확해야 한다", () => {
  const held = (quantity: number): Record<string, PaperPositionState> => ({
    [String(AAPL)]: { quantity, reserved: 0, costBasis: { minorUnits: 1_000, currency: "USD" } },
  });
  const dividend = (perShare: number) =>
    ({ kind: "dividend_applied", action: ACTION, instrument: AAPL, perShare: { amount: perShare, currency: "USD" } }) as const;

  it("곱이 이웃 정수로 굴러가면 거절한다 (codex #1 재현)", () => {
    expect(validateSystemBody(state({ positions: held(CEILING) }), dividend(3))).toBe("invalid_adjustment");
  });

  it("곱이 정확해도 적립 후 잔고가 천장을 넘으면 거절한다", () => {
    // 곱은 100 minor(정확), 잔고는 이미 천장 — 합이 천장을 넘는다.
    const s = state({ positions: held(1), cash: { USD: { balance: CEILING, reserved: 0 } } });
    expect(validateSystemBody(s, dividend(1))).toBe("invalid_adjustment");
  });

  it("보유가 없거나 0 이면 이 가드는 개입하지 않는다 — fold 가 적립하지 않기 때문", () => {
    expect(validateSystemBody(state(), dividend(1))).toBe(undefined);
    expect(validateSystemBody(state({ positions: held(0) }), dividend(1))).toBe(undefined);
  });

  it("평범한 배당은 통과한다 (양성 대조군)", () => {
    const s = state({ positions: held(100), cash: { USD: { balance: 50_000, reserved: 0 } } });
    expect(validateSystemBody(s, dividend(1.5))).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// 3) fill_applied — 매도 체결 후 잔고
// ---------------------------------------------------------------------------

describe("fill_applied: 매도 대금이 들어간 뒤의 잔고가 정확해야 한다", () => {
  it("곱은 정확한데 잔고 합이 천장을 넘는 매도를 거절한다", () => {
    const s = state({
      orders: { [String(ORDER)]: openSellOrder(1) },
      cash: { USD: { balance: CEILING, reserved: 0 } },
      positions: { [String(AAPL)]: { quantity: 10, reserved: 0, costBasis: { minorUnits: 100, currency: "USD" } } },
    });
    const fill = sellFill(1, 1); // gross = 100 minor, 정확
    expect(isExactMinor(grossMinorOf(1, { amount: 1, currency: "USD" }))).toBe(true);
    expect(validateSystemBody(s, fill)).toBe("invalid_fill");
  });

  it("잔고에 여유가 있으면 같은 체결이 통과한다 (양성 대조군)", () => {
    const s = state({
      orders: { [String(ORDER)]: openSellOrder(1) },
      cash: { USD: { balance: 50_000, reserved: 0 } },
      positions: { [String(AAPL)]: { quantity: 10, reserved: 0, costBasis: { minorUnits: 100, currency: "USD" } } },
    });
    expect(validateSystemBody(s, sellFill(1, 1))).toBe(undefined);
  });

  it("매수에는 이 가드가 없다 — 어포더빌리티가 차변을 잔고로 묶으므로 결과가 [0, balance] 안이다", () => {
    const buy: PaperOrderState = {
      ...openSellOrder(1),
      payload: { ...openSellOrder(1).payload, side: "buy" },
    };
    const s = state({
      orders: { [String(ORDER)]: buy },
      cash: { USD: { balance: CEILING, reserved: 0 } },
    });
    // 매도였다면 위 케이스처럼 invalid_fill 이었을 상태다. 매수는 이 가드를 안 지난다.
    expect(validateSystemBody(s, sellFill(1, 1))).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// 3b) 라운드 3 회귀 — 적대 리뷰가 재현한 것들 (2026-07-27)
//     이 절의 케이스는 전부 라운드 2 구현에서 **초록이었다**. 그게 이 절의 존재 이유다.
// ---------------------------------------------------------------------------

describe("라운드 3 회귀: 적대 리뷰가 재현한 결함", () => {
  it("#1 매도 대금이 fold 에 정확히 접힌다 — 세 항 결합이 현금을 소멸시키지 않는다", () => {
    // 라운드 2 는 가드와 fold 가 **둘 다** `balance + gross - tax` 를 좌→우로 계산했다.
    // `balance + gross` 가 표현 불가로 굴러간 뒤 빼면 안전영역으로 되돌아오므로
    // `isExactMinor` 는 true 를 주고 fold 는 틀린 값을 저장한다.
    //
    // 가드만 보는 테스트는 이것을 못 잡는다(라운드 2 에서도 통과가 정답이다).
    // 잡는 곳은 fold 다 — 그래서 여기서는 `foldAccountState` 의 저장값을 단언한다.
    expect(Number.isSafeInteger((CEILING + 2) - 2)).toBe(true); // 전제: 굴러도 safe 로 보인다
    expect((CEILING + 2) - 2).toBe(CEILING - 1); // 전제: 그런데 1 이 사라진다
    expect(CEILING + (2 - 2)).toBe(CEILING); // net-first 는 정확하다

    const entries = [
      entry(1, { kind: "account_opened", seedCash: [{ amount: CEILING, currency: "KRW" }] }),
      entry(2, {
        kind: "order_submitted",
        order: ORDER,
        payload: { ...openSellOrder(2).payload, limitPrice: { amount: 1, currency: "KRW" } },
        acceptedAt: "2026-07-27T00:00:00.000Z",
        reservation: { kind: "quantity" },
      }),
      entry(3, {
        kind: "fill_applied",
        fill: {
          ...sellFill(2, 1).fill,
          price: { amount: 1, currency: "KRW" },
          costs: { sellTransactionTaxMinor: 2, taxPolicyVersion: "krx-v1" },
        },
      }),
    ];
    const folded = foldAccountState(entries);
    // gross 2 − 세금 2 = 0 이므로 잔고는 seed 그대로여야 한다. 라운드 2 는 CEILING-1 을 저장했다.
    expect(folded.cash.get("KRW")?.balance).toBe(CEILING);

    // 그리고 가드는 이것을 거절하지 않는다 — 정확한 결과가 표현 가능하므로 과잉 거절도 결함이다.
    const s = state({
      orders: { [String(ORDER)]: { ...openSellOrder(2), payload: { ...openSellOrder(2).payload, limitPrice: { amount: 1, currency: "KRW" } } } },
      cash: { KRW: { balance: CEILING, reserved: 0 } },
      positions: { [String(AAPL)]: { quantity: 10, reserved: 0, costBasis: { minorUnits: 10, currency: "KRW" } } },
    });
    const guarded = {
      kind: "fill_applied" as const,
      fill: { ...sellFill(2, 1).fill, price: { amount: 1, currency: "KRW" }, costs: { sellTransactionTaxMinor: 2, taxPolicyVersion: "krx-v1" } },
    };
    expect(validateSystemBody(s, guarded)).toBe(undefined);
  });

  it("#4 genesis 가 음수·단위미만 seed 를 거절한다 — 인용한 선례와 같은 강도로", () => {
    for (const seed of [
      { amount: -1_000_000, currency: "USD" }, // 라운드 2: ACCEPTED, 잔고 -100000000
      { amount: 0.005, currency: "USD" }, // 라운드 2: ACCEPTED, 1 로 반올림돼 들어옴
      { amount: 0.5, currency: "KRW" }, // 반 원
      { amount: 0, currency: "USD" },
    ]) {
      expect(validateSystemBody(state(), { kind: "account_opened", seedCash: [seed] }), JSON.stringify(seed)).toBe(
        "invalid_seed_cash",
      );
    }
  });

  it("#4 그러면서 센트에서 나온 평범한 seed 는 통과한다 (과잉 거절 회귀)", () => {
    // `fromMinorUnits(1003,"USD")` = 10.03 이고 `10.03*100` 은 1002.9999999999999 다.
    // 강한 형태(`isSafeInteger(amount*scale)`)를 그대로 쓰면 이게 거절된다 — 돈 보존
    // property 테스트가 즉시 잡았다. 왕복 술어는 통과시킨다.
    for (const amount of [10.03, 0.01, 1234.56]) {
      expect(validateSystemBody(state(), { kind: "account_opened", seedCash: [{ amount, currency: "USD" }] }), String(amount)).toBe(
        undefined,
      );
    }
  });

  it("#7 ±Infinity 는 NaN 이 아니라 안전정수 검사에서 걸린다 (기전 고정)", () => {
    expect(Math.round(Number.POSITIVE_INFINITY * 100)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(Math.round(Number.POSITIVE_INFINITY * 100))).toBe(false);
    expect(
      validateSystemBody(state(), { kind: "account_opened", seedCash: [{ amount: Number.POSITIVE_INFINITY, currency: "USD" }] }),
    ).toBe("invalid_seed_cash");
  });
});

// ---------------------------------------------------------------------------
// 3c) 라운드 5 회귀 — 통합된 술어의 빈 배열 계약
//     두 호출자가 기대가 다르다. 그 차이를 한 함수가 지고 있으므로 여기서 고정한다.
// ---------------------------------------------------------------------------

describe("라운드 5 회귀: 빈 seedCash 는 술어 수준에서 수용된다", () => {
  it("`isRepresentableSeedCash([])` 는 true — 검사할 금액이 없으면 위반도 없다", () => {
    // 라운드 4 가 항목 검사와 집계 검사를 한 함수로 합쳤는데, 그 함수의 `[]` 동작을
    // 고정하는 테스트가 **0건**이었다. 실측(라운드 5): `[]` 를 거절하도록 바꾸는 뮤턴트가
    // money 스위트 73 케이스를 전부 통과했다.
    //
    // 여기서 true 를 고정하는 이유는 **두 호출자가 기대가 다르기** 때문이다.
    // backtest 는 빈 seed 를 별도 이유(`no_seed_cash`)로 앞에서 막으므로 이 술어가
    // 그것을 대신 거절하면 진단이 뭉개진다. 원장 읽기 경로는 `seedCash: []` 로 서비스를
    // 만들고 genesis 를 하지 않으므로 여기서 거절되면 안 된다.
    // (`[]` 로 실제 genesis 가 가능한 것은 별개의 결함이며 open-findings OF-8 이다.)
    expect(isRepresentableSeedCash([])).toBe(true);
    expect(validateSystemBody(state(), { kind: "account_opened", seedCash: [] })).toBe(undefined);
  });

  it("backtest 는 빈 seed 를 이 술어가 아니라 자기 이유로 거절한다 (진단이 뭉개지지 않는다)", async () => {
    const outcome = await runBacktest({
      runId: "r",
      seedCash: [],
      series: {
        instrument: "instr:X",
        venue: "V",
        currency: "USD",
        bars: [
          { periodStart: "2026-01-01T00:00:00.000Z", close: 10, volume: 100, complete: true },
          { periodStart: "2026-01-02T00:00:00.000Z", close: 10, volume: 100, complete: true },
        ],
      },
      strategy: () => [],
    });
    expect(outcome).toEqual({ status: "refused", reason: "no_seed_cash" });
  });
});

// ---------------------------------------------------------------------------
// 4) 배선 — 진짜 저널 append 가 이 판정을 거치는가
//    (위 셋은 순수 함수 호출이다. 함수가 옳아도 아무도 안 부르면 가드가 아니다.)
// ---------------------------------------------------------------------------

describe("배선: provision 이 이 판정을 실제로 거친다", () => {
  const account = brandReference<string, "InternalPaperAccountReference">("paper-account:ws:1") as InternalPaperAccountReference;

  it("천장을 넘는 seed 로 genesis 를 시도하면 저널이 거절하고 계정이 열리지 않는다", async () => {
    const journal = new PaperJournal(() => "2026-07-27T00:00:00.000Z");
    const outcome = await journal.appendSystem("workspace:a", account, "genesis", {
      kind: "account_opened",
      seedCash: [{ amount: CEILING, currency: "USD" }],
    });
    expect(outcome).toEqual({ status: "refused", reason: "invalid_seed_cash" });
    expect(journal.ownerOf(account)).toBe(undefined);
  });

  it("평범한 seed 는 열린다 (양성 대조군 — 하네스가 무엇에나 거절하지 않는다)", async () => {
    const journal = new PaperJournal(() => "2026-07-27T00:00:00.000Z");
    await journal.provision("workspace:a", account, [{ amount: 100_000, currency: "USD" }]);
    expect(journal.ownerOf(account)).toBe("workspace:a");
  });
});
