import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";
import { BrokerSyncEventStore } from "../src/modules/actual-portfolio/broker-sync/event-store";
import { effectiveBrokerEvents, projectBrokerBook } from "../src/modules/actual-portfolio/broker-sync/projection";
import { BrokerSnapshotStore } from "../src/modules/actual-portfolio/broker-sync/snapshot";
import type { ReceivedPage, SnapshotCandidate } from "../src/modules/actual-portfolio/broker-sync/snapshot";
import { BrokerSyncCursorStore, BrokerSyncWorker } from "../src/modules/actual-portfolio/broker-sync/sync-worker";
import { eventKey } from "../src/modules/actual-portfolio/broker-sync/contracts";
import type { BrokerComponentKey, BrokerLineage, BrokerSyncAccountReference, BrokerSyncEvent, ExternalAccountIdentity } from "../src/modules/actual-portfolio/broker-sync/contracts";
import { account, CONNECTION, viewer, WORKSPACE } from "./f10-broker-sync-harness";

/**
 * F10 codex adversarial panel regressions (different-family review). Each test
 * is a confirmed real bug the panel found; each was RED before its fix.
 */

const WS = "ws-panel";
const ALL = new Set<BrokerComponentKey>(["positions", "cash", "activity"]);

function conn(): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">("conn-panel") as ProviderConnectionReference;
}
function acct(): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">("acct-panel") as BrokerSyncAccountReference;
}
function lineage(overrides: Partial<BrokerLineage> = {}): BrokerLineage {
  return { externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("ext-panel") as ExternalAccountIdentity, verifiedFingerprint: "fp-1", providerDataEpoch: 1, ...overrides };
}
function position(entity: string, qty: number, revision: number, overrides: Partial<BrokerSyncEvent> = {}): BrokerSyncEvent {
  return { connection: conn(), account: acct(), component: "positions", entity, kind: "position", externalIdentity: `${entity}-${revision}`, revision, asOf: "2026-07-19T00:00:00Z", body: { signedQuantity: qty, currency: "USD" }, ...overrides } as BrokerSyncEvent;
}

function fullCandidate(lin: BrokerLineage, snapshotAsOf: string, events: readonly BrokerSyncEvent[]): SnapshotCandidate {
  const components: BrokerComponentKey[] = ["positions", "cash", "activity"];
  const pages: ReceivedPage[] = components.map((key) => ({ component: key, pageIndex: 0, isLastPage: true, checksum: `${key}-c`, asOf: snapshotAsOf }));
  const manifest = { snapshotAsOf, maxComponentSkewMs: 1_000, components: components.map((key) => ({ key, pageCount: 1, checksum: `${key}-c` })) };
  return { lineage: lin, account: acct(), manifest, pages, events, syncedAt: new Date(Date.parse(snapshotAsOf)) };
}

describe("F10 codex panel — confirmed regressions", () => {
  // FINDING 3
  it("holds a manifest that omits a required component (missing_component)", () => {
    const store = new BrokerSnapshotStore();
    const components: BrokerComponentKey[] = ["positions", "cash"]; // activity omitted
    const pages: ReceivedPage[] = components.map((key) => ({ component: key, pageIndex: 0, isLastPage: true, checksum: `${key}-c`, asOf: "2026-07-19T00:00:00Z" }));
    const candidate: SnapshotCandidate = {
      lineage: lineage(), account: acct(),
      manifest: { snapshotAsOf: "2026-07-19T00:00:00Z", maxComponentSkewMs: 1_000, components: components.map((key) => ({ key, pageCount: 1, checksum: `${key}-c` })) },
      pages, events: [position("AAPL", 10, 1)], syncedAt: new Date("2026-07-19T00:00:00Z"),
    };
    const outcome = store.promote(WS, candidate);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toBe("missing_component");
  });

  // FINDING 4
  it("resolves two corrections of one base deterministically (latest revision wins, single row)", () => {
    const base = position("AAPL", 10, 1);
    const corr12 = position("AAPL", 12, 2, { corrects: eventKey(base) });
    const corr13 = position("AAPL", 13, 3, { corrects: eventKey(base) });
    const forward = projectBrokerBook(effectiveBrokerEvents([base, corr12, corr13]), ALL);
    const reverse = projectBrokerBook(effectiveBrokerEvents([base, corr13, corr12]), ALL);
    expect(forward.positions).toEqual(reverse.positions);
    expect(forward.positions.map((row) => row.body.signedQuantity)).toEqual([13]);
  });

  // FINDING 1
  it("holds a different lineage promoted at an equal timestamp (no lineage rollback)", () => {
    const store = new BrokerSnapshotStore();
    expect(store.promote(WS, fullCandidate(lineage({ providerDataEpoch: 2 }), "2026-07-19T00:00:00Z", [position("NEW", 1, 1)])).status).toBe("promoted");
    const held = store.promote(WS, fullCandidate(lineage({ providerDataEpoch: 1 }), "2026-07-19T00:00:00Z", [position("OLD", 1, 1)]));
    expect(held.status).toBe("held");
    const view = store.current(WS, acct(), new Date("2026-07-19T00:00:00Z"));
    if (view.status === "fresh") expect(view.projection.positions.map((row) => row.entity)).toEqual(["NEW"]);
  });

  // FINDING 2
  it("isolates distinct lineages even when a field contains the key delimiter", () => {
    const store = new BrokerSyncEventStore();
    const a = lineage({ externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("broker|fingerprint") as ExternalAccountIdentity, verifiedFingerprint: "v1" });
    const b = lineage({ externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("broker") as ExternalAccountIdentity, verifiedFingerprint: "fingerprint|v1" });
    store.record(WS, a, position("AAPL", 10, 1));
    store.record(WS, b, position("MSFT", 5, 1));
    expect(store.events(WS, a).map((e) => e.entity)).toEqual(["AAPL"]);
    expect(store.events(WS, b).map((e) => e.entity)).toEqual(["MSFT"]);
  });

  // FINDING 5
  it("makes zero broker reads when erasure lands during authorization (SEC-06 late fence)", async () => {
    const events = new BrokerSyncEventStore();
    const snapshots = new BrokerSnapshotStore();
    const cursors = new BrokerSyncCursorStore();
    let executeCalls = 0;
    const fakeAuthorized = { execute: async () => ({ commit: async (fn: (v: unknown) => unknown) => { executeCalls += 1; return fn({}); } }) };
    const transport = {
      authorize: async () => {
        // Administrative erasure wins the race AFTER the entry fence check, during authorize.
        for (const store of [...events.erasables(), ...snapshots.erasables(), ...cursors.erasables()]) store.eraseSubject(WORKSPACE, 2);
        return fakeAuthorized;
      },
    };
    const worker = new BrokerSyncWorker({ transport: transport as never, events, snapshots, cursors, now: () => new Date("2026-07-19T00:00:00Z") });
    const outcome = await worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(outcome.status).toBe("suppressed");
    expect(executeCalls).toBe(0);
  });
});
