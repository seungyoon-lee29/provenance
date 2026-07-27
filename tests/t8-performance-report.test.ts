import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSeries, StrategyAction } from "../src/modules/paper-trading/backtest/backtest-runner";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { buildPerformance, fillConfidence, maxDrawdown, winRate } from "../src/modules/paper-trading/backtest/performance-report";
import { brandReference } from "../src/shared/contracts/brands";
import type { InternalPaperAccountReference } from "../src/shared/contracts/brands";
import { MemoryPaperJournalStore, PaperJournal } from "../src/modules/paper-trading/internal/journal";

/**
 * T8 S4a/S4b acceptance (progress/t8-backtest-engine.md): the performance block
 * is a READ-ONLY aggregation — TWR/XIRR closed forms, MDD and fill confidence
 * are pure functions, and every figure stays coverage-typed (uncomputable ⇒
 * unavailable, never a fabricated 0%). Win rate (S4b) reads the fold's per-sell
 * realized P&L (net of tax, average-cost relief) — computed IN the fold, so no
 * position-sequencing mirror exists to drift.
 */

const T = (day: number) => `2026-01-0${day}T06:30:00.000Z`;

function series(...closes: readonly number[]): BacktestSeries {
  return {
    instrument: "instr:BT",
    venue: "KRX",
    currency: "KRW",
    bars: closes.map((close, index) => ({ periodStart: T(5 + index), close, volume: 100_000, complete: true })),
  };
}

const buyOnce: BacktestConfig["strategy"] = (view) =>
  view.cursor === 0 ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction] : [];

function config(s: BacktestSeries, strategy: BacktestConfig["strategy"]): BacktestConfig {
  return { runId: "perf", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series: s, strategy };
}

describe("T8 S4 performance report — pure functions", () => {
  it("maxDrawdown: peak-to-trough ratio, and `unavailable` for a curve it cannot measure", () => {
    expect(maxDrawdown([100, 120, 90, 110])).toEqual({ status: "covered", ratio: 0.25 }); // (120−90)/120
    expect(maxDrawdown([100, 110, 130])).toEqual({ status: "covered", ratio: 0 }); // monotonic up — a MEASURED 0
    // A curve with nothing to measure is not a 0: "0% drawdown" reads as
    // "this strategy never lost money", which is a fabrication, not a fact.
    expect(maxDrawdown([])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
    expect(maxDrawdown([100])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
    // Deepest trough wins even after a partial recovery.
    expect(maxDrawdown([100, 50, 80, 40, 90])).toEqual({ status: "covered", ratio: 0.6 }); // (100−40)/100
  });

  it("fillConfidence: max/mean participation over fills, zero when none", () => {
    const c = fillConfidence([0.05, 0.1, 0.03]);
    expect(c).toEqual({ fills: 3, maxParticipation: 0.1, meanParticipation: (0.05 + 0.1 + 0.03) / 3 });
    expect(fillConfidence([])).toEqual({ fills: 0, maxParticipation: 0, meanParticipation: 0 });
  });

  it("TWR/XIRR reuse: a clean +21% over a non-leap 365-day window is exact", () => {
    const perf = buildPerformance({
      currency: "KRW",
      from: "2023-01-01T00:00:00.000Z",
      to: "2024-01-01T00:00:00.000Z",
      seedValue: 1_000_000,
      finalValue: 1_210_000,
      equity: [1_000_000, 800_000, 1_210_000],
      participations: [0.1],
      realizedSellsMinor: [],
      taxPaidValue: 0,
    });
    expect(perf.timeWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.21, 10) });
    expect(perf.moneyWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.21, 10) });
    expect(perf.maxDrawdown).toMatchObject({ status: "covered", ratio: expect.closeTo(0.2, 10) }); // 1.0M → 0.8M
  });

  it("stays honest on a zero-width window: TWR and XIRR are unavailable, not a fabricated 0%", () => {
    const perf = buildPerformance({
      currency: "KRW",
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-01T00:00:00.000Z",
      seedValue: 1_000_000,
      finalValue: 1_000_000,
      equity: [1_000_000],
      participations: [],
      realizedSellsMinor: [],
      taxPaidValue: 0,
    });
    expect(perf.timeWeightedReturn.status).toBe("unavailable");
    expect(perf.moneyWeightedReturn.status).toBe("unavailable");
    // The same single mark that makes the window zero-width leaves no curve to
    // measure — MDD joins the other two instead of reporting a fabricated 0%.
    expect(perf.maxDrawdown).toEqual({ status: "unavailable", reason: "insufficient_curve" });
  });
});

describe("T8 S4 performance report — end to end", () => {
  it("aggregates a buy-and-hold run: TWR from mark-to-market, MDD, participation", async () => {
    // bar0 submit buy 10; bar1 fill 10 @ 10,006 (cash 899,940); bar2 close 12,000.
    // equity = [1,000,000, 899,940+100,000, 899,940+120,000] = [1,000,000, 999,940, 1,019,940].
    const outcome = await runBacktest(config(series(10_000, 10_000, 12_000), buyOnce));
    if (outcome.status !== "complete") throw new Error(outcome.status);
    const perf = outcome.performance;

    expect(perf).toMatchObject({
      currency: "KRW",
      seedValue: { status: "covered", value: 1_000_000 },
      finalValue: { status: "covered", value: 1_019_940 },
    });
    expect(perf.timeWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.01994, 6) });
    expect(perf.moneyWeightedReturn.status).toBe("covered"); // day-count-sensitive; sign/coverage is the invariant
    if (perf.moneyWeightedReturn.status === "covered") expect(perf.moneyWeightedReturn.ratio).toBeGreaterThan(0);
    // Peak 1,000,000 → trough 999,940 → recovery. MDD = 60/1,000,000.
    expect(perf.maxDrawdown).toMatchObject({ status: "covered", ratio: expect.closeTo(0.00006, 10) });
    // One fill of 10 shares against a 100,000-volume bar.
    expect(perf.fillConfidence).toEqual({ fills: 1, maxParticipation: 0.0001, meanParticipation: 0.0001 });
    // S4b: buy-and-hold never sells — a win rate would be fabricated.
    expect(perf.winRate).toEqual({ status: "unavailable", reason: "no_sells" });
  });

  it("is included deterministically in the byte-identical report", async () => {
    const run = () => runBacktest(config(series(10_000, 10_000, 12_000), buyOnce));
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });
});

describe("T8 S4 performance report — codex adversarial gate regressions", () => {
  const year = { from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z" };

  it("a NaN valuation is unavailable, never a covered null", () => {
    const p = buildPerformance({ currency: "KRW", ...year, seedValue: Number.NaN, finalValue: 100, equity: [100], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
    expect(p.timeWeightedReturn.status).toBe("unavailable");
    expect(p.moneyWeightedReturn.status).toBe("unavailable");
  });

  it("an over-extrapolated sub-day window is XIRR-unrepresentable, not Infinity/−1", () => {
    const tiny = { from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:01:00.000Z" };
    const gain = buildPerformance({ currency: "KRW", ...tiny, seedValue: 100, finalValue: 101, equity: [100, 101], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
    const loss = buildPerformance({ currency: "KRW", ...tiny, seedValue: 100, finalValue: 99, equity: [100, 99], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
    expect(gain.moneyWeightedReturn).toEqual({ status: "unavailable", reason: "unrepresentable" });
    expect(loss.moneyWeightedReturn).toEqual({ status: "unavailable", reason: "unrepresentable" });
  });

  it("a total loss is a covered −100% TWR but leaves XIRR without a root", () => {
    const p = buildPerformance({ currency: "KRW", ...year, seedValue: 100, finalValue: 0, equity: [100, 0], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
    expect(p.timeWeightedReturn).toEqual({ status: "covered", ratio: -1 });
    expect(p.moneyWeightedReturn.status).toBe("unavailable");
  });

  it("fillConfidence skips a non-finite sample instead of poisoning the mean", () => {
    expect(fillConfidence([Number.NaN, 0.1])).toEqual({ fills: 1, maxParticipation: 0.1, meanParticipation: 0.1 });
  });

  // Runner boundary refusals — the report never values a bad price / seed / date.
  const seriesWith = (rows: readonly { close: number; periodStart: string }[]): BacktestSeries => ({
    instrument: "instr:BT", venue: "KRX", currency: "KRW",
    bars: rows.map((row) => ({ ...row, volume: 100_000, complete: true })),
  });

  it("refuses a non-finite or non-positive close before valuing it", async () => {
    for (const bad of [-100, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bars = seriesWith([{ close: 10_000, periodStart: T(5) }, { close: bad, periodStart: T(6) }]);
      expect(await runBacktest(config(bars, () => []))).toEqual({ status: "refused", reason: "invalid_bar_price" });
    }
  });

  it("refuses seed cash in a currency the single-currency series never values", async () => {
    const bars = seriesWith([{ close: 10_000, periodStart: T(5) }, { close: 10_000, periodStart: T(6) }]);
    const outcome = await runBacktest({
      runId: "mix", seedCash: [{ amount: 1_000_000, currency: "KRW" }, { amount: 100, currency: "USD" }], series: bars, strategy: () => [],
    });
    expect(outcome).toEqual({ status: "refused", reason: "seed_currency_mismatch" });
  });

  it("refuses an impossible calendar date (JS would normalize 02-30 → 03-01)", async () => {
    const feb30 = seriesWith([
      { close: 10_000, periodStart: "2024-02-28T06:30:00.000Z" },
      { close: 10_000, periodStart: "2024-02-30T06:30:00.000Z" },
    ]);
    expect(await runBacktest(config(feb30, () => []))).toEqual({ status: "refused", reason: "invalid_bar_time" });
  });
});

describe("T8 S4b win rate — pure function", () => {
  it("counts strictly-positive realized P&L as wins; break-even is not a win", () => {
    expect(winRate([19_870, -10_110, 0])).toEqual({ status: "covered", sells: 3, wins: 1, ratio: 1 / 3 });
    expect(winRate([1])).toEqual({ status: "covered", sells: 1, wins: 1, ratio: 1 });
  });

  it("stays honest: no sells → no_sells, a non-finite sample → invalid_sample (never a biased ratio)", () => {
    expect(winRate([])).toEqual({ status: "unavailable", reason: "no_sells" });
    expect(winRate([Number.NaN, 100])).toEqual({ status: "unavailable", reason: "invalid_sample" });
    expect(winRate([Number.POSITIVE_INFINITY])).toEqual({ status: "unavailable", reason: "invalid_sample" });
  });
});

describe("T8 S4b win rate — fold realized P&L (journal)", () => {
  const WS = "ws-s4b";
  const acct = brandReference<string, "InternalPaperAccountReference">("acct-s4b") as InternalPaperAccountReference;
  const day = (d: number) => `2026-01-${String(d).padStart(2, "0")}T04:00:00.000Z`;
  const money = (amount: number, currency = "KRW") => ({ amount, currency });

  async function journalWithPosition() {
    const journal = await new PaperJournal(() => day(5), undefined, new MemoryPaperJournalStore()).init();
    await journal.provision(WS, acct, [money(1_000_000), money(1_000, "USD")]);
    const order = (n: number, side: "buy" | "sell", quantity: number, price: number, currency = "KRW") => {
      const ref = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:${n}`);
      return { ref, submit: () => journal.appendCommand(WS, acct, "submit", { idempotencyKey: `o${n}`, expectedRevision: String(journal.currentRevision(WS, acct)) }, `o${n}`,
        () => ({ entry: { kind: "order_submitted" as const, order: ref, payload: { instrument: brandReference<string, "PaperInstrumentReference">("instr:BT"), venue: "KRX", session: "regular" as const, side, orderType: "limit" as const, limitPrice: money(price, currency), quantity, timeInForce: "GTC" as const }, acceptedAt: day(5), reservation: side === "buy" ? { kind: "cash" as const, unitPrice: money(price, currency) } : { kind: "quantity" as const } }, order: ref })) };
    };
    const fill = (key: string, ref: ReturnType<typeof order>["ref"], quantity: number, price: number, taxMinor?: number, currency = "KRW") =>
      journal.appendSystem(WS, acct, key, { kind: "fill_applied", fill: { identity: brandReference<string, "PaperFillIdentity">(key), order: ref, quantity, price: money(price, currency), eventTime: day(6), receivedAt: day(6), evidenceReference: `e:${key}`, policyVersion: "simulation-v1", ...(taxMinor !== undefined ? { costs: { sellTransactionTaxMinor: taxMinor, taxPolicyVersion: "krx-tax-v1" } } : {}) } });
    return { journal, order, fill };
  }

  it("records net-of-tax realized P&L per sell fill with rounded average-cost relief; buys record nothing", async () => {
    const { journal, order, fill } = await journalWithPosition();
    // Buy 3 @ 10,001 → basis 30,003 (indivisible by 3·2 later — exercises rounding).
    const buy = order(1, "buy", 3, 10_001);
    await buy.submit();
    await fill("f-buy", buy.ref, 3, 10_001);
    expect(journal.state(WS, acct).realizedSales).toEqual([]); // buys never realize
    // Sell 2 @ 12,000 with tax 48: gross 24,000, relief round(30,003·2/3) = 20,002
    // → realized 24,000 − 48 − 20,002 = 3,950.
    const sellWin = order(2, "sell", 2, 12_000);
    await sellWin.submit();
    await fill("f-sell-1", sellWin.ref, 2, 12_000, 48);
    // Sell the last share @ 9,000 untaxed: relief = remaining basis 10,001 (full
    // liquidation returns basis to exactly 0) → realized 9,000 − 10,001 = −1,001.
    const sellLoss = order(3, "sell", 1, 9_000);
    await sellLoss.submit();
    await fill("f-sell-2", sellLoss.ref, 1, 9_000);

    const state = journal.state(WS, acct);
    expect(state.realizedSales).toEqual([
      { minorUnits: 3_950, currency: "KRW" },
      { minorUnits: -1_001, currency: "KRW" },
    ]);
    expect(state.positions.get("instr:BT")!.costBasis.minorUnits).toBe(0);
    expect(winRate(state.realizedSales.map((sale) => sale.minorUnits))).toEqual({ status: "covered", sells: 2, wins: 1, ratio: 0.5 });
  });

  it("refuses a fill whose currency differs from the position's basis — either side (codex S4b gate)", async () => {
    const { journal, order, fill } = await journalWithPosition();
    // Buy 1 @ USD 100 → basis 10,000 CENTS. A KRW 150,000 sell would subtract
    // USD cents from KRW proceeds and fabricate a covered +140,000 KRW "win".
    const usdBuy = order(1, "buy", 1, 100, "USD");
    await usdBuy.submit();
    await fill("f-usd-buy", usdBuy.ref, 1, 100, undefined, "USD");
    const krwSell = order(2, "sell", 1, 150_000, "KRW");
    await krwSell.submit();
    expect(await fill("f-krw-sell", krwSell.ref, 1, 150_000, undefined, "KRW")).toEqual({ status: "refused", reason: "invalid_fill" });
    // Buy side too: a KRW buy fill must not extend a USD basis.
    const krwBuy = order(3, "buy", 1, 10_000, "KRW");
    await krwBuy.submit();
    expect(await fill("f-krw-buy", krwBuy.ref, 1, 10_000, undefined, "KRW")).toEqual({ status: "refused", reason: "invalid_fill" });

    const state = journal.state(WS, acct);
    expect(state.realizedSales).toEqual([]); // nothing fabricated
    expect(state.positions.get("instr:BT")).toMatchObject({ quantity: 1, costBasis: { minorUnits: 10_000, currency: "USD" } });
  });
});

describe("T8 S4b win rate — end to end", () => {
  const buyThenSell: BacktestConfig["strategy"] = (view) => {
    if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction];
    if (view.cursor === 2) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction];
    return [];
  };

  it("a profitable round trip is a covered 100% win rate; a losing one is 0%", async () => {
    const win = await runBacktest(config(series(10_000, 10_000, 12_000, 12_000), buyThenSell));
    const loss = await runBacktest(config(series(10_000, 10_000, 9_000, 9_000), buyThenSell));
    if (win.status !== "complete" || loss.status !== "complete") throw new Error("refused");
    expect(win.performance.winRate).toEqual({ status: "covered", sells: 1, wins: 1, ratio: 1 });
    expect(loss.performance.winRate).toEqual({ status: "covered", sells: 1, wins: 0, ratio: 0 });
  });
});

describe("T9 tax disclosure — pure boundaries", () => {
  const year = { from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z" };
  const base = { currency: "KRW", ...year, equity: [1_000_000, 1_019_940], participations: [], realizedSellsMinor: [] };

  it("adds the tax back for gross TWR; drag is exactly taxPaid/seed", () => {
    const p = buildPerformance({ ...base, seedValue: 1_000_000, finalValue: 1_019_940, taxPaidValue: 240 });
    expect(p.tax).toMatchObject({
      status: "covered",
      taxPaid: 240,
      grossTimeWeightedReturn: { status: "covered", ratio: expect.closeTo(0.02018, 12) },
      taxDrag: { status: "covered", ratio: 240 / 1_000_000 },
    });
  });

  it("a negative or non-finite tax total refuses the WHOLE block — and never serializes NaN as null (codex gate)", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = buildPerformance({ ...base, seedValue: 1_000_000, finalValue: 1_019_940, taxPaidValue: bad });
      expect(p.tax).toEqual({ status: "unavailable", reason: "invalid_total" });
      expect(JSON.stringify(p.tax)).not.toContain("null"); // declared-type honesty in JSON
    }
  });

  it("a zero-width window leaves gross/drag unavailable but still reports the tax actually paid", () => {
    const p = buildPerformance({
      currency: "KRW", from: year.from, to: year.from, seedValue: 1_000_000, finalValue: 1_000_000,
      equity: [1_000_000], participations: [], realizedSellsMinor: [], taxPaidValue: 240,
    });
    if (p.tax.status !== "covered") throw new Error("tax block unavailable");
    expect(p.tax.taxPaid).toBe(240); // a fact of the ledger, window-independent
    expect(p.tax.grossTimeWeightedReturn.status).toBe("unavailable");
    expect(p.tax.taxDrag.status).toBe("unavailable");
  });

  it("refuses a seed whose minor units exceed the safe-integer ledger ceiling (codex gate: 1e19 passes isInteger)", async () => {
    const outcome = await runBacktest({ runId: "huge", seedCash: [{ amount: 1e19, currency: "KRW" }], series: series(10_000, 10_000), strategy: () => [] });
    expect(outcome).toEqual({ status: "refused", reason: "invalid_seed_cash" });
  });

  it("a fill whose gross leaves the exact integer domain is refused at the ledger boundary (upstream of the tax-sum guard)", async () => {
    // Safe seed; alternating 10k/20k closes. Fills land on the NEXT bar, so a
    // buy accepted at a 20k close fills at 10k (cheap) and a sell accepted at a
    // 10k close fills at 20k (dear) — 18 compounding cycles push the cumulative
    // sell tax past 2^53, where this scenario's exact sum (…959, odd) is not
    // float-representable: a Number accumulator would report …960 as covered.
    const bars = Array.from({ length: 38 }, (_, i) => ({
      periodStart: new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString(),
      close: i % 2 === 0 ? 10_000 : 20_000,
      volume: 1e15,
      complete: true,
    }));
    const churn: BacktestConfig["strategy"] = (view) => {
      const lowClose = view.cursor % 2 === 0;
      const position = view.positions[0]?.quantity ?? 0;
      if (position > 0) {
        return lowClose ? [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: position, timeInForce: "GTC" } }] : [];
      }
      const cash = view.cash[0]?.available ?? 0;
      const quantity = Math.floor(cash / 20_100);
      return !lowClose && quantity > 0 ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity, timeInForce: "GTC" } }] : [];
    };
    const outcome = await runBacktest({
      runId: "churn",
      seedCash: [{ amount: 9_000_000_000_000_000, currency: "KRW" }],
      series: { instrument: "instr:BT", venue: "KRX", currency: "KRW", taxClass: "equity", bars },
      strategy: churn,
    });
    if (outcome.status !== "complete") throw new Error(outcome.status);
    // This fixture used to demonstrate a DOWNSTREAM symptom: the compounding
    // churn produced fills whose gross was past 2^53 — so the stored product
    // was already a neighbouring integer — and the drift was only noticed once
    // the cumulative tax itself went unsafe (`invalid_total`). The ceiling is
    // now enforced on the product where it is created (contracts.isExactMinor,
    // checked at the journal's fill boundary), so the offending fill never
    // lands and the drifted state is no longer reachable through the runner.
    // Measured here: the run's last sell would have grossed ~1.99e16, 2.2× the
    // safe-integer ceiling. The downstream `invalid_total` guard keeps its own
    // standing regression at the pure level ("a negative or non-finite tax
    // total refuses the WHOLE block" above) — it is defence in depth, not dead.
    let floatSum = 0;
    let exactSum = 0n;
    let fills = 0;
    for (const order of outcome.orders) {
      for (const fill of order.fills) {
        fills += 1;
        // Every fill that LANDED carries an exactly representable product.
        expect(Number.isSafeInteger(fill.quantity * fill.price.amount)).toBe(true);
        const tax = fill.costs?.sellTransactionTaxMinor ?? 0;
        floatSum += tax;
        exactSum += BigInt(tax);
      }
    }
    // With no mis-rounded product in the book there is no drift left to report.
    expect(Number.isSafeInteger(floatSum)).toBe(true);
    expect(BigInt(floatSum)).toBe(exactSum);
    expect(outcome.performance.tax.status).toBe("covered");
    // Fail-closed, same direction as before: the order that would have needed an
    // unrepresentable fill stays OPEN rather than folding a mis-rounded one.
    expect(outcome.orders.length).toBeGreaterThan(fills);
  });
});

describe("adversarial re-gate 2026-07-25 — serialization honesty (no field → null)", () => {
  const year = { from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" };
  const base = { currency: "KRW", equity: [100], participations: [] as number[], realizedSellsMinor: [] as number[], taxPaidValue: 0 };

  it("B-A: a non-finite seed/final echoes as coverage-typed unavailable, never a null", () => {
    const nanSeed = buildPerformance({ ...base, ...year, seedValue: Number.NaN, finalValue: 100 });
    const infFinal = buildPerformance({ ...base, ...year, seedValue: 100, finalValue: Number.POSITIVE_INFINITY });
    expect(nanSeed.seedValue).toEqual({ status: "unavailable", reason: "invalid_value" });
    expect(infFinal.finalValue).toEqual({ status: "unavailable", reason: "invalid_value" });
    // The whole report serializes with no null masquerading as a declared number.
    expect(JSON.stringify(nanSeed).includes("null")).toBe(false);
    expect(JSON.stringify(infFinal).includes("null")).toBe(false);
    // A finite run stays covered with the exact value.
    const ok = buildPerformance({ ...base, ...year, seedValue: 1_000_000, finalValue: 1_100_000 });
    expect(ok.seedValue).toEqual({ status: "covered", value: 1_000_000 });
    expect(ok.finalValue).toEqual({ status: "covered", value: 1_100_000 });
  });

  it("B-B: maxDrawdown refuses a poisoned mark outright — still never a null, and no longer a silent 0", () => {
    // Supersedes the 2026-07-25 form of this gate, which asserted the mark was
    // SKIPPED and the result stayed finite. Skipping is fillConfidence's rule,
    // and it is right there because a dropped sample stays visible in its own
    // `fills` count. Drawdown is a headline ratio with no such counter, so a
    // dropped mark silently moves it — winRate's rule applies instead.
    expect(maxDrawdown([100, Number.NEGATIVE_INFINITY])).toEqual({ status: "unavailable", reason: "invalid_sample" });
    expect(maxDrawdown([100, Number.NaN, 90])).toEqual({ status: "unavailable", reason: "invalid_sample" });
    // A negative mark would push the ratio past 1 — refused rather than owed to
    // the caller (the old contract made equity ≥ 0 the caller's obligation).
    expect(maxDrawdown([100, -1])).toEqual({ status: "unavailable", reason: "invalid_sample" });
    // A finite curve is unaffected: 120 → 90 is a 25% drawdown.
    expect(maxDrawdown([100, 120, 90, 110])).toEqual({ status: "covered", ratio: 0.25 });
    // The property B-B protects is unchanged and now holds by construction.
    const poisoned = buildPerformance({ ...base, ...year, seedValue: 100, finalValue: 100, equity: [100, Number.NaN, 90] });
    expect(JSON.stringify(poisoned).includes("null")).toBe(false);
  });
});
