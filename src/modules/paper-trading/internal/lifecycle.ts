import type { InternalPaperAccountReference } from "../../../shared/contracts/brands";

import type { PaperCorporateActionReference, PaperInstrumentReference, PaperMoney } from "./contracts";
import type { PaperJournal, SystemAppendOutcome } from "./journal";

/**
 * F8 server-only lifecycle ingestion (spec §9, AT-06): Corporate Action
 * Adjustments and dividend entitlements applied to Internal Paper accounts.
 *
 * Each action is idempotent by its action reference — a redelivery is a
 * duplicate no-op. All validation lives at the journal boundary
 * (validateSystemBody), where the dedupe check runs FIRST: a redelivered
 * action must never be re-validated against the already-transformed state.
 * The transformation itself lives in the journal fold, so an applied split
 * flips order event, Paper Reservation, position and basis all-old/all-new at
 * exactly one revision: no observer can see a half-applied state.
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

export class PaperLifecycleIngestion {
  constructor(private readonly deps: Readonly<{ journal: PaperJournal }>) {}

  applySplit(workspace: string, account: InternalPaperAccountReference, split: SplitAdjustment): Promise<SystemAppendOutcome> {
    return this.deps.journal.appendSystem(workspace, account, String(split.action), {
      kind: "corporate_action_applied",
      action: split.action,
      instrument: split.instrument,
      adjustment: { kind: "split", numerator: split.numerator, denominator: split.denominator },
    });
  }

  applyDividend(workspace: string, account: InternalPaperAccountReference, dividend: DividendEntitlement): Promise<SystemAppendOutcome> {
    return this.deps.journal.appendSystem(workspace, account, String(dividend.action), {
      kind: "dividend_applied",
      action: dividend.action,
      instrument: dividend.instrument,
      perShare: dividend.perShare,
    });
  }
}
