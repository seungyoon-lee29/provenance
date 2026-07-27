import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import { FencedKeyedStore } from "../../../platform/persistence/fenced-store";
import type { Executor } from "../../../platform/persistence/pg";
import { fromMinorUnits, grossMinorOf, isExactMinor, isRepresentableSeedCash, toMinorUnits } from "./contracts";
import type { PaperMinorMoney } from "./contracts";
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
  /** Set when the cancellation was confirmed — the late-valid-fill boundary. */
  cancelledAt?: string;
  acceptedAt: string;
  reservation: PaperReservationSpec;
  filledQuantity: number;
  fills: readonly PaperFill[];
}>;

/** `balance`/`reserved` are EXACT integer minor units (see contracts fromMinorUnits);
 * the currency is the map key. Presentation converts back to major units. */
export type PaperCashState = Readonly<{ balance: number; reserved: number }>;
export type PaperPositionState = Readonly<{ quantity: number; reserved: number; costBasis: PaperMinorMoney }>;

export type PaperAccountState = Readonly<{
  cash: ReadonlyMap<string, PaperCashState>;
  positions: ReadonlyMap<string, PaperPositionState>;
  orders: ReadonlyMap<string, PaperOrderState>;
  /** Per-sell realized P&L (T8 S4b): net proceeds (after the stored transaction
   * tax) minus the average-cost relief. A DERIVED fact of the fold — computed
   * where the relief already is, appended in fill application order, no storage
   * change (state only ever folds from entries). Win rate reads the sign; per
   * SELL FILL (the natural unit of average-cost relief), not per round trip. */
  realizedSales: readonly PaperMinorMoney[];
}>;

type MutationControl = Readonly<{ idempotencyKey: string; expectedRevision: string }>;
type Receipt = Readonly<{ canonicalPayload: string; outcome: PaperCommandOutcome }>;

/**
 * Stage 2 T2-b durability port. The journal folds from an in-memory cache for
 * reads, but every applied append commits through this store FIRST — entry,
 * §8 receipt and exactly-once system key land in ONE transaction, so a crash
 * either kept the whole append or none of it, and a restart hydrates the
 * identical fold. The in-memory impl is the behavioral oracle; the pg impl
 * (journal-store.pg.ts) passes the same contract suite.
 */
export type PaperCommandAppend = Readonly<{
  workspace: string;
  entry: PaperJournalEntry;
  atEpoch: number;
  receiptKey: string;
  canonicalPayload: string;
  /** Persisted with the receipt so a post-restart §8 replay returns the ORIGINAL outcome. */
  outcome: PaperCommandOutcome;
}>;

export type PaperSystemAppend = Readonly<{
  workspace: string;
  entry: PaperJournalEntry;
  atEpoch: number;
  scopedKey: string;
  /** Genesis only: bind account → workspace atomically with the opening entry. */
  owner?: string;
}>;

/** `conflict`: the account is already owned by a DIFFERENT workspace — a
 * cross-workspace genesis must not seed money twice (codex T2-b finding). */
export type PaperStoreAppendOutcome = Readonly<{ status: "applied" | "suppressed" | "duplicate" | "conflict" }>;

/** `stale`: the requested fence is not above the durable watermark — a delayed
 * lower erase must not shred data legitimately written at a higher epoch. */
export type PaperEraseOutcome = Readonly<{ status: "erased" | "stale"; shredded: number }>;

/** Every row carries its write epoch: hydration re-judges each row against the
 * fence, so entries a stale backup resurrected stay suppressed (SEC-09). */
export type PaperJournalSnapshot = Readonly<{
  entries: readonly Readonly<{ workspace: string; entry: PaperJournalEntry; atEpoch: number }>[];
  receipts: readonly Readonly<{ workspace: string; receiptKey: string; canonicalPayload: string; outcome: PaperCommandOutcome; atEpoch: number }>[];
  systemKeys: readonly Readonly<{ workspace: string; scopedKey: string; atEpoch: number }>[];
  owners: readonly Readonly<{ account: string; workspace: string; atEpoch: number }>[];
  fences: readonly Readonly<{ workspace: string; fence: number }>[];
}>;

export interface PaperJournalStore {
  appendCommand(append: PaperCommandAppend): Promise<PaperStoreAppendOutcome>;
  appendSystem(append: PaperSystemAppend): Promise<PaperStoreAppendOutcome>;
  /** SEC-09: shred every row for the workspace and raise the durable fence — one
   * transaction. `tx` joins an enclosing erase transaction (identity SEC-09
   * coordinator) so the identity fence and the paper shred commit or roll back
   * together; stores without transactions ignore it. */
  eraseWorkspace(workspace: string, fence: number, tx?: Executor): Promise<PaperEraseOutcome>;
  /** Full hydration snapshot for journal boot. ponytail: loads everything; page per-workspace when scale demands. */
  load(): Promise<PaperJournalSnapshot>;
}

/** In-memory reference implementation — also the default store, giving a plain `new PaperJournal(now)` exactly the pre-T2-b semantics. */
export class MemoryPaperJournalStore implements PaperJournalStore {
  readonly #fence = new Map<string, number>();
  readonly #entries = new Map<string, Readonly<{ workspace: string; entry: PaperJournalEntry; atEpoch: number }>>();
  readonly #receipts = new Map<string, Readonly<{ workspace: string; receiptKey: string; canonicalPayload: string; outcome: PaperCommandOutcome; atEpoch: number }>>();
  readonly #systemKeys = new Map<string, Readonly<{ workspace: string; scopedKey: string; atEpoch: number }>>();
  readonly #owners = new Map<string, Readonly<{ workspace: string; atEpoch: number }>>();

  /** Mirrors pg UNIQUE (workspace, account, revision): a second writer folding
   * the same revision is a loud error, never a silent overwrite. */
  readonly #revisionKeys = new Set<string>();

  #suppressed(workspace: string, atEpoch: number): boolean {
    return atEpoch <= (this.#fence.get(workspace) ?? 0);
  }

  #claimRevision(append: Readonly<{ workspace: string; entry: PaperJournalEntry }>): void {
    const key = `${append.workspace}|${String(append.entry.account)}|${append.entry.revision}`;
    if (this.#revisionKeys.has(key)) throw new Error(`paper journal revision collision (concurrent writer is unsupported): ${key}`);
    this.#revisionKeys.add(key);
  }

  appendCommand(append: PaperCommandAppend): Promise<PaperStoreAppendOutcome> {
    if (this.#suppressed(append.workspace, append.atEpoch)) return Promise.resolve({ status: "suppressed" });
    if (this.#receipts.has(append.receiptKey)) return Promise.resolve({ status: "duplicate" });
    this.#claimRevision(append);
    this.#entries.set(`${append.workspace}|${String(append.entry.entryReference)}`, { workspace: append.workspace, entry: append.entry, atEpoch: append.atEpoch });
    this.#receipts.set(append.receiptKey, {
      workspace: append.workspace,
      receiptKey: append.receiptKey,
      canonicalPayload: append.canonicalPayload,
      outcome: append.outcome,
      atEpoch: append.atEpoch,
    });
    return Promise.resolve({ status: "applied" });
  }

  appendSystem(append: PaperSystemAppend): Promise<PaperStoreAppendOutcome> {
    if (this.#suppressed(append.workspace, append.atEpoch)) return Promise.resolve({ status: "suppressed" });
    if (append.owner !== undefined) {
      const existing = this.#owners.get(String(append.entry.account));
      if (existing !== undefined && existing.workspace !== append.owner) return Promise.resolve({ status: "conflict" });
    }
    const keyId = `${append.workspace}|${append.scopedKey}`;
    if (this.#systemKeys.has(keyId)) return Promise.resolve({ status: "duplicate" });
    this.#claimRevision(append);
    this.#systemKeys.set(keyId, { workspace: append.workspace, scopedKey: append.scopedKey, atEpoch: append.atEpoch });
    this.#entries.set(`${append.workspace}|${String(append.entry.entryReference)}`, { workspace: append.workspace, entry: append.entry, atEpoch: append.atEpoch });
    if (append.owner !== undefined && !this.#owners.has(String(append.entry.account))) {
      this.#owners.set(String(append.entry.account), { workspace: append.owner, atEpoch: append.atEpoch });
    }
    return Promise.resolve({ status: "applied" });
  }

  eraseWorkspace(workspace: string, fence: number): Promise<PaperEraseOutcome> {
    // A delayed LOWER erase must be a no-op: data written at a legitimately
    // higher post-erasure epoch would otherwise be shredded while the fence
    // stayed put (codex T2-b finding).
    if (fence <= (this.#fence.get(workspace) ?? 0)) return Promise.resolve({ status: "stale", shredded: 0 });
    let shredded = 0;
    for (const [key, row] of [...this.#entries]) {
      if (row.workspace !== workspace) continue;
      this.#entries.delete(key);
      shredded += 1;
    }
    for (const [key, row] of [...this.#receipts]) if (row.workspace === workspace) this.#receipts.delete(key);
    for (const [key, row] of [...this.#systemKeys]) if (row.workspace === workspace) this.#systemKeys.delete(key);
    for (const [account, owner] of [...this.#owners]) if (owner.workspace === workspace) this.#owners.delete(account);
    for (const key of [...this.#revisionKeys]) if (key.startsWith(`${workspace}|`)) this.#revisionKeys.delete(key);
    this.#fence.set(workspace, fence);
    return Promise.resolve({ status: "erased", shredded });
  }

  load(): Promise<PaperJournalSnapshot> {
    return Promise.resolve({
      entries: [...this.#entries.values()],
      receipts: [...this.#receipts.values()],
      systemKeys: [...this.#systemKeys.values()],
      owners: [...this.#owners].map(([account, owner]) => ({ account, workspace: owner.workspace, atEpoch: owner.atEpoch })),
      fences: [...this.#fence].map(([workspace, fence]) => ({ workspace, fence })),
    });
  }
}

/**
 * The ONE definition of what a split does to a live order — the fold applies
 * it, `validateSystemBody` judges it. Two definitions would let the boundary
 * accept a shape the fold then produces differently, which is exactly how
 * OF-6 got in: the boundary looked at `payload.limitPrice` while the fold
 * rewrote `reservation.unitPrice`.
 *
 * The two prices quantize DIFFERENTLY on purpose:
 * - `limitPrice` rounds. It is a trading instruction, and the nearest tick is
 *   the honest split-adjusted instruction.
 * - the reservation unit price CEILS. A reservation is a cash hold, and a hold
 *   that rounded down would stop covering the order it exists for. Ceiling can
 *   only over-hold, by under one minor unit per share — the account's own cash,
 *   still visible in the public `reserved` number, never someone else's.
 *
 * Exact conservation is NOT available here: a split divides the unit price, and
 * an odd cent does not halve. Requiring it refused 50% of ordinary 2:1 splits
 * (67% at 3:1) — the ledger would routinely refuse a market fact. The boundary
 * bounds the hold instead (see `reservation_exceeds_balance`).
 */
export function applySplitToOrder(
  order: PaperOrderState,
  numerator: number,
  denominator: number,
): Readonly<{
  quantity: number;
  filledQuantity: number;
  limitPrice: PaperMoney | undefined;
  reservation: PaperReservationSpec;
}> {
  const split = (price: PaperMoney, quantize: (value: number) => number): PaperMoney =>
    fromMinorUnits(quantize((toMinorUnits(price) * denominator) / numerator), price.currency);
  return {
    quantity: (order.payload.quantity * numerator) / denominator,
    filledQuantity: (order.filledQuantity * numerator) / denominator,
    limitPrice: order.payload.limitPrice === undefined ? undefined : split(order.payload.limitPrice, Math.round),
    reservation: order.reservation.kind === "cash"
      ? { kind: "cash", unitPrice: split(order.reservation.unitPrice, Math.ceil) }
      : order.reservation,
  };
}

export type SystemRefusalReason =
  | "command_only"
  | "already_opened"
  | "unknown_order"
  | "order_not_fillable"
  | "invalid_fill"
  | "insufficient_cash"
  | "insufficient_position"
  | "order_not_expirable"
  | "invalid_adjustment"
  | "fractional_result"
  | "reservation_exceeds_balance"
  | "invalid_seed_cash";

export type SystemAppendOutcome =
  | Readonly<{ status: "applied"; revision: number }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "suppressed" }>
  | Readonly<{ status: "refused"; reason: SystemRefusalReason }>;

const EPSILON = 1e-9;

/** §9 boundary validation for server-only system events (see appendSystem). */
export function validateSystemBody(state: PaperAccountState, body: PaperEntryBody): SystemRefusalReason | undefined {
  switch (body.kind) {
    // Order submission and cancellation are user commands — they carry the §8
    // trio and must never enter through the system path.
    case "order_submitted":
    case "cancellation_resolved":
      return "command_only";
    case "account_opened": {
      // Genesis happens at most once per account THAT HOLDS ANYTHING. An empty
      // `seedCash` leaves both maps empty, so a second `account_opened` under a
      // different dedupe key still passes here and mints cash — reproduced by
      // adversarial review, 2026-07-27. Not closed in round 3: the fix needs a
      // genesis marker in the folded state (`#owners` knows, but this validator
      // is deliberately a pure function of the fold). → open-findings OF-8.
      if (state.cash.size > 0 || state.orders.size > 0) return "already_opened";
      // Genesis is where the FIRST number enters the exact-integer domain, so it
      // is where the domain's precondition has to be met. This path — the durable
      // one — did not check at all until round 2; the fill guard's comment claimed
      // seed cash was "already enforced" and that was false, the check lived only
      // in `backtest-runner`'s own path.
      //
      // Round 2 then imported only HALF of it, and adversarial review reproduced
      // the rest: a −$1,000,000 seed was accepted and folded to a −100000000
      // balance, and `0.005` rounded IN as 1. Round 4 then found that the
      // consolidation was half done and finished it: the whole precondition —
      // per item AND per-currency total — is `isRepresentableSeedCash`, and this
      // arm and `backtest-runner` are its two callers. (Round 4's version of this
      // comment still said "the shared `isRepresentableCash` — one definition,
      // two callers"; after round 4 that symbol has exactly ONE caller and it is
      // not this one. Adversarial review round 5 grepped it. A stale comment in
      // the commit that fixed stale comments — the third time in this file.)
      // It rejects negative, sub-unit and
      // non-finite amounts. (±Infinity is refused because `Infinity * scale` is
      // not a safe integer; it does NOT become NaN, which is what round 2's
      // comment claimed. Mechanism matters: a false mechanism in a true
      // conclusion is how the next reader builds on sand.)
      //
      // The running per-currency total is checked on top, mirroring the fold's
      // genesis arm: two seeds in one currency can each be representable and
      // their total not be.
      if (!isRepresentableSeedCash(body.seedCash)) return "invalid_seed_cash";
      return undefined;
    }
    case "order_expired": {
      const order = state.orders.get(String(body.order));
      if (order === undefined) return "unknown_order";
      if (order.execution !== "open" && order.execution !== "partially_filled") return "order_not_expirable";
      return undefined;
    }
    case "corporate_action_applied": {
      const { numerator, denominator } = body.adjustment;
      if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) {
        return "invalid_adjustment";
      }
      const scaled = (quantity: number) => (quantity * numerator) / denominator;
      const position = state.positions.get(String(body.instrument));
      if (position !== undefined) {
        if (!Number.isInteger(scaled(position.quantity))) return "fractional_result";
        // Number.isInteger is true for 1e300 — whole, but no longer countable.
        // Beyond 2^53 share counts stop being exact and every later fill/split
        // reads a lie, so the boundary refuses to produce one.
        if (!isExactMinor(scaled(position.quantity))) return "invalid_adjustment";
      }
      // Post-split cash held per currency — every reserving order, whether or
      // not this split touches it, because the ceiling below is an account-wide
      // fact and an untouched order's hold is part of it.
      const reservedAfter = new Map<string, number>();
      for (const order of state.orders.values()) {
        // Mirror the fold's reserving() predicate: a confirmed-cancelled order
        // is not adjusted by the split, so it must not veto it either (codex
        // T2-b finding: a cancelled odd-lot order blocked a legitimate split).
        if (!reserving(order)) continue;
        const touched = String(order.payload.instrument) === String(body.instrument);
        const adjusted = touched ? applySplitToOrder(order, numerator, denominator) : undefined;
        if (adjusted !== undefined) {
          if (!Number.isInteger(adjusted.quantity) || !Number.isInteger(adjusted.filledQuantity)) {
            return "fractional_result";
          }
          if (!isExactMinor(adjusted.quantity) || !isExactMinor(adjusted.filledQuantity)) {
            return "invalid_adjustment";
          }
          // An order whose split-adjusted limit quantizes to 0¢ can never be
          // filled by any positive price — it would sit open forever holding a
          // reservation. Both sides: a BUY's limit and its reservation unit
          // price are the same number at submit but quantize differently here
          // (round vs ceil), so the cash ceiling below does not imply this.
          if (adjusted.limitPrice !== undefined && toMinorUnits(adjusted.limitPrice) < 1) {
            return "fractional_result";
          }
        }
        const reservation = adjusted?.reservation ?? order.reservation;
        if (reservation.kind !== "cash") continue;
        const remaining = (adjusted?.quantity ?? order.payload.quantity)
          - (adjusted?.filledQuantity ?? order.filledQuantity);
        const currency = reservation.unitPrice.currency;
        const gross = grossMinorOf(remaining, reservation.unitPrice);
        if (!isExactMinor(gross)) return "invalid_adjustment";
        reservedAfter.set(currency, (reservedAfter.get(currency) ?? 0) + gross);
      }
      // OF-6: the split rewrites live cash reservations and submit's
      // affordability check (`required ≤ balance − reserved`) does NOT run
      // again. Exact conservation is impossible (an odd cent does not halve),
      // so the reservation is allowed to grow by the ceiling remainder — but
      // never past the cash that backs it. This is the condition the original
      // attack broke: 53 splits of a 1¢ order drove `reserved` to 2^53 while
      // the balance stayed at $1,000.
      for (const [currency, reserved] of reservedAfter) {
        if (reserved > (state.cash.get(currency)?.balance ?? 0)) return "reservation_exceeds_balance";
      }
      return undefined;
    }
    case "dividend_applied": {
      if (!Number.isFinite(body.perShare.amount) || body.perShare.amount <= 0) return "invalid_adjustment";
      // A dividend credits cash in perShare.currency; a currency differing from
      // the held position's basis fabricates foreign cash in the account (the
      // fold credits perShare.currency unconditionally). Fail closed like the
      // fill boundary — an instrument's currency never legitimately changes
      // (adversarial re-gate 2026-07-25: the fill guard closes this both ways,
      // the dividend branch did not — S4b cross-currency parity).
      const position = state.positions.get(String(body.instrument));
      if (position !== undefined && position.costBasis.currency !== body.perShare.currency) return "invalid_adjustment";
      // Both the credit the fold will compute (its `dividend_applied` arm) and the balance it lands in
      // must stay exact. Guarding only the product is not enough and guarding
      // only the total is not either — an inexact product is a fabricated number
      // whether or not the sum it joins happens to be representable. Reproduced
      // (round 2): quantity 2^53-1 × 3 stores …972 where the exact credit is
      // …973, and once a balance sits at 2^53 a 1-unit credit leaves it
      // unchanged. The condition mirrors the fold's — it credits only a held,
      // positive position, so nothing else can be refused here.
      if (position !== undefined && position.quantity > 0) {
        const creditMinor = grossMinorOf(position.quantity, body.perShare);
        if (!isExactMinor(creditMinor)) return "invalid_adjustment";
        const balance = state.cash.get(body.perShare.currency)?.balance ?? 0;
        if (!isExactMinor(balance + creditMinor)) return "invalid_adjustment";
      }
      return undefined;
    }
    case "fill_applied": {
      const fill = body.fill;
      const order = state.orders.get(String(fill.order));
      if (order === undefined) return "unknown_order";
      if (order.execution !== "open" && order.execution !== "partially_filled") return "order_not_fillable";
      if (!Number.isInteger(fill.quantity) || fill.quantity <= 0) return "invalid_fill";
      if (fill.quantity > order.payload.quantity - order.filledQuantity) return "invalid_fill";
      if (!Number.isFinite(fill.price.amount) || fill.price.amount <= 0) return "invalid_fill";
      // A malformed event time parses to NaN, every temporal comparison below
      // evaluates false, and the fill would slip past the acceptance and
      // cancellation guards (codex T2-b finding) — refuse it outright.
      if (!Number.isFinite(Date.parse(fill.eventTime))) return "invalid_fill";
      // A limit order can never fill past its (post-split) limit — enforced
      // here too, not only in the simulator (codex-panel finding: a forged
      // fill at a stale pre-split or over-limit price landed via the journal).
      const limit = order.payload.limitPrice;
      if (limit !== undefined) {
        if (fill.price.currency !== limit.currency) return "invalid_fill";
        const fillTicks = toMinorUnits(fill.price);
        const limitTicks = toMinorUnits(limit);
        if (order.payload.side === "buy" && fillTicks > limitTicks) return "order_not_fillable";
        if (order.payload.side === "sell" && fillTicks < limitTicks) return "order_not_fillable";
      }
      if (Date.parse(fill.eventTime) <= Date.parse(order.acceptedAt)) return "order_not_fillable";
      if (order.cancellation === "confirmed") {
        // Only a late VALID fill — from before the cancellation instant — may land.
        if (order.cancelledAt === undefined || Date.parse(fill.eventTime) >= Date.parse(order.cancelledAt)) {
          return "order_not_fillable";
        }
      }
      // S3 cost invariants — structural money guard only (the exact tax rate is
      // the simulator's; an independent oracle verifies it). The journal stays
      // domain-generic: it refuses a fill whose stored cost could FABRICATE or
      // over-destroy cash — a negative/non-integer tax, a tax exceeding the
      // sale proceeds, or a tax on a buy (Korean tax is sell-only).
      const grossMinor = grossMinorOf(fill.quantity, fill.price);
      // The ledger's 2^53 ceiling is DOCUMENTED (stage2c-ledger-hardening.md:74,93)
      // but was enforced on NOTHING that reaches this journal — the earlier version
      // of this comment said "already enforced on seed cash and on the tax sum",
      // and that was false: the seed check lived in `backtest-runner`'s own seed
      // validation — a different module on a different path. Round 2 (2026-07-27)
      // grepped for the enforcement this comment asserted and did not find it;
      // `account_opened` above now carries it, and round 3 moved the predicate
      // itself into `contracts` so there is one definition rather than two.
      // Do not restore the claim without the grep.
      // Past the ceiling the rounded product is a NEIGHBOURING integer, so "cash
      // conservation is exact, no epsilon" quietly stops holding. Enforced here
      // because this boundary already owns a refusal channel; the arithmetic
      // stays a plain total. A non-finite quantity/price fails the same check.
      if (!isExactMinor(grossMinor)) return "invalid_fill";
      if (fill.costs !== undefined) {
        const tax = fill.costs.sellTransactionTaxMinor;
        if (order.payload.side !== "sell") return "invalid_fill";
        if (!Number.isInteger(tax) || tax < 0) return "invalid_fill";
        if (tax > grossMinor) return "invalid_fill";
      }
      if (order.payload.side === "sell") {
        // An exact product can still land in an inexact BALANCE. That is not
        // cosmetic: once the total passes 2^53 a later 1-unit credit vanishes
        // into an unchanged balance, and `balance - reserved` starts rounding —
        // which is how an affordability check approves more than the account
        // holds. Both reproduced in round 2 (balance 2^54, reserved 1 reads as
        // …984 available where …983 is exact, and the …984 request is approved).
        // Buys need no such guard: the affordability check bounds the debit by
        // the balance, so the result stays inside [0, balance].
        //
        // The parentheses are the fix, not decoration. Round 2 wrote
        // `balance + gross - tax`, which associates left to right: `balance +
        // gross` can round through an unrepresentable intermediate and the
        // subtraction can land back INSIDE the safe range, so `isExactMinor`
        // returned true for a number that was not the sum — and the fold, using
        // the same association, stored the drifted one. Adversarial review
        // reproduced it (2026-07-27: gross 2, tax 2, balance 2^53−1 → accepted,
        // no refusal, 1 minor unit of cash silently destroyed).
        //
        // Netting first removes the intermediate instead of merely rejecting it:
        // `gross - tax` is bounded by gross (0 ≤ tax ≤ gross is enforced above),
        // so it is always representable, and one addition of two safe integers is
        // exact whenever the result is in range. Rejecting the intermediate would
        // also have been sound but refuses honest sells whose true balance IS
        // representable — a guard should not buy soundness with false refusals.
        // The fold's sell arm carries the identical association; the two must
        // stay in step, which is why the same parentheses appear there.
        const taxMinor = fill.costs?.sellTransactionTaxMinor ?? 0;
        const balanceMinor = state.cash.get(fill.price.currency)?.balance ?? 0;
        if (!isExactMinor(balanceMinor + (grossMinor - taxMinor))) return "invalid_fill";
      }
      // A fill in a different currency than the instrument's existing basis
      // would mix units in the fold — relief and realized P&L subtract across
      // currencies (USD cents off KRW proceeds), fabricating money. An
      // instrument's currency never legitimately changes mid-position; fail
      // closed for BOTH sides, here at the one boundary every position-moving
      // entry crosses (codex S4b HIGH).
      const held = state.positions.get(String(order.payload.instrument));
      if (held !== undefined && held.costBasis.currency !== fill.price.currency) return "invalid_fill";
      const reservingNow = order.cancellation !== "confirmed";
      if (order.payload.side === "buy") {
        const cash = state.cash.get(fill.price.currency);
        if (cash === undefined) return "insufficient_cash";
        // All minor units — cash conservation is exact, so no epsilon slack.
        const ownReservationMinor = reservingNow && order.reservation.kind === "cash"
          ? grossMinorOf(order.payload.quantity - order.filledQuantity, order.reservation.unitPrice)
          : 0;
        const availableMinor = cash.balance - cash.reserved + ownReservationMinor;
        if (grossMinor > availableMinor) return "insufficient_cash";
        return undefined;
      }
      if (held === undefined) return "insufficient_position";
      const position = held;
      const ownReservation = reservingNow && order.reservation.kind === "quantity"
        ? order.payload.quantity - order.filledQuantity
        : 0;
      const available = position.quantity - position.reserved + ownReservation;
      if (fill.quantity > available + EPSILON) return "insufficient_position";
      return undefined;
    }
  }
}

/** The ONLY entry kinds a user command may produce — everything else (genesis,
 * fills, corporate actions) is server-only and must go through appendSystem's
 * validation (codex T2-b finding: an unrestricted decide could mint a second
 * genesis through the command path). */
export type PaperCommandBody = Extract<PaperEntryBody, { kind: "order_submitted" | "cancellation_resolved" }>;

export type CommandDecision =
  | Readonly<{ entry: PaperCommandBody; order: PaperOrderReference }>
  | Readonly<{ refuse: Extract<PaperCommandOutcome, { status: "refused" }>["reason"] }>
  | Readonly<{ reject: true }>
  | Readonly<{ deny: true }>;

const MODULE = "paper-internal";

export class PaperJournal {
  #entries = new FencedKeyedStore<PaperJournalEntry>();
  #revisions = new Map<string, number>();
  #receipts = new Map<string, Receipt>();
  /** An Internal Paper account belongs to exactly one workspace, fixed at genesis. */
  #owners = new Map<string, string>();
  /** Exactly-once keys for system events (fill identities, corporate actions). */
  #systemKeys = new FencedKeyedStore<true>();
  readonly #store: PaperJournalStore;
  #hydrated = false;
  /** Set when the durable store may have advanced past the cache (a lost COMMIT
   * ack, a store duplicate the cache did not know) — the next mutation rebuilds
   * the cache from the store before deciding anything (codex T2-b finding). */
  #staleCache = false;
  /**
   * Append serialization: decision-against-fold and store commit must be one
   * indivisible step, or two interleaved async appends could both fold the
   * same revision. ponytail: journal-wide chain; per-account queues if
   * throughput matters. Cross-process writers are NOT supported — the stores'
   * revision uniqueness makes that loud, not silent.
   */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly now: () => string,
    private readonly writeEpoch: () => number = () => 1,
    store?: PaperJournalStore,
  ) {
    this.#store = store ?? new MemoryPaperJournalStore();
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task, task);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Hydrate the fold cache from the durable store. Await this (or any mutation
   * — they self-hydrate) before trusting synchronous reads on a persistent
   * store. Idempotent; re-runs only after a store/cache divergence was flagged.
   */
  init(): Promise<this> {
    return this.#serialize(async () => {
      await this.#ensureFresh();
      return this;
    });
  }

  /** Runs ONLY inside #serialize. Rebuilds the cache from a store snapshot:
   * each row re-judged against the fence at its own write epoch, so entries a
   * stale backup resurrected stay suppressed (SEC-09); receipts/system keys
   * restore §8 idempotency and exactly-once across the restart. */
  async #ensureFresh(): Promise<void> {
    if (this.#hydrated && !this.#staleCache) return;
    const snapshot = await this.#store.load();
    this.#entries = new FencedKeyedStore<PaperJournalEntry>();
    this.#systemKeys = new FencedKeyedStore<true>();
    this.#revisions = new Map();
    this.#receipts = new Map();
    this.#owners = new Map();
    for (const { workspace, fence } of snapshot.fences) {
      this.#entries.eraseSubject(workspace, fence);
      this.#systemKeys.eraseSubject(workspace, fence);
    }
    for (const { workspace, entry, atEpoch } of snapshot.entries) {
      if (!this.#entries.write(workspace, String(entry.entryReference), entry, atEpoch)) continue;
      const accountKey = `${workspace}|${String(entry.account)}`;
      if (entry.revision > (this.#revisions.get(accountKey) ?? 0)) this.#revisions.set(accountKey, entry.revision);
    }
    for (const receipt of snapshot.receipts) {
      if (this.#entries.isErased(receipt.workspace, receipt.atEpoch)) continue;
      this.#receipts.set(receipt.receiptKey, { canonicalPayload: receipt.canonicalPayload, outcome: receipt.outcome });
    }
    for (const key of snapshot.systemKeys) this.#systemKeys.write(key.workspace, key.scopedKey, true, key.atEpoch);
    for (const owner of snapshot.owners) {
      if (this.#entries.isErased(owner.workspace, owner.atEpoch)) continue;
      this.#owners.set(owner.account, owner.workspace);
    }
    this.#hydrated = true;
    this.#staleCache = false;
  }

  /**
   * §8 user-command path: receipt trio, then revision CAS, then the caller's
   * semantic decision against the folded state — all before a single write.
   * Only applied outcomes are receipted; refusals stay side-effect free and
   * re-evaluate on a genuine retry. An applied outcome is durable BEFORE it is
   * acknowledged: the store commit (entry + receipt, one transaction) precedes
   * the cache update and the return.
   */
  appendCommand(
    workspace: string,
    account: InternalPaperAccountReference,
    commandKind: string,
    control: MutationControl,
    canonicalPayload: string,
    decide: (context: Readonly<{ state: PaperAccountState; revision: number }>) => CommandDecision,
  ): Promise<PaperCommandOutcome> {
    return this.#serialize(async () => {
      await this.#ensureFresh();
      const receiptKey = `${workspace}|${MODULE}|${String(account)}|${commandKind}|${control.idempotencyKey}`;
      const prior = this.#receipts.get(receiptKey);
      if (prior !== undefined) {
        return prior.canonicalPayload === canonicalPayload ? prior.outcome : { status: "conflict" };
      }

      const accountKey = `${workspace}|${String(account)}`;
      const currentRevision = this.#revisions.get(accountKey) ?? 0;
      if (control.expectedRevision !== String(currentRevision)) {
        // A stale revision may just be a cache that missed a durable commit —
        // and that commit could be THIS very idempotency key. §8 gives the
        // original receipt precedence over the revision CAS, so rehydrate and
        // check for the durable receipt before rejecting (codex Stage 2-c: a
        // same-key retry whose cache lagged was rejected instead of replayed).
        this.#staleCache = true;
        await this.#ensureFresh();
        const durable = this.#receipts.get(receiptKey);
        if (durable !== undefined) {
          return durable.canonicalPayload === canonicalPayload ? durable.outcome : { status: "conflict" };
        }
        const freshRevision = this.#revisions.get(accountKey) ?? 0;
        return { status: "rejected", currentRevision: freshRevision };
      }

      const decision = decide({ state: this.state(workspace, account), revision: currentRevision });
      if ("deny" in decision) return { status: "denied" };
      if ("reject" in decision) return { status: "rejected", currentRevision };
      if ("refuse" in decision) return { status: "refused", reason: decision.refuse };
      // Runtime backstop for untyped callers: the command path may only carry
      // command kinds — genesis/fills/corporate actions are server-only.
      if (decision.entry.kind !== "order_submitted" && decision.entry.kind !== "cancellation_resolved") {
        throw new Error(`paper command path refuses server-only entry kind: ${(decision.entry as { kind: string }).kind}`);
      }

      const revision = currentRevision + 1;
      const atEpoch = this.writeEpoch();
      if (this.#entries.isErased(workspace, atEpoch)) return { status: "suppressed" };
      const entry = this.#buildEntry(account, decision.entry, revision);
      const outcome: PaperCommandOutcome = { status: "applied", revision, order: decision.order };
      const committed = await this.#commit(() => this.#store.appendCommand({ workspace, entry, atEpoch, receiptKey, canonicalPayload, outcome }));
      if (committed.status === "duplicate") {
        // The durable store already holds this idempotency key — a concurrent
        // writer committed it first, or an earlier COMMIT ack was lost. §8: the
        // ORIGINAL receipt wins, so rehydrate and replay it. The same payload
        // returns the original outcome (an idempotent retry, NOT a conflict);
        // only a DIFFERENT payload under the same key is a real conflict.
        // (Stage 2-c item 4: a concurrent same-key retry used to get a spurious
        // conflict here — the loser never reconciled to the winner's receipt.)
        this.#staleCache = true;
        await this.#ensureFresh();
        const reconciled = this.#receipts.get(receiptKey);
        if (reconciled !== undefined) {
          return reconciled.canonicalPayload === canonicalPayload ? reconciled.outcome : { status: "conflict" };
        }
        return { status: "conflict" };
      }
      if (committed.status === "conflict") {
        // The durable store knows something the cache does not — rebuild before the next decision.
        this.#staleCache = true;
        return { status: "conflict" };
      }
      if (committed.status !== "applied") return { status: "suppressed" };
      this.#entries.write(workspace, String(entry.entryReference), entry, atEpoch);
      this.#revisions.set(accountKey, revision);
      this.#receipts.set(receiptKey, { canonicalPayload, outcome });
      return outcome;
    });
  }

  /** A store failure leaves it UNKNOWN whether the commit landed (lost ack):
   * flag the cache stale so the next mutation rehydrates, then rethrow. */
  async #commit(run: () => Promise<PaperStoreAppendOutcome>): Promise<PaperStoreAppendOutcome> {
    try {
      return await run();
    } catch (error) {
      this.#staleCache = true;
      throw error;
    }
  }

  /**
   * Server-only system path (fills, expiry, corporate actions): exactly-once
   * by dedupe key — a redelivery is a no-op returning the original revision.
   *
   * The journal is the module's real mutation boundary, so the §9 invariants
   * are enforced HERE, not merely in the simulator's own guards (codex-panel
   * finding): a fill must target a fillable order inside its market-time
   * window and stay affordable, expiry must hit a live order, genesis happens
   * once, and a split can never break whole-share lots. A violating body is
   * refused with zero writes — the dedupe key is only consumed by an applied
   * entry, so a later legitimate delivery still lands. The dedupe key and the
   * entry commit in one store transaction before anything is acknowledged.
   */
  appendSystem(
    workspace: string,
    account: InternalPaperAccountReference,
    dedupeKey: string,
    body: PaperEntryBody,
    options?: Readonly<{ owner?: string }>,
  ): Promise<SystemAppendOutcome> {
    return this.#serialize(() => this.#appendSystemLocked(workspace, account, dedupeKey, body, options));
  }

  async #appendSystemLocked(
    workspace: string,
    account: InternalPaperAccountReference,
    dedupeKey: string,
    body: PaperEntryBody,
    options?: Readonly<{ owner?: string }>,
  ): Promise<SystemAppendOutcome> {
    await this.#ensureFresh();
    const scopedKey = `${String(account)}|${dedupeKey}`;
    if (this.#systemKeys.get(workspace, scopedKey) !== undefined) return { status: "duplicate" };
    const violation = validateSystemBody(this.state(workspace, account), body);
    if (violation !== undefined) return { status: "refused", reason: violation };
    const atEpoch = this.writeEpoch();
    if (this.#systemKeys.isErased(workspace, atEpoch) || this.#entries.isErased(workspace, atEpoch)) {
      return { status: "suppressed" };
    }
    const accountKey = `${workspace}|${String(account)}`;
    const revision = (this.#revisions.get(accountKey) ?? 0) + 1;
    const entry = this.#buildEntry(account, body, revision);
    const committed = await this.#commit(() => this.#store.appendSystem({ workspace, entry, atEpoch, scopedKey, ...(options?.owner !== undefined ? { owner: options.owner } : {}) }));
    if (committed.status === "duplicate") {
      // The cache said absent, the store says present: the store advanced past
      // the cache (e.g. a lost COMMIT ack on the previous try) — rehydrate
      // before the next decision so durable money stays visible.
      this.#staleCache = true;
      return { status: "duplicate" };
    }
    if (committed.status === "conflict") return { status: "refused", reason: "already_opened" };
    if (committed.status !== "applied") return { status: "suppressed" };
    this.#systemKeys.write(workspace, scopedKey, true, atEpoch);
    this.#entries.write(workspace, String(entry.entryReference), entry, atEpoch);
    this.#revisions.set(accountKey, revision);
    if (options?.owner !== undefined) this.#owners.set(String(account), options.owner);
    return { status: "applied", revision };
  }

  /** Genesis: provision the account and fix its owning workspace — owner row commits atomically with the opening entry. */
  async provision(workspace: string, account: InternalPaperAccountReference, seedCash: readonly PaperMoney[]): Promise<void> {
    if (this.#owners.has(String(account))) return;
    await this.appendSystem(workspace, account, "genesis", { kind: "account_opened", seedCash }, { owner: workspace });
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

  /** SEC-09: shred entries, receipts, revisions, ownership and dedupe keys behind the fence — durable first.
   * A stale (not-above-watermark) fence is a no-op in store AND cache. `tx` joins the identity erase
   * transaction so the deletion fence and this shred commit or roll back together. */
  eraseWorkspace(workspace: string, fence: number, tx?: Executor): Promise<number> {
    return this.#serialize(async () => {
      await this.#ensureFresh();
      const erased = await this.#store.eraseWorkspace(workspace, fence, tx);
      if (erased.status === "stale") return 0;
      for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${workspace}|`)) this.#revisions.delete(key);
      for (const key of [...this.#receipts.keys()]) if (key.startsWith(`${workspace}|`)) this.#receipts.delete(key);
      for (const [account, owner] of [...this.#owners]) if (owner === workspace) this.#owners.delete(account);
      this.#systemKeys.eraseSubject(workspace, fence);
      return this.#entries.eraseSubject(workspace, fence);
    });
  }

  #buildEntry(account: InternalPaperAccountReference, body: PaperEntryBody, revision: number): PaperJournalEntry {
    const entryReference = brandReference<string, "PaperJournalEntryReference">(
      `paper-entry:${String(account)}:${revision}`,
    );
    // Deep-freeze the applied entry so "append-only" is a RUNTIME truth, not
    // just a type-level `Readonly`. The memory store and the fold cache share
    // this reference; without the freeze a holder of `list()` could mutate a
    // validated fill's quantity or stored tax AFTER validation and the next
    // fold would apply the tampered value, minting or destroying cash (codex
    // gate HIGH).
    //
    // ← 정정 (arch-1 적대 리뷰 2라운드): this used to claim "the PG store
    // re-parses JSONB, so it is already immutable". FALSE — parsed JSONB is an
    // ordinary mutable object, and `#hydrate` puts those rows straight into the
    // fold cache unfrozen. So the freeze covers in-process appends ONLY, and
    // anything hydrated from the durable store is unprotected here. That false
    // premise is why `presentState` handed out live payloads for so long; the
    // clone at that seam is what actually covers the durable path.
    return deepFreeze({ ...body, entryReference, account, revision, recordedAt: this.now() });
  }
}

/** Recursively freeze a value so nested money objects (fill, price, costs)
 * cannot be mutated after they are recorded.
 *
 * Exported (arch-1) so `presentState` can freeze the projection it hands out:
 * a clone protects the ledger, and freezing the clone keeps caller-side
 * tampering LOUD instead of silently discarded. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** An order still holds its remaining reservation only in these axis states. */
function reserving(order: PaperOrderState): boolean {
  return (
    (order.execution === "open" || order.execution === "partially_filled")
    && (order.cancellation === "none" || order.cancellation === "requested" || order.cancellation === "rejected")
  );
}

export function foldAccountState(entries: readonly PaperJournalEntry[]): PaperAccountState {
  // Cash, cost basis and reservations fold in EXACT integer minor units — this
  // is the one place money conservation is decided, so it is never float (Stage
  // 2-c). Incoming display prices become minor units at `toMinorUnits`; nothing
  // here divides by the scale.
  // TRUST BOUNDARY: the fold does NOT re-validate its entries. Every
  // money-affecting entry (fills, dividends, splits) is checked at
  // `validateSystemBody` before append; that boundary — not this fold — is where
  // fill/dividend trust is enforced. A path that appended a fill_applied without
  // it (a migration or recovery tool) would let the fold fabricate cash. Kept
  // as one boundary rather than duplicated here (adversarial re-gate 2026-07-25).
  const cashBalance = new Map<string, number>();
  const positions = new Map<string, { quantity: number; costBasis: PaperMinorMoney }>();
  const orders = new Map<string, PaperOrderState>();
  const realizedSales: PaperMinorMoney[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case "account_opened": {
        for (const seed of entry.seedCash) {
          cashBalance.set(seed.currency, (cashBalance.get(seed.currency) ?? 0) + toMinorUnits(seed));
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
          orders.set(String(entry.order), {
            ...order,
            cancellation: entry.resolution,
            // 키의 유무를 보존한다 — `cancelledAt: undefined` 로 덮으면 "확정 시각 없음"이
            // 없던 키에서 undefined 를 든 키로 바뀐다 (exactOptionalPropertyTypes).
            ...(entry.resolution === "confirmed"
              ? { cancelledAt: entry.recordedAt }
              : order.cancelledAt !== undefined ? { cancelledAt: order.cancelledAt } : {}),
          });
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
        // Aggregate-rounded gross (shared helper) — sub-tick price × N shares
        // rounds once, or per-unit rounding creates/destroys cash.
        const grossMinor = grossMinorOf(entry.fill.quantity, entry.fill.price);
        const instrumentKey = String(order.payload.instrument);
        const position = positions.get(instrumentKey) ?? { quantity: 0, costBasis: { minorUnits: 0, currency } };
        if (order.payload.side === "buy") {
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) - grossMinor);
          positions.set(instrumentKey, {
            quantity: position.quantity + entry.fill.quantity,
            costBasis: { minorUnits: position.costBasis.minorUnits + grossMinor, currency: position.costBasis.currency },
          });
        } else {
          // Sale credits proceeds minus the stored transaction tax (S3). The tax
          // is a real outflow (to the state), so cash is NOT conserved across a
          // taxed sale — the money-conservation property accounts for it as a
          // separate leg. Absent costs ⇒ zero (untaxed / buy-side / exempt).
          const taxMinor = entry.fill.costs?.sellTransactionTaxMinor ?? 0;
          // NET first, on purpose. `(balance + gross) - tax` associates left to
          // right and can round through an unrepresentable intermediate even when
          // the true result is representable — the drift adversarial review
          // reproduced (2026-07-27: gross 2, tax 2, balance 2^53−1 lost 1 unit).
          // `gross - tax` is bounded by gross (the fill validator enforces
          // 0 ≤ tax ≤ gross), so it is always representable, and one addition of
          // two safe integers is exact whenever its result is in range — which is
          // exactly what the validator checks. Inside the safe domain both
          // associations agree, so no stored ledger is reinterpreted.
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + (grossMinor - taxMinor));
          // Average-cost basis relief (simulation-v1), rounded to the minor unit
          // in BigInt: basis·quantity can exceed 2^53 at large (but ledger-
          // representable) scale, where a float product/round drifts and a full
          // liquidation would leave a residual ±1 basis instead of exactly 0
          // (adversarial re-gate 2026-07-25). Round-half-up on the non-negative
          // terms — matches Math.round exactly (the same 2^53 discipline the S3
          // tax product uses). A full liquidation relieves basis·Q/Q = the whole
          // remaining basis exactly, so cost basis returns to precisely 0.
          const reliefMinor = position.quantity > 0
            ? Number((2n * BigInt(position.costBasis.minorUnits) * BigInt(entry.fill.quantity) + BigInt(position.quantity)) / (2n * BigInt(position.quantity)))
            : 0;
          // S4b: realized P&L of this sell — net proceeds minus the relief, at
          // the one site that knows both. Derived, so no schema/migration.
          realizedSales.push({ minorUnits: grossMinor - taxMinor - reliefMinor, currency });
          positions.set(instrumentKey, {
            quantity: position.quantity - entry.fill.quantity,
            costBasis: { minorUnits: position.costBasis.minorUnits - reliefMinor, currency: position.costBasis.currency },
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
          // One definition, two callers — the boundary judged this exact shape.
          const adjusted = applySplitToOrder(order, numerator, denominator);
          orders.set(key, {
            ...order,
            payload: {
              ...order.payload,
              quantity: adjusted.quantity,
              ...(adjusted.limitPrice !== undefined ? { limitPrice: adjusted.limitPrice } : {}),
            },
            filledQuantity: adjusted.filledQuantity,
            reservation: adjusted.reservation,
          });
        }
        break;
      }
      case "dividend_applied": {
        const position = positions.get(String(entry.instrument));
        if (position !== undefined && position.quantity > 0) {
          const currency = entry.perShare.currency;
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + grossMinorOf(position.quantity, entry.perShare));
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
      cashReserved.set(currency, (cashReserved.get(currency) ?? 0) + grossMinorOf(remaining, order.reservation.unitPrice));
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
  return { cash, positions: positionState, orders, realizedSales };
}
