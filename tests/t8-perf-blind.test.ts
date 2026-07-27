import { describe, expect, it } from "vitest";

import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { buildPerformance, fillConfidence, maxDrawdown } from "../src/modules/paper-trading/backtest/performance-report";

/**
 * BLIND acceptance gate for the T8 backtest performance report.
 *
 * Every expected number below is derived independently from the finance
 * definitions handed to the test author (NOT from reading performance-report.ts
 * or backtest-runner.ts). A mismatch between a derived value and the code's
 * actual output is a FINDING, not a bug in this file — assertions are never
 * loosened to make them pass.
 *
 * Simulation-v1 fill constant used throughout:
 *   fillPrice = ceil(bar.close * (1 + slippageBps/10000))
 *   slippageBps = min(25, 5 + 20 * (qty / fillBarVolume))
 *   (fills on the bar AFTER the acceptance bar; adverse ceil-round to KRW 1)
 */

// ---- independent helpers (finance definitions given in the task, not code) ----

function slippageBps(qty: number, volume: number): number {
  return Math.min(25, 5 + 20 * (qty / volume));
}

function fillPrice(close: number, qty: number, volume: number): number {
  return Math.ceil(close * (1 + slippageBps(qty, volume) / 10000));
}

/** peak-to-trough decline as a fraction of the running peak; 0 for <2 points or monotonic-up */
function expectedMaxDrawdown(equity: number[]): number {
  if (equity.length < 2) return 0;
  let peak = equity[0]!;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** XIRR with exactly two cashflows (seed out at `from`, terminal in at `to`), annualized on a 365-day year */
function expectedXirr(seedValue: number, finalValue: number, fromIso: string, toIso: string): number {
  const msPerYear = 365 * 24 * 3600 * 1000;
  const years = (Date.parse(toIso) - Date.parse(fromIso)) / msPerYear;
  return Math.pow(finalValue / seedValue, 1 / years) - 1;
}

// Sanity-check my own helper against the constant given in the task prompt itself
// (buy 10 @ close 10,000, volume 100,000 -> 10,006). This is not testing the
// implementation, only that I transcribed the formula correctly.
it("[self-check] fillPrice helper reproduces the documented example", () => {
  expect(fillPrice(10000, 10, 100000)).toBe(10006);
});

describe("T8 performance report — blind acceptance", () => {
  describe("(1) multi-bar buy-and-hold E2E via runBacktest", () => {
    it("matches an independently derived equity curve, TWR, XIRR, MDD, fill confidence", async () => {
      const bars = [
        { periodStart: "2026-01-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true },
        { periodStart: "2026-01-02T00:00:00.000Z", close: 10000, volume: 100000, complete: true },
        { periodStart: "2026-01-03T00:00:00.000Z", close: 10500, volume: 120000, complete: true },
        { periodStart: "2026-01-04T00:00:00.000Z", close: 11000, volume: 130000, complete: true },
      ];
      const seedCash = 1_000_000;

      const result = await runBacktest({
        runId: "t8-blind-e2e-1",
        seedCash: [{ amount: seedCash, currency: "KRW" }],
        series: { instrument: "instr:BT", venue: "KRX", currency: "KRW", bars },
        strategy: (view: { cursor: number }) =>
          view.cursor === 0
            ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }]
            : [],
      } as never);

      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      const perf = result.performance;

      // --- independent derivation ---
      // Order accepted at bar0 (cursor 0), fills at bar1 (next bar). No fill on
      // acceptance bar per the given fill constant.
      const qty = 10;
      const fillBarClose = 10000; // bar1.close
      const fillBarVolume = 100000; // bar1.volume
      const price = fillPrice(fillBarClose, qty, fillBarVolume); // 10,006
      const cashAfterFill = seedCash - qty * price; // 1,000,000 - 100,060 = 899,940

      const seedValue = seedCash; // value at bar0: no position yet
      const equity = [
        seedCash, // bar0
        cashAfterFill + qty * 10000, // bar1: 899,940 + 100,000 = 999,940
        cashAfterFill + qty * 10500, // bar2: 899,940 + 105,000 = 1,004,940
        cashAfterFill + qty * 11000, // bar3: 899,940 + 110,000 = 1,009,940
      ];
      const finalValue = equity[equity.length - 1]!;
      const twrRatio = finalValue / seedValue - 1;
      const mdd = expectedMaxDrawdown(equity);
      const xirr = expectedXirr(seedValue, finalValue, bars[0]!.periodStart, bars[3]!.periodStart);
      const participation = qty / fillBarVolume; // 10/100,000 = 0.0001

      expect(seedValue).toBe(1_000_000);
      expect(finalValue).toBe(1_009_940);
      expect(mdd).toBeCloseTo(0.00006, 10);

      expect(perf.currency).toBe("KRW");
      // boundary values are coverage-typed (adversarial re-gate 2026-07-25) —
      // interface adaptation, the asserted numbers are unchanged.
      expect(perf.seedValue).toEqual({ status: "covered", value: seedValue });
      expect(perf.finalValue).toEqual({ status: "covered", value: finalValue });
      // maxDrawdown became coverage-typed (2026-07-27) — interface adaptation,
      // the independently derived number is unchanged.
      expect(perf.maxDrawdown).toMatchObject({ status: "covered", ratio: expect.closeTo(mdd, 9) });

      expect(perf.timeWeightedReturn.status).toBe("covered");
      if (perf.timeWeightedReturn.status === "covered") {
        expect(perf.timeWeightedReturn.ratio).toBeCloseTo(twrRatio, 9);
      }

      expect(perf.moneyWeightedReturn.status).toBe("covered");
      if (perf.moneyWeightedReturn.status === "covered") {
        expect(perf.moneyWeightedReturn.ratio).toBeCloseTo(xirr, 4);
      }

      expect(perf.fillConfidence.fills).toBe(1);
      expect(perf.fillConfidence.maxParticipation).toBeCloseTo(participation, 9);
      expect(perf.fillConfidence.meanParticipation).toBeCloseTo(participation, 9);
    });
  });

  describe("(2) single-bar series — coverage honesty", () => {
    it("runBacktest: a 1-bar series cannot honestly produce TWR/XIRR", async () => {
      const bars = [{ periodStart: "2026-02-01T00:00:00.000Z", close: 5000, volume: 10000, complete: true }];
      const seedCash = 200_000;

      const result = await runBacktest({
        runId: "t8-blind-single-bar",
        seedCash: [{ amount: seedCash, currency: "KRW" }],
        series: { instrument: "instr:BT", venue: "KRX", currency: "KRW", bars },
        strategy: () => [],
      } as never);

      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      const perf = result.performance;

      expect(perf.seedValue).toEqual({ status: "covered", value: seedCash });
      expect(perf.finalValue).toEqual({ status: "covered", value: seedCash });
      // <2 equity points. The blind author recorded the observed value (0) here;
      // that 0 was the fabrication this contract change removes — a single-bar
      // run has no measurable drawdown, so it now says so (2026-07-27).
      expect(perf.maxDrawdown).toEqual({ status: "unavailable", reason: "insufficient_curve" });
      expect(perf.timeWeightedReturn.status).toBe("unavailable");
      expect(perf.moneyWeightedReturn.status).toBe("unavailable");
      expect(perf.fillConfidence.fills).toBe(0);
    });

    it("buildPerformance: a zero-width [from,to] window cannot honestly produce TWR/XIRR", () => {
      const perf = buildPerformance({
        currency: "KRW",
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
        seedValue: 200_000,
        finalValue: 200_000,
        equity: [200_000],
        participations: [],
        // S4b interface adaptation only (assertions untouched): the input
        // gained a required realized-sells field after this file was authored.
        realizedSellsMinor: [],
        taxPaidValue: 0,
      } as never);

      expect(perf.timeWeightedReturn.status).toBe("unavailable");
      expect(perf.moneyWeightedReturn.status).toBe("unavailable");
      expect(perf.maxDrawdown).toEqual({ status: "unavailable", reason: "insufficient_curve" });
      expect(perf.fillConfidence.fills).toBe(0);
    });
  });

  describe("(3) no-trade flat series", () => {
    it("runBacktest: flat closes, strategy never trades -> TWR ratio 0, MDD 0, no fills", async () => {
      const bars = [
        { periodStart: "2026-03-01T00:00:00.000Z", close: 8000, volume: 50000, complete: true },
        { periodStart: "2026-03-02T00:00:00.000Z", close: 8000, volume: 50000, complete: true },
        { periodStart: "2026-03-03T00:00:00.000Z", close: 8000, volume: 50000, complete: true },
        { periodStart: "2026-03-04T00:00:00.000Z", close: 8000, volume: 50000, complete: true },
      ];
      const seedCash = 300_000;

      const result = await runBacktest({
        runId: "t8-blind-flat",
        seedCash: [{ amount: seedCash, currency: "KRW" }],
        series: { instrument: "instr:BT", venue: "KRX", currency: "KRW", bars },
        strategy: () => [],
      } as never);

      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      const perf = result.performance;

      expect(perf.seedValue).toEqual({ status: "covered", value: seedCash });
      expect(perf.finalValue).toEqual({ status: "covered", value: seedCash });
      // Four flat marks ARE a measurable curve — a covered 0, not an unavailable.
      expect(perf.maxDrawdown).toEqual({ status: "covered", ratio: 0 });

      expect(perf.timeWeightedReturn.status).toBe("covered");
      if (perf.timeWeightedReturn.status === "covered") {
        expect(perf.timeWeightedReturn.ratio).toBe(0);
      }
      // finalValue === seedValue -> XIRR ratio is 0 regardless of the annualization window
      expect(perf.moneyWeightedReturn.status).toBe("covered");
      if (perf.moneyWeightedReturn.status === "covered") {
        expect(perf.moneyWeightedReturn.ratio).toBeCloseTo(0, 9);
      }

      expect(perf.fillConfidence.fills).toBe(0);
      expect(perf.fillConfidence.maxParticipation).toBe(0);
      expect(perf.fillConfidence.meanParticipation).toBe(0);
    });
  });

  describe("(4a) maxDrawdown — pure function", () => {
    it("degenerate series (<2 points) -> unmeasurable, not 0", () => {
      expect(maxDrawdown([])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
      expect(maxDrawdown([100])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
    });

    it("monotonic up -> covered 0", () => {
      expect(maxDrawdown([100, 110, 120, 130])).toEqual({ status: "covered", ratio: 0 });
    });

    it("monotonic down -> largest decline off the initial peak", () => {
      // peak stays 100 throughout; worst trough is 80 -> (100-80)/100
      expect(maxDrawdown([100, 90, 80])).toMatchObject({ status: "covered", ratio: expect.closeTo(0.2, 9) });
    });

    it("drawdown then recovery then a second, smaller drawdown", () => {
      // peak=100 -> trough=50: dd 0.5 (the max)
      // new peak=120 -> trough=72: dd 0.4 (smaller, must not overwrite the max)
      expect(maxDrawdown([100, 50, 90, 120, 72])).toMatchObject({ status: "covered", ratio: expect.closeTo(0.5, 9) });
    });
  });

  describe("(4b) fillConfidence — pure function", () => {
    it("computes fills / max / mean participation over samples", () => {
      const result = fillConfidence([0.1, 0.05, 0.2]);
      expect(result.fills).toBe(3);
      expect(result.maxParticipation).toBeCloseTo(0.2, 9);
      expect(result.meanParticipation).toBeCloseTo((0.1 + 0.05 + 0.2) / 3, 9);
    });

    it("empty participations -> honest zeroes, not NaN/undefined", () => {
      const result = fillConfidence([]);
      expect(result.fills).toBe(0);
      expect(result.maxParticipation).toBe(0);
      expect(result.meanParticipation).toBe(0);
    });
  });
});
