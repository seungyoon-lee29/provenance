import { FencedKeyedStore, SubjectFence } from "../../platform/persistence/fenced-store";
import type { Erasable } from "../../platform/persistence/fenced-store";
import type { ErasureParticipant } from "../identity/identity-service";

/**
 * F5 delivery persistence wiring over the platform fenced substrate (SEC-09).
 * The substrate itself lives in `platform/persistence/fenced-store` (Stage 2
 * T1); this module keeps only its own erasure participant. The re-exports
 * cover the module's internal stores until T3 removes NotificationCenter.
 */
export { FencedKeyedStore, SubjectFence };
export type { Erasable };

export type ErasureReceiptLine = Readonly<{ label: string; workspace: string; shredded: number; fence: number }>;

/**
 * One NotificationCenter erasure participant that shreds every registered
 * delivery store for the erased workspace behind a single fence and records a
 * per-store receipt line — the module receipt the SEC-09 coordinator collects.
 */
export function notificationErasureParticipant(
  stores: readonly Readonly<{ label: string; store: Erasable }>[],
  receipts: ErasureReceiptLine[] = [],
): ErasureParticipant & { readonly receipts: ErasureReceiptLine[] } {
  return {
    receipts,
    erase(context) {
      for (const { label, store } of stores) {
        const shredded = store.eraseSubject(context.workspaceReference, context.fence);
        receipts.push({ label, workspace: context.workspaceReference, shredded, fence: context.fence });
      }
      return Promise.resolve();
    },
  };
}
