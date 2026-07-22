import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";
import { BrokerSyncEventStore, BROKER_SYNC_LIVE_EPOCH } from "../src/modules/actual-portfolio/broker-sync/event-store";
import type { BrokerLineage, BrokerSyncAccountReference, BrokerSyncEvent, ExternalAccountIdentity } from "../src/modules/actual-portfolio/broker-sync/contracts";

const WORKSPACE = "ws-broker-sync-1";

function connection(id = "conn-kis-live"): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">(id) as ProviderConnectionReference;
}

function account(id = "sync-acct-1"): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">(id) as BrokerSyncAccountReference;
}

function lineage(overrides: Partial<BrokerLineage> = {}): BrokerLineage {
  return {
    externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("ext-acct-1") as ExternalAccountIdentity,
    verifiedFingerprint: "fp-1",
    providerDataEpoch: 1,
    ...overrides,
  };
}

function positionEvent(overrides: Partial<BrokerSyncEvent> = {}): BrokerSyncEvent {
  return {
    connection: connection(),
    account: account(),
    component: "positions",
    entity: "instrument:AAPL",
    kind: "position",
    externalIdentity: "ext-1",
    revision: 1,
    asOf: "2026-07-19T00:00:00Z",
    body: { signedQuantity: 10, currency: "USD" },
    ...overrides,
  } as BrokerSyncEvent;
}

describe("BrokerSyncEventStore durable-unique dedupe + quarantine", () => {
  it("records a fresh event as applied", () => {
    const store = new BrokerSyncEventStore();
    expect(store.record(WORKSPACE, lineage(), positionEvent())).toBe("applied");
    expect(store.events(WORKSPACE, lineage())).toHaveLength(1);
  });

  it("treats an identical redelivery as an idempotent duplicate", () => {
    const store = new BrokerSyncEventStore();
    store.record(WORKSPACE, lineage(), positionEvent());
    expect(store.record(WORKSPACE, lineage(), positionEvent())).toBe("duplicate");
    expect(store.events(WORKSPACE, lineage())).toHaveLength(1);
  });

  it("quarantines the same key with a divergent payload without changing state", () => {
    const store = new BrokerSyncEventStore();
    store.record(WORKSPACE, lineage(), positionEvent());
    const divergent = positionEvent({ body: { signedQuantity: 99, currency: "USD" } } as Partial<BrokerSyncEvent>);
    expect(store.record(WORKSPACE, lineage(), divergent)).toBe("quarantined");
    const stored = store.events(WORKSPACE, lineage());
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toEqual({ signedQuantity: 10, currency: "USD" });
    expect(store.quarantine(WORKSPACE)).toHaveLength(1);
  });

  it("quarantines a second external identity at an already-applied (entity,kind,revision)", () => {
    const store = new BrokerSyncEventStore();
    store.record(WORKSPACE, lineage(), positionEvent());
    const permuted = positionEvent({ externalIdentity: "ext-2" } as Partial<BrokerSyncEvent>);
    expect(store.record(WORKSPACE, lineage(), permuted)).toBe("quarantined");
    expect(store.events(WORKSPACE, lineage())).toHaveLength(1);
  });

  it("keeps events in separate lineages isolated (new provider data epoch is a new namespace)", () => {
    const store = new BrokerSyncEventStore();
    store.record(WORKSPACE, lineage(), positionEvent());
    // Same event key, different lineage (provider ledger reset) → does not collide or dedupe.
    expect(store.record(WORKSPACE, lineage({ providerDataEpoch: 2 }), positionEvent())).toBe("applied");
    expect(store.events(WORKSPACE, lineage())).toHaveLength(1);
    expect(store.events(WORKSPACE, lineage({ providerDataEpoch: 2 }))).toHaveLength(1);
  });

  it("suppresses records after the erasure fence and shreds prior events", () => {
    const store = new BrokerSyncEventStore();
    store.record(WORKSPACE, lineage(), positionEvent());
    for (const erasable of store.erasables()) erasable.eraseSubject(WORKSPACE, BROKER_SYNC_LIVE_EPOCH + 1);
    expect(store.events(WORKSPACE, lineage())).toHaveLength(0);
    expect(store.record(WORKSPACE, lineage(), positionEvent())).toBe("suppressed");
    expect(store.events(WORKSPACE, lineage())).toHaveLength(0);
  });
});
