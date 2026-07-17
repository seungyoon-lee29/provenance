import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import type { PaperFill, PaperMarketObservation, PaperMoney } from "./contracts";
import type { PaperAccountState, PaperJournal, PaperOrderState } from "./journal";

/**
 * F8 simulation-v1 Simulated Fill engine (spec §9, AT-07).
 *
 * An in-process port over the Paper journal only — it shares nothing with
 * BrokerPaperExecutionPort (F9 boundary). Fills consume exclusively real
 * Market Observations whose market event time is strictly after acceptedAt,
 * for the same instrument/venue/regular session; a delayed feed is evaluated
 * only once its data clock has passed the acceptance instant, and
 * hard-expired/unavailable/failed evidence produces no fill at all.
 *
 * Published simulation-v1 policy: allocation across the account's active
 * orders for one observation is capped at 10% of observed volume, ordered
 * deterministically by (acceptedAt, order identity); slippage is
 * 5 bps + 20 bps × cumulative participation, capped at 25 bps, applied
 * adversely and tick-rounded adversely (buy up / sell down); commissions are
 * zero. Every fill is exactly-once by (order, observation evidence) identity,
 * so stream/poll duplicates and crash redeliveries converge to the same
 * public state.
 */

export type SimulationPolicy = Readonly<{
  policyVersion: string;
  volumeParticipationCap: number;
  baseSlippageBps: number;
  participationSlippageBps: number;
  maxSlippageBps: number;
}>;

export const SIMULATION_V1: SimulationPolicy = {
  policyVersion: "simulation-v1",
  volumeParticipationCap: 0.1,
  baseSlippageBps: 5,
  participationSlippageBps: 20,
  maxSlippageBps: 25,
};

export type SimulationEvent =
  | Readonly<{ kind: "fill"; order: PaperOrderReference; quantity: number; price: PaperMoney }>
  | Readonly<{ kind: "expired"; order: PaperOrderReference }>;

const EPSILON = 1e-9;

function ticksPerUnit(currency: string): number {
  return currency === "KRW" ? 1 : 100;
}

/** Adverse tick rounding with an epsilon guard against float noise. */
function roundToTick(amount: number, currency: string, direction: "up" | "down"): number {
  const per = ticksPerUnit(currency);
  const raw = amount * per;
  const ticks = direction === "up" ? Math.ceil(raw - 1e-6) : Math.floor(raw + 1e-6);
  return ticks / per;
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

export class InternalPaperSimulator {
  constructor(
    private readonly deps: Readonly<{
      journal: PaperJournal;
      policy: SimulationPolicy;
    }>,
  ) {}

  ingest(workspace: string, account: InternalPaperAccountReference, observation: PaperMarketObservation): readonly SimulationEvent[] {
    // Hard-expired evidence never produces a fill (§9).
    if (observation.freshness === "hard_expired") return [];
    if (observation.session !== "regular") return [];
    if (!Number.isFinite(observation.volume) || observation.volume <= 0) return [];

    const events: SimulationEvent[] = [];
    const journal = this.deps.journal;

    // Deterministic pass 1 — DAY expiry: an observation from a later trading
    // day expires open DAY orders instead of filling them.
    // ponytail: UTC-day boundary, venue-local session calendar when KR venues land.
    for (const order of this.#candidates(journal.state(workspace, account), observation)) {
      if (order.payload.timeInForce !== "DAY") continue;
      if (utcDay(observation.eventTime) <= utcDay(order.acceptedAt)) continue;
      const applied = journal.appendSystem(workspace, account, `expire:${String(order.order)}`, {
        kind: "order_expired",
        order: order.order,
      });
      if (applied.status === "applied") events.push({ kind: "expired", order: order.order });
    }

    // Pass 2 — fills against the post-expiry state.
    const state = journal.state(workspace, account);
    const capShares = Math.floor(this.deps.policy.volumeParticipationCap * observation.volume + EPSILON);
    // Durable cap accounting: what this observation already filled (any order),
    // so a redelivery can never allocate past the 10% even for new orders.
    let cumulative = 0;
    for (const order of state.orders.values()) {
      for (const fill of order.fills) {
        if (fill.evidenceReference === observation.evidenceReference) cumulative += fill.quantity;
      }
    }

    for (const order of this.#candidates(state, observation)) {
      if (cumulative >= capShares) break;
      if (!this.#eligible(order, observation)) continue;
      const remaining = order.payload.quantity - order.filledQuantity;
      const allocation = Math.min(remaining, capShares - cumulative);
      if (allocation <= 0) continue;

      const participation = (cumulative + allocation) / observation.volume;
      const bps = Math.min(
        this.deps.policy.maxSlippageBps,
        this.deps.policy.baseSlippageBps + this.deps.policy.participationSlippageBps * participation,
      );
      const side = order.payload.side;
      const adjusted = (observation.price.amount * (10_000 + (side === "buy" ? bps : -bps))) / 10_000;
      const price = roundToTick(adjusted, observation.price.currency, side === "buy" ? "up" : "down");

      // Limit guard: a slippage-adjusted price crossing the limit unfavorably
      // produces no fill at all (§9) — no partial price improvement.
      const limit = order.payload.limitPrice;
      if (limit !== undefined) {
        if (side === "buy" && price > limit.amount + EPSILON) continue;
        if (side === "sell" && price < limit.amount - EPSILON) continue;
      }

      if (!this.#covered(state, order, side, allocation, price, observation.price.currency)) continue;

      const identity = brandReference<string, "PaperFillIdentity">(
        `fill:${String(order.order)}:${observation.evidenceReference}`,
      );
      const fill: PaperFill = {
        identity,
        order: order.order,
        quantity: allocation,
        price: { amount: price, currency: observation.price.currency },
        eventTime: observation.eventTime,
        receivedAt: observation.receivedAt,
        evidenceReference: observation.evidenceReference,
        policyVersion: this.deps.policy.policyVersion,
      };
      const applied = journal.appendSystem(workspace, account, String(identity), { kind: "fill_applied", fill });
      if (applied.status !== "applied") continue;
      events.push({ kind: "fill", order: order.order, quantity: allocation, price: fill.price });
      cumulative += allocation;
    }
    return events;
  }

  /** Same instrument/venue/regular session, still fillable, deterministic order. */
  #candidates(state: PaperAccountState, observation: PaperMarketObservation): readonly PaperOrderState[] {
    return [...state.orders.values()]
      .filter((order) =>
        String(order.payload.instrument) === String(observation.instrument)
        && order.payload.venue === observation.venue
        && order.payload.session === observation.session
        && (order.execution === "open" || order.execution === "partially_filled"),
      )
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt) || String(left.order).localeCompare(String(right.order)));
  }

  #eligible(order: PaperOrderState, observation: PaperMarketObservation): boolean {
    // Market event time strictly after acceptance (§9).
    if (Date.parse(observation.eventTime) <= Date.parse(order.acceptedAt)) return false;
    // The feed's data clock must have passed the acceptance instant before any
    // evaluation — this is what makes delayed feeds honest (§9).
    if (Date.parse(observation.dataClock) <= Date.parse(order.acceptedAt)) return false;
    if (order.cancellation === "confirmed") {
      // Late VALID fill after a confirmed cancellation (§9): only an
      // observation from before the cancellation instant may still fill, once.
      return order.cancelledAt !== undefined && Date.parse(observation.eventTime) < Date.parse(order.cancelledAt);
    }
    return true;
  }

  /**
   * Fail-closed affordability: a fill may never overdraw cash or oversell a
   * position, even for a market order whose reservation bound was overtaken or
   * a late fill whose reservation is already released.
   * ponytail: skips the whole allocation instead of shaving it — deterministic,
   * refine to partial affordability only if a real fixture ever needs it.
   */
  #covered(
    state: PaperAccountState,
    order: PaperOrderState,
    side: "buy" | "sell",
    allocation: number,
    price: number,
    currency: string,
  ): boolean {
    const reservingNow =
      (order.execution === "open" || order.execution === "partially_filled")
      && order.cancellation !== "confirmed";
    if (side === "buy") {
      const cash = state.cash.get(currency);
      if (cash === undefined) return false;
      const ownReservation = reservingNow && order.reservation.kind === "cash"
        ? (order.payload.quantity - order.filledQuantity) * order.reservation.unitPrice.amount
        : 0;
      const available = cash.balance - cash.reserved + ownReservation;
      return allocation * price <= available + EPSILON;
    }
    const position = state.positions.get(String(order.payload.instrument));
    if (position === undefined) return false;
    const ownReservation = reservingNow && order.reservation.kind === "quantity"
      ? order.payload.quantity - order.filledQuantity
      : 0;
    const available = position.quantity - position.reserved + ownReservation;
    return allocation <= available + EPSILON;
  }
}
