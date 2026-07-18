import { brandReference } from "../../../shared/contracts/brands";
import type { BrokerPaperAccountReference, ProviderConnectionReference } from "../../../shared/contracts/brands";
import type { MutationControl } from "../../../shared/contracts/mutation-control";
import type { ViewerContext, WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { PaperMoney, PaperOrderPayload } from "../internal/contracts";
import type { BrokerPaperBook } from "./book";
import { BROKER_LIVE_EPOCH } from "./contracts";
import type { BrokerOrderView, BrokerClientOrderReference, BrokerPaperOrderIntentReference, BrokerSubmitRefusalReason } from "./contracts";
import type { BrokerOutbox, BrokerPendingSubmissions } from "./outbox";

/**
 * F9 Broker Paper commands (spec §9, SEC-01/06/10; ADR A03/A04).
 *
 * `prepare` mints an opaque one-time BrokerPaperOrderIntent AND the stable
 * client order identity — the identity the broker sees is fixed before any
 * dispatch and reused verbatim by every retry/lookup. `submit` re-checks every
 * binding (workspace, auth epoch, account, account revision, connection
 * generation, expiry) from the workspace-scoped store, then commits the local
 * order, its derived reservation, the outbox row and the
 * PendingBrokerSubmission in ONE synchronous account transaction — always
 * BEFORE any route call (durable-before-send). Live Trading has no
 * representation on this surface at all.
 */




type IntentRecord = Readonly<{
  view: BrokerOrderIntentView;
  workspace: string;
  authorizationEpoch: string;
  payload: PaperOrderPayload;
  consumed: boolean;
}>;

export type BrokerOrderIntentView = Readonly<{
  reference: BrokerPaperOrderIntentReference;
  clientOrder: BrokerClientOrderReference;
  account: BrokerPaperAccountReference;
  accountKind: "broker";
  environment: "paper";
  accountRevision: number;
  connection: ProviderConnectionReference;
  connectionGeneration: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type BrokerPrepareRequest = Readonly<{
  account: BrokerPaperAccountReference;
  connection: ProviderConnectionReference;
  payload: PaperOrderPayload;
}>;

export type BrokerPrepareOutcome =
  | Readonly<{ status: "issued"; intent: BrokerOrderIntentView }>
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "refused"; reason: "invalid_payload" | "unsupported_order_type" | "connection_unavailable" }>;

export type BrokerCommandRefusalReason =
  | BrokerSubmitRefusalReason
  | "unknown_intent"
  | "intent_consumed"
  | "intent_expired"
  | "stale_intent_binding"
  | "connection_revoked"
  | "unknown_order"
  | "cancel_pending"
  | "cancellation_terminal";

export type BrokerCommandOutcome =
  | Readonly<{ status: "applied"; revision: number; order: BrokerOrderView }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "rejected"; currentRevision: number }>
  | Readonly<{ status: "refused"; reason: BrokerCommandRefusalReason }>
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "suppressed" }>;

/** Read-only snapshot of the connection's current credential generation (SEC-10 generation-first). */
export type BrokerConnectionSnapshotPort = Readonly<{
  currentGeneration(connection: ProviderConnectionReference, viewer: WorkspaceViewerContext): string | undefined;
}>;

export type BrokerPaperTradingDeps = Readonly<{
  now: () => string;
  identity: Readonly<{ currentAuthorizationEpoch(viewer: ViewerContext): string }>;
  policy: Readonly<{ intentTtlMs: number; seedCash: readonly PaperMoney[] }>;
  book: BrokerPaperBook;
  outbox: BrokerOutbox;
  pending: BrokerPendingSubmissions;
  connections: BrokerConnectionSnapshotPort;
  newIntentReference: (seed: string) => string;
  newClientOrder: (seed: string) => string;
}>;

function canonical(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export class BrokerPaperTradingService {
  readonly #intents = new FencedKeyedStore<IntentRecord>();

  constructor(private readonly deps: BrokerPaperTradingDeps) {}

  #workspaceViewer(viewer: ViewerContext): WorkspaceViewerContext | undefined {
    if (viewer.kind !== "workspace") return undefined;
    // SEC-01: the Viewer Context is only authority while identity still agrees.
    if (this.deps.identity.currentAuthorizationEpoch(viewer) !== String(viewer.accountAuthorizationEpoch)) return undefined;
    return viewer;
  }

  async prepare(request: BrokerPrepareRequest, viewer: ViewerContext): Promise<BrokerPrepareOutcome> {
    const workspaceViewer = this.#workspaceViewer(viewer);
    if (workspaceViewer === undefined) return { status: "denied" };
    const workspace = String(workspaceViewer.workspaceReference);

    const payload = request.payload;
    // ponytail: limit-only v1 — mirrors the book's fail-closed refusal.
    if (payload.orderType !== "limit" || payload.limitPrice === undefined) return { status: "refused", reason: "unsupported_order_type" };
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0 || !Number.isFinite(payload.limitPrice.amount) || payload.limitPrice.amount <= 0) {
      return { status: "refused", reason: "invalid_payload" };
    }

    const generation = this.deps.connections.currentGeneration(request.connection, workspaceViewer);
    if (generation === undefined) return { status: "refused", reason: "connection_unavailable" };

    // First touch provisions the broker paper account under this workspace —
    // a forged reference can never be provisioned into another workspace's book.
    this.deps.book.provision(workspace, request.account, this.deps.policy.seedCash, BROKER_LIVE_EPOCH);

    const issuedAt = this.deps.now();
    const reference = brandReference<string, "BrokerPaperOrderIntentReference">(
      this.deps.newIntentReference(`${workspace}|${String(request.account)}`),
    ) as BrokerPaperOrderIntentReference;
    const clientOrder = brandReference<string, "BrokerClientOrderReference">(
      this.deps.newClientOrder(String(reference)),
    ) as BrokerClientOrderReference;
    const view: BrokerOrderIntentView = {
      reference,
      clientOrder,
      account: request.account,
      accountKind: "broker",
      environment: "paper",
      accountRevision: this.deps.book.currentRevision(workspace, request.account),
      connection: request.connection,
      connectionGeneration: generation,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.deps.policy.intentTtlMs).toISOString(),
    };
    const record: IntentRecord = {
      view,
      workspace,
      authorizationEpoch: String(workspaceViewer.accountAuthorizationEpoch),
      payload,
      consumed: false,
    };
    const written = this.#intents.write(workspace, String(reference), record, BROKER_LIVE_EPOCH);
    if (!written) return { status: "denied" };
    return { status: "issued", intent: view };
  }

  async submit(intentReference: BrokerPaperOrderIntentReference, control: MutationControl, viewer: ViewerContext): Promise<BrokerCommandOutcome> {
    const workspaceViewer = this.#workspaceViewer(viewer);
    if (workspaceViewer === undefined) return { status: "denied" };
    const workspace = String(workspaceViewer.workspaceReference);

    const record = this.#intents.get(workspace, String(intentReference));
    if (record === undefined) return { status: "refused", reason: "unknown_intent" };
    if (record.authorizationEpoch !== String(workspaceViewer.accountAuthorizationEpoch)) return { status: "denied" };
    const { account, connection, clientOrder } = record.view;

    return this.deps.book.command<BrokerCommandOutcome>(
      workspace,
      account,
      "submit",
      { idempotencyKey: control.idempotencyKey, expectedRevision: String(control.expectedRevision) },
      canonical(["submit", String(intentReference)]),
      (nextRevision) => {
        // Binding re-checks run AFTER the receipt trio so an identical replay
        // returns the original receipt instead of tripping over its own
        // consumption (§8); refusals below stay unreceipted and side-effect free.
        if (record.consumed) return { refuse: { status: "refused", reason: "intent_consumed" } };
        if (Date.parse(this.deps.now()) > Date.parse(record.view.expiresAt)) return { refuse: { status: "refused", reason: "intent_expired" } };
        if (!this.deps.book.hasAccount(workspace, account)) return { refuse: { status: "refused", reason: "unknown_account" } };
        if (record.view.accountRevision !== this.deps.book.currentRevision(workspace, account)) {
          return { refuse: { status: "refused", reason: "stale_intent_binding" } };
        }
        // SEC-10 generation-first: a revoke/rotation after prepare kills the
        // intent BEFORE any route or outbox effect exists.
        if (this.deps.connections.currentGeneration(connection, workspaceViewer) !== record.view.connectionGeneration) {
          return { refuse: { status: "refused", reason: "connection_revoked" } };
        }
        const submitted = this.deps.book.submitLocal(workspace, account, clientOrder, record.payload, BROKER_LIVE_EPOCH);
        if (submitted.status === "refused") return { refuse: { status: "refused", reason: submitted.reason } };
        if (submitted.status === "suppressed") return { refuse: { status: "suppressed" } };
        // One transaction: intent consumption, order + derived reservation,
        // outbox row and reconciliation worklist — all before any route call.
        this.#intents.write(workspace, String(intentReference), { ...record, consumed: true }, BROKER_LIVE_EPOCH);
        this.deps.outbox.commit(
          workspace,
          { kind: "submit", account, connection, clientOrder, intent: intentReference, state: "pending_dispatch", attempts: 0 },
          BROKER_LIVE_EPOCH,
        );
        this.deps.pending.commit(
          workspace,
          { account, connection, clientOrder, intent: intentReference, since: this.deps.now() },
          BROKER_LIVE_EPOCH,
        );
        const order = this.deps.book.state(workspace, account).orders.find((row) => String(row.order) === String(clientOrder))!;
        return { commit: { status: "applied", revision: nextRevision, order } };
      },
    );
  }

  async cancel(
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
    control: MutationControl,
    viewer: ViewerContext,
  ): Promise<BrokerCommandOutcome> {
    const workspaceViewer = this.#workspaceViewer(viewer);
    if (workspaceViewer === undefined) return { status: "denied" };
    const workspace = String(workspaceViewer.workspaceReference);
    if (!this.deps.book.hasAccount(workspace, account)) return { status: "refused", reason: "unknown_account" };

    return this.deps.book.command<BrokerCommandOutcome>(
      workspace,
      account,
      "cancel",
      { idempotencyKey: control.idempotencyKey, expectedRevision: String(control.expectedRevision) },
      canonical(["cancel", String(clientOrder)]),
      (nextRevision) => {
        const refusal = this.deps.book.requestCancelLocal(workspace, account, clientOrder, BROKER_LIVE_EPOCH);
        if (refusal !== undefined) return { refuse: { status: "refused", reason: refusal } };
        const row = this.deps.outbox.get(workspace, account, clientOrder, "submit");
        const connection = row?.connection ?? this.#intents.list(workspace).find((intent) => String(intent.view.clientOrder) === String(clientOrder))?.view.connection;
        this.deps.outbox.commit(
          workspace,
          { kind: "cancel", account, connection: connection!, clientOrder, state: "pending_dispatch", attempts: 0 },
          BROKER_LIVE_EPOCH,
        );
        const order = this.deps.book.state(workspace, account).orders.find((entry) => String(entry.order) === String(clientOrder))!;
        return { commit: { status: "applied", revision: nextRevision, order } };
      },
    );
  }
}
