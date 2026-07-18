import type { Erasable } from "../../notification-center/fenced-store";

import type { BrokerSyncEventStore } from "./event-store";
import type { BrokerSnapshotStore } from "./snapshot";
import type { BrokerSyncCursorStore } from "./sync-worker";

/**
 * F10 Broker Sync erasure participation (SEC-09, spec §8: administrative erasure
 * is the ONLY removal path). The broker-sync stores are read-only projections of
 * personal broker data, so they register as ordinary `Erasable` stores in the F6
 * `ActualPortfolioErasure` `stores` array — one coordinator fence shreds the
 * event log (facts + identity index + quarantine), the current/frozen snapshot,
 * the safe watermark and the sync progress cursor together. After the fence, a
 * late sync read, a queue claim, a snapshot promotion, a late event commit and a
 * backup restore are all suppressed (each store's constructor-injected write
 * epoch sits at or below the raised fence).
 */
export function brokerSyncErasables(deps: Readonly<{ events: BrokerSyncEventStore; snapshots: BrokerSnapshotStore; cursors: BrokerSyncCursorStore }>): readonly Readonly<{ label: string; store: Erasable }>[] {
  const label = (prefix: string, stores: readonly Erasable[]) => stores.map((store, index) => ({ label: `${prefix}-${index}`, store }));
  return [
    ...label("broker-sync-events", deps.events.erasables()),
    ...label("broker-sync-snapshot", deps.snapshots.erasables()),
    ...label("broker-sync-cursor", deps.cursors.erasables()),
  ];
}
