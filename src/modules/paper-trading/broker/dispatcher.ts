import type { BrokerPaperAccountReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";
import { PAPER_ORDER_ROUTE_IDS } from "../../provider-connections/paper-transport/routes";
import type { PaperOrderTransport } from "../../provider-connections/paper-transport/paper-order-transport";
import type { BrokerPaperBook } from "./book";
import { BROKER_LIVE_EPOCH } from "./contracts";
import type { BrokerClientOrderReference, BrokerExternalOrderEvent } from "./contracts";
import type { BrokerOutbox, BrokerPendingSubmissions } from "./outbox";

/**
 * F9 dispatch + reconciliation (spec §9, AT-08).
 *
 * Sequencing is the whole design: the outbox row is `pending_dispatch` while a
 * send is provably impossible, and is durably marked `dispatched` BEFORE the
 * route call — so after any crash, `pending_dispatch` means "safe to send for
 * the first time" and `dispatched` means Submission Uncertainty: lookup first,
 * never blind-retry. The broker sees one stable client order identity either
 * way, so external accepted orders can never exceed one.
 *
 * The four named fault points (§9/AT-08) are injectable crash seams; a restart
 * converges through `reconcile`.
 */

export type BrokerFaultPoint =
  | "after-intent-commit"
  | "after-broker-accept-before-local-ack"
  | "after-local-commit-before-queue-ack"
  | "after-authorize-before-route-dispatch";

export class FaultInjected extends Error {
  constructor(readonly point: BrokerFaultPoint) {
    super(`injected crash at ${point}`);
  }
}



export type DispatchOutcome = Readonly<{
  status: "acknowledged" | "rejected_by_broker" | "cancel_resolved" | "submission_unknown" | "closed_unauthorized" | "not_pending";
  routeCalls: number;
}>;

export type ReconcileOutcome = Readonly<{
  clientOrder: BrokerClientOrderReference;
  resolution: "dispatched_fresh" | "resolved_by_lookup" | "retried_after_lookup" | "kept_unknown" | "queue_acknowledged" | "unauthorized";
}>;

type OrderFact = Readonly<{ state: "accepted" | "rejected" | "cancel_confirmed" | "cancel_rejected"; externalOrder: string; externalIdentity: string; revision: number }>;

export type BrokerDispatcherDeps = Readonly<{
  book: BrokerPaperBook;
  outbox: BrokerOutbox;
  pending: BrokerPendingSubmissions;
  transport: PaperOrderTransport;
}>;

export class BrokerDispatcher {
  constructor(private readonly deps: BrokerDispatcherDeps) {}

  #fault(faultAt: BrokerFaultPoint | undefined, point: BrokerFaultPoint): void {
    if (faultAt === point) throw new FaultInjected(point);
  }

  #eventOf(row: Readonly<{ connection: BrokerExternalOrderEvent["connection"]; clientOrder: BrokerClientOrderReference }>, fact: OrderFact): BrokerExternalOrderEvent {
    const body = fact.state === "accepted" ? { externalOrder: fact.externalOrder } : {};
    return { connection: row.connection, order: row.clientOrder, kind: fact.state, externalIdentity: fact.externalIdentity, revision: fact.revision, body };
  }

  async dispatchSubmit(
    workspace: string,
    viewer: WorkspaceViewerContext,
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
    opts: Readonly<{ faultAt?: BrokerFaultPoint }> = {},
  ): Promise<DispatchOutcome> {
    const row = this.deps.outbox.get(workspace, account, clientOrder, "submit");
    if (row === undefined || row.state !== "pending_dispatch") return { status: "not_pending", routeCalls: 0 };
    this.#fault(opts.faultAt, "after-intent-commit");

    let transport;
    try {
      transport = await this.deps.transport.authorize(row.connection, viewer);
    } catch {
      // Revoke committed before dispatch was ever possible: route call 0 and
      // the order resolves locally — the broker never saw it.
      this.deps.book.resolveLocalRejection(workspace, account, clientOrder, BROKER_LIVE_EPOCH);
      this.deps.outbox.transition(workspace, account, clientOrder, "submit", ["pending_dispatch"], "closed", BROKER_LIVE_EPOCH);
      this.deps.pending.resolve(workspace, clientOrder, BROKER_LIVE_EPOCH);
      return { status: "closed_unauthorized", routeCalls: 0 };
    }

    // Durable "a send may now happen" marker — MUST land before the route call.
    this.deps.outbox.transition(workspace, account, clientOrder, "submit", ["pending_dispatch"], "dispatched", BROKER_LIVE_EPOCH);
    this.#fault(opts.faultAt, "after-authorize-before-route-dispatch");

    const order = this.deps.book.state(workspace, account).orders.find((entry) => String(entry.order) === String(clientOrder));
    if (order === undefined) return { status: "not_pending", routeCalls: 0 };
    let result;
    try {
      result = await transport.execute(PAPER_ORDER_ROUTE_IDS.submit, {
        clientOrder: String(clientOrder),
        instrument: String(order.payload.instrument),
        side: order.payload.side,
        quantity: order.payload.quantity,
        limitPrice: order.payload.limitPrice,
        timeInForce: order.payload.timeInForce,
      });
    } catch {
      // Timeout/drop is Submission Uncertainty — never a definite failure.
      this.deps.book.markSubmissionUnknown(workspace, account, clientOrder, BROKER_LIVE_EPOCH);
      return { status: "submission_unknown", routeCalls: 1 };
    }
    this.#fault(opts.faultAt, "after-broker-accept-before-local-ack");

    let fact: OrderFact | undefined;
    try {
      await result.commit(async (value) => {
        fact = value as OrderFact;
        this.deps.book.ingest(workspace, account, this.#eventOf(row, fact), BROKER_LIVE_EPOCH);
        this.deps.outbox.transition(workspace, account, clientOrder, "submit", ["dispatched"], fact.state === "accepted" ? "acknowledged" : "closed", BROKER_LIVE_EPOCH);
      });
    } catch {
      // Late commit fenced by commitWhileCurrent (revoke raced the ack): the
      // local truth stays "uncertain" and only reconciliation may resolve it.
      this.deps.book.markSubmissionUnknown(workspace, account, clientOrder, BROKER_LIVE_EPOCH);
      return { status: "submission_unknown", routeCalls: 1 };
    }
    this.#fault(opts.faultAt, "after-local-commit-before-queue-ack");

    this.deps.pending.resolve(workspace, clientOrder, BROKER_LIVE_EPOCH);
    return { status: fact!.state === "accepted" ? "acknowledged" : "rejected_by_broker", routeCalls: 1 };
  }

  async dispatchCancel(
    workspace: string,
    viewer: WorkspaceViewerContext,
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
  ): Promise<DispatchOutcome> {
    const row = this.deps.outbox.get(workspace, account, clientOrder, "cancel");
    if (row === undefined || row.state !== "pending_dispatch") return { status: "not_pending", routeCalls: 0 };
    let transport;
    try {
      transport = await this.deps.transport.authorize(row.connection, viewer);
    } catch {
      this.deps.outbox.transition(workspace, account, clientOrder, "cancel", ["pending_dispatch"], "closed", BROKER_LIVE_EPOCH);
      return { status: "closed_unauthorized", routeCalls: 0 };
    }
    this.deps.outbox.transition(workspace, account, clientOrder, "cancel", ["pending_dispatch"], "dispatched", BROKER_LIVE_EPOCH);
    let result;
    try {
      result = await transport.execute(PAPER_ORDER_ROUTE_IDS.cancel, { clientOrder: String(clientOrder) });
    } catch {
      return { status: "submission_unknown", routeCalls: 1 };
    }
    try {
      await result.commit(async (value) => {
        const fact = value as OrderFact;
        this.deps.book.ingest(workspace, account, this.#eventOf(row, fact), BROKER_LIVE_EPOCH);
        this.deps.outbox.transition(workspace, account, clientOrder, "cancel", ["dispatched"], "acknowledged", BROKER_LIVE_EPOCH);
      });
    } catch {
      return { status: "submission_unknown", routeCalls: 1 };
    }
    return { status: "cancel_resolved", routeCalls: 1 };
  }

  /**
   * Restart convergence: every open PendingBrokerSubmission is driven to a
   * deterministic fact. `pending_dispatch` was provably never sent → first
   * send. `dispatched` is uncertainty → lookup; a not-found answer only
   * permits a retry when the provider guarantees a lookup/idempotency horizon,
   * otherwise the order stays `submission_unknown` with zero blind retries.
   */
  async reconcile(workspace: string, viewer: WorkspaceViewerContext): Promise<readonly ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (const entry of this.deps.pending.open(workspace)) {
      const { account, clientOrder } = entry;
      const row = this.deps.outbox.get(workspace, account, clientOrder, "submit");
      if (row === undefined) continue;

      if (row.state === "pending_dispatch") {
        await this.dispatchSubmit(workspace, viewer, account, clientOrder);
        outcomes.push({ clientOrder, resolution: "dispatched_fresh" });
        continue;
      }
      if (row.state === "acknowledged" || row.state === "closed") {
        // Crash landed between the local commit and the queue ack: the fact is
        // already durable, only the worklist entry needs acknowledging.
        this.deps.pending.resolve(workspace, clientOrder, BROKER_LIVE_EPOCH);
        outcomes.push({ clientOrder, resolution: "queue_acknowledged" });
        continue;
      }

      // dispatched → Submission Uncertainty.
      this.deps.book.markSubmissionUnknown(workspace, account, clientOrder, BROKER_LIVE_EPOCH);
      let transport;
      try {
        transport = await this.deps.transport.authorize(row.connection, viewer);
      } catch {
        outcomes.push({ clientOrder, resolution: "unauthorized" });
        continue;
      }
      let lookup: { found: false } | { found: true; fact: OrderFact };
      try {
        lookup = (await (await transport.execute(PAPER_ORDER_ROUTE_IDS.lookup, { clientOrder: String(clientOrder) })).commit(async (value) => value)) as typeof lookup;
      } catch {
        outcomes.push({ clientOrder, resolution: "kept_unknown" });
        continue;
      }
      if (lookup.found) {
        const fact = lookup.fact;
        this.deps.book.ingest(workspace, account, this.#eventOf(row, fact), BROKER_LIVE_EPOCH);
        this.deps.outbox.transition(workspace, account, clientOrder, "submit", ["dispatched"], fact.state === "accepted" ? "acknowledged" : "closed", BROKER_LIVE_EPOCH);
        this.deps.pending.resolve(workspace, clientOrder, BROKER_LIVE_EPOCH);
        outcomes.push({ clientOrder, resolution: "resolved_by_lookup" });
        continue;
      }
      if (!this.deps.transport.horizonGuaranteed) {
        // No lookup/idempotency horizon: blind retry 0, uncertainty holds.
        outcomes.push({ clientOrder, resolution: "kept_unknown" });
        continue;
      }
      // Horizon-guaranteed not-found: the submit provably never landed; one
      // lookup-verified resend of the SAME client order identity.
      this.deps.outbox.transition(workspace, account, clientOrder, "submit", ["dispatched"], "pending_dispatch", BROKER_LIVE_EPOCH);
      await this.dispatchSubmit(workspace, viewer, account, clientOrder);
      outcomes.push({ clientOrder, resolution: "retried_after_lookup" });
    }
    return outcomes;
  }
}
