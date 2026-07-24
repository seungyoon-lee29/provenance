import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import { currencyMinorUnitScale, grossMinorOf, minorUnitsOf } from "./contracts";
import type { PaperFill, PaperFillCosts, PaperMarketObservation, PaperMoney } from "./contracts";
import type { PaperAccountState, PaperJournal, PaperOrderState } from "./journal";
import { KRX_TAX_POLICY_VERSION, sellTransactionTaxMinor } from "./krx-transaction-tax";

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

/** Scale for representing (possibly fractional) bps policy numbers exactly. */
const BPS_SCALE = 1_000_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Exact adverse execution price in integer ticks (codex-panel finding: a float
 * epsilon guard here swallowed genuine sub-tick slippage, letting a crossing
 * price fill at the limit). All operands are integers, so a true value even
 * marginally past a tick boundary rounds adversely — and an exactly-on-tick
 * value stays put — with no epsilon at all. The stored double price is read as
 * the decimal it denotes (rounded to its tick grid).
 */
function executionPriceTicks(
  priceTicks: bigint,
  side: "buy" | "sell",
  cumulativeWithAllocation: number,
  volume: number,
  policy: SimulationPolicy,
): bigint {
  const volumeN = BigInt(volume);
  const base = BigInt(Math.round(policy.baseSlippageBps * Number(BPS_SCALE)));
  const slope = BigInt(Math.round(policy.participationSlippageBps * Number(BPS_SCALE)));
  const max = BigInt(Math.round(policy.maxSlippageBps * Number(BPS_SCALE)));
  // bps (scaled by BPS_SCALE × volume) = min(max, base + slope × participation).
  const bpsScaled = (() => {
    const raw = base * volumeN + slope * BigInt(cumulativeWithAllocation);
    const cap = max * volumeN;
    return raw < cap ? raw : cap;
  })();
  const denominator = 10_000n * BPS_SCALE * volumeN;
  const numerator = priceTicks * (side === "buy" ? denominator + bpsScaled : denominator - bpsScaled);
  return side === "buy" ? ceilDiv(numerator, denominator) : numerator / denominator;
}

function toTicks(amount: number, currency: string): bigint {
  return BigInt(Math.round(amount * currencyMinorUnitScale(currency)));
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

  async ingest(workspace: string, account: InternalPaperAccountReference, observation: PaperMarketObservation): Promise<readonly SimulationEvent[]> {
    if (observation.session !== "regular") return [];

    const events: SimulationEvent[] = [];
    const journal = this.deps.journal;

    // Deterministic pass 1 — DAY expiry: an observation from a later trading
    // day expires open DAY orders instead of filling them. Expiry is about the
    // calendar advancing, so it runs even for a hard-expired observation
    // (codex-panel finding: gating it on evidence quality left DAY orders open).
    // ponytail: UTC-day boundary, venue-local session calendar when KR venues land.
    for (const order of this.#candidates(journal.state(workspace, account), observation)) {
      if (order.payload.timeInForce !== "DAY") continue;
      if (utcDay(observation.eventTime) <= utcDay(order.acceptedAt)) continue;
      const applied = await journal.appendSystem(workspace, account, `expire:${String(order.order)}`, {
        kind: "order_expired",
        order: order.order,
      });
      if (applied.status === "applied") events.push({ kind: "expired", order: order.order });
    }

    // Hard-expired evidence never produces a FILL (§9); a broken volume can't
    // parameterize participation either.
    if (observation.freshness === "hard_expired") return events;
    if (!Number.isInteger(observation.volume) || observation.volume <= 0) return events;

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

      const side = order.payload.side;
      const currency = observation.price.currency;
      const priceTicks = executionPriceTicks(
        toTicks(observation.price.amount, currency),
        side,
        cumulative + allocation,
        observation.volume,
        this.deps.policy,
      );
      const price = Number(priceTicks) / currencyMinorUnitScale(currency);

      // Limit guard: a slippage-adjusted price crossing the limit unfavorably
      // produces no fill at all (§9). Integer-tick comparison — no epsilon to
      // hide a genuine crossing (codex-panel finding).
      const limit = order.payload.limitPrice;
      if (limit !== undefined) {
        const limitTicks = toTicks(limit.amount, limit.currency);
        if (side === "buy" && priceTicks > limitTicks) continue;
        if (side === "sell" && priceTicks < limitTicks) continue;
      }

      if (!this.#covered(state, order, side, allocation, price, observation.price.currency)) continue;

      const identity = brandReference<string, "PaperFillIdentity">(
        `fill:${String(order.order)}:${observation.evidenceReference}`,
      );
      // S3 cost: Korean transaction tax on the SALE proceeds (sell only, and
      // only when the source declared a taxClass). Computed on the same
      // aggregate-rounded gross the fold uses, so the stored value matches.
      const currencyMinor = observation.price.currency;
      const costs: PaperFillCosts | undefined = (() => {
        // KRX transaction tax: sells only, KRW only (the tax is a KRW-market
        // levy — a mis-declared non-KRW taxClass never charges), and only when
        // the source declared a class.
        if (side !== "sell" || observation.taxClass === undefined || currencyMinor !== "KRW") return undefined;
        const grossMinor = grossMinorOf(allocation, { amount: price, currency: currencyMinor });
        const taxMinor = sellTransactionTaxMinor(grossMinor, observation.taxClass, observation.eventTime);
        return taxMinor > 0 ? { sellTransactionTaxMinor: taxMinor, taxPolicyVersion: KRX_TAX_POLICY_VERSION } : undefined;
      })();
      const fill: PaperFill = {
        identity,
        order: order.order,
        quantity: allocation,
        price: { amount: price, currency: currencyMinor },
        eventTime: observation.eventTime,
        receivedAt: observation.receivedAt,
        evidenceReference: observation.evidenceReference,
        policyVersion: this.deps.policy.policyVersion,
        ...(costs !== undefined ? { costs } : {}),
      };
      const applied = await journal.appendSystem(workspace, account, String(identity), { kind: "fill_applied", fill });
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
      // Cash state is exact minor units (Stage 2-c) — compare in minor, no slack.
      const ownReservationMinor = reservingNow && order.reservation.kind === "cash"
        ? minorUnitsOf((order.payload.quantity - order.filledQuantity) * order.reservation.unitPrice.amount, order.reservation.unitPrice.currency)
        : 0;
      const availableMinor = cash.balance - cash.reserved + ownReservationMinor;
      return minorUnitsOf(allocation * price, currency) <= availableMinor;
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
