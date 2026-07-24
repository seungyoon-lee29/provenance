import { describe, expect, it } from "vitest";

import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { winRate } from "../src/modules/paper-trading/backtest/performance-report";

/**
 * BLIND acceptance gate for T8 S4b — win rate over sell fills.
 *
 * Every expected number below is derived independently from the finance
 * definitions handed to the test author (NOT from reading performance-report.ts
 * or backtest-runner.ts). A mismatch between a derived value and the code's
 * actual output is a FINDING, not a bug in this file — assertions are never
 * loosened to make them pass.
 *
 * Simulation-v1 fill policy used throughout (restated from the published contract):
 *   slippageBps = min(25, 5 + 20 * cumulativeParticipation)
 *   cumulativeParticipation = running sum of (filled qty / bar volume) over
 *     every fill in the run so far, INCLUDING the fill being priced.
 *   buy fill price  = ceil(close * (1 + bps/10000))   [adverse: buy up]
 *   sell fill price = floor(close * (1 - bps/10000))  [adverse: sell down]
 *   (an order accepted at bar N's close can only fill at bar N+1)
 *
 * S4b realized-P&L-per-sell-fill contract:
 *   gross    = round(qty * price * scale), KRW scale = 1 (integers -> no-op)
 *   tax      = equity+KRW only: floor(gross * 20 / 10000); sells only
 *   relief   = round(costBasisMinor * sellQty / positionQty);
 *              a full liquidation relieves the entire remaining basis exactly
 *   realized = gross - tax - relief
 *   win iff realized > 0 (strict; break-even is not a win)
 */

// ---- independent helpers (finance definitions given in the task, not code) ----

function slippageBps(cumulativeParticipation: number): number {
  return Math.min(25, 5 + 20 * cumulativeParticipation);
}

function fillPriceBuy(close: number, cumulativeParticipation: number): number {
  return Math.ceil(close * (1 + slippageBps(cumulativeParticipation) / 10000));
}

function fillPriceSell(close: number, cumulativeParticipation: number): number {
  return Math.floor(close * (1 - slippageBps(cumulativeParticipation) / 10000));
}

function sellTax(gross: number, taxed: boolean): number {
  return taxed ? Math.floor((gross * 20) / 10000) : 0;
}

function relief(costBasisMinor: number, sellQty: number, positionQty: number): number {
  return sellQty === positionQty ? costBasisMinor : Math.round((costBasisMinor * sellQty) / positionQty);
}

// Sanity-check the fill-price helper against the documented example
// (buy 10 @ close 10,000, volume 100,000, first fill in the run -> cumulative
// participation = 10/100,000 = 0.0001 -> 10,006). Confirms transcription only.
it("[self-check] fillPriceBuy helper reproduces the documented example", () => {
  expect(fillPriceBuy(10000, 10 / 100000)).toBe(10006);
});

describe("winRate — pure function (S4b)", () => {
  it("counts strictly-positive samples as wins; break-even (0) is not a win", () => {
    // sells: 100 (win), -50 (loss), 0 (break-even, NOT a win) -> wins=1, sells=3
    const result = winRate([100, -50, 0]);
    expect(result.status).toBe("covered");
    if (result.status !== "covered") return;
    expect(result.sells).toBe(3);
    expect(result.wins).toBe(1);
    expect(result.ratio).toBeCloseTo(1 / 3, 12);
  });

  it("single break-even sample -> covered, 0 wins, ratio 0 (not a win, not unavailable)", () => {
    const result = winRate([0]);
    expect(result.status).toBe("covered");
    if (result.status !== "covered") return;
    expect(result.sells).toBe(1);
    expect(result.wins).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("all-loss sample -> covered, ratio 0", () => {
    const result = winRate([-10, -20, -5]);
    expect(result.status).toBe("covered");
    if (result.status !== "covered") return;
    expect(result.sells).toBe(3);
    expect(result.wins).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("all-win sample -> covered, ratio 1", () => {
    const result = winRate([1, 2, 3]);
    expect(result.status).toBe("covered");
    if (result.status !== "covered") return;
    expect(result.sells).toBe(3);
    expect(result.wins).toBe(3);
    expect(result.ratio).toBe(1);
  });

  it("mixed sample -> ratio arithmetic wins/sells", () => {
    // wins: 10, 20 (>0); losses/break-even: -5, -1, 0 -> wins=2, sells=5, ratio=0.4
    const result = winRate([10, -5, 20, -1, 0]);
    expect(result.status).toBe("covered");
    if (result.status !== "covered") return;
    expect(result.sells).toBe(5);
    expect(result.wins).toBe(2);
    expect(result.ratio).toBeCloseTo(0.4, 12);
  });

  it("empty sample -> unavailable/no_sells (buy-and-hold has no win rate, not a fabricated 0%)", () => {
    const result = winRate([]);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toBe("no_sells");
  });

  it("non-finite sample (NaN) -> unavailable/invalid_sample", () => {
    const result = winRate([100, NaN, -50]);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toBe("invalid_sample");
  });

  it("non-finite sample (+Infinity) -> unavailable/invalid_sample", () => {
    const result = winRate([Infinity]);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toBe("invalid_sample");
  });

  it("non-finite sample (-Infinity) -> unavailable/invalid_sample", () => {
    const result = winRate([100, -Infinity]);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toBe("invalid_sample");
  });
});

describe("S4b end-to-end via runBacktest — performance.winRate", () => {
  it("(A) profitable round trip -> sells:1 wins:1 ratio:1 (untaxed)", async () => {
    const bars = [
      { periodStart: "2026-01-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true }, // bar0: accept buy
      { periodStart: "2026-01-02T00:00:00.000Z", close: 10000, volume: 100000, complete: true }, // bar1: fill buy, accept sell
      { periodStart: "2026-01-03T00:00:00.000Z", close: 12000, volume: 100000, complete: true }, // bar2: fill sell
    ];

    const result = await runBacktest({
      runId: "t8-s4b-blind-a",
      seedCash: [{ amount: 1_000_000, currency: "KRW" }],
      series: { instrument: "instr:S4B-A", venue: "KRX", currency: "KRW", bars },
      strategy: (view: { cursor: number }) => {
        if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
        if (view.cursor === 1) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
        return [];
      },
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // --- independent derivation ---
    // buy: qty 10 fills @ bar1 (close 10,000, vol 100,000). First fill in the
    // run -> cumulative participation = 10/100,000 = 0.0001.
    const buyPrice = fillPriceBuy(10000, 10 / 100000); // 10,006 (matches self-check)
    const costBasis = 10 * buyPrice; // 100,060

    // sell: qty 10 fills @ bar2 (close 12,000, vol 100,000). Second fill in the
    // run -> cumulative participation = 0.0001 (buy) + 10/100,000 (sell) = 0.0002.
    const sellCum = 10 / 100000 + 10 / 100000;
    const sellPrice = fillPriceSell(12000, sellCum); // floor(12000*(1-5.004/10000)) = 11,993
    const gross = 10 * sellPrice; // 119,930
    const tax = sellTax(gross, false); // untaxed
    const rel = relief(costBasis, 10, 10); // full liquidation -> 100,060 exactly
    const realized = gross - tax - rel; // 119,930 - 100,060 = 19,870 (> 0 -> win)

    expect(buyPrice).toBe(10006);
    expect(sellPrice).toBe(11993);
    expect(realized).toBe(19870);
    expect(realized).toBeGreaterThan(0);

    expect(result.performance.winRate).toEqual({ status: "covered", sells: 1, wins: 1, ratio: 1 });
  });

  it("(B) losing round trip -> sells:1 wins:0 ratio:0 (untaxed)", async () => {
    const bars = [
      { periodStart: "2026-01-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true },
      { periodStart: "2026-01-02T00:00:00.000Z", close: 10000, volume: 100000, complete: true },
      { periodStart: "2026-01-03T00:00:00.000Z", close: 9000, volume: 100000, complete: true },
    ];

    const result = await runBacktest({
      runId: "t8-s4b-blind-b",
      seedCash: [{ amount: 1_000_000, currency: "KRW" }],
      series: { instrument: "instr:S4B-B", venue: "KRX", currency: "KRW", bars },
      strategy: (view: { cursor: number }) => {
        if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
        if (view.cursor === 1) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } }];
        return [];
      },
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // --- independent derivation ---
    const buyPrice = fillPriceBuy(10000, 10 / 100000); // 10,006
    const costBasis = 10 * buyPrice; // 100,060

    const sellCum = 10 / 100000 + 10 / 100000; // 0.0002
    const sellPrice = fillPriceSell(9000, sellCum); // floor(9000*(1-5.004/10000)) = 8,995
    const gross = 10 * sellPrice; // 89,950
    const tax = sellTax(gross, false);
    const rel = relief(costBasis, 10, 10); // 100,060
    const realized = gross - tax - rel; // 89,950 - 100,060 = -10,110 (< 0 -> loss)

    expect(sellPrice).toBe(8995);
    expect(realized).toBe(-10110);
    expect(realized).toBeLessThan(0);

    expect(result.performance.winRate).toEqual({ status: "covered", sells: 1, wins: 0, ratio: 0 });
  });

  it("(C) taxed sell flips a marginal gross profit into a net loss", async () => {
    const bars = [
      { periodStart: "2026-01-01T00:00:00.000Z", close: 10000, volume: 200000, complete: true },
      { periodStart: "2026-01-02T00:00:00.000Z", close: 10000, volume: 200000, complete: true },
      { periodStart: "2026-01-03T00:00:00.000Z", close: 10016, volume: 200000, complete: true },
    ];

    const result = await runBacktest({
      runId: "t8-s4b-blind-c",
      seedCash: [{ amount: 2_000_000, currency: "KRW" }],
      series: { instrument: "instr:S4B-C", venue: "KRX", currency: "KRW", taxClass: "equity", bars },
      strategy: (view: { cursor: number }) => {
        if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 100, timeInForce: "GTC" } }];
        if (view.cursor === 1) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 100, timeInForce: "GTC" } }];
        return [];
      },
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // --- independent derivation ---
    // buy: qty 100 @ bar1 (close 10,000, vol 200,000). cumulative = 100/200,000 = 0.0005.
    const buyPrice = fillPriceBuy(10000, 100 / 200000); // ceil(10000*1.000501) = 10,006
    const costBasis = 100 * buyPrice; // 1,000,600

    // sell: qty 100 @ bar2 (close 10,016, vol 200,000). cumulative = 0.0005 + 0.0005 = 0.001.
    const sellCum = 100 / 200000 + 100 / 200000;
    const sellPrice = fillPriceSell(10016, sellCum); // floor(10016*(1-5.02/10000)) = 10,010
    const gross = 100 * sellPrice; // 1,001,000
    const tax = sellTax(gross, true); // floor(1,001,000 * 20/10000) = 2,002
    const rel = relief(costBasis, 100, 100); // full liquidation -> 1,000,600 exactly
    const preTax = gross - rel; // 1,001,000 - 1,000,600 = 400 (marginal gross profit)
    const realized = gross - tax - rel; // 1,001,000 - 2,002 - 1,000,600 = -1,602

    expect(buyPrice).toBe(10006);
    expect(sellPrice).toBe(10010);
    expect(gross).toBeGreaterThan(rel); // gross > relief: pre-tax profit exists
    expect(preTax).toBe(400);
    expect(tax).toBe(2002);
    expect(gross - tax).toBeLessThan(rel); // gross - tax < relief: tax flips it to a loss
    expect(realized).toBe(-1602);

    expect(result.performance.winRate).toEqual({ status: "covered", sells: 1, wins: 0, ratio: 0 });
  });

  it("(D) buy-and-hold, no sell fills -> unavailable/no_sells", async () => {
    const bars = [
      { periodStart: "2026-02-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true },
      { periodStart: "2026-02-02T00:00:00.000Z", close: 11000, volume: 100000, complete: true },
    ];

    const result = await runBacktest({
      runId: "t8-s4b-blind-d",
      seedCash: [{ amount: 500_000, currency: "KRW" }],
      series: { instrument: "instr:S4B-D", venue: "KRX", currency: "KRW", bars },
      strategy: (view: { cursor: number }) =>
        view.cursor === 0 ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 5, timeInForce: "GTC" } }] : [],
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // no sell fills occurred -> realizedSellsMinor is empty -> no_sells (not a fabricated 0%)
    expect(result.performance.winRate).toEqual({ status: "unavailable", reason: "no_sells" });
  });

  it("(E) partial sells in two parts -> sells:2, derived win/loss split (ratio 0.5)", async () => {
    const bars = [
      { periodStart: "2026-03-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true }, // bar0: accept buy
      { periodStart: "2026-03-02T00:00:00.000Z", close: 10000, volume: 100000, complete: true }, // bar1: fill buy, accept sell1
      { periodStart: "2026-03-03T00:00:00.000Z", close: 11000, volume: 100000, complete: true }, // bar2: fill sell1, accept sell2
      { periodStart: "2026-03-04T00:00:00.000Z", close: 9000, volume: 100000, complete: true }, // bar3: fill sell2
    ];

    const result = await runBacktest({
      runId: "t8-s4b-blind-e",
      seedCash: [{ amount: 1_000_000, currency: "KRW" }],
      series: { instrument: "instr:S4B-E", venue: "KRX", currency: "KRW", bars },
      strategy: (view: { cursor: number }) => {
        if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 20, timeInForce: "GTC" } }];
        if (view.cursor === 1) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 8, timeInForce: "GTC" } }];
        if (view.cursor === 2) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 12, timeInForce: "GTC" } }];
        return [];
      },
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // --- independent derivation ---
    // buy: qty 20 @ bar1 (close 10,000, vol 100,000). cumulative = 20/100,000 = 0.0002.
    const buyPrice = fillPriceBuy(10000, 20 / 100000); // 10,006
    const costBasis = 20 * buyPrice; // 200,120

    // sell1: qty 8 @ bar2 (close 11,000, vol 100,000). cumulative = 0.0002 + 8/100,000 = 0.00028.
    const sell1Cum = 20 / 100000 + 8 / 100000;
    const sell1Price = fillPriceSell(11000, sell1Cum); // floor(11000*(1-5.0056/10000)) = 10,994
    const gross1 = 8 * sell1Price; // 87,952
    const relief1 = relief(costBasis, 8, 20); // round(200,120 * 8/20) = 80,048 exactly
    const realized1 = gross1 - relief1; // 87,952 - 80,048 = 7,904 (> 0 -> win)

    const remainingQty = 20 - 8; // 12
    const remainingBasis = costBasis - relief1; // 200,120 - 80,048 = 120,072

    // sell2: qty 12 (remainder) @ bar3 (close 9,000, vol 100,000).
    // cumulative = 0.00028 + 12/100,000 = 0.0004.
    const sell2Cum = sell1Cum + 12 / 100000;
    const sell2Price = fillPriceSell(9000, sell2Cum); // floor(9000*(1-5.008/10000)) = 8,995
    const gross2 = 12 * sell2Price; // 107,940
    const relief2 = relief(remainingBasis, 12, remainingQty); // full liquidation -> 120,072 exactly
    const realized2 = gross2 - relief2; // 107,940 - 120,072 = -12,132 (< 0 -> loss)

    expect(sell1Price).toBe(10994);
    expect(relief1).toBe(80048);
    expect(realized1).toBe(7904);
    expect(sell2Price).toBe(8995);
    expect(relief2).toBe(120072);
    expect(realized2).toBe(-12132);

    expect(result.performance.winRate).toEqual({ status: "covered", sells: 2, wins: 1, ratio: 0.5 });
  });
});
