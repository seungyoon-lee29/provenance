import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSeries, StrategyAction } from "../src/modules/paper-trading/backtest/backtest-runner";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";

/**
 * T8 S1 acceptance (progress/t8-backtest-engine.md):
 * determinism, structural look-ahead refusal, no same-bar fill (close-accept /
 * next-bar-fill), honest DAY expiry on daily bars, fail-closed input
 * validation, refusals as recorded facts. Fill-price literals follow the
 * f8 convention of pinning simulation-v1 arithmetic as spec constants.
 */

const T = (day: number) => `2026-01-0${day}T06:30:00.000Z`;

function bars(...closes: readonly number[]): BacktestSeries {
  return {
    instrument: "instr:BT",
    venue: "KRX",
    currency: "KRW",
    bars: closes.map((close, index) => ({
      periodStart: T(5 + index),
      close,
      volume: 100_000,
      complete: true,
    })),
  };
}

const marketBuy = (quantity: number, timeInForce: "DAY" | "GTC" = "GTC"): StrategyAction => ({
  kind: "submit",
  order: { side: "buy", orderType: "market", quantity, timeInForce },
});

function config(series: BacktestSeries, strategy: BacktestConfig["strategy"]): BacktestConfig {
  return { runId: "run-1", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series, strategy };
}

const buyOnceAtBarZero: BacktestConfig["strategy"] = (view) => (view.cursor === 0 ? [marketBuy(10)] : []);

describe("T8 S1 backtest runner", () => {
  it("is deterministic: identical config → byte-identical report", async () => {
    const run = () => runBacktest(config(bars(10_000, 10_000, 10_000), buyOnceAtBarZero));
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("never fills on the acceptance bar; fills next bar at simulation-v1 slippage (literal 10,006)", async () => {
    const outcome = await runBacktest(config(bars(10_000, 10_000, 10_000), buyOnceAtBarZero));
    if (outcome.status !== "complete") throw new Error(outcome.status);
    expect(outcome.fillCount).toBe(1);
    const fill = outcome.orders[0]!.fills[0]!;
    // Accepted at bar 0's close instant — bar 0's own observation cannot fill
    // (engine strict `>`); the fill's evidence is bar 1's.
    expect(fill.evidenceReference).toBe(`backtest:instr:BT:${T(6)}`);
    // 5 bps + 20 bps × (10/100,000), adversely ceil-rounded to the KRW minor
    // unit: 10,000 × 1.0005002 → 10,006.
    expect(fill.price).toEqual({ amount: 10_006, currency: "KRW" });
    expect(outcome.cash[0]!.balance).toBe(1_000_000 - 10 * 10_006);
    expect(outcome.positions[0]!.quantity).toBe(10);
  });

  it("expires a DAY order on the next daily bar instead of filling it (honest close-accept semantics)", async () => {
    const outcome = await runBacktest(
      config(bars(10_000, 10_000), (view) => (view.cursor === 0 ? [marketBuy(10, "DAY")] : [])),
    );
    if (outcome.status !== "complete") throw new Error(outcome.status);
    expect(outcome.fillCount).toBe(0);
    expect(outcome.expiryCount).toBe(1);
    expect(outcome.orders[0]!.execution).toBe("expired");
  });

  it("structurally refuses look-ahead: probing past the cursor crashes the run", async () => {
    const probing: BacktestConfig["strategy"] = (view) => {
      view.bar(view.cursor + 1);
      return [];
    };
    await expect(runBacktest(config(bars(10_000, 10_000), probing))).rejects.toThrow(RangeError);
  });

  it("records an overspending order as a refusal fact and completes the run", async () => {
    const outcome = await runBacktest(config(bars(10_000, 10_000), (view) => (view.cursor === 0 ? [marketBuy(1_000)] : [])));
    if (outcome.status !== "complete") throw new Error(outcome.status);
    expect(outcome.fillCount).toBe(0);
    expect(outcome.refusals).toEqual([{ barIndex: 0, action: "submit", status: "insufficient_cash" }]);
  });

  it("cancels via the product seam: a far-below-market GTC limit is cancelled, never filled", async () => {
    const outcome = await runBacktest(
      config(bars(10_000, 10_000, 10_000), (view) => {
        if (view.cursor === 0) {
          return [{ kind: "submit", order: { side: "buy", orderType: "limit", limitPrice: { amount: 9_000, currency: "KRW" }, quantity: 5, timeInForce: "GTC" } } as const];
        }
        if (view.cursor === 1) {
          const open = view.orders.find((order) => order.execution === "open");
          return open === undefined ? [] : [{ kind: "cancel", order: open.order } as const];
        }
        return [];
      }),
    );
    if (outcome.status !== "complete") throw new Error(outcome.status);
    expect(outcome.fillCount).toBe(0);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.orders[0]!.cancellation).toBe("confirmed");
  });

  // ── codex adversarial gate regressions (2026-07-25) ──

  it("isolates the strategy from the ledger: mutating view.orders[].fills[] cannot corrupt money", async () => {
    const mutating: BacktestConfig["strategy"] = (view) => {
      if (view.cursor === 0) return [marketBuy(1)];
      if (view.cursor === 2 && view.orders[0]?.fills[0]) {
        (view.orders[0].fills[0] as { quantity: number }).quantity = 100;
      }
      return [];
    };
    const outcome = await runBacktest(config(bars(10_000, 10_000, 10_000), mutating));
    if (outcome.status !== "complete") throw new Error(outcome.status);
    // The fill was 1 share; the mutation attempt is confined to the strategy's clone.
    expect(outcome.positions[0]!.quantity).toBe(1);
    expect(outcome.cash[0]!.balance).toBe(1_000_000 - 1 * 10_006);
  });

  it("refuses seed cash that the integer ledger cannot hold (negative / NaN / Infinity / sub-unit)", async () => {
    for (const amount of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const outcome = await runBacktest({ runId: "r", seedCash: [{ amount, currency: "KRW" }], series: bars(10_000), strategy: () => [] });
      expect(outcome).toEqual({ status: "refused", reason: "invalid_seed_cash" });
    }
  });

  it("refuses a strategy that does not return an array (e.g. an async strategy → Promise)", async () => {
    const asyncStrategy = (async () => []) as unknown as BacktestConfig["strategy"];
    const outcome = await runBacktest(config(bars(10_000, 10_000), asyncStrategy));
    expect(outcome).toEqual({ status: "refused", reason: "invalid_strategy_result" });
  });

  it("refuses a total_return series (adjusted closes are not tradable prices) and discloses raw basis otherwise", async () => {
    const totalReturn = { ...bars(10_000, 10_000), priceBasis: "total_return" as const };
    expect(await runBacktest(config(totalReturn, () => []))).toEqual({ status: "refused", reason: "unsupported_price_basis" });

    const raw = await runBacktest(config(bars(10_000, 10_000), () => []));
    if (raw.status !== "complete") throw new Error(raw.status);
    expect(raw.priceBasis).toBe("raw");
  });

  it("fail-closed input validation: empty, incomplete, non-monotonic and unparsable-time series", async () => {
    const empty: BacktestSeries = { ...bars(), bars: [] };
    expect((await runBacktest(config(empty, () => []))).status).toBe("refused");

    const incomplete = bars(10_000, 10_000);
    const withIncomplete = { ...incomplete, bars: [incomplete.bars[0]!, { ...incomplete.bars[1]!, complete: false }] };
    expect(await runBacktest(config(withIncomplete, () => []))).toEqual({ status: "refused", reason: "incomplete_bar" });

    const backwards = { ...incomplete, bars: [incomplete.bars[1]!, incomplete.bars[0]!] };
    expect(await runBacktest(config(backwards, () => []))).toEqual({ status: "refused", reason: "non_monotonic_series" });

    const garbled = { ...incomplete, bars: [{ ...incomplete.bars[0]!, periodStart: "not-a-time" }] };
    expect(await runBacktest(config(garbled, () => []))).toEqual({ status: "refused", reason: "invalid_bar_time" });
  });
});
