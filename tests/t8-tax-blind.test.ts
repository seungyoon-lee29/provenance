import { describe, expect, it } from "vitest";

import {
  KRX_TAX_POLICY_VERSION,
  sellTransactionTaxMinor,
} from "../src/modules/paper-trading/internal/krx-transaction-tax";
import type { KrxTaxClass } from "../src/modules/paper-trading/internal/krx-transaction-tax";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import type { BacktestReport, BacktestSeries } from "../src/modules/paper-trading/backtest/backtest-runner";

// Blind test author: everything below is derived from the SPEC in the ticket, not from
// reading krx-transaction-tax.ts / simulator.ts / journal.ts / backtest-runner.ts / contracts.ts.

// ---- Reference rate table, built from the given domain facts (NOT copied from the impl) ----
// equity, combined KRX sell tax, by KST execution year. 1bp = 0.01%. Post-gate
// correction: codex proved the original "<=2022 = 23bp" spec wrong (2020 = 25bp,
// pre-2020 not year-keyable → unsupported/0). Table updated to the verified range.
function equityRateBp(year: number): number {
  if (year >= 2026) return 20;
  if (year === 2025) return 15;
  if (year === 2024) return 18;
  if (year === 2023) return 20;
  if (year === 2021 || year === 2022) return 23;
  if (year === 2020) return 25;
  return 0; // <=2019 unsupported — the runner refuses; the function backstops to 0
}

// Exact integer floor via BigInt so the reference calc can't drift on floats either.
function referenceTaxMinor(grossMinor: number, taxClass: KrxTaxClass, year: number): number {
  if (taxClass === "etf_etn") return 0;
  return Number((BigInt(grossMinor) * BigInt(equityRateBp(year))) / 10000n);
}

const YEAR_ISO: Array<{ iso: string; year: number }> = [
  { iso: "2020-06-15T04:00:00.000Z", year: 2020 },
  { iso: "2022-06-15T04:00:00.000Z", year: 2022 },
  { iso: "2023-06-15T04:00:00.000Z", year: 2023 },
  { iso: "2024-06-15T04:00:00.000Z", year: 2024 },
  { iso: "2025-06-15T04:00:00.000Z", year: 2025 },
  { iso: "2026-06-15T04:00:00.000Z", year: 2026 },
  { iso: "2030-06-15T04:00:00.000Z", year: 2030 }, // "2026+" is a range, not just literal 2026
];

describe("sellTransactionTaxMinor — per-year equity rate tiers (floor exercised)", () => {
  it("exact-division gross (1,000,000) matches the tier rate in every year", () => {
    for (const { iso, year } of YEAR_ISO) {
      const gross = 1_000_000;
      expect(sellTransactionTaxMinor(gross, "equity", iso)).toBe(referenceTaxMinor(gross, "equity", year));
    }
  });

  it("odd gross (1,000,003) forces the floor in every year", () => {
    for (const { iso, year } of YEAR_ISO) {
      const gross = 1_000_003;
      expect(sellTransactionTaxMinor(gross, "equity", iso)).toBe(referenceTaxMinor(gross, "equity", year));
    }
  });

  it("etf_etn is exempt (0) in every year, regardless of gross", () => {
    for (const { iso } of YEAR_ISO) {
      expect(sellTransactionTaxMinor(1_000_003, "etf_etn", iso)).toBe(0);
      expect(sellTransactionTaxMinor(999_999_999, "etf_etn", iso)).toBe(0);
    }
  });

  it("zero gross is zero tax for both classes", () => {
    expect(sellTransactionTaxMinor(0, "equity", "2026-06-15T04:00:00.000Z")).toBe(0);
    expect(sellTransactionTaxMinor(0, "etf_etn", "2026-06-15T04:00:00.000Z")).toBe(0);
  });

  it("negative gross does not yield a negative tax [assumed spec: clamps to 0]", () => {
    // Sale proceeds can't be negative; a negative tax would be a cash INFLOW, which
    // contradicts "tax is a cash outflow". Conservative reading: clamp to 0.
    const tax = sellTransactionTaxMinor(-1_000_000, "equity", "2026-06-15T04:00:00.000Z");
    expect(tax).toBe(0);
  });
});

describe("KST year boundary (UTC+9) — highest-value edge", () => {
  const gross = 1_000_000;

  it("2025-12-31T15:30:00Z is 2026-01-01 KST -> 2026 rate (20bp), not 2025 (15bp)", () => {
    expect(sellTransactionTaxMinor(gross, "equity", "2025-12-31T15:30:00.000Z")).toBe(
      referenceTaxMinor(gross, "equity", 2026),
    );
  });

  it("2025-12-31T14:00:00Z is still 2025-12-31 KST -> 2025 rate (15bp)", () => {
    expect(sellTransactionTaxMinor(gross, "equity", "2025-12-31T14:00:00.000Z")).toBe(
      referenceTaxMinor(gross, "equity", 2025),
    );
  });

  it("exact KST-midnight instant (2025-12-31T15:00:00.000Z UTC) already counts as 2026", () => {
    expect(sellTransactionTaxMinor(gross, "equity", "2025-12-31T15:00:00.000Z")).toBe(
      referenceTaxMinor(gross, "equity", 2026),
    );
  });

  it("one millisecond before KST midnight is still 2025", () => {
    expect(sellTransactionTaxMinor(gross, "equity", "2025-12-31T14:59:59.999Z")).toBe(
      referenceTaxMinor(gross, "equity", 2025),
    );
  });

  it("2022/2023 rate-change boundary also respects KST", () => {
    expect(sellTransactionTaxMinor(gross, "equity", "2022-12-31T15:00:00.000Z")).toBe(
      referenceTaxMinor(gross, "equity", 2023),
    );
    expect(sellTransactionTaxMinor(gross, "equity", "2022-12-31T14:59:59.999Z")).toBe(
      referenceTaxMinor(gross, "equity", 2022),
    );
  });
});

describe("floor direction — never rounds up, always a non-negative integer", () => {
  it("333,333 @ 15bp is 499.9995 -> floors to 499, not 500", () => {
    // 333333 * 15 = 4,999,995 / 10000 = 499.9995
    expect(sellTransactionTaxMinor(333_333, "equity", "2025-06-15T04:00:00.000Z")).toBe(499);
  });

  it("333,334 @ 15bp is 500.001 -> floors to 500", () => {
    expect(sellTransactionTaxMinor(333_334, "equity", "2025-06-15T04:00:00.000Z")).toBe(500);
  });

  it("is always a non-negative integer <= gross, across magnitudes and every tier", () => {
    const grosses = [1, 7, 99, 12_345, 1_234_567, 999_999_999];
    const isos = YEAR_ISO.map((y) => y.iso);
    for (const gross of grosses) {
      for (const iso of isos) {
        const tax = sellTransactionTaxMinor(gross, "equity", iso);
        expect(Number.isInteger(tax)).toBe(true);
        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThanOrEqual(gross);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// End-to-end via runBacktest
// ---------------------------------------------------------------------------------------

function bar(periodStart: string, close: number) {
  return { periodStart, close, volume: 1_000_000, complete: true };
}

const SEED_KRW = [{ amount: 1_000_000_000, currency: "KRW" }] as const;

function series2026(taxClass?: KrxTaxClass): BacktestSeries {
  return {
    instrument: "005930",
    venue: "KRX",
    currency: "KRW",
    ...(taxClass !== undefined ? { taxClass } : {}),
    bars: [
      bar("2026-03-02T00:00:00.000Z", 20_000),
      bar("2026-03-03T00:00:00.000Z", 20_500),
      bar("2026-03-04T00:00:00.000Z", 21_000),
      bar("2026-03-05T00:00:00.000Z", 21_500),
    ],
  };
}

// NOTE (fixture, not a finding): market orders here fill at the NEXT bar (no-lookahead),
// and a "DAY" order submitted against daily bars expires before that next bar ever arrives
// (fillCount 0 in a probe) — a coherent property of daily-bar backtesting, not a tax bug.
// GTC is used throughout so fills actually happen; buy/sell decisions are kept >= 2 bars
// apart so the buy's fill (at buy_cursor+1) is settled before the sell is even decided.
const buySellStrategy = (view: { cursor: number }) => {
  if (view.cursor === 0) {
    return [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 50, timeInForce: "GTC" } }] as const;
  }
  if (view.cursor === 2) {
    return [{ kind: "submit", order: { side: "sell", orderType: "market", quantity: 50, timeInForce: "GTC" } }] as const;
  }
  return [] as const;
};

async function runOrThrow(config: Parameters<typeof runBacktest>[0]): Promise<BacktestReport> {
  const report = await runBacktest(config);
  if (report.status !== "complete") {
    throw new Error(`backtest refused: ${(report as { reason: string }).reason}`);
  }
  return report;
}

function krwCash(report: BacktestReport): { balance: number } {
  const entry = report.cash.find((c) => c.currency === "KRW");
  if (!entry) throw new Error("no KRW cash entry in report");
  return entry;
}

describe("runBacktest — taxed sell end-to-end (2026 equity, 20bp)", () => {
  it("sell fill carries the correct krx-str-v1 tax; taxed cash == untaxed cash - tax; costModel differs", async () => {
    const taxed = await runOrThrow({
      runId: "t8-blind-e2e-taxed",
      seedCash: SEED_KRW,
      series: series2026("equity"),
      strategy: buySellStrategy,
    });
    const untaxed = await runOrThrow({
      runId: "t8-blind-e2e-untaxed",
      seedCash: SEED_KRW,
      series: series2026(),
      strategy: buySellStrategy,
    });

    const sellOrder = taxed.orders.find((o) => o.payload.side === "sell");
    expect(sellOrder).toBeDefined();
    const sellFill = sellOrder!.fills[0]!;
    expect(sellFill.costs).toBeDefined();

    const expectedTax = referenceTaxMinor(sellFill.quantity * sellFill.price.amount, "equity", 2026);
    expect(sellFill.costs!.sellTransactionTaxMinor).toBe(expectedTax);
    // costs.taxClass removed post-gate (Standards: write-only field); the amount
    // + policy version are the stored record. Assertion updated, not weakened.
    expect(sellFill.costs!.taxPolicyVersion).toBe(KRX_TAX_POLICY_VERSION);
    expect(KRX_TAX_POLICY_VERSION).toBe("krx-str-v1");

    expect(taxed.costModel).toBe("krx-str-v1");
    expect(untaxed.costModel).toBe("none");

    expect(krwCash(untaxed).balance - krwCash(taxed).balance).toBe(expectedTax);
  });
});

describe("runBacktest — ETF exemption end-to-end", () => {
  it("etf_etn sell has no costs and cash matches an untaxed run exactly", async () => {
    const etf = await runOrThrow({
      runId: "t8-blind-etf",
      seedCash: SEED_KRW,
      series: series2026("etf_etn"),
      strategy: buySellStrategy,
    });
    const untaxed = await runOrThrow({
      runId: "t8-blind-etf-baseline",
      seedCash: SEED_KRW,
      series: series2026(),
      strategy: buySellStrategy,
    });

    const sellFill = etf.orders.find((o) => o.payload.side === "sell")!.fills[0]!;
    expect(sellFill.costs).toBeUndefined();
    expect(krwCash(etf).balance).toBe(krwCash(untaxed).balance);
  });
});

describe("runBacktest — buys are never taxed", () => {
  it("buy fill has no costs even under taxClass equity", async () => {
    const taxed = await runOrThrow({
      runId: "t8-blind-buy-untaxed",
      seedCash: SEED_KRW,
      series: series2026("equity"),
      strategy: buySellStrategy,
    });
    const buyFill = taxed.orders.find((o) => o.payload.side === "buy")!.fills[0]!;
    expect(buyFill.costs).toBeUndefined();
  });
});

describe("runBacktest — money conservation identity with tax", () => {
  it("seed - final == buys - sells + sell_tax, exact integers", async () => {
    const report = await runOrThrow({
      runId: "t8-blind-identity",
      seedCash: SEED_KRW,
      series: series2026("equity"),
      strategy: buySellStrategy,
    });

    let buysMinor = 0;
    let sellsMinor = 0;
    let taxMinor = 0;
    for (const order of report.orders) {
      for (const fill of order.fills) {
        const gross = fill.quantity * fill.price.amount;
        if (order.payload.side === "buy") {
          buysMinor += gross;
        } else {
          sellsMinor += gross;
          taxMinor += fill.costs?.sellTransactionTaxMinor ?? 0;
        }
      }
    }

    const seed = SEED_KRW[0].amount;
    const final = krwCash(report).balance;
    expect(seed - final).toBe(buysMinor - sellsMinor + taxMinor);
  });
});

describe("runBacktest — determinism", () => {
  it("two identical taxed runs produce byte-identical reports (modulo the caller-supplied runId)", async () => {
    const cfg = (runId: string) => ({
      runId,
      seedCash: SEED_KRW,
      series: series2026("equity"),
      strategy: buySellStrategy,
    });
    const a = await runOrThrow(cfg("t8-blind-det-a"));
    const b = await runOrThrow(cfg("t8-blind-det-b"));
    // runId is embedded inside nested entity-id strings (order/account/fill identities), not
    // just the top-level field, so normalize every occurrence before comparing byte-for-byte.
    const strip = (r: BacktestReport, runId: string) => JSON.stringify(r).split(runId).join("RUNID");
    expect(strip(a, "t8-blind-det-a")).toBe(strip(b, "t8-blind-det-b"));
  });
});

describe("runBacktest — cross-year series applies the correct per-year rate to each sell", () => {
  it("a 2025 sell gets 15bp and a 2026 sell in the same run gets 20bp", async () => {
    const series: BacktestSeries = {
      instrument: "005930",
      venue: "KRX",
      currency: "KRW",
      taxClass: "equity",
      bars: [
        bar("2025-06-10T00:00:00.000Z", 15_000), // 0 buy decided (fills next bar, idx1)
        bar("2025-06-11T00:00:00.000Z", 15_100), // 1 buy fills here
        bar("2025-06-12T00:00:00.000Z", 15_200), // 2 sell1 decided (buy already settled)
        bar("2025-06-13T00:00:00.000Z", 15_300), // 3 sell1 fills here
        bar("2025-06-14T00:00:00.000Z", 15_400), // 4 buffer, still 2025
        bar("2026-06-10T00:00:00.000Z", 16_000), // 5 buffer before sell2 decision
        bar("2026-06-11T00:00:00.000Z", 16_100), // 6 sell2 decided
        bar("2026-06-12T00:00:00.000Z", 16_200), // 7 sell2 fills here
        bar("2026-06-13T00:00:00.000Z", 16_300), // 8 buffer, still 2026
      ],
    };

    const strategy = (view: { cursor: number }) => {
      if (view.cursor === 0) {
        return [
          { kind: "submit", order: { side: "buy", orderType: "market", quantity: 200, timeInForce: "GTC" } },
        ] as const;
      }
      if (view.cursor === 2 || view.cursor === 6) {
        return [
          { kind: "submit", order: { side: "sell", orderType: "market", quantity: 100, timeInForce: "GTC" } },
        ] as const;
      }
      return [] as const;
    };

    const report = await runOrThrow({
      runId: "t8-blind-cross-year",
      seedCash: SEED_KRW,
      series,
      strategy,
    });

    const sells = report.orders.filter((o) => o.payload.side === "sell");
    expect(sells).toHaveLength(2);
    // Rely on submission order (sell1 submitted at cursor 2, sell2 at cursor 6), not on any
    // execution-timestamp field we don't have visibility into per the given contract.
    const [sell1, sell2] = sells;
    const fill1 = sell1!.fills[0]!;
    const fill2 = sell2!.fills[0]!;

    expect(fill1.costs?.sellTransactionTaxMinor).toBe(
      referenceTaxMinor(fill1.quantity * fill1.price.amount, "equity", 2025),
    );
    expect(fill2.costs?.sellTransactionTaxMinor).toBe(
      referenceTaxMinor(fill2.quantity * fill2.price.amount, "equity", 2026),
    );

    // The two effective rates must actually differ (15bp vs 20bp) — guards against the
    // exact-value assertions above accidentally passing at a single flat rate.
    const bp1 = (fill1.costs!.sellTransactionTaxMinor * 10000) / (fill1.quantity * fill1.price.amount);
    const bp2 = (fill2.costs!.sellTransactionTaxMinor * 10000) / (fill2.quantity * fill2.price.amount);
    expect(Math.round(bp1)).toBe(15);
    expect(Math.round(bp2)).toBe(20);
  });
});

describe("runBacktest — tax never makes cash negative or exceeds proceeds", () => {
  it("cash strictly increases on the taxed sell, and stored tax < gross proceeds", async () => {
    const buyOnly: BacktestSeries = {
      instrument: "005930",
      venue: "KRX",
      currency: "KRW",
      taxClass: "equity",
      bars: [bar("2026-03-02T00:00:00.000Z", 20_000), bar("2026-03-03T00:00:00.000Z", 20_500)],
    };
    const buyOnlyStrategy = (view: { cursor: number }) =>
      view.cursor === 0
        ? ([{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 50, timeInForce: "GTC" } }] as const)
        : ([] as const);

    const beforeSell = await runOrThrow({
      runId: "t8-blind-sanity-before",
      seedCash: SEED_KRW,
      series: buyOnly,
      strategy: buyOnlyStrategy,
    });
    const afterSell = await runOrThrow({
      runId: "t8-blind-sanity-after",
      seedCash: SEED_KRW,
      series: series2026("equity"),
      strategy: buySellStrategy,
    });

    expect(krwCash(afterSell).balance).toBeGreaterThan(krwCash(beforeSell).balance);

    const sellFill = afterSell.orders.find((o) => o.payload.side === "sell")!.fills[0]!;
    const proceeds = sellFill.quantity * sellFill.price.amount;
    expect(sellFill.costs!.sellTransactionTaxMinor).toBeGreaterThanOrEqual(0);
    expect(sellFill.costs!.sellTransactionTaxMinor).toBeLessThan(proceeds);
  });
});
