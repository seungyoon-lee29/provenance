import type { Brand, ProviderConnectionReference } from "../../../shared/contracts/brands";

/**
 * F10 Broker Sync contracts (spec §8, UF-06, AT-09; ADR A04).
 *
 * Broker Sync is a READ-ONLY projection: it ingests provider facts about a real
 * broker account (positions, cash, activity) and never mutates an order. It
 * shares no journal, storage or revisions with the Paper lanes. Valuation
 * (price × quantity, FX, P&L) is NOT re-derived here — F7 owns that downstream;
 * F10 preserves source-stated values exactly and only projects them.
 */

/** The provider's own identity for the external account. */
export type ExternalAccountIdentity = Brand<string, "ExternalAccountIdentity">;
/** F10-owned account handle; never interchangeable with an Actual/Paper reference. */
export type BrokerSyncAccountReference = Brand<string, "BrokerSyncAccountReference">;

/**
 * A broker sync lineage (spec §8): the event dedupe namespace is scoped by
 * ExternalAccountIdentity + verified fingerprint + ProviderDataEpoch. A retained
 * reconnect continues the namespace ONLY when all three match; a provider ledger
 * reset, a different fingerprint/epoch, or provider-ID reuse after deletion is a
 * brand-new lineage that never inherits the old events.
 */
export type BrokerLineage = Readonly<{
  externalAccountIdentity: ExternalAccountIdentity;
  verifiedFingerprint: string;
  providerDataEpoch: number;
}>;

/** The three components every complete Broker Snapshot must account for. */
export type BrokerComponentKey = "positions" | "cash" | "activity";

/** A value preserved exactly as the source stated it — never re-derived. */
export type BrokerSourceMoney = Readonly<{ amount: number; currency: string }>;

export type BrokerPositionBody = Readonly<{
  signedQuantity: number;
  currency: string;
  sourceCostBasis?: BrokerSourceMoney;
  /** option/short/margin/unsupported instruments: preserved, not valued. */
  unsupported?: boolean;
  sourceType?: string;
  sourceReference?: string;
}>;

export type BrokerCashBody = Readonly<{ balance: number; currency: string }>;

export type BrokerActivityBody = Readonly<{
  activityKind: string;
  occurredAt: string;
  signedCashAmount?: BrokerSourceMoney;
  instrument?: string;
  signedQuantity?: number;
}>;

type BrokerEventCore = Readonly<{
  connection: ProviderConnectionReference;
  account: BrokerSyncAccountReference;
  entity: string;
  externalIdentity: string;
  revision: number;
  asOf: string;
  /** For a correction/reversal: the eventKey (within this lineage) it supersedes. */
  corrects?: string;
}>;

/**
 * One durable provider fact, durable-unique within a lineage by
 * (connection, account, component, entity, kind, externalIdentity, revision).
 * The same key with a divergent body is a Reconciliation Issue, not a change.
 */
export type BrokerSyncEvent =
  | (BrokerEventCore & Readonly<{ component: "positions"; kind: "position" | "reversal"; body: BrokerPositionBody }>)
  | (BrokerEventCore & Readonly<{ component: "cash"; kind: "cash_balance" | "reversal"; body: BrokerCashBody }>)
  | (BrokerEventCore & Readonly<{ component: "activity"; kind: "activity" | "reversal"; body: BrokerActivityBody }>);

export type BrokerReconciliationIssue = Readonly<{
  lineageKey: string;
  eventKey: string;
  reason: "divergent_payload" | "identity_permutation";
  storedPayload: string;
  divergentPayload: string;
}>;

/**
 * Stable string key for a lineage (the dedupe namespace).
 *
 * JSON-array encoded, not `|`-joined: a raw delimiter join is not injective, so
 * `("broker|fingerprint","v1")` and `("broker","fingerprint|v1")` would collide
 * and bleed two distinct lineages into one namespace (codex panel). JSON quoting
 * makes the tuple encoding injective.
 */
export function lineageKey(lineage: BrokerLineage): string {
  return JSON.stringify([String(lineage.externalAccountIdentity), lineage.verifiedFingerprint, lineage.providerDataEpoch]);
}

/** Durable-unique event key within a lineage (injective JSON-tuple encoding). */
export function eventKey(event: BrokerSyncEvent): string {
  return JSON.stringify([String(event.connection), String(event.account), event.component, event.entity, event.kind, event.externalIdentity, event.revision]);
}

/** Permutation key: (component, entity, kind, revision) must map to one external identity. */
export function permutationKey(event: BrokerSyncEvent): string {
  return JSON.stringify([event.component, event.entity, event.kind, event.revision]);
}

/** Order-insensitive canonical form for divergence detection. */
export function canonicalPayload(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  });
}
