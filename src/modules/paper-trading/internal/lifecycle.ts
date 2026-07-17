import type { InternalPaperAccountReference } from "../../../shared/contracts/brands";

import type { PaperCorporateActionReference, PaperInstrumentReference, PaperMoney } from "./contracts";
import type { PaperJournal } from "./journal";

/**
 * F8 server-only lifecycle ingestion (spec §9, AT-06): Corporate Action
 * Adjustments and dividend entitlements applied to Internal Paper accounts.
 *
 * Each action is idempotent by its action reference — a redelivery is a
 * duplicate no-op. The transformation itself lives in the journal fold, so an
 * applied split flips order event, Paper Reservation, position and basis
 * all-old/all-new at exactly one revision: no observer can see a half-applied
 * state. Validation runs against the folded state BEFORE anything is
 * appended, so a refused action leaves no record and no side effect.
 */

export type SplitAdjustment = Readonly<{
  action: PaperCorporateActionReference;
  instrument: PaperInstrumentReference;
  numerator: number;
  denominator: number;
}>;

export type DividendEntitlement = Readonly<{
  action: PaperCorporateActionReference;
  instrument: PaperInstrumentReference;
  /** Cash rate per held share. ponytail: entitlement is the position at
   * application time; as-of/ex-date entitlement when a real calendar lands. */
  perShare: PaperMoney;
}>;

export type LifecycleOutcome =
  | Readonly<{ status: "applied"; revision: number }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "suppressed" }>
  | Readonly<{ status: "refused"; reason: "invalid_adjustment" | "fractional_result" }>;

export class PaperLifecycleIngestion {
  constructor(private readonly deps: Readonly<{ journal: PaperJournal }>) {}

  applySplit(workspace: string, account: InternalPaperAccountReference, split: SplitAdjustment): LifecycleOutcome {
    const { numerator, denominator } = split;
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) {
      return { status: "refused", reason: "invalid_adjustment" };
    }
    // Fail closed on any transformation that would break whole-share lots
    // (initial product scope). ponytail: cash-in-lieu is the upgrade path.
    const state = this.deps.journal.state(workspace, account);
    const instrument = String(split.instrument);
    const wholeShares = (quantity: number) => Number.isInteger((quantity * numerator) / denominator);
    const position = state.positions.get(instrument);
    if (position !== undefined && !wholeShares(position.quantity)) {
      return { status: "refused", reason: "fractional_result" };
    }
    for (const order of state.orders.values()) {
      if (String(order.payload.instrument) !== instrument) continue;
      if (order.execution !== "open" && order.execution !== "partially_filled") continue;
      if (!wholeShares(order.payload.quantity) || !wholeShares(order.filledQuantity)) {
        return { status: "refused", reason: "fractional_result" };
      }
    }

    return this.deps.journal.appendSystem(workspace, account, String(split.action), {
      kind: "corporate_action_applied",
      action: split.action,
      instrument: split.instrument,
      adjustment: { kind: "split", numerator, denominator },
    });
  }

  applyDividend(workspace: string, account: InternalPaperAccountReference, dividend: DividendEntitlement): LifecycleOutcome {
    if (!Number.isFinite(dividend.perShare.amount) || dividend.perShare.amount <= 0) {
      return { status: "refused", reason: "invalid_adjustment" };
    }
    return this.deps.journal.appendSystem(workspace, account, String(dividend.action), {
      kind: "dividend_applied",
      action: dividend.action,
      instrument: dividend.instrument,
      perShare: dividend.perShare,
    });
  }
}
