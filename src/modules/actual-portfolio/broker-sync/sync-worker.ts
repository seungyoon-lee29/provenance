import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { Erasable } from "../../notification-center/fenced-store";
import type { ProviderConnectionReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";
import { BROKER_READ_ROUTE_IDS } from "../../provider-connections/read-transport/routes";
import type { BrokerReadPageResponse } from "../../provider-connections/read-transport/routes";
import type { BrokerReadTransport } from "../../provider-connections/read-transport/broker-read-transport";

import type { BrokerComponentKey, BrokerLineage, BrokerSyncAccountReference, BrokerSyncEvent, ExternalAccountIdentity } from "./contracts";
import { eventKey, lineageKey } from "./contracts";
import { BrokerSyncEventStore, BROKER_SYNC_LIVE_EPOCH } from "./event-store";
import type { BrokerSnapshotStore, ReceivedPage, SnapshotManifest } from "./snapshot";

/**
 * F10 broker sync worker (spec §8, AT-09). Drives the read-only transport to
 * page every manifest component, folds the pages into the durable event store,
 * and asks the snapshot store to promote — which only happens if the pages form
 * a CompleteBrokerSnapshot. A partial page, a cursor reset, a gap, a divergent
 * checksum or an unauthorized connection all leave the prior complete snapshot
 * and its safe watermark untouched (spec §8: "partial/cursor/schema/re-auth
 * 실패는 마지막 complete Snapshot을 교체하지 않는다").
 *
 * Convergence: a fresh worker over the same durable stores re-pages, dedupes to
 * the same events, and promotes to the same snapshot (external reads are
 * idempotent). Lineage: a new triple (ledger reset / different fingerprint or
 * epoch) is a fresh namespace, so the old events never leak into it.
 */

const COMPONENT_ROUTE: Readonly<Record<BrokerComponentKey, string>> = {
  positions: BROKER_READ_ROUTE_IDS.positions,
  cash: BROKER_READ_ROUTE_IDS.cash,
  activity: BROKER_READ_ROUTE_IDS.activity,
};

export type SyncRunOutcome =
  | Readonly<{ status: "promoted"; lineageKey: string }>
  | Readonly<{ status: "held"; reason: string }>
  | Readonly<{ status: "unauthorized" }>
  | Readonly<{ status: "suppressed" }>;

type SyncProgressRow = Readonly<{ lineageKey: string; provisionalWatermark: string }>;

/** Durable per-account sync progress: the current lineage + the provisional (received) watermark. */
export class BrokerSyncCursorStore {
  readonly #progress = new FencedKeyedStore<SyncProgressRow>();

  constructor(private readonly writeEpoch: () => number = () => BROKER_SYNC_LIVE_EPOCH) {}

  recordProgress(workspace: string, account: BrokerSyncAccountReference, lineage: string, provisionalWatermark: string): void {
    const existing = this.#progress.get(workspace, String(account));
    const highest = existing !== undefined && existing.lineageKey === lineage && existing.provisionalWatermark > provisionalWatermark
      ? existing.provisionalWatermark
      : provisionalWatermark;
    this.#progress.write(workspace, String(account), { lineageKey: lineage, provisionalWatermark: highest }, this.writeEpoch());
  }

  lineageKeyOf(workspace: string, account: BrokerSyncAccountReference): string | undefined {
    return this.#progress.get(workspace, String(account))?.lineageKey;
  }

  provisionalWatermark(workspace: string, account: BrokerSyncAccountReference): string | undefined {
    return this.#progress.get(workspace, String(account))?.provisionalWatermark;
  }

  isErased(workspace: string): boolean {
    return this.#progress.isErased(workspace, this.writeEpoch());
  }

  erasables(): readonly Erasable[] {
    return [this.#progress];
  }
}

export type BrokerSyncWorkerDeps = Readonly<{
  transport: BrokerReadTransport;
  events: BrokerSyncEventStore;
  snapshots: BrokerSnapshotStore;
  cursors: BrokerSyncCursorStore;
  now: () => Date;
}>;

export class BrokerSyncWorker {
  constructor(private readonly deps: BrokerSyncWorkerDeps) {}

  async sync(workspace: string, viewer: WorkspaceViewerContext, account: BrokerSyncAccountReference, connection: ProviderConnectionReference): Promise<SyncRunOutcome> {
    // Deletion fence: after erasure there is no broker read, no queue claim and
    // no promotion — the transport is never even touched.
    if (this.deps.cursors.isErased(workspace)) return { status: "suppressed" };

    let transport;
    try {
      transport = await this.deps.transport.authorize(connection, viewer);
    } catch {
      return { status: "unauthorized" };
    }

    let manifestHead: { lineage: BrokerLineage; manifest: SnapshotManifest };
    try {
      const head = (await (await transport.execute(BROKER_READ_ROUTE_IDS.checksum, { account: String(account) })).commit(async (value) => value)) as {
        lineage: { externalAccountIdentity: string; verifiedFingerprint: string; providerDataEpoch: number };
        manifest: SnapshotManifest;
      };
      manifestHead = { lineage: brandLineage(head.lineage), manifest: head.manifest };
    } catch {
      return { status: "held", reason: "transport_failed" };
    }

    const lineage = manifestHead.lineage;
    const currentLineageKey = lineageKey(lineage);
    const pages: ReceivedPage[] = [];
    const runKeys = new Set<string>();

    for (const component of manifestHead.manifest.components) {
      if (component.pageCount === 0) continue; // present-and-empty; nothing to page.
      let cursor: string | undefined;
      let expected = 0;
      for (;;) {
        let page: BrokerReadPageResponse;
        try {
          page = (await (await transport.execute(COMPONENT_ROUTE[component.key], { account: String(account), component: component.key, cursor })).commit(async (value) => value)) as BrokerReadPageResponse;
        } catch {
          return { status: "held", reason: "transport_failed" };
        }
        if (page.pageIndex !== expected) return { status: "held", reason: "cursor_reset" };

        for (const wire of page.events) {
          const event = { connection, account, component: component.key, entity: wire.entity, kind: wire.kind, externalIdentity: wire.externalIdentity, revision: wire.revision, asOf: wire.asOf, ...(wire.corrects !== undefined ? { corrects: wire.corrects } : {}), body: wire.body } as BrokerSyncEvent;
          this.deps.events.record(workspace, lineage, event);
          runKeys.add(eventKey(event));
        }
        pages.push({ component: component.key, pageIndex: page.pageIndex, isLastPage: page.isLastPage, checksum: page.checksum, asOf: page.asOf });
        if (page.isLastPage || page.nextCursor === undefined) break;
        cursor = page.nextCursor;
        expected += 1;
      }
    }

    // The provisional watermark is how fresh the data we have SEEN is (the
    // manifest as-of of this run), advanced even when promotion is held.
    this.deps.cursors.recordProgress(workspace, account, currentLineageKey, manifestHead.manifest.snapshotAsOf);

    // The snapshot is exactly the events read THIS run (scoped by key), taken
    // from the durable store so a divergent redelivery keeps the ORIGINAL value.
    const snapshotEvents = this.deps.events.events(workspace, lineage).filter((event) => runKeys.has(eventKey(event)));
    const outcome = this.deps.snapshots.promote(workspace, { lineage, account, manifest: manifestHead.manifest, pages, events: snapshotEvents, syncedAt: this.deps.now() });
    if (outcome.status === "promoted") return { status: "promoted", lineageKey: currentLineageKey };
    if (outcome.status === "suppressed") return { status: "suppressed" };
    return { status: "held", reason: outcome.reason };
  }
}

function brandLineage(wire: { externalAccountIdentity: string; verifiedFingerprint: string; providerDataEpoch: number }): BrokerLineage {
  return { externalAccountIdentity: wire.externalAccountIdentity as ExternalAccountIdentity, verifiedFingerprint: wire.verifiedFingerprint, providerDataEpoch: wire.providerDataEpoch };
}
