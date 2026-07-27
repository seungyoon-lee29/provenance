// Blind acceptance tests written against ONLY
// `.scratch/honesty-and-gates/blind-contract.md`. No implementation source
// file was opened while writing this file (see report to the orchestrator
// for the exact blindness ledger). Where the contract's public signatures
// were insufficient to construct valid inputs (CorporateAction shape,
// AccountingSeriesInput/Result shape, computeScopeAwareReturn input/changes
// shape), field names were discovered by *executing* the public exports
// with probe inputs and reading the JSON they returned back — never by
// reading .ts source. Every such inferred field name is called out in a
// comment at first use. Anything still unresolved after that is reported
// as contract-unspecified rather than guessed.
import { describe, expect, it } from "vitest";
import { maxDrawdown } from "../src/modules/paper-trading/backtest/performance-report";
import { isExactMinor, grossMinorOf } from "../src/modules/paper-trading/internal/contracts";
import {
  splitQuantityFactor,
  resolveAccountingSeries,
} from "../src/modules/actual-portfolio/calculation/corporate-actions";
import { computeScopeAwareReturn } from "../src/modules/actual-portfolio/calculation/transfers";

// ---------------------------------------------------------------------------
// C1 — maxDrawdown (src/modules/paper-trading/backtest/performance-report.ts)
// Fully specified by the contract: no shape guessing needed.
// ---------------------------------------------------------------------------
describe("C1 maxDrawdown", () => {
  it("rejects an empty curve as insufficient_curve, not 0", () => {
    expect(maxDrawdown([])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
  });

  it("rejects a single mark as insufficient_curve", () => {
    expect(maxDrawdown([100])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
  });

  it("insufficient_curve takes priority over invalid_sample when a single mark is also NaN", () => {
    // Contract lists the <2-marks check (clause 1) before the non-finite/negative
    // check (clause 2). A single NaN mark should trip clause 1 first.
    expect(maxDrawdown([NaN])).toEqual({ status: "unavailable", reason: "insufficient_curve" });
  });

  it("accepts exactly 2 marks (boundary) as covered", () => {
    expect(maxDrawdown([100, 90])).toEqual({ status: "covered", ratio: 0.1 });
  });

  it("exactly 2 equal marks are covered with ratio 0", () => {
    expect(maxDrawdown([100, 100])).toEqual({ status: "covered", ratio: 0 });
  });

  it("a monotonic non-decreasing curve is covered with ratio exactly 0, not unavailable", () => {
    expect(maxDrawdown([100, 110, 120, 130])).toEqual({ status: "covered", ratio: 0 });
  });

  it("ratio boundary 1: a full drawdown to 0 is covered with ratio 1", () => {
    expect(maxDrawdown([100, 0])).toEqual({ status: "covered", ratio: 1 });
  });

  it("a NaN mark anywhere in the curve is invalid_sample, not skipped", () => {
    expect(maxDrawdown([100, NaN, 90])).toEqual({ status: "unavailable", reason: "invalid_sample" });
  });

  it("a +Infinity mark is invalid_sample", () => {
    expect(maxDrawdown([100, Infinity, 90])).toEqual({ status: "unavailable", reason: "invalid_sample" });
  });

  it("a -Infinity mark is invalid_sample", () => {
    expect(maxDrawdown([-Infinity, 100, 90])).toEqual({ status: "unavailable", reason: "invalid_sample" });
  });

  it("a negative mark is invalid_sample even though the rest of the curve looks normal", () => {
    expect(maxDrawdown([100, -1, 90])).toEqual({ status: "unavailable", reason: "invalid_sample" });
  });

  it("a deeper first drawdown is not overwritten by a shallower one after a new all-time high", () => {
    // Peak 100 -> trough 50 is a 0.5 drawdown. The curve then makes a NEW
    // all-time high of 150, then drops back to 100: only a 0.333 drawdown
    // relative to the new peak. An implementation that resets its "max so
    // far" whenever a new peak is set (instead of keeping a running global
    // max) would wrongly report 0.333 here.
    expect(maxDrawdown([100, 50, 150, 100])).toEqual({ status: "covered", ratio: 0.5 });
  });

  it("JSON.stringify never contains a null for covered results", () => {
    const result = maxDrawdown([100, 50, 150, 100]);
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("JSON.stringify never contains a null for unavailable results (insufficient_curve)", () => {
    expect(JSON.stringify(maxDrawdown([]))).not.toContain("null");
  });

  it("JSON.stringify never contains a null for unavailable results (invalid_sample)", () => {
    expect(JSON.stringify(maxDrawdown([100, NaN]))).not.toContain("null");
  });

  // C1.5 (buildPerformance(...).performance.maxDrawdown carries this type
  // through) is NOT tested: the contract gives no signature for
  // buildPerformance (its parameters, return shape, and import path are
  // never stated). Guessing them would violate the "don't open files just
  // to confirm an import" rule. Reported as contract-unspecified.
});

// ---------------------------------------------------------------------------
// C4 — contracts.ts (src/modules/paper-trading/internal/contracts.ts)
// Fully specified formulas; journal.ts fill_applied validation (C4.2-4) has
// no exported entry point named in the contract, so it is untestable via
// public imports and is reported as contract-unspecified.
// ---------------------------------------------------------------------------
describe("C4 isExactMinor / grossMinorOf", () => {
  it("isExactMinor is true for a plain safe integer", () => {
    expect(isExactMinor(100)).toBe(true);
  });

  it("isExactMinor is false for a non-integer", () => {
    expect(isExactMinor(100.5)).toBe(false);
  });

  it("isExactMinor is false for NaN", () => {
    expect(isExactMinor(NaN)).toBe(false);
  });

  it("isExactMinor is false for +Infinity", () => {
    expect(isExactMinor(Infinity)).toBe(false);
  });

  it("isExactMinor is false for -Infinity", () => {
    expect(isExactMinor(-Infinity)).toBe(false);
  });

  it("isExactMinor is true at the Number.MAX_SAFE_INTEGER boundary", () => {
    expect(isExactMinor(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("isExactMinor is false one past the Number.MAX_SAFE_INTEGER boundary", () => {
    expect(isExactMinor(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("isExactMinor does not impose an undocumented positivity constraint", () => {
    // Contract says isExactMinor is exactly Number.isSafeInteger — no
    // mention of sign. A negative safe integer must still be exact.
    expect(isExactMinor(-100)).toBe(true);
  });

  it("grossMinorOf uses scale 1 for KRW", () => {
    expect(grossMinorOf(10, { amount: 1000, currency: "KRW" })).toBe(10000);
  });

  it("grossMinorOf uses scale 100 for a non-KRW currency", () => {
    expect(grossMinorOf(2, { amount: 5, currency: "USD" })).toBe(1000); // 2*5*100
  });

  it("grossMinorOf rounds the aggregate once, not per unit", () => {
    // total = 3 * 0.005 * 100 = 1.5 -> Math.round -> 2.
    // A buggy per-unit implementation would round 0.005*100=0.5 to 1 first,
    // then multiply by quantity 3, giving 3 instead of 2.
    expect(grossMinorOf(3, { amount: 0.005, currency: "USD" })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C2 — corporate-actions.ts
// CorporateAction's discriminant field is `kind` (confirmed by executing
// splitQuantityFactor/resolveAccountingSeries with probe inputs and reading
// the JSON back — not by reading source). Confirmed fields used below:
// { kind: "split"|"delisting"|"merger"|"spin_off", effectiveAt: string,
//   ratio?: number, basisAllocation?: unknown, actionReference?: string }
// AccountingSeriesInput = { actions, points: {at, price}[], basis }
// ---------------------------------------------------------------------------
describe("C2 splitQuantityFactor", () => {
  it("C2-1 decisive case: an offset-mixed effectiveAt does not get treated as future relative to `at`", () => {
    // "2026-03-05T00:00:00+09:00" is instant 2026-03-04T15:00:00Z, which is
    // BEFORE "2026-03-04T16:00:01Z" even though it sorts AFTER it as a
    // plain string (lexicographic "03-05" > "03-04"). A split effective at
    // that earlier instant must NOT be counted as "after `at`".
    const factor = splitQuantityFactor(
      [{ kind: "split", effectiveAt: "2026-03-05T00:00:00+09:00", ratio: 2 } as any],
      "2026-03-04T16:00:01Z",
    );
    expect(factor).toBe(1);
  });

  it("excludes a split whose effectiveAt is the exact same instant as `at`", () => {
    const factor = splitQuantityFactor(
      [{ kind: "split", effectiveAt: "2026-03-01T00:00:00Z", ratio: 2 } as any],
      "2026-03-01T00:00:00Z",
    );
    expect(factor).toBe(1);
  });

  it("multiplies the ratios of only the splits strictly after `at`", () => {
    const factor = splitQuantityFactor(
      [
        { kind: "split", effectiveAt: "2026-01-01T00:00:00Z", ratio: 2, actionReference: "S1" },
        { kind: "split", effectiveAt: "2026-06-01T00:00:00Z", ratio: 3, actionReference: "S2" },
        { kind: "split", effectiveAt: "2026-09-01T00:00:00Z", ratio: 5, actionReference: "S3" },
      ] as any,
      "2026-03-01T00:00:00Z",
    );
    expect(factor).toBe(15); // 3 * 5, the 2026-01-01 split is excluded
  });
});

describe("C2 resolveAccountingSeries", () => {
  it("rejects an unparseable action.effectiveAt as invalid_timestamp", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "split", effectiveAt: "not-a-real-timestamp", ratio: 2 }],
      points: [{ at: "2026-01-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(result).toEqual({ status: "unavailable", reason: "invalid_timestamp" });
  });

  it("rejects an unparseable point.at as invalid_timestamp", () => {
    const result = resolveAccountingSeries({
      actions: [],
      points: [{ at: "also-garbage", price: 100 }],
      basis: "raw",
    } as any);
    expect(result).toEqual({ status: "unavailable", reason: "invalid_timestamp" });
  });

  it("always rejects basis: total_return_adjusted", () => {
    const result = resolveAccountingSeries({
      actions: [],
      points: [{ at: "2026-01-01T00:00:00Z", price: 100 }],
      basis: "total_return_adjusted",
    } as any);
    expect(result.status).toBe("unavailable");
  });

  it("rejects duplicate actionReference across two split actions", () => {
    const result = resolveAccountingSeries({
      actions: [
        { kind: "split", effectiveAt: "2026-01-05T00:00:00Z", ratio: 2, actionReference: "A1" },
        { kind: "split", effectiveAt: "2026-02-05T00:00:00Z", ratio: 3, actionReference: "A1" },
      ],
      points: [{ at: "2026-03-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(result.status).toBe("unavailable");
  });

  // The blind author filed the `actionReference`-omitted case as possibly a bug:
  // two entirely different splits with no reference on either are rejected as
  // `duplicate_action`. Adjudicated (main session, 2026-07-27): NOT a defect.
  // `CorporateAction.actionReference` is declared a required `string`; the probe
  // reached this state only by casting through `as any`. Identity is what the
  // reference MEANS in this domain (the same reference is the same corporate
  // action — see the f8 panel's rejected content-hash proposal), so two actions
  // claiming no identity are indistinguishable and refusing them is fail-closed.
  // The contract doc was the thing at fault: it said "duplicate actionReference
  // is rejected" without saying the reference is mandatory. Both halves asserted.
  it("distinct references are not duplicates; a repeated reference is", () => {
    const covered = resolveAccountingSeries({
      actions: [
        { kind: "split", actionReference: "ca:1", effectiveAt: "2026-01-05T00:00:00Z", ratio: 2 },
        { kind: "split", actionReference: "ca:2", effectiveAt: "2026-02-05T00:00:00Z", ratio: 3 },
      ],
      points: [{ at: "2026-03-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(covered.status).toBe("covered");

    const duplicate = resolveAccountingSeries({
      actions: [
        { kind: "split", actionReference: "ca:1", effectiveAt: "2026-01-05T00:00:00Z", ratio: 2 },
        { kind: "split", actionReference: "ca:1", effectiveAt: "2026-02-05T00:00:00Z", ratio: 3 },
      ],
      points: [{ at: "2026-03-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(duplicate).toEqual({ status: "unavailable", reason: "duplicate_action" });
  });

  it("rejects a merger action with no basisAllocation", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "merger", effectiveAt: "2026-01-10T00:00:00Z", actionReference: "M1" }],
      points: [{ at: "2026-02-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(result.status).toBe("unavailable");
  });

  it("rejects a spin_off action with no basisAllocation", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "spin_off", effectiveAt: "2026-01-10T00:00:00Z", actionReference: "SP1" }],
      points: [{ at: "2026-02-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(result.status).toBe("unavailable");
  });

  it("C2-1 decisive case for delisting: the earliest delisting by instant wins, original string preserved, despite lexicographic order flip", () => {
    const result = resolveAccountingSeries({
      actions: [
        { kind: "delisting", effectiveAt: "2026-03-05T00:00:00+09:00", actionReference: "D1" }, // instant 2026-03-04T15:00:00Z (earlier)
        { kind: "delisting", effectiveAt: "2026-03-04T16:00:01Z", actionReference: "D2" }, // instant later, but lexicographically earlier string
      ],
      points: [{ at: "2026-01-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect((result as any).delistedAt).toBe("2026-03-05T00:00:00+09:00");
  });

  it("a point exactly at the delisting instant (>=) is post_delisting_price", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "delisting", effectiveAt: "2026-01-15T00:00:00.000Z", actionReference: "D1" }],
      points: [{ at: "2026-01-15T00:00:00Z", price: 50 }],
      basis: "raw",
    } as any);
    expect(result).toEqual({ status: "unavailable", reason: "post_delisting_price" });
  });

  it("a point 1ms before the delisting instant is still covered, not post_delisting_price", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "delisting", effectiveAt: "2026-01-15T00:00:00.000Z", actionReference: "D1" }],
      points: [{ at: "2026-01-14T23:59:59.999Z", price: 50 }],
      basis: "raw",
    } as any);
    expect(result.status).toBe("covered");
  });

  it("delisting-vs-point instant comparison is offset-aware: a point at the same instant written with a different offset is still post_delisting_price", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "delisting", effectiveAt: "2026-01-15T09:00:00+09:00", actionReference: "D1" }],
      points: [{ at: "2026-01-15T00:00:00.000Z", price: 50 }],
      basis: "raw",
    } as any);
    expect(result).toEqual({ status: "unavailable", reason: "post_delisting_price" });
  });

  it("basis: raw divides each point price by splitQuantityFactor at that point's instant", () => {
    const result = resolveAccountingSeries({
      actions: [{ kind: "split", effectiveAt: "2026-01-10T00:00:00Z", ratio: 2, actionReference: "S1" }],
      points: [{ at: "2026-01-01T00:00:00Z", price: 100 }],
      basis: "raw",
    } as any);
    expect(result.status).toBe("covered");
    expect((result as any).points[0].price).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// C3 — transfers.ts computeScopeAwareReturn
// The contract gives NO type for `input`, `changes`, or ScopeAwareReturnResult
// at all (only prose). The following shape was reverse-engineered purely by
// executing computeScopeAwareReturn with probe inputs and reading back the
// JSON/thrown-error messages (e.g. "Cannot read properties of undefined
// (reading 'map')" pinpointed missing array fields) — never by reading
// transfers.ts source:
//   input.window = { from: string, to: string }
//   input.externalFlows = { at: string, amount: number }[]
//   input.{holdings,positions,legs,valuations,snapshots,contributions,
//          withdrawals} = [] (required to not throw; exact valuation shape
//          needed for a genuinely "covered"/"single" result is still
//          UNSPECIFIED — every scenario below bottoms out at
//          status:"unavailable" / reason:"missing_boundary_valuation" once
//          past the checks under test, which is fine for testing C3's
//          validation/classification/segmentation logic in isolation)
//   changes = { at: string, type: string }[] (membership changes)
//   result.segments[i].window = { from, to }
// ---------------------------------------------------------------------------
const c3Base = {
  window: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
  holdings: [] as unknown[],
  positions: [] as unknown[],
  legs: [] as unknown[],
  valuations: [] as unknown[],
  snapshots: [] as unknown[],
  contributions: [] as unknown[],
  withdrawals: [] as unknown[],
  externalFlows: [] as unknown[],
};

describe("C3 computeScopeAwareReturn", () => {
  it("rejects an unparseable window.from as invalid_timestamp", () => {
    const result = computeScopeAwareReturn(
      { ...c3Base, window: { from: "not-a-date", to: c3Base.window.to } } as any,
      [] as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "invalid_timestamp" });
  });

  it("rejects an unparseable membership-change timestamp as invalid_timestamp", () => {
    const result = computeScopeAwareReturn(c3Base as any, [{ at: "not-a-date", type: "remove" }] as any);
    expect(result).toEqual({ status: "unavailable", reason: "invalid_timestamp" });
  });

  it("rejects an unparseable external-flow timestamp as invalid_timestamp", () => {
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: "not-a-date", amount: 1 }] } as any,
      [] as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "invalid_timestamp" });
  });

  it("a flow at or before window.from (<= from) is flow_outside_window", () => {
    const changes = [{ at: "2026-03-01T00:00:00Z", type: "remove" }];
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: c3Base.window.from, amount: 500 }] } as any,
      changes as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_outside_window" });
  });

  it("a flow at or after window.to (>= to) is flow_outside_window", () => {
    const changes = [{ at: "2026-03-01T00:00:00Z", type: "remove" }];
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: c3Base.window.to, amount: 500 }] } as any,
      changes as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_outside_window" });
  });

  it("a flow strictly before window.from is flow_outside_window (does not silently vanish)", () => {
    const changes = [{ at: "2026-03-01T00:00:00Z", type: "remove" }];
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: "2025-12-01T00:00:00Z", amount: 500 }] } as any,
      changes as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_outside_window" });
  });

  it("a flow at the exact same instant/string as a scope break is flow_at_scope_break", () => {
    const breakAt = "2026-03-01T00:00:00Z";
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: breakAt, amount: 500 }] } as any,
      [{ at: breakAt, type: "remove" }] as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_at_scope_break" });
  });

  // C3-3: "다른 ISO 정밀도/오프셋으로 적힌 같은 시각도 같은 것으로 본다."
  //
  // The blind author filed this as a VIOLATION using "2026-03-01T09:00:00-09:00"
  // as "the same instant" as "2026-03-01T00:00:00Z". It is not: a -09:00 offset
  // means UTC = local + 9h, so that string is 18:00Z — nine hours after the
  // break, and correctly assigned to the following segment. The finding was
  // falsified by measurement (main session, 2026-07-27); the offset arithmetic
  // was inverted. The case it MEANT to make is a real one, so it is kept here
  // with instants that actually coincide, in every form the contract names.
  it.each([
    ["identical string", "2026-03-01T00:00:00Z"],
    ["different precision", "2026-03-01T00:00:00.000Z"],
    ["east offset", "2026-03-01T09:00:00+09:00"],
    ["west offset", "2026-02-28T19:00:00-05:00"],
  ])("a flow at the break instant written as %s is flow_at_scope_break", (_label, at) => {
    expect(Date.parse(at)).toBe(Date.parse("2026-03-01T00:00:00Z")); // the premise itself
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at, amount: 500 }] } as any,
      [{ at: "2026-03-01T00:00:00Z", type: "remove" }] as any,
    );
    expect(result).toEqual({ status: "unavailable", reason: "flow_at_scope_break" });
  });

  it("a flow strictly inside a segment is neither flow_outside_window nor flow_at_scope_break", () => {
    const result = computeScopeAwareReturn(
      { ...c3Base, externalFlows: [{ at: "2026-02-01T00:00:00Z", amount: 500 }] } as any,
      [{ at: "2026-03-01T00:00:00Z", type: "remove" }] as any,
    );
    // Whatever this resolves to, it must not be one of the flow-classification
    // rejections — those are reserved for genuinely out-of-window/at-break flows.
    if (result.status === "unavailable") {
      expect(result.reason).not.toBe("flow_outside_window");
      expect(result.reason).not.toBe("flow_at_scope_break");
    }
  });

  it("preserves the caller's original window.from/window.to strings on the outer segment boundaries, even with unusual precision", () => {
    const from = "2026-01-01T00:00:00.000+00:00";
    const to = "2026-06-01T00:00:00Z";
    const result: any = computeScopeAwareReturn(
      { ...c3Base, window: { from, to } } as any,
      [{ at: "2026-03-01T00:00:00Z", type: "remove" }] as any,
    );
    expect(result.status).toBe("scope_break");
    expect(result.segments[0].window.from).toBe(from);
    expect(result.segments[result.segments.length - 1].window.to).toBe(to);
  });

  it("a break inside the window (no flows) produces a segmented result distinct from the no-break path", () => {
    const withBreak: any = computeScopeAwareReturn(c3Base as any, [{ at: "2026-03-01T00:00:00Z", type: "remove" }] as any);
    const withoutBreak: any = computeScopeAwareReturn(c3Base as any, [] as any);
    expect(withBreak.status).toBe("scope_break");
    expect(withoutBreak.status).not.toBe("scope_break");
  });
});
