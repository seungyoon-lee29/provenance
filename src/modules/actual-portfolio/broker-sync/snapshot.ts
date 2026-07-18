import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { Erasable } from "../../notification-center/fenced-store";

import type { BrokerComponentKey, BrokerLineage, BrokerSyncAccountReference, BrokerSyncEvent } from "./contracts";
import { lineageKey } from "./contracts";
import { effectiveBrokerEvents, projectBrokerBook } from "./projection";
import type { BrokerProjection } from "./projection";
import { BROKER_SYNC_LIVE_EPOCH } from "./event-store";

/**
 * The CompleteBrokerSnapshot is the ONLY promotable truth (spec §8). A snapshot
 * is complete iff every manifest component is fully paged (contiguous, no gap),
 * each component's page checksums fold to the manifest checksum, and the
 * components sit inside the bounded skew window. Anything else — a partial page,
 * a gap, a divergent checksum, skew, an older snapshot — is HELD: the current
 * projection and its safe watermark are never overwritten by non-complete data.
 *
 * Current display carries a fixed-clock expiry: +60s soft (stale) and +15min
 * hard, after which the current value is gone and only a frozen evidence view of
 * the last snapshot remains (never usable for current total/P&L/rebalance).
 */

export const BROKER_SNAPSHOT_SOFT_EXPIRY_MS = 60_000;
export const BROKER_SNAPSHOT_HARD_EXPIRY_MS = 15 * 60_000;

export type ReceivedPage = Readonly<{ component: BrokerComponentKey; pageIndex: number; isLastPage: boolean; checksum: string; asOf: string }>;

export type SnapshotManifest = Readonly<{
  snapshotAsOf: string;
  maxComponentSkewMs: number;
  components: readonly Readonly<{ key: BrokerComponentKey; pageCount: number; checksum: string }>[];
}>;

export type SnapshotCandidate = Readonly<{
  lineage: BrokerLineage;
  account: BrokerSyncAccountReference;
  manifest: SnapshotManifest;
  pages: readonly ReceivedPage[];
  events: readonly BrokerSyncEvent[];
  syncedAt: Date;
}>;

export type CompletenessAssessment =
  | Readonly<{ status: "complete"; presentComponents: ReadonlySet<BrokerComponentKey>; maxAsOfMs: number; minAsOfMs: number }>
  | Readonly<{ status: "partial"; reason: "missing_component" | "gap" | "divergent_checksum" | "skew_exceeded" }>;

export type PromoteOutcome =
  | Readonly<{ status: "promoted" }>
  | Readonly<{ status: "held"; reason: "missing_component" | "gap" | "divergent_checksum" | "skew_exceeded" | "stale" }>
  | Readonly<{ status: "suppressed" }>;

type StoredSnapshot = Readonly<{
  lineageKey: string;
  snapshotAsOf: string;
  syncedAtMs: number;
  projection: BrokerProjection;
}>;

export type BrokerSnapshotView =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "fresh" | "stale"; lineageKey: string; snapshotAsOf: string; syncedAtMs: number; projection: BrokerProjection; safeWatermark: string }>
  | Readonly<{ status: "expired"; lineageKey: string; snapshotAsOf: string; syncedAtMs: number; frozen: BrokerProjection; safeWatermark: string }>;

/** Deterministic fold of a component's page checksums (order-insensitive by page index). */
export function foldComponentChecksum(pages: readonly ReceivedPage[]): string {
  return [...pages].sort((a, b) => a.pageIndex - b.pageIndex).map((page) => page.checksum).join("|");
}

export function assessSnapshot(manifest: SnapshotManifest, pages: readonly ReceivedPage[]): CompletenessAssessment {
  const present = new Set<BrokerComponentKey>();
  let minAsOfMs = Number.POSITIVE_INFINITY;
  let maxAsOfMs = Number.NEGATIVE_INFINITY;

  for (const component of manifest.components) {
    const collected = pages.filter((page) => page.component === component.key);
    const byIndex = new Map(collected.map((page) => [page.pageIndex, page]));
    // Contiguous 0..pageCount-1 with no gap (a missing page is a gap even when a
    // forged checksum matches the short fold). Extra/spurious pages beyond the
    // count are caught by the checksum fold below.
    for (let index = 0; index < component.pageCount; index += 1) {
      if (!byIndex.has(index)) return { status: "partial", reason: "gap" };
    }
    if (foldComponentChecksum(collected) !== component.checksum) return { status: "partial", reason: "divergent_checksum" };
    present.add(component.key);
    for (const page of collected) {
      const asOfMs = Date.parse(page.asOf);
      minAsOfMs = Math.min(minAsOfMs, asOfMs);
      maxAsOfMs = Math.max(maxAsOfMs, asOfMs);
    }
  }

  if (maxAsOfMs !== Number.NEGATIVE_INFINITY && maxAsOfMs - minAsOfMs > manifest.maxComponentSkewMs) {
    return { status: "partial", reason: "skew_exceeded" };
  }
  return { status: "complete", presentComponents: present, maxAsOfMs, minAsOfMs };
}

export class BrokerSnapshotStore {
  readonly #current = new FencedKeyedStore<StoredSnapshot>();
  readonly #safe = new FencedKeyedStore<string>();

  constructor(private readonly writeEpoch: () => number = () => BROKER_SYNC_LIVE_EPOCH) {}

  promote(workspace: string, candidate: SnapshotCandidate): PromoteOutcome {
    const epoch = this.writeEpoch();
    if (this.#current.isErased(workspace, epoch)) return { status: "suppressed" };

    const assessment = assessSnapshot(candidate.manifest, candidate.pages);
    if (assessment.status === "partial") return { status: "held", reason: assessment.reason };

    // Never roll back: a complete snapshot older than the current one is held.
    const account = String(candidate.account);
    const existing = this.#current.get(workspace, account);
    if (existing !== undefined && candidate.manifest.snapshotAsOf < existing.snapshotAsOf) {
      return { status: "held", reason: "stale" };
    }

    const projection = projectBrokerBook(effectiveBrokerEvents(candidate.events), assessment.presentComponents);
    const stored: StoredSnapshot = {
      lineageKey: lineageKey(candidate.lineage),
      snapshotAsOf: candidate.manifest.snapshotAsOf,
      syncedAtMs: candidate.syncedAt.getTime(),
      projection,
    };
    this.#current.write(workspace, account, stored, epoch);
    this.#safe.write(workspace, account, candidate.manifest.snapshotAsOf, epoch);
    return { status: "promoted" };
  }

  current(workspace: string, account: BrokerSyncAccountReference, now: Date): BrokerSnapshotView {
    const stored = this.#current.get(workspace, String(account));
    if (stored === undefined) return { status: "none" };
    const safeWatermark = this.#safe.get(workspace, String(account)) ?? stored.snapshotAsOf;
    const ageMs = now.getTime() - stored.syncedAtMs;
    const base = { lineageKey: stored.lineageKey, snapshotAsOf: stored.snapshotAsOf, syncedAtMs: stored.syncedAtMs, safeWatermark };
    if (ageMs > BROKER_SNAPSHOT_HARD_EXPIRY_MS) return { status: "expired", ...base, frozen: stored.projection };
    if (ageMs > BROKER_SNAPSHOT_SOFT_EXPIRY_MS) return { status: "stale", ...base, projection: stored.projection };
    return { status: "fresh", ...base, projection: stored.projection };
  }

  safeWatermark(workspace: string, account: BrokerSyncAccountReference): string | undefined {
    return this.#safe.get(workspace, String(account));
  }

  erasables(): readonly Erasable[] {
    return [this.#current, this.#safe];
  }
}
