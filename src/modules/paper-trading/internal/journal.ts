import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import { FencedKeyedStore } from "../../../platform/persistence/fenced-store";
import type { Executor } from "../../../platform/persistence/pg";
import { fromMinorUnits, minorUnitsOf, toMinorUnits } from "./contracts";
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
  | "fractional_result";

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
    case "account_opened":
      // Genesis happens exactly once per account.
      return state.cash.size > 0 || state.orders.size > 0 ? "already_opened" : undefined;
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
      const wholeShares = (quantity: number) => Number.isInteger((quantity * numerator) / denominator);
      const position = state.positions.get(String(body.instrument));
      if (position !== undefined && !wholeShares(position.quantity)) return "fractional_result";
      for (const order of state.orders.values()) {
        if (String(order.payload.instrument) !== String(body.instrument)) continue;
        if (order.execution !== "open" && order.execution !== "partially_filled") continue;
        // Mirror the fold's reserving() predicate: a confirmed-cancelled order
        // is not adjusted by the split, so it must not veto it either (codex
        // T2-b finding: a cancelled odd-lot order blocked a legitimate split).
        if (order.cancellation === "confirmed") continue;
        if (!wholeShares(order.payload.quantity) || !wholeShares(order.filledQuantity)) return "fractional_result";
        // A split that would drive a live limit price below one minor unit (a
        // $0.01 limit through a 3:1 split → $0.0033 → 0¢) is unrepresentable in the
        // cents ledger: it would zero the order's reservation, free cash that must
        // stay held, and leave an order no positive fill can ever satisfy. Refuse
        // it — fail closed, same as the fractional-share veto (codex Stage 2-c HIGH).
        if (order.payload.limitPrice !== undefined
            && Math.round((toMinorUnits(order.payload.limitPrice) * denominator) / numerator) < 1) {
          return "fractional_result";
        }
      }
      return undefined;
    }
    case "dividend_applied":
      return Number.isFinite(body.perShare.amount) && body.perShare.amount > 0 ? undefined : "invalid_adjustment";
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
      const reservingNow = order.cancellation !== "confirmed";
      if (order.payload.side === "buy") {
        const cash = state.cash.get(fill.price.currency);
        if (cash === undefined) return "insufficient_cash";
        // All minor units — cash conservation is exact, so no epsilon slack.
        const ownReservationMinor = reservingNow && order.reservation.kind === "cash"
          ? minorUnitsOf((order.payload.quantity - order.filledQuantity) * order.reservation.unitPrice.amount, order.reservation.unitPrice.currency)
          : 0;
        const availableMinor = cash.balance - cash.reserved + ownReservationMinor;
        if (minorUnitsOf(fill.quantity * fill.price.amount, fill.price.currency) > availableMinor) return "insufficient_cash";
        return undefined;
      }
      const position = state.positions.get(String(order.payload.instrument));
      if (position === undefined) return "insufficient_position";
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
    const committed = await this.#commit(() => this.#store.appendSystem({ workspace, entry, atEpoch, scopedKey, owner: options?.owner }));
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
  // Cash, cost basis and reservations fold in EXACT integer minor units — this
  // is the one place money conservation is decided, so it is never float (Stage
  // 2-c). Incoming display prices become minor units at `toMinorUnits`; nothing
  // here divides by the scale.
  const cashBalance = new Map<string, number>();
  const positions = new Map<string, { quantity: number; costBasis: PaperMinorMoney }>();
  const orders = new Map<string, PaperOrderState>();

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
            cancelledAt: entry.resolution === "confirmed" ? entry.recordedAt : order.cancelledAt,
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
        // Round the AGGREGATE, not per share: a sub-tick price (e.g. a $0.005
        // dividend or off-tick fill) times N shares must round once, or per-unit
        // rounding creates/destroys cash (codex Stage 2-c: 3¢ vs the correct 2¢).
        const grossMinor = minorUnitsOf(entry.fill.quantity * entry.fill.price.amount, currency);
        const instrumentKey = String(order.payload.instrument);
        const position = positions.get(instrumentKey) ?? { quantity: 0, costBasis: { minorUnits: 0, currency } };
        if (order.payload.side === "buy") {
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) - grossMinor);
          positions.set(instrumentKey, {
            quantity: position.quantity + entry.fill.quantity,
            costBasis: { minorUnits: position.costBasis.minorUnits + grossMinor, currency: position.costBasis.currency },
          });
        } else {
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + grossMinor);
          // Average-cost basis relief (simulation-v1), rounded to the minor unit.
          // The final share of a position relieves `minorUnits · 1 / 1` = the whole
          // remaining basis, so a full liquidation returns cost basis to exactly 0.
          const reliefMinor = position.quantity > 0
            ? Math.round((position.costBasis.minorUnits * entry.fill.quantity) / position.quantity)
            : 0;
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
          const payload = order.payload;
          const adjustedQuantity = (payload.quantity * numerator) / denominator;
          // The split inverts the price by its ratio, then quantizes to the minor
          // unit — a split-adjusted price is exact-representable, never a float like
          // $3.3333. Cash derived from it is re-read through toMinorUnits, so it
          // stays exact. (The ratio divide is inherent to a split; the money value
          // it produces is an integer minor amount.)
          const splitPrice = (price: PaperMoney): PaperMoney =>
            fromMinorUnits(Math.round((toMinorUnits(price) * denominator) / numerator), price.currency);
          const adjustedLimit = payload.limitPrice === undefined ? undefined : splitPrice(payload.limitPrice);
          const adjustedReservation: PaperReservationSpec = order.reservation.kind === "cash"
            ? { kind: "cash", unitPrice: splitPrice(order.reservation.unitPrice) }
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
          cashBalance.set(currency, (cashBalance.get(currency) ?? 0) + minorUnitsOf(position.quantity * entry.perShare.amount, currency));
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
      cashReserved.set(currency, (cashReserved.get(currency) ?? 0) + minorUnitsOf(remaining * order.reservation.unitPrice.amount, currency));
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
