import type { BrokerComponentKey, BrokerSyncEvent } from "./contracts";
import { eventKey } from "./contracts";

/**
 * Resolve a lineage's append-only events into their effective set, then project
 * the read-only broker book. Corrections never mutate a source event: a later
 * event `corrects` a prior one, voiding it and (unless it is a `reversal`)
 * contributing its own body. Correction chains are linear (a target is corrected
 * at most once, reversals are never themselves corrected), so voiding a
 * correction restores what it corrected — and the fold is order-insensitive
 * because effectiveness is keyed by identity, not arrival (F6 pattern).
 */

export type BrokerPositionEvent = Extract<BrokerSyncEvent, { component: "positions" }>;
export type BrokerCashEvent = Extract<BrokerSyncEvent, { component: "cash" }>;
export type BrokerActivityEvent = Extract<BrokerSyncEvent, { component: "activity" }>;

export type BrokerProjection = Readonly<{
  positions: readonly BrokerPositionEvent[];
  cash: readonly BrokerCashEvent[];
  activity: readonly BrokerActivityEvent[];
  /**
   * absence-vs-zero: a component that fully synced is `present` even with zero
   * rows (a real zero balance); a component that never completed is `absent`.
   */
  components: Readonly<Record<BrokerComponentKey, "present" | "absent">>;
}>;

export function effectiveBrokerEvents(events: readonly BrokerSyncEvent[]): readonly BrokerSyncEvent[] {
  // A target may be corrected more than once (a provider anomaly). Pick a single
  // deterministic winner — highest revision, ties broken by event key — so the
  // fold can never double-count or depend on arrival order (codex panel). The
  // losing correctors of the same target are voided along with the base.
  const correctorsOf = new Map<string, BrokerSyncEvent[]>();
  for (const event of events) {
    if (event.corrects === undefined) continue;
    const bucket = correctorsOf.get(event.corrects);
    if (bucket === undefined) correctorsOf.set(event.corrects, [event]);
    else bucket.push(event);
  }
  const winnerOf = new Map<string, BrokerSyncEvent>();
  const losers = new Set<string>();
  for (const [target, correctors] of correctorsOf) {
    const winner = correctors.reduce((best, next) =>
      next.revision > best.revision || (next.revision === best.revision && eventKey(next) > eventKey(best)) ? next : best,
    );
    winnerOf.set(target, winner);
    for (const corrector of correctors) if (eventKey(corrector) !== eventKey(winner)) losers.add(eventKey(corrector));
  }

  const memo = new Map<string, boolean>();
  const effective = (event: BrokerSyncEvent): boolean => {
    const key = eventKey(event);
    if (losers.has(key)) return false; // superseded by a later correction of the same target
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const winner = winnerOf.get(key);
    const result = winner === undefined ? true : !effective(winner);
    memo.set(key, result);
    return result;
  };

  // A reversal only voids its target; it never carries a row of its own.
  return events.filter((event) => event.kind !== "reversal" && effective(event));
}

export function projectBrokerBook(effective: readonly BrokerSyncEvent[], presentComponents: ReadonlySet<BrokerComponentKey>): BrokerProjection {
  const componentState = (key: BrokerComponentKey): "present" | "absent" => (presentComponents.has(key) ? "present" : "absent");
  return {
    positions: effective.filter((event): event is BrokerPositionEvent => event.component === "positions"),
    cash: effective.filter((event): event is BrokerCashEvent => event.component === "cash"),
    activity: effective.filter((event): event is BrokerActivityEvent => event.component === "activity"),
    components: { positions: componentState("positions"), cash: componentState("cash"), activity: componentState("activity") },
  };
}
