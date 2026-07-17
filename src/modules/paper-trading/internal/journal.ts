import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type {
  PaperCommandOutcome,
  PaperCorporateActionReference,
  PaperFill,
  PaperInstrumentReference,
  PaperJournalEntryReference,
  PaperMoney,
  PaperOrderPayload,
} from "./contracts";

/**
 * F8 append-only Internal Paper journal (spec §9/§8, SEC-09; ADR A04).
 *
 * The journal is the ONLY thing that changes Paper cash, positions, orders or
 * reservations: every public number is a fold over the entries, so a
 * reservation can never drift from the orders that hold it and a fill is the
 * only entry kind that moves a position. User commands go through the §8
 * idempotency trio (original receipt / side-effect-free conflict / stale
 * revision rejected); system events (fills, expiry, corporate actions) are
 * exactly-once by a durable dedupe key. Entries sit on the fenced substrate:
 * administrative erasure is the only removal path and suppresses any late
 * replay or restore at a pre-erasure epoch.
 */

export type PaperReservationSpec =
  | Readonly<{ kind: "cash"; unitPrice: PaperMoney }>
  | Readonly<{ kind: "quantity" }>;

export type PaperJournalEntry = Readonly<
  {
    entryReference: PaperJournalEntryReference;
    account: InternalPaperAccountReference;
    revision: number;
    recordedAt: string;
  } & (
    | { kind: "account_opened"; seedCash: readonly PaperMoney[] }
    | { kind: "order_submitted"; order: PaperOrderReference; payload: PaperOrderPayload; acceptedAt: string; reservation: PaperReservationSpec }
    | { kind: "cancellation_resolved"; order: PaperOrderReference; resolution: "confirmed" | "rejected" }
    | { kind: "fill_applied"; fill: PaperFill }
    | { kind: "order_expired"; order: PaperOrderReference }
    | {
        kind: "corporate_action_applied";
        action: PaperCorporateActionReference;
        instrument: PaperInstrumentReference;
        adjustment: Readonly<{ kind: "split"; numerator: number; denominator: number }>;
      }
    | {
        kind: "dividend_applied";
        action: PaperCorporateActionReference;
        instrument: PaperInstrumentReference;
        perShare: PaperMoney;
      }
  )
>;

export type PaperEntryBody =
  | Readonly<{ kind: "order_submitted"; order: PaperOrderReference; payload: PaperOrderPayload; acceptedAt: string; reservation: PaperReservationSpec }>
  | Readonly<{ kind: "cancellation_resolved"; order: PaperOrderReference; resolution: "confirmed" | "rejected" }>
  | Readonly<{ kind: "account_opened"; seedCash: readonly PaperMoney[] }>
  | Readonly<{ kind: "fill_applied"; fill: PaperFill }>
  | Readonly<{ kind: "order_expired"; order: PaperOrderReference }>
  | Readonly<{
      kind: "corporate_action_applied";
      action: PaperCorporateActionReference;
      instrument: PaperInstrumentReference;
      adjustment: Readonly<{ kind: "split"; numerator: number; denominator: number }>;
    }>
  | Readonly<{ kind: "dividend_applied"; action: PaperCorporateActionReference; instrument: PaperInstrumentReference; perShare: PaperMoney }>;

export type PaperOrderState = Readonly<{
  order: PaperOrderReference;
  payload: PaperOrderPayload;
  submission: "acknowledged";
  execution: "not_started" | "open" | "partially_filled" | "filled" | "expired";
  cancellation: "none" | "requested" | "confirmed" | "rejected";
  acceptedAt: string;
  reservation: PaperReservationSpec;
  filledQuantity: number;
  fills: readonly PaperFill[];
}>;

export type PaperCashState = Readonly<{ balance: number; reserved: number }>;
export type PaperPositionState = Readonly<{ quantity: number; reserved: number; costBasis: PaperMoney }>;

export type PaperAccountState = Readonly<{
  cash: ReadonlyMap<string, PaperCashState>;
  positions: ReadonlyMap<string, PaperPositionState>;
  orders: ReadonlyMap<string, PaperOrderState>;
}>;

type MutationControl = Readonly<{ idempotencyKey: string; expectedRevision: string }>;
type Receipt = Readonly<{ canonicalPayload: string; outcome: PaperCommandOutcome }>;

export type CommandDecision =
  | Readonly<{ entry: PaperEntryBody; order: PaperOrderReference }>
  | Readonly<{ refuse: Extract<PaperCommandOutcome, { status: "refused" }>["reason"] }>
  | Readonly<{ reject: true }>
  | Readonly<{ deny: true }>;

const MODULE = "paper-internal";

export class PaperJournal {
  readonly #entries = new FencedKeyedStore<PaperJournalEntry>();
  readonly #revisions = new Map<string, number>();
  readonly #receipts = new Map<string, Receipt>();
  /** An Internal Paper account belongs to exactly one workspace, fixed at genesis. */
  readonly #owners = new Map<string, string>();
  /** Exactly-once keys for system events (fill identities, corporate actions). */
  readonly #systemKeys = new FencedKeyedStore<true>();

  constructor(
    private readonly now: () => string,
    private readonly writeEpoch: () => number = () => 1,
  ) {}

  /**
   * §8 user-command path: receipt trio, then revision CAS, then the caller's
   * semantic decision against the folded state — all before a single write.
   * Only applied outcomes are receipted; refusals stay side-effect free and
   * re-evaluate on a genuine retry.
   */
  appendCommand(
    workspace: string,
    account: InternalPaperAccountReference,
    commandKind: string,
    control: MutationControl,
    canonicalPayload: string,
    decide: (context: Readonly<{ state: PaperAccountState; revision: number }>) => CommandDecision,
  ): PaperCommandOutcome {
    const receiptKey = `${workspace}|${MODULE}|${String(account)}|${commandKind}|${control.idempotencyKey}`;
    const prior = this.#receipts.get(receiptKey);
    if (prior !== undefined) {
      return prior.canonicalPayload === canonicalPayload ? prior.outcome : { status: "conflict" };
    }

    const accountKey = `${workspace}|${String(account)}`;
    const currentRevision = this.#revisions.get(accountKey) ?? 0;
    if (control.expectedRevision !== String(currentRevision)) {
      return { status: "rejected", currentRevision };
    }

    const decision = decide({ state: this.state(workspace, account), revision: currentRevision });
    if ("deny" in decision) return { status: "denied" };
    if ("reject" in decision) return { status: "rejected", currentRevision };
    if ("refuse" in decision) return { status: "refused", reason: decision.refuse };

    const revision = currentRevision + 1;
    const entry = this.#buildEntry(account, decision.entry, revision);
    const written = this.#entries.write(workspace, String(entry.entryReference), entry, this.writeEpoch());
    if (!written) return { status: "suppressed" };
    this.#revisions.set(accountKey, revision);
    const outcome: PaperCommandOutcome = { status: "applied", revision, order: decision.order };
    this.#receipts.set(receiptKey, { canonicalPayload, outcome });
    return outcome;
  }

  /**
   * Server-only system path (fills, expiry, corporate actions): exactly-once
   * by dedupe key — a redelivery is a no-op returning the original revision.
   */
  appendSystem(
    workspace: string,
    account: InternalPaperAccountReference,
    dedupeKey: string,
    body: PaperEntryBody,
  ): Readonly<{ status: "applied"; revision: number }> | Readonly<{ status: "duplicate" }> | Readonly<{ status: "suppressed" }> {
    const scopedKey = `${String(account)}|${dedupeKey}`;
    const inserted = this.#systemKeys.writeIfAbsent(workspace, scopedKey, true, this.writeEpoch());
    if (!inserted.written) {
      return inserted.value === undefined ? { status: "suppressed" } : { status: "duplicate" };
    }
    const accountKey = `${workspace}|${String(account)}`;
    const revision = (this.#revisions.get(accountKey) ?? 0) + 1;
    const entry = this.#buildEntry(account, body, revision);
    const written = this.#entries.write(workspace, String(entry.entryReference), entry, this.writeEpoch());
    if (!written) return { status: "suppressed" };
    this.#revisions.set(accountKey, revision);
    return { status: "applied", revision };
  }

  /** Genesis: provision the account and fix its owning workspace. */
  provision(workspace: string, account: InternalPaperAccountReference, seedCash: readonly PaperMoney[]): void {
    if (this.#owners.has(String(account))) return;
    const applied = this.appendSystem(workspace, account, "genesis", { kind: "account_opened", seedCash });
    if (applied.status === "applied") this.#owners.set(String(account), workspace);
  }

  ownerOf(account: InternalPaperAccountReference): string | undefined {
    return this.#owners.get(String(account));
  }

  accounts(workspace: string): readonly InternalPaperAccountReference[] {
    const owned: InternalPaperAccountReference[] = [];
    for (const [account, owner] of this.#owners) {
      if (owner === workspace) owned.push(account as InternalPaperAccountReference);
    }
    return owned;
  }

  list(workspace: string, account: InternalPaperAccountReference): readonly PaperJournalEntry[] {
    return this.#entries
      .list(workspace)
      .filter((entry) => String(entry.account) === String(account))
      .sort((left, right) => left.revision - right.revision);
  }

  currentRevision(workspace: string, account: InternalPaperAccountReference): number {
    return this.#revisions.get(`${workspace}|${String(account)}`) ?? 0;
  }

  state(workspace: string, account: InternalPaperAccountReference): PaperAccountState {
    return foldAccountState(this.list(workspace, account));
  }

  /** SEC-09: shred entries, receipts, revisions, ownership and dedupe keys behind the fence. */
  eraseWorkspace(workspace: string, fence: number): number {
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${workspace}|`)) this.#revisions.delete(key);
    for (const key of [...this.#receipts.keys()]) if (key.startsWith(`${workspace}|`)) this.#receipts.delete(key);
    for (const [account, owner] of [...this.#owners]) if (owner === workspace) this.#owners.delete(account);
    this.#systemKeys.eraseSubject(workspace, fence);
    return this.#entries.eraseSubject(workspace, fence);
  }

  #buildEntry(account: InternalPaperAccountReference, body: PaperEntryBody, revision: number): PaperJournalEntry {
    const entryReference = brandReference<string, "PaperJournalEntryReference">(
      `paper-entry:${String(account)}:${revision}`,
    );
    return { ...body, entryReference, account, revision, recordedAt: this.now() };
  }
}

/** An order still holds its remaining reservation only in these axis states. */
function reserving(order: PaperOrderState): boolean {
  return (
    (order.execution === "open" || order.execution === "partially_filled")
    && (order.cancellation === "none" || order.cancellation === "requested" || order.cancellation === "rejected")
  );
}

export function foldAccountState(entries: readonly PaperJournalEntry[]): PaperAccountState {
  const cashBalance = new Map<string, number>();
  const positions = new Map<string, { quantity: number; costBasis: { amount: number; currency: string } }>();
  const orders = new Map<string, PaperOrderState>();

  for (const entry of entries) {
    switch (entry.kind) {
      case "account_opened": {
        for (const seed of entry.seedCash) {
          cashBalance.set(seed.currency, (cashBalance.get(seed.currency) ?? 0) + seed.amount);
        }
        break;
      }
      case "order_submitted": {
        orders.set(String(entry.order), {
          order: entry.order,
          payload: entry.payload,
          submission: "acknowledged",
          execution: "open",
          cancellation: "none",
          acceptedAt: entry.acceptedAt,
          reservation: entry.reservation,
          filledQuantity: 0,
          fills: [],
        });
        break;
      }
      case "cancellation_resolved": {
        const order = orders.get(String(entry.order));
        // A confirmed cancellation is terminal for the axis: a later recorded
        // rejection (e.g. a second cancel attempt) never regresses it.
        if (order !== undefined && order.cancellation !== "confirmed") {
          orders.set(String(entry.order), { ...order, cancellation: entry.resolution });
        }
        break;
      }
      case "fill_applied": {
        const order = orders.get(String(entry.fill.order));
        if (order === undefined) break;
        const filledQuantity = order.filledQuantity + entry.fill.quantity;
        const execution = filledQuantity >= order.payload.quantity ? "filled" : "partially_filled";
        orders.set(String(entry.fill.order), {
          ...order,
          filledQuantity,
          execution,
          fills: [...order.fills, entry.fill],
        });
        const currency = entry.fill.price.currency;
        const gross = entry.fill.quantity * entry.fill.price.amount;
        const instrumentKey = String(order.payload.instrument);
        const position = positions.get(instrumentKey) ?? { quantity: 0, costBasis: { amount: 0, currency } };
        if (order.payload.side === "buy") {
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) - gross);
          positions.set(instrumentKey, {
            quantity: position.quantity + entry.fill.quantity,
            costBasis: { amount: position.costBasis.amount + gross, currency: position.costBasis.currency },
          });
        } else {
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + gross);
          // Average-cost basis relief — a published simulation-v1 assumption.
          const averageBasis = position.quantity > 0 ? position.costBasis.amount / position.quantity : 0;
          positions.set(instrumentKey, {
            quantity: position.quantity - entry.fill.quantity,
            costBasis: { amount: position.costBasis.amount - averageBasis * entry.fill.quantity, currency: position.costBasis.currency },
          });
        }
        break;
      }
      case "order_expired": {
        const order = orders.get(String(entry.order));
        if (order !== undefined) orders.set(String(entry.order), { ...order, execution: "expired" });
        break;
      }
      case "corporate_action_applied": {
        const { numerator, denominator } = entry.adjustment;
        const instrumentKey = String(entry.instrument);
        const position = positions.get(instrumentKey);
        if (position !== undefined) {
          // Quantity scales, total raw cost basis is preserved (§8: exactly once).
          positions.set(instrumentKey, {
            quantity: (position.quantity * numerator) / denominator,
            costBasis: position.costBasis,
          });
        }
        for (const [key, order] of orders) {
          if (String(order.payload.instrument) !== instrumentKey) continue;
          if (!reserving(order)) continue;
          const payload = order.payload;
          const adjustedQuantity = (payload.quantity * numerator) / denominator;
          const adjustedLimit = payload.limitPrice === undefined
            ? undefined
            : { amount: (payload.limitPrice.amount * denominator) / numerator, currency: payload.limitPrice.currency };
          const adjustedReservation: PaperReservationSpec = order.reservation.kind === "cash"
            ? { kind: "cash", unitPrice: { amount: (order.reservation.unitPrice.amount * denominator) / numerator, currency: order.reservation.unitPrice.currency } }
            : order.reservation;
          orders.set(key, {
            ...order,
            payload: { ...payload, quantity: adjustedQuantity, limitPrice: adjustedLimit },
            filledQuantity: (order.filledQuantity * numerator) / denominator,
            reservation: adjustedReservation,
          });
        }
        break;
      }
      case "dividend_applied": {
        const position = positions.get(String(entry.instrument));
        if (position !== undefined && position.quantity > 0) {
          const currency = entry.perShare.currency;
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + position.quantity * entry.perShare.amount);
        }
        break;
      }
    }
  }

  // Reservations are DERIVED from open orders — they cannot drift.
  const cashReserved = new Map<string, number>();
  const quantityReserved = new Map<string, number>();
  for (const order of orders.values()) {
    if (!reserving(order)) continue;
    const remaining = order.payload.quantity - order.filledQuantity;
    if (order.reservation.kind === "cash") {
      const currency = order.reservation.unitPrice.currency;
      cashReserved.set(currency, (cashReserved.get(currency) ?? 0) + remaining * order.reservation.unitPrice.amount);
    } else {
      const key = String(order.payload.instrument);
      quantityReserved.set(key, (quantityReserved.get(key) ?? 0) + remaining);
    }
  }

  const cash = new Map<string, PaperCashState>();
  for (const [currency, balance] of cashBalance) {
    cash.set(currency, { balance, reserved: cashReserved.get(currency) ?? 0 });
  }
  const positionState = new Map<string, PaperPositionState>();
  for (const [instrument, position] of positions) {
    positionState.set(instrument, {
      quantity: position.quantity,
      reserved: quantityReserved.get(instrument) ?? 0,
      costBasis: position.costBasis,
    });
  }
  return { cash, positions: positionState, orders };
}
