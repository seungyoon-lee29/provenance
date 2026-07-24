import { brandReference } from "../../../shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";
import type { ViewerContext, WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";

import { FencedKeyedStore } from "../../../platform/persistence/fenced-store";
import type { Erasable } from "../../../platform/persistence/fenced-store";
import type {
  PaperCashRow,
  PaperCommandOutcome,
  PaperMoney,
  PaperObservationPort,
  PaperOrderIntentReference,
  PaperOrderIntentView,
  PaperOrderPayload,
  PaperOrderView,
  PaperPositionRow,
  PaperPrepareOutcome,
  PaperPrepareRequest,
  PaperTradingCommand,
} from "./contracts";
import { fromMinorUnits, minorUnitsOf } from "./contracts";
import { PaperJournal } from "./journal";
import type { CommandDecision, PaperAccountState, PaperJournalStore } from "./journal";

/**
 * F8 `PaperTrading.open/prepare/change` (spec §9/§6, SEC-01/06; ADR A04).
 *
 * The workspace comes ONLY from the Viewer Context. A PaperOrderIntent is an
 * opaque one-time server record: prepare binds it to the workspace, the
 * current auth epoch, the account kind/id/revision, the paper environment,
 * the canonical payload hash, the simulation policy and an expiry — submit
 * never trusts a wire payload, it re-resolves the intent and the account from
 * the workspace-scoped stores and re-checks every binding immediately before
 * commit. A forged or Actual account id simply does not resolve in the Paper
 * store and is refused with zero side effects; the branded types already make
 * it uncastable in checked code (ADR A04).
 */

type IntentRecord = Readonly<{
  view: PaperOrderIntentView;
  workspace: string;
  authorizationEpoch: string;
  payload: PaperOrderPayload;
  consumed: boolean;
}>;

export type PaperTradingPolicy = Readonly<{
  policyVersion: string;
  seedCash: readonly PaperMoney[];
  intentTtlMs: number;
  maxSlippageBps: number;
}>;

export type PaperTradingDependencies = Readonly<{
  now: () => string;
  identity: Readonly<{ currentAuthorizationEpoch(viewer: ViewerContext): string }>;
  observations: PaperObservationPort;
  policy: PaperTradingPolicy;
  updateId: () => string;
  /** T2-b: durable journal store (pg in production wiring); omitted = in-memory (tests, backtest). */
  journalStore?: PaperJournalStore;
}>;

export type PaperSectionKey = "orders" | "blotter";

export type PaperInitialShell =
  | Readonly<{ status: "denied" }>
  | Readonly<{
      status: "ready";
      requestRevision: string;
      account: InternalPaperAccountReference;
      cash: readonly PaperCashRow[];
      positions: readonly PaperPositionRow[];
      orders: readonly PaperOrderView[];
    }>;

export type PaperSectionUpdate = Readonly<{
  updateId: string;
  sectionKey: PaperSectionKey;
  sequence: number;
  requestRevision: string;
  authorizationEpoch: string;
  scope: string;
  accountRevisions: Readonly<Record<string, number>>;
  evidenceWatermark: string;
  policyVersion: string;
  resumeCursor: string;
  orders: readonly PaperOrderView[];
}>;

export type PaperPortfolioLoad = Readonly<{
  initial: Promise<PaperInitialShell>;
  refresh(section: PaperSectionKey): Promise<PaperSectionUpdate | undefined>;
}>;

export type PaperPortfolioRequest = Readonly<{
  requestRevision: string;
  resume?: Partial<Record<PaperSectionKey, string>>;
}>;

/** Tick sizes for the initial product scope (§9: US/KR cash equities). */
function tickOf(currency: string): number {
  return currency === "KRW" ? 1 : 0.01;
}

function roundUpToTick(amount: number, currency: string): number {
  const tick = tickOf(currency);
  return Math.ceil(amount / tick - 1e-9) * tick;
}

export class PaperTradingService {
  readonly journal: PaperJournal;
  readonly #intents = new FencedKeyedStore<IntentRecord>();
  #intentCounter = 0;
  /**
   * Journal hydration. Every public entry point awaits it BEFORE any
   * synchronous journal read (ownerOf/currentRevision/state), or a service
   * constructed over a durable store would judge ownership against an empty
   * cache and refuse its own persisted account (codex T2-b finding).
   */
  readonly #ready: Promise<unknown>;

  constructor(private readonly deps: PaperTradingDependencies) {
    this.journal = new PaperJournal(deps.now, undefined, deps.journalStore);
    this.#ready = this.journal.init();
  }

  async prepare(request: PaperPrepareRequest, viewer: ViewerContext): Promise<PaperPrepareOutcome> {
    await this.#ready;
    if (!this.#authorized(viewer)) return { status: "denied" };
    const workspace = String(viewer.workspaceReference);
    if (!validPayload(request.payload)) return { status: "refused", reason: "invalid_payload" };

    let account = request.account;
    if (account === undefined) {
      account = this.#defaultAccount(workspace);
      await this.journal.provision(workspace, account, this.deps.policy.seedCash);
    }
    const owner = this.journal.ownerOf(account);
    if (owner === undefined) return { status: "refused", reason: "unknown_account" };
    if (owner !== workspace) return { status: "denied" };

    const issuedAt = this.deps.now();
    const expiresAt = new Date(Date.parse(issuedAt) + this.deps.policy.intentTtlMs).toISOString();
    this.#intentCounter += 1;
    const reference = brandReference<string, "PaperOrderIntentReference">(
      `paper-intent:${workspace}:${this.#intentCounter}`,
    );
    const view: PaperOrderIntentView = {
      reference,
      account,
      accountKind: "internal",
      environment: "paper",
      accountRevision: this.journal.currentRevision(workspace, account),
      policyVersion: this.deps.policy.policyVersion,
      issuedAt,
      expiresAt,
    };
    const record: IntentRecord = {
      view,
      workspace,
      authorizationEpoch: String(viewer.accountAuthorizationEpoch),
      payload: request.payload,
      consumed: false,
    };
    const written = this.#intents.write(workspace, String(reference), record, 1);
    if (!written) return { status: "denied" };
    return { status: "issued", intent: view };
  }

  async change(command: PaperTradingCommand, control: Readonly<{ idempotencyKey: string; expectedRevision: string }>, viewer: ViewerContext): Promise<PaperCommandOutcome> {
    await this.#ready;
    if (!this.#authorized(viewer)) return { status: "denied" };
    const workspace = String(viewer.workspaceReference);
    // Account ownership is fixed at genesis in the Paper store. An unknown id
    // — including any forged Actual account id, which can never be provisioned
    // here — resolves to nothing and is refused before anything is written.
    const owner = this.journal.ownerOf(command.account);
    if (owner === undefined) return { status: "refused", reason: "unknown_account" };
    if (owner !== workspace) return { status: "denied" };

    const canonicalPayload = JSON.stringify(command);
    const outcome = await this.journal.appendCommand(
      workspace,
      command.account,
      command.kind,
      control,
      canonicalPayload,
      (context) =>
        command.kind === "submit"
          ? this.#decideSubmit(workspace, command.intent, command.account, viewer, context)
          : this.#decideCancel(command.order, context.state),
    );
    if (outcome.status === "applied" && command.kind === "submit") {
      this.#consumeIntent(workspace, command.intent);
    }
    return outcome;
  }

  open(request: PaperPortfolioRequest, viewer: ViewerContext): PaperPortfolioLoad {
    if (!this.#authorized(viewer)) {
      return { initial: Promise.resolve({ status: "denied" }), refresh: () => Promise.resolve(undefined) };
    }
    const workspace = String(viewer.workspaceReference);
    const account = this.#defaultAccount(workspace);
    const sequences = new Map<PaperSectionKey, number>();
    for (const [section, cursor] of Object.entries(request.resume ?? {})) {
      const resumed = Number.parseInt(cursor.split(":")[1] ?? "", 10);
      if (Number.isInteger(resumed) && resumed >= 0) sequences.set(section as PaperSectionKey, resumed);
    }

    // ONE hydration+provision promise shared by initial and refresh: a refresh
    // racing ahead of initial must not observe the pre-genesis empty state
    // (codex T2-b finding).
    const provisioned = (async () => {
      await this.#ready;
      await this.journal.provision(workspace, account, this.deps.policy.seedCash);
    })();

    return {
      initial: provisioned.then((): PaperInitialShell => ({
        status: "ready",
        requestRevision: request.requestRevision,
        account,
        ...presentState(this.journal.state(workspace, account), account),
      })),
      refresh: (section) => provisioned.then(() => this.#refresh(section, request, viewer, workspace, account, sequences)),
    };
  }

  #refresh(
    section: PaperSectionKey,
    request: PaperPortfolioRequest,
    viewer: ViewerContext,
    workspace: string,
    account: InternalPaperAccountReference,
    sequences: Map<PaperSectionKey, number>,
  ): PaperSectionUpdate | undefined {
    // SEC-01/06: re-check immediately before emit.
    if (!this.#authorized(viewer)) return undefined;
    const sequence = (sequences.get(section) ?? 0) + 1;
    sequences.set(section, sequence);
    const presented = presentState(this.journal.state(workspace, account), account);
    return {
      updateId: this.deps.updateId(),
      sectionKey: section,
      sequence,
      requestRevision: request.requestRevision,
      authorizationEpoch: viewer.kind === "workspace" ? String(viewer.accountAuthorizationEpoch) : "",
      scope: workspace,
      accountRevisions: { [String(account)]: this.journal.currentRevision(workspace, account) },
      evidenceWatermark: this.deps.now(),
      policyVersion: this.deps.policy.policyVersion,
      resumeCursor: `${section}:${sequence}`,
      orders: presented.orders,
    };
  }

  #decideSubmit(
    workspace: string,
    intentReference: PaperOrderIntentReference,
    account: InternalPaperAccountReference,
    viewer: WorkspaceViewerContext,
    context: Readonly<{ state: PaperAccountState; revision: number }>,
  ): CommandDecision {
    const record = this.#intents.get(workspace, String(intentReference));
    if (record === undefined) return { refuse: "unknown_intent" };
    // Re-check every binding of the one-time record (§9): account, kind,
    // environment, auth epoch, expiry, one-time state, account revision.
    if (String(record.view.account) !== String(account)) return { refuse: "unknown_intent" };
    if (record.view.accountKind !== "internal" || record.view.environment !== "paper") return { refuse: "unknown_intent" };
    if (record.authorizationEpoch !== String(viewer.accountAuthorizationEpoch)) return { deny: true };
    if (record.consumed) return { refuse: "intent_consumed" };
    if (Date.parse(this.deps.now()) >= Date.parse(record.view.expiresAt)) return { refuse: "intent_expired" };
    if (record.view.accountRevision !== context.revision) return { reject: true };

    const payload = record.payload;
    const acceptedAt = this.deps.now();
    const order = brandReference<string, "PaperOrderReference">(
      `paper-order:${String(account)}:${context.revision + 1}`,
    );

    if (payload.side === "buy") {
      const unitPrice = this.#reservationUnitPrice(payload);
      if (unitPrice === undefined) return { refuse: "no_valid_observation" };
      const requiredMinor = minorUnitsOf(payload.quantity * unitPrice.amount, unitPrice.currency);
      const cash = context.state.cash.get(unitPrice.currency);
      const availableMinor = (cash?.balance ?? 0) - (cash?.reserved ?? 0);
      // CAS: the overspend guard runs against the folded state inside the same
      // synchronous append — a concurrent submit sees the reservation or loses.
      // All minor units (Stage 2-c) — exact, no epsilon slack.
      if (availableMinor < requiredMinor) return { refuse: "insufficient_cash" };
      return { entry: { kind: "order_submitted", order, payload, acceptedAt, reservation: { kind: "cash", unitPrice } }, order };
    }

    const position = context.state.positions.get(String(payload.instrument));
    const sellable = (position?.quantity ?? 0) - (position?.reserved ?? 0);
    if (sellable < payload.quantity) return { refuse: "insufficient_position" };
    return { entry: { kind: "order_submitted", order, payload, acceptedAt, reservation: { kind: "quantity" } }, order };
  }

  #decideCancel(order: PaperOrderReference, state: PaperAccountState): CommandDecision {
    const current = state.orders.get(String(order));
    if (current === undefined) return { refuse: "unknown_order" };
    // A confirmed cancellation is terminal for the axis: a second cancel is a
    // side-effect-free refusal, not another journal row (blind-gate finding).
    if (current.cancellation === "confirmed") return { refuse: "already_cancelled" };
    const cancellable = current.execution === "open" || current.execution === "partially_filled";
    // A cancel on a filled/expired order is a recorded rejection: the
    // reservation (already released by the terminal state) is untouched.
    return {
      entry: { kind: "cancellation_resolved", order, resolution: cancellable ? "confirmed" : "rejected" },
      order,
    };
  }

  /** Limit orders bound reservation by the limit; market buys by the freshest
   * valid observation plus the maximum slippage — no valid observation means
   * the overspend cannot be bounded, so the submit fails closed. */
  #reservationUnitPrice(payload: PaperOrderPayload): PaperMoney | undefined {
    if (payload.orderType === "limit") return payload.limitPrice;
    const observation = this.deps.observations.currentObservation(payload.instrument);
    if (observation === undefined) return undefined;
    if (observation.freshness !== "realtime" && observation.freshness !== "delayed") return undefined;
    const bounded = observation.price.amount * (1 + this.deps.policy.maxSlippageBps / 10_000);
    return { amount: roundUpToTick(bounded, observation.price.currency), currency: observation.price.currency };
  }

  /** SEC-09 wiring: the module's non-journal fenced stores, for the erasure participant. */
  erasableStores(): readonly Readonly<{ label: string; store: Erasable }>[] {
    return [{ label: "paper-intents", store: this.#intents }];
  }

  #consumeIntent(workspace: string, reference: PaperOrderIntentReference): void {
    const record = this.#intents.get(workspace, String(reference));
    if (record !== undefined) this.#intents.write(workspace, String(reference), { ...record, consumed: true }, 1);
  }

  #defaultAccount(workspace: string): InternalPaperAccountReference {
    return brandReference<string, "InternalPaperAccountReference">(`paper-account:internal:${workspace}`);
  }

  #authorized(viewer: ViewerContext): viewer is WorkspaceViewerContext {
    if (viewer.kind !== "workspace") return false;
    return this.deps.identity.currentAuthorizationEpoch(viewer) === String(viewer.accountAuthorizationEpoch);
  }
}

function validPayload(payload: PaperOrderPayload): boolean {
  if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) return false;
  if (payload.session !== "regular") return false;
  if (payload.orderType === "limit") {
    if (payload.limitPrice === undefined) return false;
    if (!Number.isFinite(payload.limitPrice.amount) || payload.limitPrice.amount <= 0) return false;
    // Limits live on the tick grid, so the simulator's limit guard is an exact
    // integer comparison (USD $0.01 / KRW 1).
    const ticks = payload.limitPrice.amount * (payload.limitPrice.currency === "KRW" ? 1 : 100);
    if (Math.abs(ticks - Math.round(ticks)) > 1e-6) return false;
  }
  return true;
}

function presentState(state: PaperAccountState, account: InternalPaperAccountReference): Readonly<{
  cash: readonly PaperCashRow[];
  positions: readonly PaperPositionRow[];
  orders: readonly PaperOrderView[];
}> {
  // The fold carries exact integer minor units; presentation is the one boundary
  // back to display major units (Stage 2-c).
  const cash: PaperCashRow[] = [];
  for (const [currency, row] of state.cash) {
    cash.push({
      currency,
      balance: fromMinorUnits(row.balance, currency).amount,
      reserved: fromMinorUnits(row.reserved, currency).amount,
      available: fromMinorUnits(row.balance - row.reserved, currency).amount,
    });
  }
  const positions: PaperPositionRow[] = [];
  for (const [instrument, row] of state.positions) {
    if (row.quantity === 0 && row.reserved === 0) continue;
    positions.push({
      instrument: brandReference<string, "PaperInstrumentReference">(instrument),
      quantity: row.quantity,
      reserved: row.reserved,
      costBasis: fromMinorUnits(row.costBasis.minorUnits, row.costBasis.currency),
    });
  }
  const orders: PaperOrderView[] = [];
  for (const order of state.orders.values()) {
    orders.push({
      order: order.order,
      account,
      payload: order.payload,
      submission: order.submission,
      execution: order.execution,
      cancellation: order.cancellation,
      acceptedAt: order.acceptedAt,
      filledQuantity: order.filledQuantity,
      fills: order.fills,
    });
  }
  orders.sort((left, right) => (left.acceptedAt ?? "").localeCompare(right.acceptedAt ?? "") || String(left.order).localeCompare(String(right.order)));
  return { cash, positions, orders };
}
