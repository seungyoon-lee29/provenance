import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSeries, StrategyAction } from "../src/modules/paper-trading/backtest/backtest-runner";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { brandReference } from "../src/shared/contracts/brands";
import type { InternalPaperAccountReference } from "../src/shared/contracts/brands";
import { PaperJournal, MemoryPaperJournalStore } from "../src/modules/paper-trading/internal/journal";
import { KRX_TAX_POLICY_VERSION, sellTransactionTaxMinor } from "../src/modules/paper-trading/internal/krx-transaction-tax";

/**
 * T8 S3 — Korean transaction tax on sells. The rate table itself is unit-checked
 * (krx-transaction-tax demo); here we verify it flows through the SAME fill
 * engine end-to-end (backtest), is disclosed, hits sells only, and — crucially —
 * that the journal REFUSES a forged fill whose stored tax could fabricate cash.
 */

const T = (day: number) => `2026-01-${String(day).padStart(2, "0")}T04:00:00.000Z`;

function series(taxClass: BacktestSeries["taxClass"]): BacktestSeries {
  return {
    instrument: "instr:BT",
    venue: "KRX",
    currency: "KRW",
    ...(taxClass !== undefined ? { taxClass } : {}),
    bars: [5, 6, 7, 8].map((d) => ({ periodStart: T(d), close: 10_000, volume: 1_000_000, complete: true })),
  };
}

const buyThenSell: BacktestConfig["strategy"] = (view) => {
  if (view.cursor === 0) return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction];
  if (view.cursor === 2) return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction];
  return [];
};

function run(taxClass: BacktestSeries["taxClass"]) {
  return runBacktest({ runId: "tax", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series: series(taxClass), strategy: buyThenSell });
}

describe("T8 S3 transaction tax", () => {
  it("charges 2026 equity tax (20bp) on sale proceeds, stores it on the fill, discloses the cost model", async () => {
    const taxed = await run("equity");
    const untaxed = await run(undefined);
    if (taxed.status !== "complete" || untaxed.status !== "complete") throw new Error("refused");

    const sellFill = taxed.orders.find((o) => o.payload.side === "sell")!.fills[0]!;
    const proceeds = sellFill.quantity * sellFill.price.amount; // gross, KRW scale 1
    const expectedTax = Math.floor((proceeds * 20) / 10_000);
    expect(sellFill.costs).toEqual({ sellTransactionTaxMinor: expectedTax, taxPolicyVersion: KRX_TAX_POLICY_VERSION });
    // Tax is the ONLY difference from the untaxed run.
    expect(untaxed.cash[0]!.balance - taxed.cash[0]!.balance).toBe(expectedTax);
    expect(taxed.costModel).toBe(KRX_TAX_POLICY_VERSION);
    expect(untaxed.costModel).toBe("none");
  });

  it("exempts ETF/ETN (no cost, cash equals the untaxed run)", async () => {
    const etf = await run("etf_etn");
    const untaxed = await run(undefined);
    if (etf.status !== "complete" || untaxed.status !== "complete") throw new Error("refused");
    expect(etf.orders.find((o) => o.payload.side === "sell")!.fills[0]!.costs).toBeUndefined();
    expect(etf.cash[0]!.balance).toBe(untaxed.cash[0]!.balance);
  });

  it("never taxes a buy: buy fills carry no costs", async () => {
    const taxed = await run("equity");
    if (taxed.status !== "complete") throw new Error("refused");
    expect(taxed.orders.find((o) => o.payload.side === "buy")!.fills[0]!.costs).toBeUndefined();
  });

  it("T9: taxed run's gross TWR equals the untaxed run's net TWR; drag is exactly tax/seed", async () => {
    const taxed = await run("equity");
    const untaxed = await run(undefined);
    if (taxed.status !== "complete" || untaxed.status !== "complete") throw new Error("refused");
    const sellFill = taxed.orders.find((o) => o.payload.side === "sell")!.fills[0]!;
    const expectedTax = Math.floor((sellFill.quantity * sellFill.price.amount * 20) / 10_000);
    if (taxed.performance.tax.status !== "covered") throw new Error("tax block unavailable");
    expect(taxed.performance.tax.taxPaid).toBe(expectedTax);
    // The fills are identical across the two runs (no post-sale trades), so the
    // add-back counterfactual is not an approximation here — it must equal the
    // genuinely untaxed run to the last bit.
    expect(taxed.performance.tax.grossTimeWeightedReturn).toEqual(untaxed.performance.timeWeightedReturn);
    expect(taxed.performance.tax.taxDrag).toEqual({ status: "covered", ratio: expectedTax / 1_000_000 });
    expect(untaxed.performance.tax).toEqual({
      status: "covered",
      taxPaid: 0,
      grossTimeWeightedReturn: untaxed.performance.timeWeightedReturn,
      taxDrag: { status: "covered", ratio: 0 },
    });
  });

  it("journal refuses a forged fill whose tax exceeds proceeds or is negative, or a tax on a buy", async () => {
    const store = new MemoryPaperJournalStore();
    const journal = await new PaperJournal(() => T(5), undefined, store).init();
    const ws = "ws-forge";
    const acct = brandReference<string, "InternalPaperAccountReference">("acct-forge") as InternalPaperAccountReference;
    await journal.provision(ws, acct, [{ amount: 1_000_000, currency: "KRW" }]);

    // Open a sell order to forge a fill against (seed a position first via a buy fill).
    const buy = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:1`);
    await journal.appendCommand(ws, acct, "submit", { idempotencyKey: "b", expectedRevision: "1" }, "b",
      () => ({ entry: { kind: "order_submitted", order: buy, payload: { instrument: brandReference<string, "PaperInstrumentReference">("instr:BT"), venue: "KRX", session: "regular", side: "buy", orderType: "limit", limitPrice: { amount: 10_000, currency: "KRW" }, quantity: 10, timeInForce: "GTC" }, acceptedAt: T(5), reservation: { kind: "cash", unitPrice: { amount: 10_000, currency: "KRW" } } }, order: buy }));
    await journal.appendSystem(ws, acct, "buyfill", { kind: "fill_applied", fill: { identity: brandReference<string, "PaperFillIdentity">("buyfill"), order: buy, quantity: 10, price: { amount: 10_000, currency: "KRW" }, eventTime: T(6), receivedAt: T(6), evidenceReference: "e1", policyVersion: "simulation-v1" } });

    const sell = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:3`);
    await journal.appendCommand(ws, acct, "submit", { idempotencyKey: "s", expectedRevision: "3" }, "s",
      () => ({ entry: { kind: "order_submitted", order: sell, payload: { instrument: brandReference<string, "PaperInstrumentReference">("instr:BT"), venue: "KRX", session: "regular", side: "sell", orderType: "limit", limitPrice: { amount: 9_000, currency: "KRW" }, quantity: 10, timeInForce: "GTC" }, acceptedAt: T(6), reservation: { kind: "quantity" } }, order: sell }));

    const sellFill = (tax: number, order = sell) => ({
      kind: "fill_applied" as const,
      fill: { identity: brandReference<string, "PaperFillIdentity">(`forge-${tax}-${String(order)}`), order, quantity: 10, price: { amount: 9_500, currency: "KRW" }, eventTime: T(7), receivedAt: T(7), evidenceReference: `e-${tax}`, policyVersion: "simulation-v1", costs: { sellTransactionTaxMinor: tax, taxPolicyVersion: KRX_TAX_POLICY_VERSION } },
    });

    // gross = 10 × 9,500 = 95,000. A tax above that would fabricate cash.
    expect((await journal.appendSystem(ws, acct, "over", sellFill(95_001))).status).toBe("refused");
    expect((await journal.appendSystem(ws, acct, "neg", sellFill(-1))).status).toBe("refused");
    // Tax on a BUY order is refused (Korean tax is sell-only).
    expect((await journal.appendSystem(ws, acct, "onbuy", sellFill(1, buy))).status).toBe("refused");
    // A legitimate tax within proceeds is accepted.
    expect((await journal.appendSystem(ws, acct, "ok", sellFill(190))).status).toBe("applied");
  });

  it("rate table matches the module for a 1,000,000-won sale across EVERY verified tax-year tier", () => {
    const at = (year: number) => sellTransactionTaxMinor(1_000_000, "equity", `${year}-06-01T04:00:00.000Z`);
    expect([at(2020), at(2021), at(2022), at(2023), at(2024), at(2025), at(2026)]).toEqual([2_500, 2_300, 2_300, 2_000, 1_800, 1_500, 2_000]);
    expect(sellTransactionTaxMinor(1_000_000, "etf_etn", "2026-06-01T04:00:00.000Z")).toBe(0);
    // KST year boundary and floor (codex/blind gate).
    expect(sellTransactionTaxMinor(1_000_000, "equity", "2025-12-31T15:30:00.000Z")).toBe(2_000);
    expect(sellTransactionTaxMinor(999, "equity", "2025-06-01T04:00:00.000Z")).toBe(1);
    expect(sellTransactionTaxMinor(-1_000_000, "equity", "2026-06-01T04:00:00.000Z")).toBe(0);
  });

  // ── codex gate regressions (2026-07-25) ──

  it("journal entries are deep-frozen: a validated fill cannot be mutated after append (append-only is runtime-true)", async () => {
    const taxed = await run("equity");
    if (taxed.status !== "complete") throw new Error(taxed.status);
    const sellFill = taxed.orders.find((o) => o.payload.side === "sell")!.fills[0]!;
    expect(() => { (sellFill.costs as { sellTransactionTaxMinor: number }).sellTransactionTaxMinor = -1; }).toThrow(TypeError);
    expect(() => { (sellFill as { quantity: number }).quantity = 999; }).toThrow(TypeError);
  });

  it("fails closed on a taxClass declared for a non-KRW series (KRX tax is a KRW levy)", async () => {
    const usd: BacktestSeries = { instrument: "instr:US", venue: "NASDAQ", currency: "USD", taxClass: "equity", bars: [5, 6].map((d) => ({ periodStart: T(d), close: 100, volume: 1_000_000, complete: true })) };
    expect(await runBacktest({ runId: "x", seedCash: [{ amount: 1_000_000, currency: "USD" }], series: usd, strategy: () => [] })).toEqual({ status: "refused", reason: "tax_class_currency_mismatch" });
  });

  it("fails closed on a taxed sale in a year with no verified rate (pre-2020)", async () => {
    const old: BacktestSeries = { ...series("equity"), bars: [{ periodStart: "2019-06-01T04:00:00.000Z", close: 10_000, volume: 1_000_000, complete: true }] };
    expect(await runBacktest({ runId: "x", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series: old, strategy: () => [] })).toEqual({ status: "refused", reason: "unsupported_tax_year" });
  });

  it("rejects a timezone-less bar time (environment-dependent parsing)", async () => {
    const local: BacktestSeries = { ...series(undefined), bars: [{ periodStart: "2026-01-05T04:00:00", close: 10_000, volume: 1_000_000, complete: true }] };
    expect(await runBacktest({ runId: "x", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series: local, strategy: () => [] })).toEqual({ status: "refused", reason: "invalid_bar_time" });
  });
});
