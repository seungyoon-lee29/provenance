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
 */
export function computePortfolioReturn(input: PerformanceInput): PortfolioReturnResult {
  const { window } = input;
  if (window.from >= window.to) return { status: "unavailable", reason: "empty_window" };

  const currency = input.valuations[0]?.value.currency;
  if (currency === undefined) return { status: "unavailable", reason: "missing_boundary_valuation" };
  const sameCurrency = input.valuations.every((point) => point.value.currency === currency)
    && input.externalFlows.every((flow) => flow.amount.currency === currency);
  if (!sameCurrency) return { status: "unavailable", reason: "mixed_currency" };

  for (const flow of input.externalFlows) {
    if (flow.at <= window.from || flow.at >= window.to) {
      return { status: "unavailable", reason: "flow_outside_window" };
    }
  }

  const valuationAt = new Map<string, number>();
  for (const point of input.valuations) valuationAt.set(point.at, point.value.amount);
  if (!valuationAt.has(window.from) || !valuationAt.has(window.to)) {
    return { status: "unavailable", reason: "missing_boundary_valuation" };
  }

  const flowTotals = new Map<string, number>();
  for (const flow of input.externalFlows) {
    flowTotals.set(flow.at, (flowTotals.get(flow.at) ?? 0) + flow.amount.amount);
  }
  for (const at of flowTotals.keys()) {
    if (!valuationAt.has(at)) return { status: "unavailable", reason: "missing_valuation_at_flow" };
  }

  const cuts = [window.from, ...[...flowTotals.keys()].sort(), window.to];
  const subPeriods: SubPeriodReturn[] = [];
  let linked = 1;
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const from = cuts[index];
    const to = cuts[index + 1];
    if (from === undefined || to === undefined) continue;
    const base = (valuationAt.get(from) ?? 0) + (flowTotals.get(from) ?? 0);
    if (base <= 0) return { status: "unavailable", reason: "zero_or_negative_base" };
    const ratio = (valuationAt.get(to) ?? 0) / base;
    subPeriods.push({ from, to, ratio });
    linked *= ratio;
  }

  return { status: "covered", timeWeightedReturn: linked - 1, subPeriods };
}
