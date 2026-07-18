import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { Erasable } from "../../notification-center/fenced-store";

import type { BrokerLineage, BrokerReconciliationIssue, BrokerSyncEvent } from "./contracts";
import { canonicalPayload, eventKey, lineageKey, permutationKey } from "./contracts";

/** All live sync writes happen at this epoch; the erasure fence retires it (F6/F8/F9 lane pattern). */
export const BROKER_SYNC_LIVE_EPOCH = 1;

export type BrokerRecordOutcome = "applied" | "duplicate" | "quarantined" | "suppressed";

type StoredEvent = Readonly<{ event: BrokerSyncEvent; canonical: string; namespace: string }>;

/**
 * Durable, lineage-scoped store of provider facts (spec §8 event durable-unique).
 *
 * Every key is prefixed by the lineage namespace, so a new lineage (provider
 * ledger reset, different fingerprint/epoch) never sees the old events — the
 * namespace separation IS the "new lineage doesn't inherit" rule, structurally.
 * Within a lineage: an identical redelivery is an idempotent duplicate; the same
 * key with a divergent body, or a second external identity at an already-applied
 * (entity,kind,revision), is a Reconciliation Issue that changes nothing.
 *
 * The write epoch is a constructor-injected constant (F9 pattern — never a
 * per-call argument, which was the erasure-fence bypass the F9 codex panel found).
 */
export class BrokerSyncEventStore {
  readonly #events = new FencedKeyedStore<StoredEvent>();
  readonly #identity = new FencedKeyedStore<string>();
  readonly #quarantine = new FencedKeyedStore<BrokerReconciliationIssue>();

  constructor(private readonly writeEpoch: () => number = () => BROKER_SYNC_LIVE_EPOCH) {}

  record(workspace: string, lineage: BrokerLineage, event: BrokerSyncEvent): BrokerRecordOutcome {
    const epoch = this.writeEpoch();
    if (this.#events.isErased(workspace, epoch)) return "suppressed";

    const namespace = lineageKey(lineage);
    const key = JSON.stringify([namespace, eventKey(event)]);
    const canonical = canonicalPayload(event.body);

    const existing = this.#events.get(workspace, key);
    if (existing !== undefined) {
      if (existing.canonical === canonical) return "duplicate";
      return this.#quarantineIssue(workspace, epoch, namespace, key, "divergent_payload", existing.canonical, canonical);
    }

    // A given (component,entity,kind,revision) may bind to exactly one external
    // identity within a lineage — a second identity is a reconciliation issue.
    const permKey = JSON.stringify([namespace, permutationKey(event)]);
    const boundIdentity = this.#identity.get(workspace, permKey);
    if (boundIdentity !== undefined && boundIdentity !== event.externalIdentity) {
      return this.#quarantineIssue(workspace, epoch, namespace, key, "identity_permutation", boundIdentity, event.externalIdentity);
    }

    this.#events.write(workspace, key, { event, canonical, namespace }, epoch);
    this.#identity.write(workspace, permKey, event.externalIdentity, epoch);
    return "applied";
  }

  #quarantineIssue(
    workspace: string,
    epoch: number,
    namespace: string,
    key: string,
    reason: BrokerReconciliationIssue["reason"],
    stored: string,
    divergent: string,
  ): BrokerRecordOutcome {
    const issue: BrokerReconciliationIssue = { lineageKey: namespace, eventKey: key, reason, storedPayload: stored, divergentPayload: divergent };
    this.#quarantine.write(workspace, JSON.stringify([key, reason]), issue, epoch);
    return "quarantined";
  }

  events(workspace: string, lineage: BrokerLineage): readonly BrokerSyncEvent[] {
    const namespace = lineageKey(lineage);
    return this.#events.list(workspace).filter((stored) => stored.namespace === namespace).map((stored) => stored.event);
  }

  quarantine(workspace: string): readonly BrokerReconciliationIssue[] {
    return this.#quarantine.list(workspace);
  }

  erasables(): readonly Erasable[] {
    return [this.#events, this.#identity, this.#quarantine];
  }
}
