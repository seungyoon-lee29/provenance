import { FencedKeyedStore } from "./fenced-store";
import type { DeliveryCauseId } from "./contracts";

/**
 * F5 Delivery Fact log (spec §11 line 341). Every external delivery signal is
 * recorded as an append-only Delivery Fact; there is deliberately no update or
 * promote operation, so a provider `provider_accepted` is never turned into
 * `delivered`, an open/click is never turned into `seen`, and `sent` is never
 * inferred. The log sits on the fenced substrate so administrative erasure
 * shreds a workspace's facts and suppresses a late webhook replay (SEC-09).
 */
export type DeliveryFactKind =
  | "queued"
  | "provider_accepted"
  | "delayed"
  | "delivered"
  | "seen"
  | "bounced"
  | "complained"
  | "provider_suppressed"
  | "suppressed"
  | "failed"
  | "expired";

export type DeliveryFact = Readonly<{
  sequence: number;
  causeId: DeliveryCauseId;
  intentUniqueKey: string;
  kind: DeliveryFactKind;
  occurredAt: string;
}>;

export type DeliveryFactInput = Omit<DeliveryFact, "sequence">;

// Higher wins. Positive progress is ordered queued→seen; terminal negatives rank
// above all progress so a failure is never hidden behind an earlier success. A
// kind is only ever picked if a fact of that kind was actually recorded, which
// is what makes the projection promotion-free.
// ponytail: the failure-over-progress ordering is a display policy; refine in B7
// if the surface needs a richer status. The invariant tested here is "no promotion".
const STATUS_PRECEDENCE: Record<DeliveryFactKind, number> = {
  queued: 0,
  delayed: 1,
  provider_accepted: 2,
  delivered: 3,
  seen: 4,
  expired: 5,
  suppressed: 6,
  provider_suppressed: 7,
  failed: 8,
  bounced: 9,
  complained: 10,
};

export function projectDeliveryStatus(facts: readonly DeliveryFact[]): DeliveryFactKind | "none" {
  let best: DeliveryFactKind | undefined;
  for (const f of facts) {
    if (best === undefined || STATUS_PRECEDENCE[f.kind] > STATUS_PRECEDENCE[best]) best = f.kind;
  }
  return best ?? "none";
}

export class DeliveryFactLog {
  readonly #store = new FencedKeyedStore<DeliveryFact>();
  readonly #sequence = new Map<string, number>();

  /**
   * Append one fact for the subject. Returns `{ appended: false }` when the
   * subject is fenced (erased) — a late provider result cannot regenerate state.
   * Each fact takes a fresh per-subject sequence key, so a write never overwrites
   * an earlier fact: the log is append-only by construction.
   */
  append(subject: string, fact: DeliveryFactInput, atEpoch: number): Readonly<{ appended: boolean; fact?: DeliveryFact }> {
    const next = (this.#sequence.get(subject) ?? 0) + 1;
    const stored: DeliveryFact = { ...fact, sequence: next };
    if (!this.#store.write(subject, `fact:${next}`, stored, atEpoch)) return { appended: false };
    this.#sequence.set(subject, next);
    return { appended: true, fact: stored };
  }

  list(subject: string): readonly DeliveryFact[] {
    return [...this.#store.list(subject)].sort((a, b) => a.sequence - b.sequence);
  }

  listForDelivery(subject: string, intentUniqueKey: string): readonly DeliveryFact[] {
    return this.list(subject).filter((f) => f.intentUniqueKey === intentUniqueKey);
  }

  eraseSubject(subject: string, fence: number): number {
    this.#sequence.delete(subject);
    return this.#store.eraseSubject(subject, fence);
  }

  isErased(subject: string, atEpoch: number): boolean {
    return this.#store.isErased(subject, atEpoch);
  }
}
