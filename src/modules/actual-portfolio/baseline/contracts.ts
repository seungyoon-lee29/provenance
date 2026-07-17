import type { Brand } from "@/shared/contracts/brands";

/**
 * F6 Actual Portfolio baseline contracts (spec §6/§8, UF-06, ADR A04).
 *
 * Every reference here is an Actual-owned brand: an Actual account, journal
 * entry or instrument can never be passed where a Paper reference is expected
 * (and vice versa) — the ledgers share no types, storage or revisions. The
 * journal records only what the user asserted (opening aggregate lots, manual
 * positions, activities) plus append-only corrections; nothing here models
 * derived history (tax lots, realized P&L, holding periods) by construction.
 */

export type ActualAccountReference = Brand<string, "ActualAccountReference">;
export type ActualJournalEntryReference = Brand<string, "ActualJournalEntryReference">;
export type ActualInstrumentReference = Brand<string, "ActualInstrumentReference">;
/** Provenance of a user assertion (manual entry, imported statement, …). */
export type ActualSourceReference = Brand<string, "ActualSourceReference">;

export type SourceMoney = Readonly<{
  amount: number;
  currency: string;
  /** Preserved exactly as the source stated it — never re-derived. */
  includesFees?: boolean;
}>;

/**
 * A synthetic aggregate lot as of a baseline date (spec §8): quantity and the
 * source-stated cost basis only. No transaction history is reconstructed.
 */
export type OpeningPosition = Readonly<{
  instrument: ActualInstrumentReference;
  signedQuantity: number;
  currency: string;
  /** The baseline date the aggregate lot represents. */
  asOf: string;
  source: ActualSourceReference;
  sourceCostBasis?: SourceMoney;
}>;

export type ManualPosition = Readonly<{
  instrument: ActualInstrumentReference;
  signedQuantity: number;
  currency: string;
  asOf: string;
  source: ActualSourceReference;
  sourceCostBasis?: SourceMoney;
  /** Whether the user asserts this row fully describes the holding. */
  completeness: "complete" | "partial";
}>;

export type PortfolioActivity = Readonly<{
  activityKind: "cash_deposit" | "cash_withdrawal" | "buy" | "sell" | "fee" | "other";
  instrument?: ActualInstrumentReference;
  signedQuantity?: number;
  signedCashAmount?: Readonly<{ amount: number; currency: string }>;
  occurredAt: string;
  source: ActualSourceReference;
}>;

export type ActualRecordPayload =
  | Readonly<{ kind: "opening_position"; position: OpeningPosition }>
  | Readonly<{ kind: "manual_position"; position: ManualPosition }>
  | Readonly<{ kind: "portfolio_activity"; activity: PortfolioActivity }>;

export type ActualPortfolioCommand =
  | Readonly<{ kind: "record_opening_position"; account: ActualAccountReference; position: OpeningPosition }>
  | Readonly<{ kind: "record_manual_position"; account: ActualAccountReference; position: ManualPosition }>
  | Readonly<{ kind: "record_activity"; account: ActualAccountReference; activity: PortfolioActivity }>
  | Readonly<{ kind: "supersede_entry"; account: ActualAccountReference; target: ActualJournalEntryReference; replacement: ActualRecordPayload }>
  | Readonly<{ kind: "reverse_entry"; account: ActualAccountReference; target: ActualJournalEntryReference; reason: string }>;

/** A source row is never mutated; corrections append these entry kinds. */
export type ActualJournalEntry = Readonly<
  {
    entryReference: ActualJournalEntryReference;
    account: ActualAccountReference;
    revision: number;
    recordedAt: string;
  } & (
    | { kind: "opening_position"; position: OpeningPosition }
    | { kind: "manual_position"; position: ManualPosition }
    | { kind: "portfolio_activity"; activity: PortfolioActivity }
    | { kind: "superseding"; supersedes: ActualJournalEntryReference; replacement: ActualRecordPayload }
    | { kind: "reversal"; reverses: ActualJournalEntryReference; reason: string }
  )
>;

export type ActualCommandOutcome =
  | Readonly<{ status: "applied"; revision: number; entryReference: ActualJournalEntryReference }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "rejected"; currentRevision: number }>
  | Readonly<{ status: "refused"; reason: "unknown_entry" }>
  | Readonly<{ status: "suppressed" }>;
