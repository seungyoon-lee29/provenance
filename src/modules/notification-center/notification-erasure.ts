import { brandReference } from "../../shared/contracts/brands";
import type { ErasureParticipant } from "../identity/identity-service";
import type { Erasable } from "./fenced-store";
import type { OccurrenceStore } from "./occurrence-engine";
import type { ProviderMessageDirectory, WebhookTombstoneRegistry } from "./webhook-inbox";

/**
 * F5 NotificationCenter erasure participant (SEC-09, ticket 14 line 30).
 *
 * One coordinator fence erases every personal delivery store: the occurrence
 * spine (alert rules, watermarks/state, occurrences, notification records) and
 * each registered fenced store (intent outbox, fact log, webhook inbox,
 * unsubscribe token hashes, sealed endpoint/action material — B7 registers
 * quota/abuse, pending queue and cache stores as they materialize). Erased
 * provider-message bindings are tombstoned so a late SIGNED webhook writes
 * nothing but the bounded counter. The per-store receipt is the module's
 * public erasure state the Identity coordinator collects; a replayed
 * coordinator call keeps the original receipt instead of zeroing it.
 */
export type NotificationErasureLine = Readonly<{ label: string; shredded: number }>;

export type NotificationErasureReceipt = Readonly<{
  workspace: string;
  fence: number;
  lines: readonly NotificationErasureLine[];
  tombstonedProviderMessages: number;
  /** Bindings stored without a dispatch route cannot be tombstoned — reported honestly, never hidden. */
  unroutedBindings: number;
}>;

export class NotificationCenterErasure implements ErasureParticipant {
  readonly #receipts = new Map<string, NotificationErasureReceipt>();

  constructor(
    private readonly deps: Readonly<{
      occurrences: OccurrenceStore;
      stores: readonly Readonly<{ label: string; store: Erasable }>[];
      directory: ProviderMessageDirectory;
      tombstones: WebhookTombstoneRegistry;
      now: () => number;
    }>,
  ) {}

  erase(context: Readonly<{ accountReference: string; workspaceReference: string; scope: "workspace" | "account"; fence: number }>): Promise<void> {
    const { workspaceReference: workspace, fence } = context;
    const prior = this.#receipts.get(workspace);
    if (prior !== undefined && prior.fence >= fence) return Promise.resolve();

    const spine = this.deps.occurrences.eraseWorkspace(brandReference<string, "WorkspaceReference">(workspace), fence);
    const lines: NotificationErasureLine[] = [
      { label: "alert-occurrence", shredded: spine.occurrences },
      { label: "notification-record", shredded: spine.records },
    ];
    for (const { label, store } of this.deps.stores) {
      lines.push({ label, shredded: store.eraseSubject(workspace, fence) });
    }

    let tombstoned = 0;
    let unrouted = 0;
    for (const removed of this.deps.directory.eraseOwner(workspace)) {
      if (removed.route === undefined) {
        unrouted += 1;
        continue;
      }
      this.deps.tombstones.record(removed.route.provider, removed.route.environment, removed.providerMessageId, this.deps.now());
      tombstoned += 1;
    }

    this.#receipts.set(workspace, { workspace, fence, lines, tombstonedProviderMessages: tombstoned, unroutedBindings: unrouted });
    return Promise.resolve();
  }

  /** The module's public erasure state (receipt = what the SEC-09 coordinator publishes). */
  receiptFor(workspace: string): NotificationErasureReceipt | undefined {
    return this.#receipts.get(workspace);
  }
}
