import type { Brand, BrokerPaperAccountReference, ProviderConnectionReference } from "@/shared/contracts/brands";

import type { CancellationState, ExecutionState, PaperMoney, PaperOrderPayload, SubmissionState } from "../internal/contracts";

/**
 * F9 Broker Paper contracts (spec §9, AT-08; ADR A03/A04).
 *
 * The broker lane shares TYPES with the internal lane (payload, money, the
 * three independent state axes) but no journal, storage or revisions — the
 * internal simulator and the broker book can never observe each other's
 * state. Every reference is a broker-owned brand; Live Trading has no
 * representation here at all.
 */

/** All live writes happen at this epoch; the erasure fence retires it (F8 lane pattern). */
export const BROKER_LIVE_EPOCH = 1;

/** Stable client order identity — minted once at prepare, reused verbatim across every retry/lookup. */
export type BrokerClientOrderReference = Brand<string, "BrokerClientOrderReference">;
export type BrokerPaperOrderIntentReference = Brand<string, "BrokerPaperOrderIntentReference">;

export type BrokerOrderEventKind = "accepted" | "rejected" | "fill" | "cancel_confirmed" | "cancel_rejected" | "expired";

/**
 * One provider fact about one order. Durable-unique by
 * (connection, account, order, kind, externalIdentity, revision); the same
 * key with a different body is a Reconciliation Issue, never a state change.
 */
export type BrokerExternalOrderEvent = Readonly<{
  connection: ProviderConnectionReference;
  order: BrokerClientOrderReference;
  kind: BrokerOrderEventKind;
  externalIdentity: string;
  revision: number;
  body: Readonly<{ externalOrder?: string; quantity?: number; price?: PaperMoney }>;
}>;

export type BrokerQuarantineRecord = Readonly<{
  order: BrokerClientOrderReference;
  eventKey: string;
  storedPayload: string;
  divergentPayload: string;
}>;

export type BrokerOrderView = Readonly<{
  order: BrokerClientOrderReference;
  account: BrokerPaperAccountReference;
  payload: PaperOrderPayload;
  submission: SubmissionState;
  execution: ExecutionState;
  cancellation: CancellationState;
  filledQuantity: number;
  externalOrder?: string;
}>;

export type BrokerCashRow = Readonly<{ currency: string; balance: number; reserved: number }>;
export type BrokerPositionRow = Readonly<{ instrument: string; quantity: number; costBasis: PaperMoney }>;

export type BrokerBookState = Readonly<{
  cash: readonly BrokerCashRow[];
  positions: readonly BrokerPositionRow[];
  orders: readonly BrokerOrderView[];
  quarantine: readonly BrokerQuarantineRecord[];
}>;

export type BrokerSubmitRefusalReason =
  | "unknown_account"
  | "unsupported_order_type"
  | "invalid_payload"
  | "client_order_conflict"
  | "insufficient_cash"
  | "insufficient_position";

export type BrokerIngestRefusalReason =
  | "unknown_account"
  | "unknown_order"
  | "invalid_event"
  | "not_pending"
  | "not_fillable"
  | "over_limit_fill"
  | "insufficient_cash"
  | "insufficient_position"
  | "cancellation_terminal";

export type BrokerProvisionOutcome = Readonly<{ status: "applied" | "duplicate" | "suppressed" }>;

export type BrokerSubmitOutcome =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "refused"; reason: BrokerSubmitRefusalReason }>
  | Readonly<{ status: "suppressed" }>;

export type BrokerIngestOutcome =
  | Readonly<{ status: "applied" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "quarantined" }>
  | Readonly<{ status: "refused"; reason: BrokerIngestRefusalReason }>
  | Readonly<{ status: "suppressed" }>;
