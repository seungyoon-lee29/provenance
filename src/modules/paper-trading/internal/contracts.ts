import type { Brand, InternalPaperAccountReference, PaperOrderReference } from "@/shared/contracts/brands";

/**
 * F8 Internal Paper Trading contracts (spec §9, UF-07, AT-07; ADR A04).
 *
 * Every reference is a Paper-owned brand: an Internal Paper account, order,
 * intent or fill can never be passed where an Actual reference is expected
 * (and vice versa) — the ledgers share no types, storage or revisions. The
 * three order state axes (submission / execution / cancellation) are
 * independent fields by construction; no combined enum exists that could
 * collapse them. Live Trading has no representation here at all.
 */

export type PaperJournalEntryReference = Brand<string, "PaperJournalEntryReference">;
export type PaperInstrumentReference = Brand<string, "PaperInstrumentReference">;
export type PaperOrderIntentReference = Brand<string, "PaperOrderIntentReference">;
/** Identity of one simulated fill — the exactly-once key for position changes. */
export type PaperFillIdentity = Brand<string, "PaperFillIdentity">;
export type PaperCorporateActionReference = Brand<string, "PaperCorporateActionReference">;

export type PaperMoney = Readonly<{ amount: number; currency: string }>;

export type PaperOrderPayload = Readonly<{
  instrument: PaperInstrumentReference;
  venue: string;
  /** Initial product scope is regular-session cash equities/ETFs only (§9). */
  session: "regular";
  side: "buy" | "sell";
  orderType: "market" | "limit";
  limitPrice?: PaperMoney;
  quantity: number;
  timeInForce: "DAY" | "GTC";
}>;

export type SubmissionState = "draft" | "pending_submission" | "acknowledged" | "rejected" | "submission_unknown";
export type ExecutionState = "not_started" | "open" | "partially_filled" | "filled" | "expired";
export type CancellationState = "none" | "requested" | "confirmed" | "rejected";

/** A simulated fill applied to an order (spec §9 simulation-v1). */
export type PaperFill = Readonly<{
  identity: PaperFillIdentity;
  order: PaperOrderReference;
  quantity: number;
  /** Slippage-adjusted, tick-rounded execution price. */
  price: PaperMoney;
  /** Market event time of the observation used (must be > acceptedAt). */
  eventTime: string;
  receivedAt: string;
  evidenceReference: string;
  policyVersion: string;
}>;

export type PaperOrderView = Readonly<{
  order: PaperOrderReference;
  account: InternalPaperAccountReference;
  payload: PaperOrderPayload;
  submission: SubmissionState;
  execution: ExecutionState;
  cancellation: CancellationState;
  acceptedAt?: string;
  filledQuantity: number;
  fills: readonly PaperFill[];
}>;

export type PaperCashRow = Readonly<{ currency: string; balance: number; reserved: number; available: number }>;

export type PaperPositionRow = Readonly<{
  instrument: PaperInstrumentReference;
  quantity: number;
  /** Quantity held back for open sell orders (oversell guard). */
  reserved: number;
  /** Raw cost basis in the instrument currency, corporate-action adjusted exactly once. */
  costBasis: PaperMoney;
}>;

/**
 * Opaque one-time server record (spec §9): the browser only ever holds the
 * reference. Binding covers workspace, auth epoch, account kind/id/revision,
 * paper environment, canonical payload hash, simulation policy and expiry —
 * submit re-checks every one of them from the workspace-scoped store.
 */
export type PaperOrderIntentView = Readonly<{
  reference: PaperOrderIntentReference;
  account: InternalPaperAccountReference;
  accountKind: "internal";
  environment: "paper";
  accountRevision: number;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type PaperPrepareRequest = Readonly<{
  /** Omitted → the workspace's default Internal Paper Account (provisioned lazily). */
  account?: InternalPaperAccountReference;
  payload: PaperOrderPayload;
}>;

export type PaperPrepareOutcome =
  | Readonly<{ status: "issued"; intent: PaperOrderIntentView }>
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "refused"; reason: "invalid_payload" | "unknown_account" }>;

export type PaperTradingCommand =
  | Readonly<{ kind: "submit"; account: InternalPaperAccountReference; intent: PaperOrderIntentReference }>
  | Readonly<{ kind: "cancel"; account: InternalPaperAccountReference; order: PaperOrderReference }>;

export type PaperCommandOutcome =
  | Readonly<{ status: "applied"; revision: number; order: PaperOrderReference }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "rejected"; currentRevision: number }>
  | Readonly<{
      status: "refused";
      reason:
        | "unknown_account"
        | "unknown_order"
        | "unknown_intent"
        | "intent_consumed"
        | "intent_expired"
        | "insufficient_cash"
        | "insufficient_position"
        | "no_valid_observation";
    }>
  /** SEC-01: guest, stale auth epoch or a cross-workspace account/intent id. */
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "suppressed" }>;

/** Real Market Observation offered to reservation bounding and the simulator. */
export type PaperMarketObservation = Readonly<{
  instrument: PaperInstrumentReference;
  venue: string;
  session: "regular";
  price: PaperMoney;
  volume: number;
  eventTime: string;
  receivedAt: string;
  /** Data clock of the feed — delayed feeds evaluate only after it passes acceptedAt. */
  dataClock: string;
  freshness: "realtime" | "delayed" | "stale" | "hard_expired";
  evidenceReference: string;
}>;

export interface PaperObservationPort {
  /** Freshest valid observation for reservation bounding, if any. */
  currentObservation(instrument: PaperInstrumentReference): PaperMarketObservation | undefined;
}
