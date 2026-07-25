/**
 * T8 BLIND gate — S1 (backtest-runner) + S2 (CLI commands).
 *
 * Written WITHOUT reading backtest-runner.ts / commands.ts / main.ts /
 * paper-trading/internal/* / the implementer's own t8-*.test.ts files.
 * Only the interface contract + behavioral SPEC handed to the blind author,
 * plus docs/notes/2026-07-22-pivot-backtest-strategy-engine.md (design doc,
 * not implementation) were consulted. Fixtures are built inline; CLI
 * file-loading fixtures are written to tests/fixtures/t8-blind/ in beforeAll.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runBacktest,
  type BacktestBar,
  type BacktestConfig,
  type BacktestSeries,
  type BacktestStrategy,
} from "../src/modules/paper-trading/backtest/backtest-runner";
import {
  paperAccountCommand,
  paperOpenCommand,
  runBacktestCommand,
  STRATEGY_MODULE_FLAG,
} from "../src/cli/commands";

// ---------------------------------------------------------------------------
// small inline fixture helpers (no shared fixtures/t8/* reuse per gate rules)
// ---------------------------------------------------------------------------

function bar(periodStart: string, close: number, volume: number, complete = true): BacktestBar {
  return { periodStart, close, volume, complete };
}

function series(bars: readonly BacktestBar[], overrides?: Partial<BacktestSeries>): BacktestSeries {
  return {
    instrument: "instr:BLIND",
    venue: "KRX",
    currency: "KRW",
    bars,
    ...overrides,
  };
}

function krw(amount: number): { amount: number; currency: string } {
  return { amount, currency: "KRW" };
}

const noop: BacktestStrategy = () => [];

// ---------------------------------------------------------------------------
// S1 — backtest-runner
// ---------------------------------------------------------------------------

describe("S1 backtest-runner (blind)", () => {
  it("1. DETERMINISM: identical config run twice is byte-identical JSON", async () => {
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 3, timeInForce: "GTC" } }]
        : [];
    const config: BacktestConfig = {
      runId: "blind-determinism",
      seedCash: [krw(500_000)],
      series: series([
        bar("2026-04-01T00:00:00.000Z", 10_000, 500),
        bar("2026-04-02T00:00:00.000Z", 10_000, 500),
        bar("2026-04-03T00:00:00.000Z", 10_000, 500),
      ]),
      strategy,
    };

    const first = await runBacktest(config);
    const second = await runBacktest(config);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("2. INPUT FAIL-CLOSED: each malformed input yields its typed refusal reason", async () => {
    const validBars = [bar("2026-05-01T00:00:00.000Z", 10_000, 100), bar("2026-05-02T00:00:00.000Z", 10_000, 100)];

    const emptySeries = await runBacktest({
      runId: "blind-fail-empty",
      seedCash: [krw(1000)],
      series: series([]),
      strategy: noop,
    });
    expect(emptySeries).toMatchObject({ status: "refused", reason: "empty_series" });

    const incompleteBar = await runBacktest({
      runId: "blind-fail-incomplete",
      seedCash: [krw(1000)],
      series: series([bar("2026-05-01T00:00:00.000Z", 10_000, 100, false)]),
      strategy: noop,
    });
    expect(incompleteBar).toMatchObject({ status: "refused", reason: "incomplete_bar" });

    const invalidTime = await runBacktest({
      runId: "blind-fail-time",
      seedCash: [krw(1000)],
      series: series([bar("not-a-date", 10_000, 100)]),
      strategy: noop,
    });
    expect(invalidTime).toMatchObject({ status: "refused", reason: "invalid_bar_time" });

    const nonMonotonic = await runBacktest({
      runId: "blind-fail-monotonic",
      seedCash: [krw(1000)],
      series: series([
        bar("2026-05-02T00:00:00.000Z", 10_000, 100),
        bar("2026-05-01T00:00:00.000Z", 10_000, 100),
      ]),
      strategy: noop,
    });
    expect(nonMonotonic).toMatchObject({ status: "refused", reason: "non_monotonic_series" });

    const noSeedCash = await runBacktest({
      runId: "blind-fail-cash",
      seedCash: [],
      series: series(validBars),
      strategy: noop,
    });
    expect(noSeedCash).toMatchObject({ status: "refused", reason: "no_seed_cash" });
  });

  it("3. LOOK-AHEAD (structural): view.bar(i) for i>cursor, negative, or non-integer rejects with RangeError", async () => {
    const twoBars = [bar("2026-06-01T00:00:00.000Z", 10_000, 100), bar("2026-06-02T00:00:00.000Z", 10_000, 100)];
    const base = { runId: "blind-lookahead", seedCash: [krw(100_000)], series: series(twoBars) };

    const ahead: BacktestStrategy = (view) => {
      view.bar(view.cursor + 1); // physically exists in `bars`, but is ahead of cursor
      return [];
    };
    const negative: BacktestStrategy = (view) => {
      view.bar(-1);
      return [];
    };
    const fractional: BacktestStrategy = (view) => {
      view.bar(0.5);
      return [];
    };

    await expect(runBacktest({ ...base, strategy: ahead })).rejects.toThrow(RangeError);
    await expect(runBacktest({ ...base, strategy: negative })).rejects.toThrow(RangeError);
    await expect(runBacktest({ ...base, strategy: fractional })).rejects.toThrow(RangeError);
  });

  it("4. LOOK-AHEAD (fills): a fill's evidence never points at its own acceptance bar", async () => {
    const barN = bar("2026-07-01T00:00:00.000Z", 10_000, 500);
    const barN1 = bar("2026-07-02T00:00:00.000Z", 10_000, 500);
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 1, timeInForce: "GTC" } }]
        : [];

    const outcome = await runBacktest({
      runId: "blind-lookahead-fill",
      seedCash: [krw(100_000)],
      series: series([barN, barN1]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    const [order] = outcome.orders;
    expect(order?.fills.length).toBeGreaterThan(0);
    for (const fill of order?.fills ?? []) {
      expect(fill.evidenceReference).toContain(barN1.periodStart);
      expect(fill.evidenceReference).not.toContain(barN.periodStart);
    }
  });

  it("5. DAY semantics: a DAY market order accepted at bar N expires at bar N+1 without filling", async () => {
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 1, timeInForce: "DAY" } }]
        : [];

    const outcome = await runBacktest({
      runId: "blind-day-expiry",
      seedCash: [krw(100_000)],
      series: series([
        bar("2026-08-01T00:00:00.000Z", 10_000, 500),
        bar("2026-08-02T00:00:00.000Z", 10_000, 500),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    expect(outcome.expiryCount).toBe(1);
    expect(outcome.fillCount).toBe(0);
    expect(outcome.orders[0]?.execution).toBe("expired");
  });

  it("6. SIMULATION-V1 pricing: exact adverse-slippage, minor-unit-rounded fill price for a buy and a sell", async () => {
    // volume=100 -> cap floor(0.10*100)=10, single order per bar so participation=10/100=0.1
    // exactly -> slippage = min(25, 5+20*0.1) = 7bps.
    // buy:  9999 * 1.0007 = 10005.9993 -> round UP (adverse) -> 10006
    // sell: 9999 * 0.9993 = 9992.0007  -> round DOWN (adverse) -> 9992
    const strategy: BacktestStrategy = (view) => {
      if (view.cursor === 0) {
        return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
      }
      if (view.cursor === 2) {
        return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
      }
      return [];
    };

    const outcome = await runBacktest({
      runId: "blind-pricing",
      seedCash: [krw(1_000_000)],
      series: series([
        bar("2026-09-01T00:00:00.000Z", 9_999, 100),
        bar("2026-09-02T00:00:00.000Z", 9_999, 100),
        bar("2026-09-03T00:00:00.000Z", 9_999, 100),
        bar("2026-09-04T00:00:00.000Z", 9_999, 100),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    const buyOrder = outcome.orders.find((o) => o.payload.side === "buy");
    const sellOrder = outcome.orders.find((o) => o.payload.side === "sell");
    expect(buyOrder?.fills[0]?.price.amount).toBe(10_006);
    expect(sellOrder?.fills[0]?.price.amount).toBe(9_992);
  });

  it("7. MONEY CONSERVATION: seed - final balance equals fill notional buys minus sells (integers), reserved 0 at end", async () => {
    const strategy: BacktestStrategy = (view) => {
      if (view.cursor === 0) {
        return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
      }
      if (view.cursor === 2) {
        return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
      }
      return [];
    };

    const seed = 1_000_000;
    const outcome = await runBacktest({
      runId: "blind-money-conservation",
      seedCash: [krw(seed)],
      series: series([
        bar("2026-10-01T00:00:00.000Z", 9_999, 100),
        bar("2026-10-02T00:00:00.000Z", 9_999, 100),
        bar("2026-10-03T00:00:00.000Z", 9_999, 100),
        bar("2026-10-04T00:00:00.000Z", 9_999, 100),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");

    let buyNotional = 0;
    let sellNotional = 0;
    for (const order of outcome.orders) {
      for (const fill of order.fills) {
        const notional = fill.quantity * fill.price.amount;
        if (order.payload.side === "buy") buyNotional += notional;
        else sellNotional += notional;
      }
    }

    const finalCash = outcome.cash.find((c) => c.currency === "KRW");
    expect(finalCash).toBeDefined();
    expect(seed - (finalCash?.balance ?? Number.NaN)).toBe(buyNotional - sellNotional);
    expect(finalCash?.reserved).toBe(0);
  });

  it("8. VOLUME CAP: an order over 10% of bar volume fills at most floor(0.10*volume) per subsequent bar, accumulating", async () => {
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 25, timeInForce: "GTC" } }]
        : [];

    const outcome = await runBacktest({
      runId: "blind-volume-cap",
      seedCash: [krw(1_000_000)],
      series: series([
        bar("2026-11-01T00:00:00.000Z", 10_000, 100),
        bar("2026-11-02T00:00:00.000Z", 10_000, 100),
        bar("2026-11-03T00:00:00.000Z", 10_000, 100),
        bar("2026-11-04T00:00:00.000Z", 10_000, 100),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    const order = outcome.orders[0];
    expect(order?.filledQuantity).toBe(25);
    expect(order?.fills.length).toBeGreaterThanOrEqual(3); // 10 + 10 + 5 at cap 10/bar
    for (const fill of order?.fills ?? []) {
      expect(fill.quantity).toBeLessThanOrEqual(10);
    }
    expect(order?.fills.reduce((sum, f) => sum + f.quantity, 0)).toBe(25);
  });

  it("9. REFUSALS ARE FACTS: an overspending buy yields no fill and a recorded insufficient_cash refusal", async () => {
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 1_000_000, timeInForce: "GTC" } }]
        : [];

    const outcome = await runBacktest({
      runId: "blind-refusal",
      seedCash: [krw(100)],
      series: series([
        bar("2026-12-01T00:00:00.000Z", 10_000, 1000),
        bar("2026-12-02T00:00:00.000Z", 10_000, 1000),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    expect(outcome.fillCount).toBe(0);
    expect(outcome.refusals).toEqual([{ barIndex: 0, action: "submit", status: "insufficient_cash" }]);
  });

  it("10. LIMIT GUARD: a buy limit below execution price never fills; a permissive limit never fills above its own price", async () => {
    const strategy: BacktestStrategy = (view) =>
      view.cursor === 0
        ? [
            {
              kind: "submit",
              order: {
                side: "buy",
                orderType: "limit",
                limitPrice: krw(9_000), // far below expected ~10,006 execution price -> must never fill
                quantity: 7,
                timeInForce: "GTC",
              },
            },
            {
              kind: "submit",
              order: {
                side: "buy",
                orderType: "limit",
                limitPrice: krw(20_000), // far above expected execution price -> should fill
                quantity: 5,
                timeInForce: "GTC",
              },
            },
          ]
        : [];

    const outcome = await runBacktest({
      runId: "blind-limit-guard",
      seedCash: [krw(500_000)],
      series: series([
        bar("2027-01-01T00:00:00.000Z", 10_000, 200),
        bar("2027-01-02T00:00:00.000Z", 10_000, 200),
      ]),
      strategy,
    });

    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    const blocked = outcome.orders.find((o) => o.payload.quantity === 7);
    const permitted = outcome.orders.find((o) => o.payload.quantity === 5);

    expect(blocked?.filledQuantity).toBe(0);
    expect(blocked?.fills.length).toBe(0);

    expect(permitted?.fills.length).toBeGreaterThan(0);
    for (const fill of permitted?.fills ?? []) {
      expect(fill.price.amount).toBeLessThanOrEqual(20_000);
    }
  });
});

// ---------------------------------------------------------------------------
// S2 — CLI commands
// ---------------------------------------------------------------------------

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/t8-blind/", import.meta.url));
const VALID_SERIES_PATH = `${FIXTURES_DIR}valid-series.json`;
const EMPTY_SERIES_PATH = `${FIXTURES_DIR}empty-series.json`;
const MALFORMED_SERIES_PATH = `${FIXTURES_DIR}malformed-shape.json`;
const VALID_STRATEGY_PATH = `${FIXTURES_DIR}valid-strategy.ts`;
const NO_FUNCTION_STRATEGY_PATH = `${FIXTURES_DIR}no-function-strategy.ts`;
const NONEXISTENT_SERIES_PATH = `${FIXTURES_DIR}does-not-exist.json`;

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  writeFileSync(
    VALID_SERIES_PATH,
    JSON.stringify({
      instrument: "instr:BLIND-CLI",
      venue: "KRX",
      currency: "KRW",
      bars: [
        { periodStart: "2027-02-01T00:00:00.000Z", close: 10_000, volume: 100, complete: true },
        { periodStart: "2027-02-02T00:00:00.000Z", close: 10_000, volume: 100, complete: true },
      ],
    }),
  );

  writeFileSync(
    EMPTY_SERIES_PATH,
    JSON.stringify({ instrument: "instr:BLIND-CLI-EMPTY", venue: "KRX", currency: "KRW", bars: [] }),
  );

  writeFileSync(MALFORMED_SERIES_PATH, JSON.stringify({ foo: "bar", not: "a series" }));

  writeFileSync(VALID_STRATEGY_PATH, "export default function strategy() {\n  return [];\n}\n");

  // Non-function default export (loader must reject). Named const form keeps
  // the generated fixture lint-clean (import/no-anonymous-default-export).
  writeFileSync(NO_FUNCTION_STRATEGY_PATH, "const notAStrategy = 42;\nexport default notAStrategy;\n");
});

describe("S2 CLI commands (blind)", () => {
  // Post-gate interface adaptation (T10 S2, runtime-identical): the module
  // strategy path these blind cases drive is now opt-in behind
  // BACKTEST_STRATEGY_MODULE_ENABLED. No assertion below is changed.
  beforeAll(() => {
    process.env[STRATEGY_MODULE_FLAG] = "true";
  });
  afterAll(() => {
    delete process.env[STRATEGY_MODULE_FLAG];
  });

  it("11. ENVELOPE UNIFORMITY: success/refused/api all share the documented shape and exit-code mapping", async () => {
    const ok = await runBacktestCommand({ series: VALID_SERIES_PATH, strategyModule: VALID_STRATEGY_PATH, cash: 100_000 });
    expect(ok.envelope.ok).toBe(true);
    if (ok.envelope.ok) {
      expect(ok.envelope).toHaveProperty("command");
      expect(ok.envelope).toHaveProperty("result");
    }
    expect(ok.exitCode).toBe(0);

    const refused = await runBacktestCommand({
      series: EMPTY_SERIES_PATH,
      strategyModule: VALID_STRATEGY_PATH,
      cash: 100_000,
    });
    expect(refused.envelope.ok).toBe(false);
    if (!refused.envelope.ok) {
      expect(refused.envelope.error.code).toBe("refused");
      expect(refused.envelope).toHaveProperty("command");
      expect(refused.envelope.error).toHaveProperty("message");
    }
    expect(refused.exitCode).toBe(1);

    // Type-level repair only (post-gate maintenance, runtime-identical): the
    // blind contract described deps.pool as `unknown`; the real signature is
    // `Pool`, so the stub needs the same cast the repo's own tests use.
    const poisonedPool = {
      connect: () => Promise.reject(new Error("nope")),
      query: () => Promise.reject(new Error("nope")),
    } as unknown as Pool;
    const api = await paperOpenCommand({ seed: 1000, currency: "KRW" }, { pool: poisonedPool });
    expect(api.envelope.ok).toBe(false);
    if (!api.envelope.ok) {
      expect(api.envelope.error.code).toBe("api");
    }
    expect(api.exitCode).toBe(2);
  });

  it("12. Series/strategy file loading: nonexistent path, wrong JSON shape, and a strategy exporting no function all yield usage/1", async () => {
    const nonexistent = await runBacktestCommand({
      series: NONEXISTENT_SERIES_PATH,
      strategyModule: VALID_STRATEGY_PATH,
      cash: 100_000,
    });
    expect(nonexistent.exitCode).toBe(1);
    expect(nonexistent.envelope.ok).toBe(false);
    if (!nonexistent.envelope.ok) expect(nonexistent.envelope.error.code).toBe("usage");

    const malformed = await runBacktestCommand({
      series: MALFORMED_SERIES_PATH,
      strategyModule: VALID_STRATEGY_PATH,
      cash: 100_000,
    });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.envelope.ok).toBe(false);
    if (!malformed.envelope.ok) expect(malformed.envelope.error.code).toBe("usage");

    const noFunctionStrategy = await runBacktestCommand({
      series: VALID_SERIES_PATH,
      strategyModule: NO_FUNCTION_STRATEGY_PATH,
      cash: 100_000,
    });
    expect(noFunctionStrategy.exitCode).toBe(1);
    expect(noFunctionStrategy.envelope.ok).toBe(false);
    if (!noFunctionStrategy.envelope.ok) expect(noFunctionStrategy.envelope.error.code).toBe("usage");
  });

  it("13. paper open/account: poisoned pool never unhandled-rejects (api/2); usage guards never touch the pool", async () => {
    // Type-level repair only (post-gate maintenance, runtime-identical): the
    // blind contract described deps.pool as `unknown`; the real signature is
    // `Pool`, so the stub needs the same cast the repo's own tests use.
    const poisonedPool = {
      connect: () => Promise.reject(new Error("nope")),
      query: () => Promise.reject(new Error("nope")),
    } as unknown as Pool;

    const openApi = await paperOpenCommand({ seed: 1000, currency: "KRW" }, { pool: poisonedPool });
    expect(openApi.exitCode).toBe(2);
    expect(openApi.envelope.ok).toBe(false);
    if (!openApi.envelope.ok) expect(openApi.envelope.error.code).toBe("api");

    const accountApi = await paperAccountCommand({ pool: poisonedPool });
    expect(accountApi.exitCode).toBe(2);
    expect(accountApi.envelope.ok).toBe(false);
    if (!accountApi.envelope.ok) expect(accountApi.envelope.error.code).toBe("api");

    let touchedForBadSeed = false;
    const flagPoolBadSeed = {
      connect: () => {
        touchedForBadSeed = true;
        return Promise.resolve({});
      },
      query: () => {
        touchedForBadSeed = true;
        return Promise.resolve({});
      },
    } as unknown as Pool;
    const badSeed = await paperOpenCommand({ seed: -1, currency: "KRW" }, { pool: flagPoolBadSeed });
    expect(badSeed.exitCode).toBe(1);
    expect(badSeed.envelope.ok).toBe(false);
    if (!badSeed.envelope.ok) expect(badSeed.envelope.error.code).toBe("usage");
    expect(touchedForBadSeed).toBe(false);

    let touchedForBadCurrency = false;
    const flagPoolBadCurrency = {
      connect: () => {
        touchedForBadCurrency = true;
        return Promise.resolve({});
      },
      query: () => {
        touchedForBadCurrency = true;
        return Promise.resolve({});
      },
    } as unknown as Pool;
    const badCurrency = await paperOpenCommand({ seed: 1000, currency: "EUR" }, { pool: flagPoolBadCurrency });
    expect(badCurrency.exitCode).toBe(1);
    expect(badCurrency.envelope.ok).toBe(false);
    if (!badCurrency.envelope.ok) expect(badCurrency.envelope.error.code).toBe("usage");
    expect(touchedForBadCurrency).toBe(false);
  });
});
