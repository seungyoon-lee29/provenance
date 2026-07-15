import type { ErasureParticipant } from "../identity/identity-service";

/**
 * F5 delivery persistence substrate (SEC-09 as a Prevent, not a bolt-on).
 *
 * Every durable NotificationCenter store — Notification Records, the Delivery
 * Intent outbox, the append-only Delivery Fact log, the webhook inbox — sits on
 * a `FencedKeyedStore` so administrative erasure is structural: each store keeps
 * a monotonic deletion fence per erasure subject (a workspace OR a pending
 * identity), and any write at or below that fence is suppressed. That is what
 * stops a late worker/webhook result or a backup restore from re-creating
 * personal delivery state after erasure.
 */
export class SubjectFence {
  readonly #fence = new Map<string, number>();

  fenceOf(subject: string): number {
    return this.#fence.get(subject) ?? 0;
  }

  /** A write belonging to an epoch at or below the fence is suppressed. */
  suppressed(subject: string, atEpoch: number): boolean {
    return atEpoch <= this.fenceOf(subject);
  }

  raise(subject: string, fence: number): void {
    this.#fence.set(subject, Math.max(this.fenceOf(subject), fence));
  }
}

export interface Erasable {
  /** Shred everything for the subject behind a fence bumped past `fence`; returns the receipt count. */
  eraseSubject(subject: string, fence: number): number;
}

export class FencedKeyedStore<T> implements Erasable {
  readonly #fence = new SubjectFence();
  readonly #data = new Map<string, Map<string, T>>();

  #bucket(subject: string): Map<string, T> {
    let bucket = this.#data.get(subject);
    if (!bucket) {
      bucket = new Map<string, T>();
      this.#data.set(subject, bucket);
    }
    return bucket;
  }

  /** Returns false when suppressed by the fence; otherwise upserts and returns true. */
  write(subject: string, key: string, value: T, atEpoch: number): boolean {
    if (this.#fence.suppressed(subject, atEpoch)) return false;
    this.#bucket(subject).set(key, value);
    return true;
  }

  /**
   * Idempotent insert for a unique key (Delivery Intent outbox / webhook inbox):
   * writes only if absent, is suppressed by the fence, and returns the stored
   * value (existing on a replay, new on first write) so callers can dedupe.
   */
  writeIfAbsent(subject: string, key: string, value: T, atEpoch: number): Readonly<{ written: boolean; value: T | undefined }> {
    if (this.#fence.suppressed(subject, atEpoch)) return { written: false, value: undefined };
    const bucket = this.#bucket(subject);
    const existing = bucket.get(key);
    if (existing !== undefined) return { written: false, value: existing };
    bucket.set(key, value);
    return { written: true, value };
  }

  get(subject: string, key: string): T | undefined {
    return this.#data.get(subject)?.get(key);
  }

  list(subject: string): readonly T[] {
    return [...(this.#data.get(subject)?.values() ?? [])];
  }

  size(subject: string): number {
    return this.#data.get(subject)?.size ?? 0;
  }

  isErased(subject: string, atEpoch: number): boolean {
    return this.#fence.suppressed(subject, atEpoch);
  }

  eraseSubject(subject: string, fence: number): number {
    const shredded = this.size(subject);
    this.#fence.raise(subject, fence);
    this.#data.delete(subject);
    return shredded;
  }
}

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
