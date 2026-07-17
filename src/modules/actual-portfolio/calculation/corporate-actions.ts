import type { ActualInstrumentReference } from "../baseline/contracts";

export type CorporateAction =
  | Readonly<{ actionReference: string; kind: "split"; instrument: ActualInstrumentReference; effectiveAt: string; ratio: number }>
  | Readonly<{
      actionReference: string;
      kind: "merger" | "spin_off";
      instrument: ActualInstrumentReference;
      effectiveAt: string;
      basisAllocation?: Readonly<{ continuing: number; spun?: number }>;
    }>
  | Readonly<{ actionReference: string; kind: "delisting"; instrument: ActualInstrumentReference; effectiveAt: string }>;

/**
 * `raw` carries historical prints; `split_restated` has splits already baked
 * in; `total_return_adjusted` bakes dividends into prices and is REJECTED for
 * account P&L input (§8) — combined with dividend entitlements it would count
 * the same income twice.
 */
export type PriceBasis = "raw" | "split_restated" | "total_return_adjusted";

export type SeriesPoint = Readonly<{ at: string; price: number }>;

/** A single instrument's series per call (ponytail: multi-instrument filtering lands with the F11 wiring). */
export type AccountingSeriesInput = Readonly<{
  basis: PriceBasis;
  points: readonly SeriesPoint[];
  actions: readonly CorporateAction[];
}>;

export type AccountingSeriesResult =
  | Readonly<{ status: "covered"; points: readonly SeriesPoint[]; delistedAt?: string }>
  | Readonly<{
      status: "unavailable";
      reason: "total_return_basis_rejected" | "duplicate_action" | "incomplete_corporate_action_basis" | "post_delisting_price";
    }>;

/**
 * Quantity factor restating a holding AT `at` in final post-split terms:
 * the product of the ratios of splits effective after `at` (10 shares before
 * a 2:1 split are 20 after). Prices divide by the same factor, which is what
 * makes raw + adjustment equal an already-restated series exactly (AT-06).
 */
export function splitQuantityFactor(actions: readonly CorporateAction[], at: string): number {
  let factor = 1;
  for (const action of actions) {
    if (action.kind === "split" && action.effectiveAt > at) factor *= action.ratio;
  }
  return factor;
}

/**
 * Applies corporate actions to a price series exactly once, fail closed
 * (spec §8 / AT-06): duplicate action references, an incomplete merger or
 * spin-off basis, a total-return basis, or a price at/after a delisting all
 * yield `unavailable` — never a silently adjusted (or double-adjusted) number.
 */
export function resolveAccountingSeries(input: AccountingSeriesInput): AccountingSeriesResult {
  if (input.basis === "total_return_adjusted") {
    return { status: "unavailable", reason: "total_return_basis_rejected" };
  }

  const seen = new Set<string>();
  for (const action of input.actions) {
    if (seen.has(action.actionReference)) return { status: "unavailable", reason: "duplicate_action" };
    seen.add(action.actionReference);
    if ((action.kind === "merger" || action.kind === "spin_off") && action.basisAllocation === undefined) {
      return { status: "unavailable", reason: "incomplete_corporate_action_basis" };
    }
  }

  let delistedAt: string | undefined;
  for (const action of input.actions) {
    if (action.kind === "delisting" && (delistedAt === undefined || action.effectiveAt < delistedAt)) {
      delistedAt = action.effectiveAt;
    }
  }
  if (delistedAt !== undefined && input.points.some((point) => point.at >= (delistedAt ?? ""))) {
    return { status: "unavailable", reason: "post_delisting_price" };
  }

  const points = input.basis === "raw"
    ? input.points.map((point) => ({ at: point.at, price: point.price / splitQuantityFactor(input.actions, point.at) }))
    : [...input.points];

  return delistedAt === undefined
    ? { status: "covered", points }
    : { status: "covered", points, delistedAt };
}
