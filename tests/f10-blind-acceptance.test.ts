/**
 * F10 Broker Sync — BLIND acceptance tests.
 *
 * Authored from contracts + AC + spec §8 ONLY. Never read the implementation
 * bodies (event-store.ts, snapshot.ts, projection.ts, sync-worker.ts).
 * All expected values are hand-computed independent oracles from the spec.
 *
 * TDD seams used:
 *   - BrokerSyncEventStore  (record / events / quarantine / erasables)
 *   - effectiveBrokerEvents + projectBrokerBook  (projection pure functions)
 *   - BrokerSnapshotStore   (promote / current / safeWatermark / erasables)
 *   - BrokerSyncWorker via makeWorker harness (end-to-end sync)
 */

import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";

// ── Event store
import { BrokerSyncEventStore, BROKER_SYNC_LIVE_EPOCH } from "../src/modules/actual-portfolio/broker-sync/event-store";
import type { Erasable } from "../src/platform/persistence/fenced-store";

// ── Projection
import { effectiveBrokerEvents, projectBrokerBook } from "../src/modules/actual-portfolio/broker-sync/projection";

// ── Snapshot store
import {
  BROKER_SNAPSHOT_HARD_EXPIRY_MS,
  BROKER_SNAPSHOT_SOFT_EXPIRY_MS,
  BrokerSnapshotStore,
  foldComponentChecksum,
} from "../src/modules/actual-portfolio/broker-sync/snapshot";
import type { ReceivedPage, SnapshotCandidate } from "../src/modules/actual-portfolio/broker-sync/snapshot";

// ── Contracts / helpers
import { eventKey } from "../src/modules/actual-portfolio/broker-sync/contracts";
import type {
  BrokerComponentKey,
  BrokerLineage,
  BrokerSyncAccountReference,
  BrokerSyncEvent,
  ExternalAccountIdentity,
} from "../src/modules/actual-portfolio/broker-sync/contracts";

// ── Harness (worker e2e)
import {
  CONNECTION,
  ScriptedBrokerReadSource,
  WORKSPACE,
  account,
  cashWire,
  makeWorker,
  positionWire,
  viewer,
} from "./f10-broker-sync-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const WS = "ws-blind-accept";
const NOW_MS = Date.UTC(2026, 6, 19); // 2026-07-19T00:00:00Z

function conn(id = "conn-blind"): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">(id) as ProviderConnectionReference;
}
function acct(id = "acct-blind-1"): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">(id) as BrokerSyncAccountReference;
}
function lineage(overrides: Partial<BrokerLineage> = {}): BrokerLineage {
  return {
    externalAccountIdentity: brandReference<string, "ExternalAccountIdentity">("blind-ext-1") as ExternalAccountIdentity,
    verifiedFingerprint: "fp-blind",
    providerDataEpoch: 1,
    ...overrides,
  };
}
function at(offsetMs = 0): Date {
  return new Date(NOW_MS + offsetMs);
}

/** Minimal position event. */
function posEvent(
  entity: string,
  signedQuantity: number,
  opts: Partial<BrokerSyncEvent> = {},
): BrokerSyncEvent {
  return {
    connection: conn(),
    account: acct(),
    component: "positions",
    entity,
    kind: "position",
    externalIdentity: `${entity}-r1`,
    revision: 1,
    asOf: "2026-07-19T00:00:00Z",
    body: { signedQuantity, currency: "USD" },
    ...opts,
  } as BrokerSyncEvent;
}
/** Build an internally-consistent SnapshotCandidate (checksums fold correctly). */
function candidateSnap(opts: {
  snapshotAsOf?: string;
  syncedAt: Date;
  events?: readonly BrokerSyncEvent[];
  pageChecksumsByComponent?: Partial<Record<BrokerComponentKey, string[]>>;
  pageCounts?: Partial<Record<BrokerComponentKey, number>>;
  manifestChecksumOverride?: Partial<Record<BrokerComponentKey, string>>;
  asOfByComponent?: Partial<Record<BrokerComponentKey, string>>;
  maxSkewMs?: number;
  dropPage?: { component: BrokerComponentKey; pageIndex: number };
}): SnapshotCandidate {
  const snapshotAsOf = opts.snapshotAsOf ?? "2026-07-19T00:00:00Z";
  const components: BrokerComponentKey[] = ["positions", "cash", "activity"];
  const pages: ReceivedPage[] = [];
  const manifestComponents = components.map((key) => {
    const count = opts.pageCounts?.[key] ?? 1;
    const checksums = opts.pageChecksumsByComponent?.[key] ?? Array.from({ length: count }, (_v, i) => `${key}-blind-c${i}`);
    const asOf = opts.asOfByComponent?.[key] ?? snapshotAsOf;
    for (let i = 0; i < count; i += 1) {
      if (opts.dropPage && opts.dropPage.component === key && opts.dropPage.pageIndex === i) continue;
      pages.push({ component: key, pageIndex: i, isLastPage: i === count - 1, checksum: checksums[i] ?? `${key}-blind-c${i}`, asOf });
    }
    const folded = foldComponentChecksum(
      checksums.map((checksum, i) => ({ component: key, pageIndex: i, isLastPage: i === count - 1, checksum, asOf })),
    );
    return { key, pageCount: count, checksum: opts.manifestChecksumOverride?.[key] ?? folded };
  });
  return {
    lineage: lineage(),
    account: acct(),
    manifest: { snapshotAsOf, maxComponentSkewMs: opts.maxSkewMs ?? 1_000, components: manifestComponents },
    pages,
    events: opts.events ?? [posEvent("AAPL", 10)],
    syncedAt: opts.syncedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Event store: deduplication and quarantine
//    Spec §8: "same key with divergent body is Reconciliation Issue, not a change"
//    AC: "identical redelivery is duplicate; same durable key + different body = quarantined
//         and stored value unchanged; second external identity at applied (entity,kind,revision) = quarantined"
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – event store deduplication", () => {
  it("AC1a: identical redelivery returns 'duplicate' and does not change the event list", () => {
    const store = new BrokerSyncEventStore();
    const lg = lineage();
    const event = posEvent("AAPL", 10);

    const first = store.record(WS, lg, event);
    expect(first).toBe("applied");

    const second = store.record(WS, lg, event);
    // Oracle: same durable key + same body → duplicate (idempotent, spec §8)
    expect(second).toBe("duplicate");

    // State must be unchanged: exactly one event
    expect(store.events(WS, lg)).toHaveLength(1);
  });

  it("AC1b: same durable key with a different body is quarantined and stored value unchanged", () => {
    const store = new BrokerSyncEventStore();
    const lg = lineage();
    const original = posEvent("AAPL", 10);
    store.record(WS, lg, original);

    // Same key components (connection, account, component, entity, kind, externalIdentity, revision)
    // but different body — this is a divergent payload
    const divergent = posEvent("AAPL", 99); // signedQuantity changed → same key, divergent body
    const result = store.record(WS, lg, divergent);
    // Oracle: divergent payload on an existing key → "quarantined" (spec §8, contracts.ts line 70-71)
    expect(result).toBe("quarantined");

    // The stored event is unchanged (still 10, not 99)
    const stored = store.events(WS, lg);
    expect(stored).toHaveLength(1);
    expect((stored[0]?.body as { signedQuantity: number }).signedQuantity).toBe(10);
  });

  it("AC1b: quarantined event appears in quarantine list with reason=divergent_payload", () => {
    const store = new BrokerSyncEventStore();
    const lg = lineage();
    store.record(WS, lg, posEvent("MSFT", 5));
    store.record(WS, lg, posEvent("MSFT", 99)); // divergent
    const issues = store.quarantine(WS);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const issue = issues.find((i) => i.reason === "divergent_payload");
    // Oracle: a divergent-payload quarantine must exist
    expect(issue).toBeDefined();
  });

  it("AC1c: a second external identity at same (entity, kind, revision) is quarantined (identity_permutation)", () => {
    const store = new BrokerSyncEventStore();
    const lg = lineage();
    // First event with externalIdentity "AAPL-r1"
    store.record(WS, lg, posEvent("AAPL", 10, { externalIdentity: "AAPL-r1" }));
    // Different externalIdentity at the same (entity="AAPL", kind="position", revision=1) slot
    const permuted = posEvent("AAPL", 10, { externalIdentity: "AAPL-r1-alt" });
    const result = store.record(WS, lg, permuted);
    // Oracle: same (entity,kind,revision) mapped to two external identities → identity_permutation quarantine
    expect(result).toBe("quarantined");
    const issues = store.quarantine(WS);
    const permIssue = issues.find((i) => i.reason === "identity_permutation");
    expect(permIssue).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lineage isolation
//    Spec §8: "ExternalAccountIdentity + verified fingerprint + ProviderDataEpoch"
//    Different providerDataEpoch → different namespace, no cross-lineage dedupe
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – lineage isolation", () => {
  it("AC2: same event payload under two providerDataEpoch values does NOT dedupe; each lineage sees its own event", () => {
    const store = new BrokerSyncEventStore();
    const lg1 = lineage({ providerDataEpoch: 1 });
    const lg2 = lineage({ providerDataEpoch: 2 });
    const event1 = posEvent("AAPL", 10);
    const event2 = posEvent("AAPL", 10); // identical wire content

    store.record(WS, lg1, event1);
    store.record(WS, lg2, event2);

    // Oracle: two separate namespaces → each has exactly 1 event, no cross-lineage bleed
    expect(store.events(WS, lg1)).toHaveLength(1);
    expect(store.events(WS, lg2)).toHaveLength(1);

    // Reversed second delivery is still "applied" (not "duplicate") because lineage differs
    const result = store.record(WS, lg2, event2);
    expect(result).toBe("duplicate"); // within lg2 it IS a dup
    // But lg1 remains unaffected
    expect(store.events(WS, lg1)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Projection
//    Spec §8: "superseding/reversal is added, not overwriting source events"
//    AC: reversal voids target but component stays "present" (zero, not absent);
//        never-synced component is "absent";
//        correction order-independence
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – projection", () => {
  it("AC3a: a reversal voids its target position; component stays 'present' (zero rows, not absent)", () => {
    const base = posEvent("AAPL", 10, { externalIdentity: "AAPL-r1", revision: 1 });
    // Oracle: eventKey of base is the corrects value for the reversal
    const baseKey = eventKey(base);
    const reversal: BrokerSyncEvent = {
      ...base,
      kind: "reversal",
      externalIdentity: "AAPL-r1-rev",
      revision: 2,
      body: { signedQuantity: 0, currency: "USD" },
      corrects: baseKey,
    } as BrokerSyncEvent;

    const effective = effectiveBrokerEvents([base, reversal]);
    const book = projectBrokerBook(effective, new Set<BrokerComponentKey>(["positions", "cash", "activity"]));

    // Oracle: reversal voids the base → positions row count is 0 (nothing to show) OR the
    // projection shows a zero-qty row; either way the component is "present" not "absent"
    // (spec §8: "absence-vs-zero" distinction; a component that received events is present)
    expect(book.components.positions).toBe("present");
    // No non-zero AAPL position should survive
    const aaplPositions = book.positions.filter((r) => r.entity === "AAPL" && (r.body as { signedQuantity: number }).signedQuantity !== 0);
    expect(aaplPositions).toHaveLength(0);
  });

  it("AC3b: a component that was never synced is 'absent'", () => {
    // Only positions events provided; cash and activity never touched
    const events = [posEvent("AAPL", 5)];
    const effective = effectiveBrokerEvents(events);
    const presentComponents = new Set<BrokerComponentKey>(["positions"]);
    const book = projectBrokerBook(effective, presentComponents);

    // Oracle: positions is present (had events), cash and activity are absent (never synced)
    expect(book.components.positions).toBe("present");
    expect(book.components.cash).toBe("absent");
    expect(book.components.activity).toBe("absent");
  });

  it("AC3c: correction order-independence — base+correction in both arrival orders yield identical positions", () => {
    // Base position
    const base = posEvent("AAPL", 10, { externalIdentity: "AAPL-r1", revision: 1 });
    const baseKey = eventKey(base);
    // Correction supersedes base with new value
    const correction = posEvent("AAPL", 12, {
      externalIdentity: "AAPL-r2",
      revision: 2,
      corrects: baseKey,
    });

    const presentComponents = new Set<BrokerComponentKey>(["positions", "cash", "activity"]);

    // Order 1: base first, then correction
    const book1 = projectBrokerBook(effectiveBrokerEvents([base, correction]), presentComponents);
    // Order 2: correction first, then base (late delivery)
    const book2 = projectBrokerBook(effectiveBrokerEvents([correction, base]), presentComponents);

    // Oracle: deterministic regardless of arrival order → same final positions
    // AAPL should be 12 (correction wins) in both
    const qty1 = book1.positions.find((r) => r.entity === "AAPL");
    const qty2 = book2.positions.find((r) => r.entity === "AAPL");
    expect((qty1?.body as { signedQuantity: number } | undefined)?.signedQuantity).toBe(12);
    expect((qty2?.body as { signedQuantity: number } | undefined)?.signedQuantity).toBe(12);
    // Full position arrays are structurally equal
    expect(book1.positions).toEqual(book2.positions);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Snapshot completeness gate
//    Spec §8: "complete Broker Snapshot … bounded skew, absence-vs-zero, all pages"
//    AC: page gap / divergent checksum / out-of-skew component → HELD, prior snapshot preserved;
//        zero-page component is present-and-empty (still complete)
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – snapshot completeness", () => {
  it("AC4a: a page gap causes 'held' and the prior complete snapshot is preserved", () => {
    const store = new BrokerSnapshotStore();
    // Promote a baseline complete snapshot
    const r1 = store.promote(WS, candidateSnap({ syncedAt: at(0) }));
    expect(r1.status).toBe("promoted");

    // Attempt a candidate where one page from positions is missing (manifest says 2, only 1 delivered)
    const gapped = candidateSnap({
      syncedAt: at(100),
      snapshotAsOf: "2026-07-19T00:01:00Z",
      pageCounts: { positions: 2 },
      dropPage: { component: "positions", pageIndex: 1 },
    });
    const r2 = store.promote(WS, gapped);
    // Oracle: incomplete (gap) → held
    expect(r2.status).toBe("held");

    // Prior snapshot still current
    const view = store.current(WS, acct(), at(100));
    expect(view.status).toBe("fresh");
    // Safe watermark must not have advanced past the baseline
    expect(store.safeWatermark(WS, acct())).toBe("2026-07-19T00:00:00Z");
  });

  it("AC4b: a divergent component checksum causes 'held' and prior snapshot preserved", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));

    const tampered = candidateSnap({
      syncedAt: at(100),
      snapshotAsOf: "2026-07-19T00:01:00Z",
      manifestChecksumOverride: { cash: "tampered-checksum" },
    });
    const result = store.promote(WS, tampered);
    // Oracle: checksum mismatch → held (spec §8: "checksum audit")
    expect(result.status).toBe("held");
    expect(store.current(WS, acct(), at(100)).status).toBe("fresh");
    expect(store.safeWatermark(WS, acct())).toBe("2026-07-19T00:00:00Z");
  });

  it("AC4c: a component outside the bounded skew window causes 'held' and prior snapshot preserved", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));

    // snapshotAsOf 00:01:00Z, activity asOf 00:00:00Z → skew = 60_000ms, maxSkewMs = 1_000 → exceeds bound
    const skewed = candidateSnap({
      syncedAt: at(200),
      snapshotAsOf: "2026-07-19T00:01:00Z",
      maxSkewMs: 1_000,
      asOfByComponent: {
        positions: "2026-07-19T00:01:00Z",
        cash: "2026-07-19T00:01:00Z",
        activity: "2026-07-19T00:00:00Z", // 60s behind → exceeds 1s maxSkewMs
      },
    });
    const result = store.promote(WS, skewed);
    // Oracle: skew > maxComponentSkewMs → held
    expect(result.status).toBe("held");
    expect(store.current(WS, acct(), at(200)).status).toBe("fresh");
  });

  it("AC4d: a zero-page component is present-and-empty and the snapshot is still complete (promoted)", () => {
    const store = new BrokerSnapshotStore();
    // activity has 0 pages → present-and-empty (absence-vs-zero: confirmed empty)
    const c = candidateSnap({
      syncedAt: at(0),
      pageCounts: { positions: 1, cash: 1, activity: 0 },
      events: [posEvent("AAPL", 10)],
    });
    const result = store.promote(WS, c);
    // Oracle: zero-page component is complete (spec routes.ts comment line 68: "A zero-page … folds to empty checksum — absence-vs-zero, allowed")
    expect(result.status).toBe("promoted");

    const view = store.current(WS, acct(), at(0));
    expect(view.status).toBe("fresh");
    if (view.status === "fresh") {
      // activity component is present (explicitly synced, confirmed empty)
      expect(view.projection.components.activity).toBe("present");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Never roll back
//    Spec §8: "partial/cursor/schema/re-auth failures do not replace the last complete snapshot"
//    AC: complete snapshot with older snapshotAsOf than current is held
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – no rollback", () => {
  it("AC5: a complete snapshot with an older snapshotAsOf than the current one is held", () => {
    const store = new BrokerSnapshotStore();

    // Promote a newer snapshot first
    const newer = candidateSnap({ syncedAt: at(100), snapshotAsOf: "2026-07-19T01:00:00Z" });
    expect(store.promote(WS, newer).status).toBe("promoted");

    // Now attempt to promote an older (but technically complete) snapshot
    const older = candidateSnap({ syncedAt: at(200), snapshotAsOf: "2026-07-19T00:00:00Z" });
    const result = store.promote(WS, older);
    // Oracle: must not roll back — older snapshotAsOf → held (spec §8)
    expect(result.status).toBe("held");

    // The current snapshot's watermark reflects the newer run
    expect(store.safeWatermark(WS, acct())).toBe("2026-07-19T01:00:00Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Expiry (fixed clock)
//    Spec §8: "+60s soft expiry, 15min hard expiry"
//    AC: within 60s = fresh; past 60s = stale (value still present); past 15min = expired,
//        NO current projection, only frozen evidence view
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – expiry with fixed clock", () => {
  it("AC6a: within 60s of promotion the snapshot is 'fresh'", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));

    // Oracle: 0ms elapsed → fresh (well within 60s soft expiry)
    const view = store.current(WS, acct(), at(0));
    expect(view.status).toBe("fresh");

    // Oracle: 59 999ms elapsed → still fresh (1ms before soft expiry)
    const viewAlmost = store.current(WS, acct(), at(BROKER_SNAPSHOT_SOFT_EXPIRY_MS - 1));
    expect(viewAlmost.status).toBe("fresh");
    if (viewAlmost.status === "fresh") {
      // Value is present
      expect(viewAlmost.projection).toBeDefined();
    }
  });

  it("AC6b: past 60s but before 15min the snapshot is 'stale' and the projection is still present", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));

    // Oracle: 60_001ms elapsed → past soft expiry, not yet hard
    const view = store.current(WS, acct(), at(BROKER_SNAPSHOT_SOFT_EXPIRY_MS + 1));
    expect(view.status).toBe("stale");
    // Stale still carries the projection (value available for display)
    if (view.status === "stale") {
      expect(view.projection).toBeDefined();
      expect(view.snapshotAsOf).toBe("2026-07-19T00:00:00Z");
    }
  });

  it("AC6c: past 15min hard expiry the status is 'expired', projection is absent, only frozen evidence present", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));

    // Oracle: BROKER_SNAPSHOT_HARD_EXPIRY_MS + 1ms elapsed → expired
    const view = store.current(WS, acct(), at(BROKER_SNAPSHOT_HARD_EXPIRY_MS + 1));
    expect(view.status).toBe("expired");
    // Spec §8: "hard expiry 뒤 current Information Outcome은 value가 없고 별도 historical/frozen evidence만"
    // expired carries .frozen, NOT .projection
    expect((view as { projection?: unknown }).projection).toBeUndefined();
    if (view.status === "expired") {
      expect(view.frozen).toBeDefined();
    }
  });

  it("AC6 constants: soft=60s and hard=15min (900s) as specified", () => {
    // Oracle: exact values from spec §8
    expect(BROKER_SNAPSHOT_SOFT_EXPIRY_MS).toBe(60_000);
    expect(BROKER_SNAPSHOT_HARD_EXPIRY_MS).toBe(900_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Worker end-to-end (via harness)
//    AC / spec §8 behaviors exercised through makeWorker
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_NOW = () => new Date("2026-07-19T00:00:00.000Z");

function baseSource(): ScriptedBrokerReadSource {
  const src = new ScriptedBrokerReadSource();
  src.set("positions", [{ events: [positionWire("AAPL", 10)], checksum: "pos-blind-0", asOf: "2026-07-19T00:00:00Z" }]);
  src.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-blind-0", asOf: "2026-07-19T00:00:00Z" }]);
  src.set("activity", []); // present-and-empty
  return src;
}

describe("F10 blind acceptance – worker end-to-end", () => {
  it("AC7a: a clean full sync promotes a complete snapshot", async () => {
    const h = makeWorker(baseSource(), WORKER_NOW);
    const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    // Oracle: all components complete → promoted (spec §8 completeness conditions)
    expect(outcome.status).toBe("promoted");
    const view = h.snapshots.current(WORKSPACE, account(), WORKER_NOW());
    expect(view.status).toBe("fresh");
  });

  it("AC7b: cursor reset holds and preserves the prior snapshot", async () => {
    const src = baseSource();
    src.set("positions", [
      { events: [positionWire("AAPL", 10)], checksum: "p0", asOf: "2026-07-19T00:00:00Z" },
      { events: [positionWire("MSFT", 5)], checksum: "p1", asOf: "2026-07-19T00:00:00Z" },
    ]);
    const h = makeWorker(src, WORKER_NOW);
    // First sync: complete → promoted
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");
    const priorWatermark = h.snapshots.safeWatermark(WORKSPACE, account());

    // Inject mid-stream cursor reset
    src.resetCursor = { component: "positions", atCursor: "1" };
    const held = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    // Oracle: cursor reset → held (spec §8: "cursor … failure does not replace last complete snapshot")
    expect(held.status).toBe("held");
    // Prior snapshot still current and watermark unchanged
    expect(h.snapshots.current(WORKSPACE, account(), WORKER_NOW()).status).toBe("fresh");
    expect(h.snapshots.safeWatermark(WORKSPACE, account())).toBe(priorWatermark);
  });

  it("AC7b: page gap holds and preserves the prior snapshot", async () => {
    const src = baseSource();
    const h = makeWorker(src, WORKER_NOW);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");

    // Now inject a gap: manifest claims 2 position pages but only 1 exists
    src.overridePageCount("positions", 2);
    const held = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(held.status).toBe("held");
    expect(h.snapshots.current(WORKSPACE, account(), WORKER_NOW()).status).toBe("fresh");
  });

  it("AC7b: divergent checksum holds and preserves the prior snapshot", async () => {
    const src = baseSource();
    const h = makeWorker(src, WORKER_NOW);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");

    src.overrideChecksum("cash", "tampered-blind");
    const held = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(held.status).toBe("held");
    expect(h.snapshots.current(WORKSPACE, account(), WORKER_NOW()).status).toBe("fresh");
  });

  it("AC7c: revoked connection returns 'unauthorized' without touching the snapshot", async () => {
    const h = makeWorker(baseSource(), WORKER_NOW);
    h.revoke();
    const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    // Oracle: revoked auth → unauthorized (spec §8: "ConnectionLifecycleFence")
    expect(outcome.status).toBe("unauthorized");
    // No snapshot promoted (worker was never authorized)
    expect(h.snapshots.current(WORKSPACE, account(), WORKER_NOW()).status).toBe("none");
  });

  it("AC7d: a restarted worker converges to the same projection with no double-count", async () => {
    const src = baseSource();
    const h = makeWorker(src, WORKER_NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    const before = h.snapshots.current(WORKSPACE, account(), WORKER_NOW());

    // Restart: fresh worker over the same durable stores
    await h.restartedWorker().sync(WORKSPACE, viewer(), account(), CONNECTION);
    const after = h.snapshots.current(WORKSPACE, account(), WORKER_NOW());

    // Oracle: idempotent — same projection, no double-count
    expect(after).toEqual(before);
    if (after.status === "fresh") {
      // Only 1 AAPL position (not duplicated)
      expect(after.projection.positions.filter((r) => r.entity === "AAPL")).toHaveLength(1);
    }
  });

  it("AC7e: a new provider data epoch does not leak old positions into the new lineage's projection", async () => {
    const src = baseSource();
    const h = makeWorker(src, WORKER_NOW);
    // Epoch 1: AAPL 10
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);

    // Epoch 2: only MSFT 7 (ledger reset)
    src.lineage = { ...src.lineage, providerDataEpoch: 2 };
    src.set("positions", [{ events: [positionWire("MSFT", 7)], checksum: "pos-e2", asOf: "2026-07-19T00:00:00Z" }]);
    src.set("cash", [{ events: [cashWire("USD", 2000)], checksum: "cash-e2", asOf: "2026-07-19T00:00:00Z" }]);
    const outcome2 = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(outcome2.status).toBe("promoted");

    const view = h.snapshots.current(WORKSPACE, account(), WORKER_NOW());
    if (view.status === "fresh") {
      // Oracle: new epoch → new lineage → AAPL must NOT appear (old namespace does not leak)
      const entities = view.projection.positions.map((r) => r.entity);
      expect(entities).not.toContain("AAPL");
      expect(entities).toContain("MSFT");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Erasure fence
//    AC: after eraseSubject(workspace, BIG_FENCE) on erasables(),
//        record(...) returns "suppressed" and events(...)/current(...) are empty/none
// ─────────────────────────────────────────────────────────────────────────────

describe("F10 blind acceptance – erasure fence", () => {
  it("AC8a: event store record returns 'suppressed' after erasure fence; events() is empty", () => {
    const store = new BrokerSyncEventStore();
    const lg = lineage();
    store.record(WS, lg, posEvent("AAPL", 10));
    expect(store.events(WS, lg)).toHaveLength(1);

    // Oracle: BROKER_SYNC_LIVE_EPOCH + 1 is the fence value used by AC (see f10-broker-event-store.test.ts line 87)
    const BIG_FENCE = BROKER_SYNC_LIVE_EPOCH + 1;
    for (const erasable of store.erasables() as Erasable[]) {
      erasable.eraseSubject(WS, BIG_FENCE);
    }

    // After erasure: events returns empty
    expect(store.events(WS, lg)).toHaveLength(0);

    // Spec §8 (AC requirements): restore suppression — a late record must return "suppressed"
    const late = store.record(WS, lg, posEvent("AAPL", 10));
    expect(late).toBe("suppressed");

    // Even after the suppressed write, events() remains empty
    expect(store.events(WS, lg)).toHaveLength(0);
  });

  it("AC8b: snapshot store current() returns 'none' after erasure fence", () => {
    const store = new BrokerSnapshotStore();
    store.promote(WS, candidateSnap({ syncedAt: at(0) }));
    expect(store.current(WS, acct(), at(0)).status).toBe("fresh");

    const BIG_FENCE = BROKER_SYNC_LIVE_EPOCH + 1;
    for (const erasable of store.erasables() as Erasable[]) {
      erasable.eraseSubject(WS, BIG_FENCE);
    }

    // Oracle: all snapshot data erased → none
    expect(store.current(WS, acct(), at(0)).status).toBe("none");
    // Safe watermark is also gone
    expect(store.safeWatermark(WS, acct())).toBeUndefined();
  });
});
