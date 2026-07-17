import type {
  PerformanceInput,
  PortfolioReturnResult,
  SubPeriodReturn,
} from "./contracts";

/**
 * Portfolio Return = time-weighted return (spec §8): the window is split at
 * each external-flow instant, each sub-period grows from the previous
 * pre-flow valuation plus the flows applied at its start, and the sub-period
 * ratios are linked geometrically. This removes the effect of flow size and
 * timing — only the portfolio's own growth remains (AT-05).
 *
 * Convention: a valuation point at a flow instant is the PRE-flow value; the
 * flow lands after it and forms the next sub-period's base.
 *
 * All instants are normalized through `Date.parse` so equal instants written
 * with different ISO precision ("…00Z" vs "…00.000Z") collapse to one cut —
 * an unparseable timestamp fails closed (adversarial panel 2026-07-18: raw
 * string keys let a boundary flow slip past the window guard as a phantom
 * zero-duration sub-period).
 */
export function computePortfolioReturn(input: PerformanceInput): PortfolioReturnResult {
  const fromMs = Date.parse(input.window.from);
  const toMs = Date.parse(input.window.to);
  const instants = [
    fromMs,
    toMs,
    ...input.valuations.map((point) => Date.parse(point.at)),
    ...input.externalFlows.map((flow) => Date.parse(flow.at)),
  ];
  if (instants.some(Number.isNaN)) return { status: "unavailable", reason: "invalid_timestamp" };
  if (fromMs >= toMs) return { status: "unavailable", reason: "empty_window" };

  const currency = input.valuations[0]?.value.currency;
  if (currency === undefined) return { status: "unavailable", reason: "missing_boundary_valuation" };
  const sameCurrency = input.valuations.every((point) => point.value.currency === currency)
    && input.externalFlows.every((flow) => flow.amount.currency === currency);
  if (!sameCurrency) return { status: "unavailable", reason: "mixed_currency" };

  for (const flow of input.externalFlows) {
    const flowMs = Date.parse(flow.at);
    if (flowMs <= fromMs || flowMs >= toMs) {
      return { status: "unavailable", reason: "flow_outside_window" };
    }
  }

  const valuationAt = new Map<number, number>();
  for (const point of input.valuations) valuationAt.set(Date.parse(point.at), point.value.amount);
  if (!valuationAt.has(fromMs) || !valuationAt.has(toMs)) {
    return { status: "unavailable", reason: "missing_boundary_valuation" };
  }

  const flowTotals = new Map<number, number>();
  for (const flow of input.externalFlows) {
    const flowMs = Date.parse(flow.at);
    flowTotals.set(flowMs, (flowTotals.get(flowMs) ?? 0) + flow.amount.amount);
  }
  for (const at of flowTotals.keys()) {
    if (!valuationAt.has(at)) return { status: "unavailable", reason: "missing_valuation_at_flow" };
  }

  const cuts = [fromMs, ...[...flowTotals.keys()].sort((left, right) => left - right), toMs];
  const subPeriods: SubPeriodReturn[] = [];
  let linked = 1;
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const from = cuts[index];
    const to = cuts[index + 1];
    if (from === undefined || to === undefined) continue;
    const base = (valuationAt.get(from) ?? 0) + (flowTotals.get(from) ?? 0);
    const end = valuationAt.get(to) ?? 0;
    // A non-positive base OR end value makes the ratio financially meaningless
    // (no short-book TWR semantics in this contract) — fail closed.
    if (base <= 0 || end <= 0) return { status: "unavailable", reason: "zero_or_negative_base" };
    const ratio = end / base;
    subPeriods.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ratio });
    linked *= ratio;
  }

  return { status: "covered", timeWeightedReturn: linked - 1, subPeriods };
}
