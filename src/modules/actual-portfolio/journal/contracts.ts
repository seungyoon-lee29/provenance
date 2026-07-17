import type { Brand } from "@/shared/contracts/brands";

import type {
  ActualAccountReference,
  ActualInstrumentReference,
  ActualSourceReference,
} from "../baseline/contracts";
import type { ReportingMoney } from "../calculation/contracts";
import type { CorporateAction } from "../calculation/corporate-actions";

/**
 * F7 accounting journal contracts (spec §8 / AT-06): dividend entitlements,
 * portfolio transfers and corporate-action records are F7-owned accounting
 * events, kept in their OWN append-only journal layered beside the F6
 * baseline journal (whose public contract stays untouched). Corrections
 * append superseding/reversal entries; source rows are never mutated.
 */

export type AccountingEventReference = Brand<string, "AccountingEventReference">;

export type DividendEntitlement = Readonly<{
  kind: "dividend_entitlement";
  account: ActualAccountReference;
  instrument: ActualInstrumentReference;
  exDate: string;
  amountPerShare: ReportingMoney;
  source: ActualSourceReference;
}>;

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

export type CorporateActionRecord = Readonly<{
  kind: "corporate_action_record";
  account: ActualAccountReference;
  action: CorporateAction;
  source: ActualSourceReference;
}>;

export type AccountingEvent = DividendEntitlement | PortfolioTransfer | CorporateActionRecord;

export type AccountingEntry = Readonly<
  {
    eventReference: AccountingEventReference;
    account: ActualAccountReference;
    sequence: number;
    recordedAt: string;
  } & (
    | { kind: "event"; event: AccountingEvent }
    | { kind: "superseding"; supersedes: AccountingEventReference; replacement: AccountingEvent }
    | { kind: "reversal"; reverses: AccountingEventReference; reason: string }
  )
>;

export type AccountingAppendOutcome =
  | Readonly<{ status: "applied"; sequence: number; eventReference: AccountingEventReference }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "refused"; reason: "unknown_event" | "already_corrected" }>
  | Readonly<{ status: "suppressed" }>;
