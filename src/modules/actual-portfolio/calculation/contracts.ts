/**
 * F7 portfolio accounting calculation contracts (spec §8, AT-05/06).
 *
 * Everything here is coverage-typed: a return or P&L value exists ONLY on the
 * covered variant. Outside Performance Coverage — a missing valuation at a
 * flow instant, a missing window boundary, a meaningless base — the result is
 * `unavailable` with a named reason and carries no number at all (§8: no
 * estimation, no partial promotion). Inputs are already-typed reporting
 * currency values produced upstream from `PortfolioEvidenceResolver` envelopes;
 * this module never reads raw Evidence or provider payloads.
 */

export type ReportingMoney = Readonly<{ amount: number; currency: string }>;

/** Portfolio value at an instant, in the reporting currency. */
export type ValuationPoint = Readonly<{ at: string; value: ReportingMoney }>;

/**
 * An external cash flow crossing the Portfolio Scope boundary (deposit +,
 * withdrawal −). Transfers inside the scope are NOT external flows (§8).
 */
export type ExternalFlow = Readonly<{ at: string; amount: ReportingMoney }>;

export type PerformanceWindow = Readonly<{ from: string; to: string }>;

export type PerformanceInput = Readonly<{
  window: PerformanceWindow;
  /**
   * Valuations from evidence. The engine requires a point at each window
   * boundary and at each external-flow instant (the pre-flow value); it never
   * interpolates a missing one.
   */
  valuations: readonly ValuationPoint[];
  externalFlows: readonly ExternalFlow[];
}>;

export type SubPeriodReturn = Readonly<{ from: string; to: string; ratio: number }>;

export type PerformanceUnavailableReason =
  | "empty_window"
  | "missing_boundary_valuation"
  | "missing_valuation_at_flow"
  | "zero_or_negative_base"
  | "flow_outside_window"
  | "mixed_currency";

export type PortfolioReturnResult =
  | Readonly<{ status: "covered"; timeWeightedReturn: number; subPeriods: readonly SubPeriodReturn[] }>
  | Readonly<{ status: "unavailable"; reason: PerformanceUnavailableReason }>;
