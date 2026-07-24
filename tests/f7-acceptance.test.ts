/**
 * F7 acceptance tests — AT-05 / AT-06
 * Seams: public exports only; no src/ reads.
 * All expected values from spec literals (hand-worked), never from running the code.
 */

import { describe, it, expect } from "vitest";

import { computePortfolioReturn } from "../src/modules/actual-portfolio/calculation/performance";
import { computePersonalReturn } from "../src/modules/actual-portfolio/calculation/personal-return";
import { computeReportingPnl } from "../src/modules/actual-portfolio/calculation/reporting-pnl";
import {
  resolveAccountingSeries,
  splitQuantityFactor,
} from "../src/modules/actual-portfolio/calculation/corporate-actions";
import {
  classifyTransfer,
  computeScopeAwareReturn,
} from "../src/modules/actual-portfolio/calculation/transfers";
import { evaluateRebalancing } from "../src/modules/actual-portfolio/calculation/rebalancing";
import { brandReference } from "../src/shared/contracts/brands";
import type {
  ActualAccountReference,
  ActualInstrumentReference,
  ActualSourceReference,
} from "../src/modules/actual-portfolio/calculation/actual-refs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const acct = (id: string) =>
  brandReference<string, "ActualAccountReference">(id) as ActualAccountReference;

const instr = (id: string) =>
  brandReference<string, "ActualInstrumentReference">(id) as ActualInstrumentReference;

const src = (id: string) =>
  brandReference<string, "ActualSourceReference">(id) as ActualSourceReference;

// ---------------------------------------------------------------------------
// 1. Portfolio Return — TWR
// ---------------------------------------------------------------------------

describe("computePortfolioReturn – TWR", () => {
  it("spec literal: 1000→1100 (+10%), flow +900 → base 2000→2200 (+10%) ⇒ TWR exactly 21%", () => {
    // Spec: TWR = (1.10 × 1.10) − 1 = 0.21
    const result = computePortfolioReturn({
      window: { from: "2026-01-01", to: "2026-03-01" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        // pre-flow valuation AT the flow instant = 1100
        { at: "2026-02-01", value: { amount: 1100, currency: "USD" } },
        { at: "2026-03-01", value: { amount: 2200, currency: "USD" } },
      ],
      externalFlows: [
        { at: "2026-02-01", amount: { amount: 900, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.timeWeightedReturn).toBeCloseTo(0.21, 10);
    }
  });

  it("missing boundary valuation ⇒ unavailable missing_boundary_valuation", () => {
    const result = computePortfolioReturn({
      window: { from: "2026-01-01", to: "2026-12-31" },
      valuations: [
        // from boundary present but to boundary missing
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
      ],
      externalFlows: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_boundary_valuation");
    }
  });

  it("missing valuation at flow instant ⇒ unavailable missing_valuation_at_flow", () => {
    const result = computePortfolioReturn({
      window: { from: "2026-01-01", to: "2026-12-31" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        { at: "2026-12-31", value: { amount: 1200, currency: "USD" } },
        // no valuation at 2026-06-01 where flow occurs
      ],
      externalFlows: [
        { at: "2026-06-01", amount: { amount: 500, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_valuation_at_flow");
    }
  });

  it("flow outside window ⇒ unavailable flow_outside_window", () => {
    const result = computePortfolioReturn({
      window: { from: "2026-01-01", to: "2026-06-30" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        { at: "2026-06-30", value: { amount: 1100, currency: "USD" } },
      ],
      externalFlows: [
        { at: "2026-09-01", amount: { amount: 500, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("flow_outside_window");
    }
  });

  it("mixed currency valuations ⇒ unavailable mixed_currency", () => {
    const result = computePortfolioReturn({
      window: { from: "2026-01-01", to: "2026-12-31" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        { at: "2026-12-31", value: { amount: 1100, currency: "KRW" } },
      ],
      externalFlows: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("mixed_currency");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Personal Return — XIRR
// ---------------------------------------------------------------------------

describe("computePersonalReturn – XIRR", () => {
  it("spec literal: −1000 @2026-01-01, +1100 @2027-01-01 ⇒ exactly 10%", () => {
    // 1000·(1+r) = 1100, t=1y ⇒ r=0.10
    const result = computePersonalReturn({
      flows: [
        { at: "2026-01-01", amount: { amount: -1000, currency: "USD" } },
        { at: "2027-01-01", amount: { amount: 1100, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.annualizedRate).toBeCloseTo(0.1, 8);
    }
  });

  it("multi-root fixture −1000 / +2500 @+1y / −1560 @+2y ⇒ unavailable no_unique_solution", () => {
    // Polynomial 1000r²−2500r+1560=0 has two real roots (r≈1.2 and r≈1.3 as (1+r))
    // ⇒ XIRR has no unique solution → must be unavailable
    const result = computePersonalReturn({
      flows: [
        { at: "2026-01-01", amount: { amount: -1000, currency: "USD" } },
        { at: "2027-01-01", amount: { amount: 2500, currency: "USD" } },
        { at: "2028-01-01", amount: { amount: -1560, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("no_unique_solution");
    }
  });

  it("single flow ⇒ unavailable insufficient_flows", () => {
    const result = computePersonalReturn({
      flows: [
        { at: "2026-01-01", amount: { amount: -1000, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("insufficient_flows");
    }
  });

  it("all flows same sign ⇒ unavailable no_sign_change", () => {
    const result = computePersonalReturn({
      flows: [
        { at: "2026-01-01", amount: { amount: 1000, currency: "USD" } },
        { at: "2027-01-01", amount: { amount: 1100, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("no_sign_change");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Reporting P&L decomposition
// ---------------------------------------------------------------------------

describe("computeReportingPnl – price / fx / interaction", () => {
  it("spec literal: 50→55 USD, FX 10→12 ⇒ price 50 / fx 100 / interaction 10 / total 160", () => {
    // N₀=50,N₁=55, F₀=10,F₁=12 (KRW/USD)
    // price=(55−50)·10=50, fx=50·(12−10)=100, interaction=(55−50)·(12−10)=10 → total=160
    // Start: 50·10=500 KRW, End: 55·12=660 KRW, grossReturn=160/500=0.32
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [
        {
          key: "sec1",
          kind: "security",
          nativeCurrency: "USD",
          startNativeValue: 50,
          endNativeValue: 55,
          fx: { start: 10, end: 12 },
        },
      ],
      charges: [],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.gross.price).toBeCloseTo(50, 8);
      expect(result.gross.fx).toBeCloseTo(100, 8);
      expect(result.gross.interaction).toBeCloseTo(10, 8);
      expect(result.gross.total).toBeCloseTo(160, 8);
      // gross return 10%+20%+2% = 32%
      expect(result.grossReturn.total).toBeCloseTo(0.32, 8);
      expect(result.startReportingValue).toBeCloseTo(500, 8);
    }
  });

  it("gross 20 − fee 2 − tax 1 = net 17", () => {
    // Reporting-currency row (no fx): USD security reporting in USD
    // Start=200, End=220, price gain=20, no fx component
    const result = computeReportingPnl({
      reportingCurrency: "USD",
      rows: [
        {
          key: "sec2",
          kind: "security",
          nativeCurrency: "USD",
          startNativeValue: 200,
          endNativeValue: 220,
          // no fx: reporting-currency row
        },
      ],
      charges: [
        { kind: "fee", amount: { amount: 2, currency: "USD" } },
        { kind: "tax", amount: { amount: 1, currency: "USD" } },
      ],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.gross.total).toBeCloseTo(20, 8);
      expect(result.fees).toBeCloseTo(2, 8);
      expect(result.taxes).toBeCloseTo(1, 8);
      expect(result.net).toBeCloseTo(17, 8);
    }
  });

  it("foreign row missing fx ⇒ unavailable missing_fx", () => {
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [
        {
          key: "sec3",
          kind: "security",
          nativeCurrency: "USD",
          startNativeValue: 100,
          endNativeValue: 110,
          // fx is required for foreign row but omitted
        },
      ],
      charges: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_fx");
    }
  });

  it("reporting-currency row with fx ⇒ unavailable invalid_fx", () => {
    const result = computeReportingPnl({
      reportingCurrency: "USD",
      rows: [
        {
          key: "sec4",
          kind: "security",
          nativeCurrency: "USD",
          startNativeValue: 100,
          endNativeValue: 110,
          fx: { start: 1, end: 1 }, // forbidden for domestic row
        },
      ],
      charges: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("invalid_fx");
    }
  });

  it("no rows ⇒ unavailable no_rows", () => {
    const result = computeReportingPnl({
      reportingCurrency: "USD",
      rows: [],
      charges: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("no_rows");
    }
  });

  it("decomposition identity: price + fx + interaction === N1*F1 - N0*F0", () => {
    // Arbitrary values; identity must hold exactly (not toBeCloseTo — same arithmetic)
    const N0 = 100, N1 = 130, F0 = 5, F1 = 7;
    // expected: start=500, end=910, total=410
    // price=(130-100)*5=150, fx=100*(7-5)=200, interaction=(130-100)*(7-5)=60 → sum=410
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [
        {
          key: "ident",
          kind: "security",
          nativeCurrency: "USD",
          startNativeValue: N0,
          endNativeValue: N1,
          fx: { start: F0, end: F1 },
        },
      ],
      charges: [],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      const { price, fx, interaction, total } = result.gross;
      expect(price + fx + interaction).toBeCloseTo(total, 10);
      expect(total).toBeCloseTo(N1 * F1 - N0 * F0, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Corporate Actions
// ---------------------------------------------------------------------------

describe("resolveAccountingSeries / splitQuantityFactor", () => {
  it("2:1 split: raw price series + split action ⇒ pre-split price halved, post-split unchanged", () => {
    // raw basis: [100 @2026-01-01, 110 @2026-06-01], split 2:1 effectiveAt 2026-03-01
    // Spec: pre-split prices ÷ ratio ⇒ 100÷2=50; post-split price 110 unchanged
    const result = resolveAccountingSeries({
      basis: "raw",
      points: [
        { at: "2026-01-01", price: 100 },
        { at: "2026-06-01", price: 110 }, // post-split, stays
      ],
      actions: [
        {
          actionReference: "split-1",
          kind: "split",
          instrument: instr("instr:A"),
          effectiveAt: "2026-03-01",
          ratio: 2,
        },
      ],
    });

    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      const jan = result.points.find((p) => p.at === "2026-01-01");
      const jun = result.points.find((p) => p.at === "2026-06-01");
      expect(jan?.price).toBeCloseTo(50, 10); // pre-split price ÷ 2
      expect(jun?.price).toBeCloseTo(110, 10); // post-split unchanged
    }
  });

  it("total_return_adjusted basis ⇒ unavailable total_return_basis_rejected", () => {
    const result = resolveAccountingSeries({
      basis: "total_return_adjusted",
      points: [{ at: "2026-01-01", price: 100 }],
      actions: [],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("total_return_basis_rejected");
    }
  });

  it("duplicate action reference ⇒ unavailable duplicate_action", () => {
    const result = resolveAccountingSeries({
      basis: "raw",
      points: [
        { at: "2026-01-01", price: 100 },
        { at: "2026-12-31", price: 110 },
      ],
      actions: [
        {
          actionReference: "split-dup",
          kind: "split",
          instrument: instr("instr:A"),
          effectiveAt: "2026-06-01",
          ratio: 2,
        },
        {
          actionReference: "split-dup", // duplicate
          kind: "split",
          instrument: instr("instr:A"),
          effectiveAt: "2026-07-01",
          ratio: 2,
        },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("duplicate_action");
    }
  });

  it("merger without basisAllocation ⇒ unavailable incomplete_corporate_action_basis", () => {
    const result = resolveAccountingSeries({
      basis: "raw",
      points: [{ at: "2026-01-01", price: 100 }],
      actions: [
        {
          actionReference: "merger-1",
          kind: "merger",
          instrument: instr("instr:A"),
          effectiveAt: "2026-06-01",
          // no basisAllocation
        },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("incomplete_corporate_action_basis");
    }
  });

  it("price point after delisting ⇒ unavailable post_delisting_price", () => {
    const result = resolveAccountingSeries({
      basis: "raw",
      points: [
        { at: "2026-01-01", price: 100 },
        { at: "2026-12-31", price: 0.01 }, // after delisting
      ],
      actions: [
        {
          actionReference: "delist-1",
          kind: "delisting",
          instrument: instr("instr:A"),
          effectiveAt: "2026-06-01",
        },
      ],
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("post_delisting_price");
    }
  });

  it("splitQuantityFactor: product of ratios for splits AFTER given date", () => {
    // Splits: 2:1 at 2026-03-01, 3:1 at 2026-09-01
    // at=2026-01-01 ⇒ both are after ⇒ factor = 2*3 = 6
    const factor = splitQuantityFactor(
      [
        {
          actionReference: "sp1",
          kind: "split",
          instrument: instr("instr:B"),
          effectiveAt: "2026-03-01",
          ratio: 2,
        },
        {
          actionReference: "sp2",
          kind: "split",
          instrument: instr("instr:B"),
          effectiveAt: "2026-09-01",
          ratio: 3,
        },
      ],
      "2026-01-01"
    );

    expect(factor).toBeCloseTo(6, 10);
  });
});

// ---------------------------------------------------------------------------
// 5. Transfers
// ---------------------------------------------------------------------------

describe("classifyTransfer", () => {
  // Adjudicated by main agent: replaced the runtime `ReadonlySet` shim with a plain
  // Set (satisfies the ReadonlySet<string> parameter); tsc strict rejected the shim
  // (TS7009). Mechanical type fix only — no assertion changed.
  const scopeAccounts = new Set<string>(["actual-account:alice", "actual-account:bob"]);

  it("transfer between two in-scope accounts ⇒ internal", () => {
    const transfer = {
      kind: "portfolio_transfer" as const,
      account: acct("actual-account:alice"),
      counterparty: { kind: "internal" as const, account: acct("actual-account:bob") },
      direction: "out" as const,
      occurredAt: "2026-06-01",
      source: src("source:x"),
    };

    const result = classifyTransfer(transfer, scopeAccounts);
    expect(result.status).toBe("internal");
  });

  it("transfer to external with fairValue ⇒ external_flow with negative amount (direction out)", () => {
    const transfer = {
      kind: "portfolio_transfer" as const,
      account: acct("actual-account:alice"),
      counterparty: { kind: "external" as const },
      direction: "out" as const,
      occurredAt: "2026-06-01",
      fairValue: { amount: 500, currency: "USD" },
      source: src("source:x"),
    };

    const result = classifyTransfer(transfer, scopeAccounts);
    expect(result.status).toBe("external_flow");
    if (result.status === "external_flow") {
      expect(result.flow.amount.amount).toBe(-500); // out = negative flow
      expect(result.flow.amount.currency).toBe("USD");
    }
  });

  it("transfer to external without fairValue ⇒ unavailable missing_fair_value", () => {
    const transfer = {
      kind: "portfolio_transfer" as const,
      account: acct("actual-account:alice"),
      counterparty: { kind: "external" as const },
      direction: "in" as const,
      occurredAt: "2026-06-01",
      // no fairValue
      source: src("source:x"),
    };

    const result = classifyTransfer(transfer, scopeAccounts);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("missing_fair_value");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Scope-aware return — scope_break
// ---------------------------------------------------------------------------

describe("computeScopeAwareReturn – scope_break", () => {
  it("account added strictly inside window ⇒ status scope_break, no combined return", () => {
    const baseInput = {
      window: { from: "2026-01-01", to: "2026-12-31" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        { at: "2026-12-31", value: { amount: 1100, currency: "USD" } },
      ],
      externalFlows: [],
    };

    const result = computeScopeAwareReturn(baseInput, [
      { at: "2026-06-01", change: "added", account: acct("actual-account:new") },
    ]);

    expect(result.status).toBe("scope_break");
    if (result.status === "scope_break") {
      expect(result.segments.length).toBeGreaterThan(0);
      // No combined timeWeightedReturn on the scope_break result
      expect((result as any).timeWeightedReturn).toBeUndefined();
    }
  });

  it("external flow exactly at scope-break instant ⇒ unavailable flow_at_scope_break", () => {
    const baseInput = {
      window: { from: "2026-01-01", to: "2026-12-31" },
      valuations: [
        { at: "2026-01-01", value: { amount: 1000, currency: "USD" } },
        { at: "2026-06-01", value: { amount: 1050, currency: "USD" } },
        { at: "2026-12-31", value: { amount: 1100, currency: "USD" } },
      ],
      externalFlows: [
        { at: "2026-06-01", amount: { amount: 200, currency: "USD" } },
      ],
    };

    const result = computeScopeAwareReturn(baseInput, [
      { at: "2026-06-01", change: "removed", account: acct("actual-account:old") },
    ]);

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("flow_at_scope_break");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Rebalancing
// ---------------------------------------------------------------------------

describe("evaluateRebalancing", () => {
  const completePositions = {
    completeness: "complete" as const,
    total: { amount: 10000, currency: "USD" },
    rows: [
      {
        instrument: instr("instr:X"),
        signedQuantity: 100,
        aggregateLot: false,
        asOf: "2026-01-01",
        source: src("source:x"),
        reportingValue: { amount: 6000, currency: "USD" },
        weight: 0.6,
      },
      {
        instrument: instr("instr:Y"),
        signedQuantity: 50,
        aggregateLot: false,
        asOf: "2026-01-01",
        source: src("source:x"),
        reportingValue: { amount: 4000, currency: "USD" },
        weight: 0.4,
      },
    ],
  };

  it("no target ⇒ not_configured", () => {
    const result = evaluateRebalancing({ positions: completePositions });
    expect(result.status).toBe("not_configured");
  });

  it("partial positions ⇒ unavailable incomplete_total", () => {
    const partialPositions = {
      completeness: "partial" as const,
      knownSubtotal: { amount: 6000, currency: "USD" },
      missing: [{ instrument: instr("instr:Z"), reason: "price" as const }],
      rows: completePositions.rows,
    };

    const result = evaluateRebalancing({
      positions: partialPositions,
      target: {
        weights: { "instr:X": 0.5, "instr:Y": 0.5 },
        policyVersion: "v1",
      },
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("incomplete_total");
    }
  });

  it("target weights not summing to 1 ⇒ unavailable invalid_target", () => {
    const result = evaluateRebalancing({
      positions: completePositions,
      target: {
        weights: { "instr:X": 0.6, "instr:Y": 0.6 }, // sums to 1.2
        policyVersion: "v1",
      },
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("invalid_target");
    }
  });

  it("valid target ⇒ proposed with no order/submit/execute keys and no functions", () => {
    const result = evaluateRebalancing({
      positions: completePositions,
      target: {
        weights: { "instr:X": 0.5, "instr:Y": 0.5 },
        policyVersion: "v1",
      },
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      // No live/paper/order/submit/execute/functions in result
      const str = JSON.stringify(result);
      expect(str).not.toMatch(/\border\b|\bsubmit\b|\bexecute\b|\blive\b|\bpaper\b/);
      // Check rows exist with expected shape
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.policyVersion).toBe("v1");
    }
  });

  it("guardrail not configured ⇒ guardrail status not_configured", () => {
    const result = evaluateRebalancing({
      positions: completePositions,
      target: {
        weights: { "instr:X": 0.5, "instr:Y": 0.5 },
        policyVersion: "v1",
      },
      // no guardrail
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.guardrail.status).toBe("not_configured");
    }
  });
});

// Section 8 "Accounting Journal" was removed with Stage 2 T4: the journal/ layer
// is deleted. The surviving calculation functions (performance, personal-return,
// reporting-pnl, corporate-actions, transfers, rebalancing) keep their acceptance
// coverage in sections 1–7 above.
