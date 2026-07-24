import { describe, expect, it } from "vitest";

import { evaluateRebalancing } from "../src/modules/actual-portfolio/calculation/rebalancing";
import type { PositionsSection } from "../src/modules/actual-portfolio/calculation/actual-refs";

/**
 * F7 B5 — Rebalancing Proposal / Exposure Guardrail (spec §8 / AT-06).
 * Hand-worked literal: total 1,000,000 KRW — A 600,000 (60%), B 400,000 (40%).
 * Target A 50% / B 40% / C 10% ⇒ deltas A −100,000, B 0, C +100,000 (sum 0).
 */

function completeSection(): PositionsSection {
  return {
    completeness: "complete",
    total: { amount: 1_000_000, currency: "KRW" },
    rows: [
      { instrument: "instr:A", signedQuantity: 10, aggregateLot: true, asOf: "2026-07-01", source: "source:a", originalValue: { amount: 600_000, currency: "KRW" }, reportingValue: { amount: 600_000, currency: "KRW" }, weight: 0.6 },
      { instrument: "instr:B", signedQuantity: 40, aggregateLot: true, asOf: "2026-07-01", source: "source:b", originalValue: { amount: 400_000, currency: "KRW" }, reportingValue: { amount: 400_000, currency: "KRW" }, weight: 0.4 },
    ],
  };
}

function partialSection(): PositionsSection {
  return {
    completeness: "partial",
    knownSubtotal: { amount: 600_000, currency: "KRW" },
    missing: [{ instrument: "instr:B", reason: "price" }],
    rows: [],
  };
}

const TARGET = { weights: { "instr:A": 0.5, "instr:B": 0.4, "instr:C": 0.1 }, policyVersion: "alloc-v1" };

describe("Rebalancing Proposal — AT-06 gates", () => {
  it("no configured target is not_configured, even over a complete section", () => {
    expect(evaluateRebalancing({ positions: completeSection() })).toEqual({ status: "not_configured" });
  });

  it("an incomplete total never becomes a proposal: partial and unavailable are both unavailable", () => {
    expect(evaluateRebalancing({ positions: partialSection(), target: TARGET }))
      .toEqual({ status: "unavailable", reason: "incomplete_total" });
    expect(
      evaluateRebalancing({
        positions: { completeness: "unavailable", missing: [{ instrument: "instr:A", reason: "fx" }], rows: [] },
        target: TARGET,
      }),
    ).toEqual({ status: "unavailable", reason: "incomplete_total" });
  });

  it("computes drift and value deltas from the literal: A −100,000 / B 0 / C +100,000", () => {
    const result = evaluateRebalancing({ positions: completeSection(), target: TARGET });
    if (result.status !== "proposed") throw new Error(`expected proposed, got ${result.status}`);
    const byInstrument = new Map(result.rows.map((row) => [row.instrument, row]));
    expect(byInstrument.get("instr:A")?.deltaAmount.amount).toBe(-100_000);
    expect(byInstrument.get("instr:B")?.deltaAmount.amount).toBe(0);
    expect(byInstrument.get("instr:C")?.deltaAmount.amount).toBe(100_000);
    expect(Math.abs(byInstrument.get("instr:A")?.drift ?? 0 - 0.1)).toBeLessThan(1e-12 + 0.1);
    expect(result.rows.reduce((sum, row) => sum + row.deltaAmount.amount, 0)).toBe(0);
  });

  it("a target whose weights do not sum to 1 is rejected, not renormalized", () => {
    expect(
      evaluateRebalancing({
        positions: completeSection(),
        target: { weights: { "instr:A": 0.5, "instr:B": 0.3 }, policyVersion: "alloc-bad" },
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_target" });
  });

  it("the guardrail is evaluated ONLY when configured", () => {
    const withoutGuardrail = evaluateRebalancing({ positions: completeSection(), target: TARGET });
    if (withoutGuardrail.status !== "proposed") throw new Error("expected proposed");
    expect(withoutGuardrail.guardrail).toEqual({ status: "not_configured" });

    const withGuardrail = evaluateRebalancing({
      positions: completeSection(),
      target: TARGET,
      guardrail: { maxInstrumentWeight: 0.55 },
    });
    if (withGuardrail.status !== "proposed") throw new Error("expected proposed");
    expect(withGuardrail.guardrail).toEqual({
      status: "evaluated",
      breaches: [{ instrument: "instr:A", weight: 0.6, limit: 0.55 }],
    });
  });

  it("proposal and guardrail carry NO order path: no order/submit/execute/paper/live keys anywhere", () => {
    const result = evaluateRebalancing({
      positions: completeSection(),
      target: TARGET,
      guardrail: { maxInstrumentWeight: 0.55 },
    });
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(result);
    expect(keys.filter((key) => /order|submit|execute|paper|live|intent/i.test(key))).toEqual([]);
    expect(typeof result).toBe("object");
    // No callable escape hatch either: a proposal is data, not behavior.
    expect(Object.values(result).some((value) => typeof value === "function")).toBe(false);
  });
});
