import { describe, expect, it } from "vitest";

import type { BacktestSeries } from "../src/modules/paper-trading/backtest/backtest-runner";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { compileStrategy, STRATEGY_CATALOG } from "../src/modules/paper-trading/backtest/strategy-catalog";
import type { StrategyContext } from "../src/modules/paper-trading/backtest/strategy-catalog";

/**
 * T10 S1 slice regression (progress/t10-strategy-cli-mcp.md).
 *
 * The load-bearing tests are the two "silently empty run" traps recorded in the
 * progress doc: a built-in that sizes at the raw close never fills (slippage
 * headroom), and a built-in that submits DAY never fills on a daily series
 * (expiry precedes the first fillable observation). Both fail as ZERO fills and
 * a green report, so they are asserted on fillCount end-to-end through the real
 * runner rather than on the emitted action shape.
 *
 * Blind acceptance authorship is a separate agent at the tier-top gate.
 */

const T = (day: number) => `2026-01-${String(day).padStart(2, "0")}T06:30:00.000Z`;

const CONTEXT: StrategyContext = { currency: "KRW", instrument: "instr:BT" };

function series(...closes: readonly number[]): BacktestSeries {
  return {
    instrument: "instr:BT",
    venue: "KRX",
    currency: "KRW",
    bars: closes.map((close, index) => ({ periodStart: T(5 + index), close, volume: 1_000_000, complete: true })),
  };
}

function compiled(name: string, params?: unknown) {
  const outcome = compileStrategy({ name, params }, CONTEXT);
  if (outcome.status !== "compiled") throw new Error(`expected compiled, got ${outcome.reason}: ${outcome.message}`);
  return outcome;
}

async function report(name: string, params: unknown, bars: BacktestSeries, seed = 1_000_000) {
  const outcome = await runBacktest({
    runId: "t10",
    seedCash: [{ amount: seed, currency: "KRW" }],
    series: bars,
    strategy: compiled(name, params).strategy,
  });
  if (outcome.status !== "complete") throw new Error(`refused: ${outcome.reason}`);
  return outcome;
}

describe("T10 S1 — declarative strategy catalog", () => {
  it("buy_and_hold at cashFraction 1 actually fills (slippage-headroom sizing)", async () => {
    // The trap: floor(1,000,000 / 10,000) = 100 shares costs 1,000,600 at the
    // simulation-v1 buy price and #covered skips the WHOLE allocation, so a
    // naive built-in reports 0 fills with no error. Ceiling sizing → 99.
    const outcome = await report("buy_and_hold", {}, series(10_000, 10_000, 10_000));
    expect(outcome.fillCount).toBeGreaterThan(0);
    expect(outcome.positions[0]?.quantity).toBe(99);
    expect(outcome.expiryCount).toBe(0);
    expect(outcome.refusals).toEqual([]);
  });

  it("built-ins submit GTC, so a daily series fills instead of expiring", async () => {
    // A DAY order accepted at bar N's close is expired by bar N+1 (different
    // UTC day) BEFORE it can fill — the whole run would be expiries.
    const outcome = await report("buy_and_hold", {}, series(10_000, 10_000, 10_000, 10_000));
    expect(outcome.expiryCount).toBe(0);
    expect(outcome.fillCount).toBe(1);
  });

  it("cashFraction scales the entry and defaults to the full balance", async () => {
    const half = await report("buy_and_hold", { cashFraction: 0.5 }, series(10_000, 10_000, 10_000));
    expect(half.positions[0]?.quantity).toBe(49);
    expect(compiled("buy_and_hold").params).toEqual({ cashFraction: 1 });
  });

  it("sma_cross enters on the golden cross and goes flat on the death cross", async () => {
    // Down, then up (crosses fast above slow), then down again (crosses back).
    const closes = [
      100, 98, 96, 94, 92, 90, 88, 86,
      95, 110, 130, 150, 170, 190,
      150, 120, 90, 70, 50, 40, 35, 30,
    ];
    const outcome = await report("sma_cross", { fast: 3, slow: 6 }, series(...closes), 100_000);
    expect(outcome.fillCount).toBeGreaterThanOrEqual(2);
    // Round-tripped: the exit sold everything the entry bought.
    expect(outcome.positions.find((row) => String(row.instrument) === CONTEXT.instrument)?.quantity ?? 0).toBe(0);
    expect(outcome.refusals).toEqual([]);
  });

  it("sma_cross stays out while the slow window is incomplete (no look-ahead RangeError)", async () => {
    // A window reaching before bar 0 would throw inside the runner; a window
    // reaching past the cursor is the engine's look-ahead guard. Neither fires.
    const outcome = await report("sma_cross", { fast: 2, slow: 5 }, series(10, 20, 30, 40, 50, 60), 100_000);
    expect(outcome.barCount).toBe(6);
  });

  it("is deterministic: same spec and series → byte-identical report", async () => {
    const run = () => report("sma_cross", { fast: 2, slow: 4 }, series(10, 12, 14, 11, 9, 8, 13, 18, 22), 50_000);
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("refuses an unknown strategy by name, listing what it knows", () => {
    const outcome = compileStrategy({ name: "moon_phase" }, CONTEXT);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("unknown_strategy");
    expect(outcome.message).toContain("buy_and_hold");
  });

  it.each([
    ["fast not below slow", "sma_cross", { fast: 20, slow: 5 }],
    ["non-integer window", "sma_cross", { fast: 1.5, slow: 5 }],
    ["cashFraction above 1", "buy_and_hold", { cashFraction: 1.5 }],
    ["cashFraction at 0", "buy_and_hold", { cashFraction: 0 }],
    ["unknown parameter key", "buy_and_hold", { cashFractoin: 0.5 }],
  ])("refuses invalid params: %s", (_label, name, params) => {
    const outcome = compileStrategy({ name, params }, CONTEXT);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("invalid_params");
  });

  it("exposes a parameter schema for every catalog entry (describe surface)", () => {
    expect(STRATEGY_CATALOG.length).toBeGreaterThan(0);
    for (const definition of STRATEGY_CATALOG) {
      expect(definition.summary.length).toBeGreaterThan(0);
      expect(definition.paramsSchema.safeParse({ nope: 1 }).success).toBe(false);
    }
  });
});
