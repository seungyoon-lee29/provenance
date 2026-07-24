import type { Brand } from "@/shared/contracts/brands";

import type { ReportingMoney } from "./contracts";

/**
 * Actual-account reference brands and the position/transfer data shapes that the
 * surviving pure calculation functions accept as input. Moved here in Stage 2 T4
 * when `actual-portfolio` was trimmed to `calculation/` only: these were the sole
 * dependencies `corporate-actions`, `rebalancing` and `transfers` had on the
 * deleted `baseline/` (branded refs, live valuation) and `journal/` (accounting
 * events) layers. The layers that *produced* these shapes are gone; a backtest
 * (T8+) supplies them instead. §8 semantics (coverage typing, no partial
 * promotion) live in the functions, not here.
 *
 * ponytail: the shapes are moved verbatim, not re-sliced to only the fields each
 * function reads — that keeps the F7 tests and every type identical (a narrower
 * shape would trip excess-property checks in the test constructors). Narrow if it
 * ever drifts. `Money`/`ReportingMoney` were structurally identical, so the
 * position rows now carry `ReportingMoney` rather than a duplicate money type.
 */

export type ActualAccountReference = Brand<string, "ActualAccountReference">;
export type ActualInstrumentReference = Brand<string, "ActualInstrumentReference">;
/** Provenance of a user assertion (manual entry, imported statement, …). */
export type ActualSourceReference = Brand<string, "ActualSourceReference">;

export type PositionRow = Readonly<{
  instrument: string;
  signedQuantity: number;
  aggregateLot: boolean;
  asOf: string;
  source: string;
  /** Position-currency market value, present when the price is known. */
  originalValue?: ReportingMoney;
  /** Reporting-currency value, present when price AND fx are known. */
  reportingValue?: ReportingMoney;
}>;

export type ValuedPositionRow = PositionRow & Readonly<{ weight: number }>;

export type MissingValuation = Readonly<{ instrument: string; reason: "price" | "fx" }>;

export type PositionsSection =
  | Readonly<{ completeness: "complete"; total: ReportingMoney; rows: readonly ValuedPositionRow[] }>
  | Readonly<{ completeness: "partial"; knownSubtotal: ReportingMoney; missing: readonly MissingValuation[]; rows: readonly PositionRow[] }>
  | Readonly<{ completeness: "unavailable"; missing: readonly MissingValuation[]; rows: readonly PositionRow[] }>;

export type PortfolioTransfer = Readonly<{
  kind: "portfolio_transfer";
  /** The in-scope account whose ledger records the transfer. */
  account: ActualAccountReference;
  counterparty:
    | Readonly<{ kind: "internal"; account: ActualAccountReference }>
    | Readonly<{ kind: "external" }>;
  direction: "in" | "out";
  instrument?: ActualInstrumentReference;
  quantity?: number;
  occurredAt: string;
  /** Evidence-based fair value — required for a boundary transfer to become a return flow (§8). */
  fairValue?: ReportingMoney;
  source: ActualSourceReference;
}>;
