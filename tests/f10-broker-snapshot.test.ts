import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";
import {
  BROKER_SNAPSHOT_HARD_EXPIRY_MS,
  BROKER_SNAPSHOT_SOFT_EXPIRY_MS,
  BrokerSnapshotStore,
  foldComponentChecksum,
} from "../src/modules/actual-portfolio/broker-sync/snapshot";
import type { ReceivedPage, SnapshotCandidate } from "../src/modules/actual-portfolio/broker-sync/snapshot";
import type { BrokerComponentKey, BrokerLineage, BrokerSyncAccountReference, BrokerSyncEvent, ExternalAccountIdentity } from "../src/modules/actual-portfolio/broker-sync/contracts";

const WS = "ws-1";

function conn(): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">("conn-live") as ProviderConnectionReference;
}
function acct(): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">("acct-1") as BrokerSyncAccountReference;
}
function lineage(): BrokerLineage {
  return { externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("ext-1") as ExternalAccountIdentity, verifiedFingerprint: "fp-1", providerDataEpoch: 1 };
}
function at(ms: number): Date {
  return new Date(Date.UTC(2026, 6, 19) + ms);
}

function position(entity: string, qty: number): BrokerSyncEvent {
  return { connection: conn(), account: acct(), component: "positions", entity, kind: "position", externalIdentity: `${entity}-1`, revision: 1, asOf: "2026-07-19T00:00:00Z", body: { signedQuantity: qty, currency: "USD" } } as BrokerSyncEvent;
}

/** Build a manifest+pages pair that is internally consistent (checksums fold to the manifest). */
function candidate(opts: {
  snapshotAsOf?: string;
  syncedAt: Date;
  pageChecksums?: Partial<Record<BrokerComponentKey, string[]>>;
  pageCounts?: Partial<Record<BrokerComponentKey, number>>;
  asOfByComponent?: Partial<Record<BrokerComponentKey, string>>;
  manifestChecksumOverride?: Partial<Record<BrokerComponentKey, string>>;
  maxSkewMs?: number;
  events?: readonly BrokerSyncEvent[];
  dropPage?: { component: BrokerComponentKey; pageIndex: number };
}): SnapshotCandidate {
  const components: BrokerComponentKey[] = ["positions", "cash", "activity"];
  const snapshotAsOf = opts.snapshotAsOf ?? "2026-07-19T00:00:00Z";
  const pages: ReceivedPage[] = [];
  const manifestComponents = components.map((key) => {
    const count = opts.pageCounts?.[key] ?? 1;
    const checks = opts.pageChecksums?.[key] ?? Array.from({ length: count }, (_v, i) => `${key}-c${i}`);
    const asOf = opts.asOfByComponent?.[key] ?? snapshotAsOf;
    for (let i = 0; i < count; i += 1) {
      if (opts.dropPage && opts.dropPage.component === key && opts.dropPage.pageIndex === i) continue;
      pages.push({ component: key, pageIndex: i, isLastPage: i === count - 1, checksum: checks[i] ?? `${key}-c${i}`, asOf });
    }
    return { key, pageCount: count, checksum: opts.manifestChecksumOverride?.[key] ?? foldComponentChecksum(checks.map((checksum, i) => ({ component: key, pageIndex: i, isLastPage: i === count - 1, checksum, asOf }))) };
  });
  return {
    lineage: lineage(),
    account: acct(),
    manifest: { snapshotAsOf, maxComponentSkewMs: opts.maxSkewMs ?? 1_000, components: manifestComponents },
    pages,
    events: opts.events ?? [position("AAPL", 10)],
    syncedAt: opts.syncedAt,
  };
}

describe("F10 broker snapshot — completeness gate, atomic promotion, expiry", () => {
  it("promotes a complete snapshot and advances the safe watermark", () => {
    const store = new BrokerSnapshotStore();
    expect(store.promote(WS, candidate({ syncedAt: at(0) })).status).toBe("promoted");
    const view = store.current(WS, acct(), at(0));
    expect(view.status).toBe("fresh");
    expect(store.safeWatermark(WS, acct())).toBe("2026-07-19T00:00:00Z");
  });

  it("holds a partial snapshot (page gap) and preserves the last complete snapshot", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidate({ syncedAt: at(0) }));
    const held = store.promote(WS, candidate({ syncedAt: at(10), snapshotAsOf: "2026-07-19T00:05:00Z", pageCounts: { positions: 2 }, dropPage: { component: "positions", pageIndex: 1 } }));
    expect(held.status).toBe("held");
    const view = store.current(WS, acct(), at(10));
    expect(view.status).toBe("fresh");
    if (view.status === "fresh") expect(view.snapshotAsOf).toBe("2026-07-19T00:00:00Z");
    expect(store.safeWatermark(WS, acct())).toBe("2026-07-19T00:00:00Z");
  });

  it("holds a snapshot with a missing page even when a tampered checksum matches the short fold (gap != checksum)", () => {
    const store = new BrokerSnapshotStore();
    // pageCount 2, only page 0 delivered, and the manifest checksum forged to fold of just page 0.
    const held = store.promote(WS, candidate({ syncedAt: at(0), pageCounts: { positions: 2 }, dropPage: { component: "positions", pageIndex: 1 }, manifestChecksumOverride: { positions: "positions-c0" } }));
    expect(held.status).toBe("held");
    if (held.status === "held") expect(held.reason).toBe("gap");
    expect(store.current(WS, acct(), at(0)).status).toBe("none");
  });

  it("holds a snapshot whose component checksum diverges from the manifest", () => {
    const store = new BrokerSnapshotStore();
    const held = store.promote(WS, candidate({ syncedAt: at(0), manifestChecksumOverride: { cash: "tampered" } }));
    expect(held.status).toBe("held");
    if (held.status === "held") expect(held.reason).toBe("divergent_checksum");
    expect(store.current(WS, acct(), at(0)).status).toBe("none");
  });

  it("holds a snapshot whose components exceed the bounded skew window", () => {
    const store = new BrokerSnapshotStore();
    const held = store.promote(WS, candidate({ syncedAt: at(0), maxSkewMs: 1_000, asOfByComponent: { activity: "2026-07-19T01:00:00Z" } }));
    expect(held.status).toBe("held");
    if (held.status === "held") expect(held.reason).toBe("skew_exceeded");
  });

  it("treats a zero-page component as present-and-empty, not absent (still complete)", () => {
    const store = new BrokerSnapshotStore();
    const outcome = store.promote(WS, candidate({ syncedAt: at(0), pageCounts: { cash: 0 }, events: [position("AAPL", 10)] }));
    expect(outcome.status).toBe("promoted");
    const view = store.current(WS, acct(), at(0));
    if (view.status === "fresh") expect(view.projection.components.cash).toBe("present");
  });

  it("holds a snapshot older than the current one (never rolls back)", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidate({ syncedAt: at(0), snapshotAsOf: "2026-07-19T00:10:00Z" }));
    const held = store.promote(WS, candidate({ syncedAt: at(10), snapshotAsOf: "2026-07-19T00:05:00Z" }));
    expect(held.status).toBe("held");
    if (held.status === "held") expect(held.reason).toBe("stale");
  });

  it("marks soft-expired at 60s and hard-expired at 15min (current value gone, frozen only)", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidate({ syncedAt: at(0) }));
    expect(store.current(WS, acct(), at(BROKER_SNAPSHOT_SOFT_EXPIRY_MS + 1)).status).toBe("stale");
    const expired = store.current(WS, acct(), at(BROKER_SNAPSHOT_HARD_EXPIRY_MS + 1));
    expect(expired.status).toBe("expired");
    if (expired.status === "expired") {
      expect(expired.frozen.positions).toHaveLength(1);
      expect("projection" in expired).toBe(false);
    }
  });

  it("suppresses promotion after the erasure fence and drops the current snapshot", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidate({ syncedAt: at(0) }));
    for (const erasable of store.erasables()) erasable.eraseSubject(WS, 2);
    expect(store.current(WS, acct(), at(0)).status).toBe("none");
    expect(store.promote(WS, candidate({ syncedAt: at(1) })).status).toBe("suppressed");
    expect(store.current(WS, acct(), at(1)).status).toBe("none");
  });
});
