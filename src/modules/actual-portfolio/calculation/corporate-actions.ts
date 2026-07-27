import type { ActualInstrumentReference } from "./actual-refs";

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
      reason:
        | "total_return_basis_rejected"
        | "duplicate_action"
        | "incomplete_corporate_action_basis"
        | "post_delisting_price"
        | "invalid_timestamp";
    }>;

/**
 * Quantity factor restating a holding AT `at` in final post-split terms:
 * the product of the ratios of splits effective after `at` (10 shares before
 * a 2:1 split are 20 after). Prices divide by the same factor, which is what
 * makes raw + adjustment equal an already-restated series exactly (AT-06).
 *
 * Instants are normalized through `Date.parse` before comparison, matching the
 * TWR engine. ISO strings do NOT sort chronologically across offsets — KRX's
 * "2024-03-05T00:00:00+09:00" is a full nine hours BEFORE "2024-03-04T16:00:01Z"
 * yet sorts after it lexicographically — so a raw string compare applies a
 * split on the wrong side of `at` and silently mis-restates every price from
 * there on. An unparseable instant yields a false comparison here; the module
 * boundary (`resolveAccountingSeries`) refuses it outright instead.
 */
export function splitQuantityFactor(actions: readonly CorporateAction[], at: string): number {
  const atMs = Date.parse(at);
  let factor = 1;
  for (const action of actions) {
    if (action.kind === "split" && Date.parse(action.effectiveAt) > atMs) factor *= action.ratio;
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

  // Every instant this function orders must at least PARSE, which is what lets
  // the comparisons below be plain numeric ones.
  // Scope of this check, stated exactly (it is weaker than it looks): `Date.parse`
  // silently normalizes an impossible calendar date (2026-02-30 → 2026-03-02) and
  // reads a timezone-less string in the machine's LOCAL zone, so neither is caught
  // here. `backtest-runner.ts` already refuses both via private `isCalendarDate`
  // and `hasTimezone` helpers (earlier codex gates) — this module, on the return
  // path, never got them. Hardening that is a follow-up; do not read this guard
  // as "the instant is real".
  const instants = [
    ...input.actions.map((action) => Date.parse(action.effectiveAt)),
    ...input.points.map((point) => Date.parse(point.at)),
  ];
  if (instants.some(Number.isNaN)) return { status: "unavailable", reason: "invalid_timestamp" };

  const seen = new Set<string>();
  for (const action of input.actions) {
    if (seen.has(action.actionReference)) return { status: "unavailable", reason: "duplicate_action" };
    seen.add(action.actionReference);
    if ((action.kind === "merger" || action.kind === "spin_off") && action.basisAllocation === undefined) {
      return { status: "unavailable", reason: "incomplete_corporate_action_basis" };
    }
  }

  // EARLIEST delisting wins, ordered by instant — the string minimum picked the
  // wrong action across mixed offsets and then let post-delisting prices through.
  let delisted: Readonly<{ at: string; ms: number }> | undefined;
  for (const action of input.actions) {
    if (action.kind !== "delisting") continue;
    const ms = Date.parse(action.effectiveAt);
    if (delisted === undefined || ms < delisted.ms) delisted = { at: action.effectiveAt, ms };
  }
  const delistedMs = delisted?.ms;
  if (delistedMs !== undefined && input.points.some((point) => Date.parse(point.at) >= delistedMs)) {
    return { status: "unavailable", reason: "post_delisting_price" };
  }

  const points = input.basis === "raw"
    ? input.points.map((point) => ({ at: point.at, price: point.price / splitQuantityFactor(input.actions, point.at) }))
    : [...input.points];

  return delisted === undefined
    ? { status: "covered", points }
    : { status: "covered", points, delistedAt: delisted.at };
}
