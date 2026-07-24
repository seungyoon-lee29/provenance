import type { PositionsSection } from "./actual-refs";
import type { ReportingMoney } from "./contracts";

export type TargetAllocation = Readonly<{
  weights: Readonly<Record<string, number>>;
  policyVersion: string;
}>;

export type ExposureGuardrail = Readonly<{ maxInstrumentWeight: number }>;

export type RebalancingRow = Readonly<{
  instrument: string;
  currentWeight: number;
  targetWeight: number;
  /** current − target; positive means overweight. */
  drift: number;
  /** Reporting-currency amount to move toward target (target·total − current). */
  deltaAmount: ReportingMoney;
}>;

export type GuardrailOutcome =
  | Readonly<{ status: "not_configured" }>
  | Readonly<{ status: "evaluated"; breaches: readonly Readonly<{ instrument: string; weight: number; limit: number }>[] }>;

/**
 * A Rebalancing Proposal is DATA about drift — it carries no order, submit or
 * account payload and no methods, so there is no path from here to any order
 * lane (AT-06: guardrail만으로 주문 0, Actual→Paper 변환 method 0).
 */
export type RebalancingEvaluation =
  | Readonly<{ status: "not_configured" }>
  | Readonly<{ status: "unavailable"; reason: "incomplete_total" | "invalid_target" }>
  | Readonly<{ status: "proposed"; policyVersion: string; rows: readonly RebalancingRow[]; guardrail: GuardrailOutcome }>;

export type RebalancingInput = Readonly<{
  positions: PositionsSection;
  target?: TargetAllocation;
  guardrail?: ExposureGuardrail;
}>;

/**
 * Target Allocation / Exposure Guardrail evaluation (spec §8 / AT-06):
 * no target → `not_configured`; anything short of a complete total →
 * `unavailable` (a known subtotal is never promoted into a proposal base);
 * the guardrail is evaluated only when configured.
 */
export function evaluateRebalancing(input: RebalancingInput): RebalancingEvaluation {
  if (input.target === undefined) return { status: "not_configured" };
  if (input.positions.completeness !== "complete") {
    return { status: "unavailable", reason: "incomplete_total" };
  }

  const weightSum = Object.values(input.target.weights).reduce((sum, weight) => sum + weight, 0);
  const wellFormed = Math.abs(weightSum - 1) <= 1e-9
    && Object.values(input.target.weights).every((weight) => weight >= 0);
  if (!wellFormed) return { status: "unavailable", reason: "invalid_target" };

  const total = input.positions.total.amount;
  const currency = input.positions.total.currency;
  const currentByInstrument = new Map(
    input.positions.rows.map((row) => [row.instrument, { weight: row.weight, value: row.reportingValue?.amount ?? 0 }]),
  );

  const instruments = [...new Set([...currentByInstrument.keys(), ...Object.keys(input.target.weights)])].sort();
  const rows: RebalancingRow[] = instruments.map((instrument) => {
    const current = currentByInstrument.get(instrument) ?? { weight: 0, value: 0 };
    const targetWeight = input.target?.weights[instrument] ?? 0;
    return {
      instrument,
      currentWeight: current.weight,
      targetWeight,
      drift: current.weight - targetWeight,
      deltaAmount: { amount: targetWeight * total - current.value, currency },
    };
  });

  const guardrail: GuardrailOutcome = input.guardrail === undefined
    ? { status: "not_configured" }
    : {
        status: "evaluated",
        breaches: input.positions.rows
          .filter((row) => row.weight > (input.guardrail?.maxInstrumentWeight ?? Number.POSITIVE_INFINITY))
          .map((row) => ({ instrument: row.instrument, weight: row.weight, limit: input.guardrail?.maxInstrumentWeight ?? 0 })),
      };

  return { status: "proposed", policyVersion: input.target.policyVersion, rows, guardrail };
}
