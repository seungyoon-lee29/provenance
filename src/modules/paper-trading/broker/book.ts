import type { BrokerPaperAccountReference } from "@/shared/contracts/brands";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import { currencyMinorUnitScale } from "../internal/contracts";
import type { PaperMoney, PaperOrderPayload } from "../internal/contracts";
import type {
  BrokerBookState,
  BrokerClientOrderReference,
  BrokerExternalOrderEvent,
  BrokerIngestOutcome,
  BrokerIngestRefusalReason,
  BrokerOrderView,
  BrokerProvisionOutcome,
  BrokerQuarantineRecord,
  BrokerSubmitOutcome,
} from "./contracts";

/**
 * F9 Broker Paper book (spec §9, AT-08): the account-local fold of durable
 * facts. Local submits and provider events mutate cash/position/order state in
 * one synchronous section per account — reservation is never stored, it is
 * DERIVED from the orders that are still holding funds/shares, so a
 * reservation drift is structurally impossible (F8 insight carried over).
 *
 * Provider facts are durable-unique by
 * (connection, account, order, kind, externalIdentity, revision); a replay is
 * a no-op duplicate and the same key with a different body is quarantined as a
 * Reconciliation Issue without touching money. The whole store sits on the
 * fenced substrate so erasure suppresses every later write (SEC-09).
 */

type OrderState = {
  order: BrokerClientOrderReference;
  payloadCanonical: string;
  payload: PaperOrderPayload;
  submission: BrokerOrderView["submission"];
  execution: BrokerOrderView["execution"];
  cancellation: BrokerOrderView["cancellation"];
  filledQuantity: number;
  externalOrder?: string;
  cancelRevision?: number;
};

type AccountState = {
  account: BrokerPaperAccountReference;
  cash: Map<string, { balanceMinor: number }>;
  positions: Map<string, { quantity: number; basisMinor: number; currency: string }>;
  orders: Map<string, OrderState>;
  /** eventKey -> canonical body of the applied fact (durable-unique index). */
  events: Map<string, string>;
  quarantine: Map<string, BrokerQuarantineRecord>;
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : entry,
  );
}

function toMinor(money: PaperMoney): number {
  return Math.round(money.amount * currencyMinorUnitScale(money.currency));
}

function reserving(order: OrderState): boolean {
  return (
    (order.submission === "pending_submission" || order.submission === "acknowledged" || order.submission === "submission_unknown") &&
    (order.execution === "not_started" || order.execution === "open" || order.execution === "partially_filled") &&
    order.cancellation !== "confirmed"
  );
}

function reservedCashMinor(state: AccountState, currency: string): number {
  let total = 0;
  for (const order of state.orders.values()) {
    if (!reserving(order) || order.payload.side !== "buy") continue;
    const limit = order.payload.limitPrice;
    if (limit === undefined || limit.currency !== currency) continue;
    total += (order.payload.quantity - order.filledQuantity) * toMinor(limit);
  }
  return total;
}

function reservedShares(state: AccountState, instrument: string): number {
  let total = 0;
  for (const order of state.orders.values()) {
    if (!reserving(order) || order.payload.side !== "sell") continue;
    if (String(order.payload.instrument) !== instrument) continue;
    total += order.payload.quantity - order.filledQuantity;
  }
  return total;
}

function eventKeyOf(event: BrokerExternalOrderEvent): string {
  return [String(event.connection), String(event.order), event.kind, event.externalIdentity, String(event.revision)].join("|");
}

export type BrokerBookCommandResult<T> =
  | T
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "rejected"; currentRevision: number }>
  | Readonly<{ status: "suppressed" }>;

export class BrokerPaperBook {
  readonly #accounts = new FencedKeyedStore<AccountState>();
  /** `${workspace}|${account}` -> append-only account revision (bumped by applied commands AND applied provider facts). */
  readonly #revisions = new Map<string, number>();
  /** `${workspace}|${account}|${kind}|${idempotencyKey}` -> receipted outcome (§8 trio). */
  readonly #receipts = new Map<string, { payload: string; outcome: unknown }>();

  currentRevision(workspace: string, account: BrokerPaperAccountReference): number {
    return this.#revisions.get(`${workspace}|${String(account)}`) ?? 0;
  }

  hasAccount(workspace: string, account: BrokerPaperAccountReference): boolean {
    return this.#accounts.get(workspace, String(account)) !== undefined;
  }

  /**
   * §8 user-command path (mirror of the F8 journal): receipt trio first, then
   * revision CAS, then the caller's semantic section. Only committed outcomes
   * are receipted and bump the revision; refusals stay side-effect free. The
   * `act` closure runs the whole account transaction (book mutation + outbox +
   * pending worklist) in one synchronous section.
   */
  command<T extends Readonly<{ status: string }>>(
    workspace: string,
    account: BrokerPaperAccountReference,
    commandKind: string,
    control: Readonly<{ idempotencyKey: string; expectedRevision: string }>,
    canonicalPayload: string,
    act: (nextRevision: number) => Readonly<{ commit: T }> | Readonly<{ refuse: T }>,
  ): BrokerBookCommandResult<T> {
    if (this.#accounts.isErased(workspace, 1)) return { status: "suppressed" };
    const receiptKey = `${workspace}|${String(account)}|${commandKind}|${control.idempotencyKey}`;
    const prior = this.#receipts.get(receiptKey);
    if (prior !== undefined) {
      return prior.payload === canonicalPayload ? (prior.outcome as T) : { status: "conflict" };
    }
    const currentRevision = this.currentRevision(workspace, account);
    if (control.expectedRevision !== String(currentRevision)) return { status: "rejected", currentRevision };
    const result = act(currentRevision + 1);
    if ("refuse" in result) return result.refuse;
    this.#revisions.set(`${workspace}|${String(account)}`, currentRevision + 1);
    this.#receipts.set(receiptKey, { payload: canonicalPayload, outcome: result.commit });
    return result.commit;
  }

  /** Local `requested` mark on the cancellation axis; the confirmed state is terminal. */
  requestCancelLocal(
    workspace: string,
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
    atEpoch: number,
  ): "unknown_account" | "unknown_order" | "cancel_pending" | "cancellation_terminal" | undefined {
    if (this.#accounts.isErased(workspace, atEpoch)) return "unknown_account";
    const state = this.#accounts.get(workspace, String(account));
    if (state === undefined) return "unknown_account";
    const order = state.orders.get(String(clientOrder));
    if (order === undefined) return "unknown_order";
    if (order.cancellation === "confirmed") return "cancellation_terminal";
    if (order.cancellation === "requested") return "cancel_pending";
    order.cancellation = "requested";
    return undefined;
  }

  provision(workspace: string, account: BrokerPaperAccountReference, seedCash: readonly PaperMoney[], atEpoch: number): BrokerProvisionOutcome {
    const fresh: AccountState = {
      account,
      cash: new Map(seedCash.map((money) => [money.currency, { balanceMinor: toMinor(money) }])),
      positions: new Map(),
      orders: new Map(),
      events: new Map(),
      quarantine: new Map(),
    };
    const { written, value } = this.#accounts.writeIfAbsent(workspace, String(account), fresh, atEpoch);
    if (value === undefined) return { status: "suppressed" };
    return { status: written ? "applied" : "duplicate" };
  }

  submitLocal(
    workspace: string,
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
    payload: PaperOrderPayload,
    atEpoch: number,
  ): BrokerSubmitOutcome {
    if (this.#accounts.isErased(workspace, atEpoch)) return { status: "suppressed" };
    const state = this.#accounts.get(workspace, String(account));
    if (state === undefined) return { status: "refused", reason: "unknown_account" };

    // ponytail: limit-only v1 — the broker lane has no pre-submit price bound
    // for a market buy; observation-bound reservation (F8 style) is the upgrade.
    if (payload.orderType !== "limit" || payload.limitPrice === undefined) return { status: "refused", reason: "unsupported_order_type" };
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) return { status: "refused", reason: "invalid_payload" };
    if (!Number.isFinite(payload.limitPrice.amount) || payload.limitPrice.amount <= 0) return { status: "refused", reason: "invalid_payload" };

    const payloadCanonical = canonical(payload);
    const existing = state.orders.get(String(clientOrder));
    if (existing !== undefined) {
      // The client order identity is stable: the same identity must always mean
      // the same order. Identical redelivery is idempotent; anything else is a
      // conflict, never a second external order.
      return existing.payloadCanonical === payloadCanonical ? { status: "duplicate" } : { status: "refused", reason: "client_order_conflict" };
    }

    const limit = payload.limitPrice;
    if (payload.side === "buy") {
      const costMinor = payload.quantity * toMinor(limit);
      const balanceMinor = state.cash.get(limit.currency)?.balanceMinor ?? 0;
      const available = balanceMinor - reservedCashMinor(state, limit.currency);
      if (costMinor > available) return { status: "refused", reason: "insufficient_cash" };
    } else {
      const instrument = String(payload.instrument);
      const held = state.positions.get(instrument)?.quantity ?? 0;
      if (payload.quantity > held - reservedShares(state, instrument)) return { status: "refused", reason: "insufficient_position" };
    }

    state.orders.set(String(clientOrder), {
      order: clientOrder,
      payloadCanonical,
      payload,
      submission: "pending_submission",
      execution: "not_started",
      cancellation: "none",
      filledQuantity: 0,
    });
    return { status: "accepted" };
  }

  ingest(workspace: string, account: BrokerPaperAccountReference, event: BrokerExternalOrderEvent, atEpoch: number): BrokerIngestOutcome {
    if (this.#accounts.isErased(workspace, atEpoch)) return { status: "suppressed" };
    const state = this.#accounts.get(workspace, String(account));
    if (state === undefined) return { status: "refused", reason: "unknown_account" };

    const eventKey = eventKeyOf(event);
    const body = canonical(event.body);
    const stored = state.events.get(eventKey);
    if (stored !== undefined) {
      if (stored === body) return { status: "duplicate" };
      // Same durable identity, different payload: Reconciliation Issue. The
      // book never moves; redelivery of the same divergence stays one record.
      state.quarantine.set(`${eventKey}#${body}`, { order: event.order, eventKey, storedPayload: stored, divergentPayload: body });
      return { status: "quarantined" };
    }

    const refusal = this.#fold(state, event);
    if (refusal !== undefined) return { status: "refused", reason: refusal };
    state.events.set(eventKey, body);
    this.#revisions.set(`${workspace}|${String(account)}`, this.currentRevision(workspace, account) + 1);
    return { status: "applied" };
  }

  /** Applies one validated provider fact; returns a refusal reason instead of touching state when invalid. */
  #fold(state: AccountState, event: BrokerExternalOrderEvent): BrokerIngestRefusalReason | undefined {
    const order = state.orders.get(String(event.order));
    if (order === undefined) return "unknown_order";

    switch (event.kind) {
      case "accepted": {
        if (typeof event.body.externalOrder !== "string" || event.body.externalOrder.length === 0) return "invalid_event";
        if (order.submission !== "pending_submission" && order.submission !== "submission_unknown") return "not_pending";
        order.submission = "acknowledged";
        order.externalOrder = event.body.externalOrder;
        if (order.execution === "not_started") order.execution = "open";
        return undefined;
      }
      case "rejected": {
        if (order.submission !== "pending_submission" && order.submission !== "submission_unknown") return "not_pending";
        order.submission = "rejected";
        return undefined;
      }
      case "fill":
        return this.#foldFill(state, order, event);
      case "cancel_confirmed": {
        if (order.cancellation === "confirmed") return "cancellation_terminal";
        order.cancellation = "confirmed";
        order.cancelRevision = event.revision;
        return undefined;
      }
      case "cancel_rejected": {
        // Confirmed is terminal for the cancellation axis (F8 fold lesson).
        if (order.cancellation === "confirmed") return "cancellation_terminal";
        order.cancellation = "rejected";
        return undefined;
      }
      case "expired": {
        if (order.execution !== "open" && order.execution !== "partially_filled") return "not_fillable";
        order.execution = "expired";
        return undefined;
      }
    }
  }

  #foldFill(state: AccountState, order: OrderState, event: BrokerExternalOrderEvent): BrokerIngestRefusalReason | undefined {
    const { quantity, price } = event.body;
    const limit = order.payload.limitPrice;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) return "invalid_event";
    if (price === undefined || !Number.isFinite(price.amount) || price.amount <= 0) return "invalid_event";
    if (limit === undefined || price.currency !== limit.currency) return "invalid_event";
    if (order.execution !== "open" && order.execution !== "partially_filled") return "not_fillable";
    if (quantity > order.payload.quantity - order.filledQuantity) return "invalid_event";
    // A fill after a confirmed cancellation is only the late delivery of a
    // pre-cancel fact: its provider revision must precede the cancel's.
    if (order.cancellation === "confirmed" && (order.cancelRevision === undefined || event.revision >= order.cancelRevision)) return "not_fillable";
    // The paper broker never crosses the limit; a crossing fill is provider
    // degradation and must not move money.
    const priceMinor = toMinor(price);
    const limitMinor = toMinor(limit);
    if (order.payload.side === "buy" ? priceMinor > limitMinor : priceMinor < limitMinor) return "over_limit_fill";

    const costMinor = quantity * priceMinor;
    const currency = price.currency;
    const cashRow = state.cash.get(currency) ?? { balanceMinor: 0 };
    const instrument = String(order.payload.instrument);

    if (order.payload.side === "buy") {
      // Own reservation covers a reserving order's fill (price ≤ limit); a late
      // fill draws on free balance and must still be affordable, fail-closed.
      const ownReservationMinor = reserving(order) ? (order.payload.quantity - order.filledQuantity) * limitMinor : 0;
      const available = cashRow.balanceMinor - reservedCashMinor(state, currency) + ownReservationMinor;
      if (costMinor > available) return "insufficient_cash";
      cashRow.balanceMinor -= costMinor;
      state.cash.set(currency, cashRow);
      const position = state.positions.get(instrument) ?? { quantity: 0, basisMinor: 0, currency };
      position.quantity += quantity;
      position.basisMinor += costMinor;
      state.positions.set(instrument, position);
    } else {
      const position = state.positions.get(instrument);
      if (position === undefined || position.quantity < quantity) return "insufficient_position";
      const reduceMinor = Math.round((position.basisMinor * quantity) / position.quantity);
      position.quantity -= quantity;
      position.basisMinor -= reduceMinor;
      if (position.quantity === 0) state.positions.delete(instrument);
      cashRow.balanceMinor += costMinor;
      state.cash.set(currency, cashRow);
    }

    order.filledQuantity += quantity;
    order.execution = order.filledQuantity === order.payload.quantity ? "filled" : "partially_filled";
    return undefined;
  }

  state(workspace: string, account: BrokerPaperAccountReference): BrokerBookState {
    const state = this.#accounts.get(workspace, String(account));
    if (state === undefined) return { cash: [], positions: [], orders: [], quarantine: [] };
    return {
      cash: [...state.cash.entries()].map(([currency, row]) => ({
        currency,
        balance: row.balanceMinor / currencyMinorUnitScale(currency),
        reserved: reservedCashMinor(state, currency) / currencyMinorUnitScale(currency),
      })),
      positions: [...state.positions.entries()].map(([instrument, position]) => ({
        instrument,
        quantity: position.quantity,
        costBasis: { amount: position.basisMinor / currencyMinorUnitScale(position.currency), currency: position.currency },
      })),
      orders: [...state.orders.values()].map((order) => ({
        order: order.order,
        account: state.account,
        payload: order.payload,
        submission: order.submission,
        execution: order.execution,
        cancellation: order.cancellation,
        filledQuantity: order.filledQuantity,
        ...(order.externalOrder === undefined ? {} : { externalOrder: order.externalOrder }),
      })),
      quarantine: [...state.quarantine.values()],
    };
  }

  /** SEC-09: shred account state, receipts and revisions behind the fence. */
  eraseWorkspace(workspace: string, fence: number): number {
    for (const key of [...this.#receipts.keys()]) if (key.startsWith(`${workspace}|`)) this.#receipts.delete(key);
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${workspace}|`)) this.#revisions.delete(key);
    return this.#accounts.eraseSubject(workspace, fence);
  }
}
