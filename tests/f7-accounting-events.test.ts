import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import {
  computeScopeAwareReturn,
  classifyTransfer,
} from "../src/modules/actual-portfolio/calculation/transfers";
import {
  resolveAccountingSeries,
  splitQuantityFactor,
} from "../src/modules/actual-portfolio/calculation/corporate-actions";
import type { CorporateAction } from "../src/modules/actual-portfolio/calculation/corporate-actions";
import type { ActualAccountReference } from "../src/modules/actual-portfolio/calculation/actual-refs";

/**
 * F7 B4 — transfer/scope + corporate action oracles (spec §8 / AT-06). The
 * AccountingJournal cases moved out with Stage 2 T4 (the journal/ layer was
 * deleted); these hand-worked literals keep the surviving pure calculations
 * covered — the success branches f7-acceptance's rejection-path cases don't reach.
 */

function account(name: string): ActualAccountReference {
  return brandReference<string, "ActualAccountReference">(`actual-account:${name}`) as ActualAccountReference;
}

function instrument(symbol: string) {
  return brandReference<string, "ActualInstrumentReference">(`instr:${symbol}`);
}

function source(name: string) {
  return brandReference<string, "ActualSourceReference">(`source:${name}`);
}

describe("Portfolio Transfer — scope 내부는 외부 flow가 아니다 (spec §8)", () => {
  const scope = new Set([String(account("a1")), String(account("a2"))]);

  it("a transfer between two in-scope accounts is internal: zero external flows", () => {
    const result = classifyTransfer(
      {
        kind: "portfolio_transfer",
        account: account("a1"),
        counterparty: { kind: "internal", account: account("a2") },
        direction: "out",
        instrument: instrument("SSNLF"),
        quantity: 10,
        occurredAt: "2026-04-01T00:00:00.000Z",
        source: source("stmt-1"),
      },
      scope,
    );
    expect(result).toEqual({ status: "internal" });
  });

  it("a scope-boundary in-kind transfer becomes a return flow ONLY with evidence-based fair value", () => {
    const base = {
      kind: "portfolio_transfer" as const,
      account: account("a1"),
      counterparty: { kind: "external" as const },
      direction: "in" as const,
      instrument: instrument("SSNLF"),
      quantity: 10,
      occurredAt: "2026-04-01T00:00:00.000Z",
      source: source("stmt-2"),
    };
    expect(classifyTransfer({ ...base, fairValue: { amount: 700_000, currency: "KRW" } }, scope)).toEqual({
      status: "external_flow",
      flow: { at: "2026-04-01T00:00:00.000Z", amount: { amount: 700_000, currency: "KRW" } },
    });
    expect(classifyTransfer(base, scope)).toEqual({ status: "unavailable", reason: "missing_fair_value" });
    // An outbound boundary transfer is a negative flow.
    const out = classifyTransfer(
      { ...base, direction: "out", fairValue: { amount: 700_000, currency: "KRW" } },
      scope,
    );
    expect(out.status === "external_flow" && out.flow.amount.amount).toBe(-700_000);
  });
});

describe("Scope membership change — 조용한 chain-link 금지 (AT-06)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-04-01T00:00:00.000Z";
  const T2 = "2026-07-01T00:00:00.000Z";
  const krw = (amount: number) => ({ amount, currency: "KRW" });
  const flowFree = {
    window: { from: T0, to: T2 },
    valuations: [
      { at: T0, value: krw(1_000) },
      { at: T1, value: krw(1_100) },
      { at: T2, value: krw(1_210) },
    ],
    externalFlows: [],
  };

  it("without membership changes it delegates: 21% covered", () => {
    const result = computeScopeAwareReturn(flowFree, []);
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.timeWeightedReturn - 0.21)).toBeLessThan(1e-12);
  });

  it("a mid-window removal yields scope_break segments and NO combined return value", () => {
    const result = computeScopeAwareReturn(flowFree, [{ at: T1, change: "removed", account: account("a2") }]);
    if (result.status !== "scope_break") throw new Error(`expected scope_break, got ${result.status}`);
    expect(result.segments).toHaveLength(2);
    expect("timeWeightedReturn" in result).toBe(false);
    const [first, second] = result.segments;
    if (first?.result.status !== "covered" || second?.result.status !== "covered") throw new Error("segments not covered");
    expect(Math.abs(first.result.timeWeightedReturn - 0.1)).toBeLessThan(1e-12);
    expect(Math.abs(second.result.timeWeightedReturn - 0.1)).toBeLessThan(1e-12);
  });

  it("a flow exactly at a break instant cannot be silently assigned: unavailable", () => {
    const result = computeScopeAwareReturn(
      { ...flowFree, externalFlows: [{ at: T1, amount: krw(100) }] },
      [{ at: T1, change: "added", account: account("a3") }],
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_at_scope_break" });
  });
});

describe("Corporate Action — 2:1 split 동등성과 fail-closed (AT-06)", () => {
  const SPLIT: CorporateAction = {
    actionReference: "ca:split-1",
    kind: "split",
    instrument: instrument("SSNLF"),
    effectiveAt: "2026-01-15T00:00:00.000Z",
    ratio: 2,
  };
  const rawPoints = [
    { at: "2026-01-01T00:00:00.000Z", price: 10_000 },
    { at: "2026-02-01T00:00:00.000Z", price: 5_500 },
  ];
  const restatedPoints = [
    { at: "2026-01-01T00:00:00.000Z", price: 5_000 },
    { at: "2026-02-01T00:00:00.000Z", price: 5_500 },
  ];

  it("raw + split adjustment equals the restated series exactly (no double application)", () => {
    const raw = resolveAccountingSeries({ basis: "raw", points: rawPoints, actions: [SPLIT] });
    const restated = resolveAccountingSeries({ basis: "split_restated", points: restatedPoints, actions: [SPLIT] });
    if (raw.status !== "covered" || restated.status !== "covered") throw new Error("expected covered");
    expect(raw.points).toEqual(restated.points);
    // Quantity stated in post-split terms: 10 shares before the split are 20 after.
    expect(splitQuantityFactor([SPLIT], "2026-01-01T00:00:00.000Z")).toBe(2);
    expect(splitQuantityFactor([SPLIT], "2026-02-01T00:00:00.000Z")).toBe(1);
    // Value continuity across the split day: 10 × 10,000 = 20 × 5,000.
    expect(10 * 10_000).toBe(10 * 2 * 5_000);
  });

  it("the same action listed twice is rejected, never applied twice", () => {
    expect(resolveAccountingSeries({ basis: "raw", points: rawPoints, actions: [SPLIT, { ...SPLIT }] }))
      .toEqual({ status: "unavailable", reason: "duplicate_action" });
  });

  it("total_return_adjusted price basis is rejected at the P&L input boundary", () => {
    expect(resolveAccountingSeries({ basis: "total_return_adjusted", points: restatedPoints, actions: [] }))
      .toEqual({ status: "unavailable", reason: "total_return_basis_rejected" });
  });

  it("a merger without complete basis allocation fails closed", () => {
    const merger: CorporateAction = {
      actionReference: "ca:merger-1",
      kind: "merger",
      instrument: instrument("SSNLF"),
      effectiveAt: "2026-03-01T00:00:00.000Z",
    };
    expect(resolveAccountingSeries({ basis: "raw", points: rawPoints, actions: [merger] }))
      .toEqual({ status: "unavailable", reason: "incomplete_corporate_action_basis" });
    const complete = resolveAccountingSeries({
      basis: "raw",
      points: rawPoints,
      actions: [{ ...merger, basisAllocation: { continuing: 1 } }],
    });
    expect(complete.status).toBe("covered");
  });

  it("a price at or after delisting is contradictory evidence: unavailable; the series ends at the delisting", () => {
    const delisting: CorporateAction = {
      actionReference: "ca:delist-1",
      kind: "delisting",
      instrument: instrument("SSNLF"),
      effectiveAt: "2026-01-20T00:00:00.000Z",
    };
    expect(resolveAccountingSeries({ basis: "raw", points: rawPoints, actions: [delisting] }))
      .toEqual({ status: "unavailable", reason: "post_delisting_price" });
    const truncated = resolveAccountingSeries({
      basis: "raw",
      points: [rawPoints[0] ?? { at: "", price: 0 }],
      actions: [SPLIT, delisting],
    });
    if (truncated.status !== "covered") throw new Error("expected covered");
    expect(truncated.delistedAt).toBe("2026-01-20T00:00:00.000Z");
    expect(truncated.points).toEqual([{ at: "2026-01-01T00:00:00.000Z", price: 5_000 }]);
  });
});
