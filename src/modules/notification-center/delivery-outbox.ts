import { FencedKeyedStore } from "./fenced-store";
import type { PlannedDeliveryIntent } from "./delivery-intent";

/**
 * The durable Delivery Intent outbox (spec §11): a planned intent is committed
 * BEFORE any external call, keyed by its `(causeId, channel, destinationFingerprint)`
 * unique identity so a replayed commit is idempotent (no double dispatch). It
 * sits on the fenced substrate, so a commit for an erased subject is suppressed.
 */
export type OutboxCommitResult =
  | Readonly<{ status: "committed"; intent: PlannedDeliveryIntent }>
  | Readonly<{ status: "duplicate"; intent: PlannedDeliveryIntent }>
  | Readonly<{ status: "suppressed" }>;

export class DeliveryOutbox {
  readonly #store = new FencedKeyedStore<PlannedDeliveryIntent>();

  /**
   * @param subject the erasure subject that owns the intent — a workspace for
   *   alert delivery, a pending identity for pre-account challenges.
   * @param atEpoch the authorization epoch the write belongs to; a commit at or
   *   below the subject's deletion fence is suppressed.
   */
  commit(subject: string, intent: PlannedDeliveryIntent, atEpoch: number): OutboxCommitResult {
    const { written, value } = this.#store.writeIfAbsent(subject, intent.uniqueKey, intent, atEpoch);
    if (value === undefined) return { status: "suppressed" };
    return written ? { status: "committed", intent: value } : { status: "duplicate", intent: value };
  }

  get(subject: string, uniqueKey: string): PlannedDeliveryIntent | undefined {
    return this.#store.get(subject, uniqueKey);
  }

  list(subject: string): readonly PlannedDeliveryIntent[] {
    return this.#store.list(subject);
  }

  eraseSubject(subject: string, fence: number): number {
    return this.#store.eraseSubject(subject, fence);
  }

  isErased(subject: string, atEpoch: number): boolean {
    return this.#store.isErased(subject, atEpoch);
  }
}
