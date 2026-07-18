import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { BrokerPaperAccountReference, ProviderConnectionReference, Revision } from "../src/shared/contracts/brands";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import {
  ProviderAuthorization,
  type AuthorizationCommitGuard,
  type CurrentAuthorizationState,
  type ProviderConnectionAuthorization,
  type TransportExecutor,
} from "../src/platform/provider-transport";
import { paperOrderRoutes, PAPER_ORDER_CAPABILITY, PAPER_ORDER_PROVIDER, PAPER_ORDER_PURPOSE, PAPER_ORDER_ROUTE_IDS } from "../src/modules/provider-connections/paper-transport/routes";
import { PaperOrderTransport } from "../src/modules/provider-connections/paper-transport/paper-order-transport";
import { BrokerPaperBook } from "../src/modules/paper-trading/broker/book";
import { BrokerOutbox, BrokerPendingSubmissions } from "../src/modules/paper-trading/broker/outbox";
import { BrokerPaperTradingService } from "../src/modules/paper-trading/broker/service";
import { BrokerDispatcher } from "../src/modules/paper-trading/broker/dispatcher";
import type { PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

const WORKSPACE = "workspace:a";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL");
const CONNECTION = brandReference<string, "ProviderConnectionReference">("conn-scripted-paper") as ProviderConnectionReference;

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

function account(): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">("broker-acct-1") as BrokerPaperAccountReference;
}

function limitBuy(quantity: number, limit: number): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "NASDAQ",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce: "DAY",
  };
}

function control(key: string, revision: number): MutationControl {
  return { idempotencyKey: key, expectedRevision: brandReference<string, "Revision">(String(revision)) as Revision };
}

type BrokerRecord = { externalOrder: string; state: "accepted" | "rejected" | "cancel_confirmed" | "cancel_rejected"; externalIdentity: string; revision: number };

/** Deterministic in-memory broker behind the pinned TransportExecutor seam (network-off lane, §12.2). */
class ScriptedBroker {
  orders = new Map<string, BrokerRecord>();
  submitCalls = 0;
  lookupCalls = 0;
  cancelCalls = 0;
  lastSubmitBody: unknown;
  mode: "accept" | "reject" | "timeout" | "accept-lost" = "accept";
  #seq = 0;

  executor: TransportExecutor = async (request) => {
    const body = JSON.parse(request.body ?? "{}") as { clientOrder: string };
    if (request.url.endsWith("/v1/paper/orders")) {
      this.submitCalls += 1;
      this.lastSubmitBody = JSON.parse(request.body!);
      if (this.mode === "timeout") throw new Error("socket timeout");
      const existing = this.orders.get(body.clientOrder);
      if (existing !== undefined) return { state: existing.state, externalOrder: existing.externalOrder, externalIdentity: existing.externalIdentity, revision: existing.revision };
      this.#seq += 1;
      const record: BrokerRecord = {
        externalOrder: `X-${this.#seq}`,
        state: this.mode === "reject" ? "rejected" : "accepted",
        externalIdentity: `E-${this.#seq}`,
        revision: 1,
      };
      this.orders.set(body.clientOrder, record);
      if (this.mode === "accept-lost") throw new Error("connection dropped after accept");
      return { state: record.state, externalOrder: record.externalOrder, externalIdentity: record.externalIdentity, revision: record.revision };
    }
    if (request.url.endsWith("/v1/paper/orders/lookup") || request.url.endsWith("/v1/paper/orders/status")) {
      this.lookupCalls += 1;
      const record = this.orders.get(body.clientOrder);
      if (record === undefined) return { found: false };
      return { found: true, fact: { state: record.state, externalOrder: record.externalOrder, externalIdentity: record.externalIdentity, revision: record.revision } };
    }
    this.cancelCalls += 1;
    const record = this.orders.get(body.clientOrder);
    if (record === undefined) throw new Error("unknown order");
    this.#seq += 1;
    const updated: BrokerRecord = { ...record, state: "cancel_confirmed", externalIdentity: `C-${this.#seq}`, revision: record.revision + 1 };
    this.orders.set(body.clientOrder, updated);
    return { state: updated.state, externalOrder: updated.externalOrder, externalIdentity: updated.externalIdentity, revision: updated.revision };
  };
}

function harness(options: Readonly<{ horizonGuaranteed?: boolean }> = {}) {
  const broker = new ScriptedBroker();
  const grant: ProviderConnectionAuthorization = {
    purpose: PAPER_ORDER_PURPOSE,
    connectionReference: CONNECTION,
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    provider: PAPER_ORDER_PROVIDER,
    environment: "paper",
    capability: PAPER_ORDER_CAPABILITY,
    credentialVersion: brandReference<string, "CredentialVersion">("v1"),
    credentialGeneration: brandReference<string, "CredentialGeneration">("gen-1"),
    lifecycleFence: brandReference<string, "ConnectionLifecycleFence">("fence-1"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    allowedRouteIds: Object.values(PAPER_ORDER_ROUTE_IDS),
  };
  const state: { current: CurrentAuthorizationState } = {
    current: {
      purpose: grant.purpose,
      connectionReference: grant.connectionReference,
      workspaceReference: grant.workspaceReference,
      provider: grant.provider,
      environment: grant.environment,
      capability: grant.capability,
      allowedRouteIds: grant.allowedRouteIds,
      connectionState: "verified",
      credentialVersion: grant.credentialVersion,
      credentialGeneration: grant.credentialGeneration,
      lifecycleFence: grant.lifecycleFence,
      sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
      accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
      membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    },
  };
  const commitGuard: AuthorizationCommitGuard = {
    async commitWhileCurrent(_authorization, _viewer, value, persist) {
      if (state.current.connectionState !== "verified") throw new Error("provider authorization is stale");
      return persist(value);
    },
  };
  const providerAuthorization = new ProviderAuthorization(
    paperOrderRoutes(),
    async () => grant,
    async () => state.current,
    async () => ({ authorization: "Bearer sentinel" }),
    commitGuard,
    async () => ["8.8.8.8"],
    broker.executor,
    () => new Date("2026-07-18T10:00:00.000Z"),
  );
  const transport = new PaperOrderTransport({ authorization: providerAuthorization, lookupHorizonGuaranteed: options.horizonGuaranteed ?? true });

  const book = new BrokerPaperBook();
  const outbox = new BrokerOutbox();
  const pending = new BrokerPendingSubmissions();
  let intentSeq = 0;
  let orderSeq = 0;
  const service = new BrokerPaperTradingService({
    now: () => "2026-07-18T10:00:00.000Z",
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    policy: { intentTtlMs: 60_000, seedCash: [{ amount: 100_000, currency: "USD" }] },
    book,
    outbox,
    pending,
    connections: { currentGeneration: () => (state.current.connectionState === "verified" ? String(state.current.credentialGeneration) : undefined) },
    newIntentReference: () => `bpi-${++intentSeq}`,
    newClientOrder: () => `bco-${++orderSeq}`,
  });
  const dispatcher = new BrokerDispatcher({ book, outbox, pending, transport });

  const revoke = () => {
    state.current = { ...state.current, connectionState: "revoked" };
  };
  return { broker, book, outbox, pending, service, dispatcher, revoke };
}

type Harness = ReturnType<typeof harness>;

async function submitted(h: Harness, payload = limitBuy(5, 110)) {
  const revision = h.book.currentRevision(WORKSPACE, account());
  const prepared = await h.service.prepare({ account: account(), connection: CONNECTION, payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare: ${prepared.status}`);
  const outcome = await h.service.submit(prepared.intent.reference, control(`k-${String(prepared.intent.reference)}`, revision), viewer());
  if (outcome.status !== "applied") throw new Error(`submit: ${outcome.status}`);
  return prepared.intent;
}

function usd(h: Harness) {
  return h.book.state(WORKSPACE, account()).cash.find((row) => row.currency === "USD")!;
}

function order(h: Harness) {
  return h.book.state(WORKSPACE, account()).orders[0]!;
}

describe("dispatch happy path (§9 durable-before-send)", () => {
  it("sends exactly the booked order, acknowledges locally and resolves the worklist", async () => {
    const h = harness();
    const intent = await submitted(h);
    const outcome = await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "acknowledged", routeCalls: 1 });
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.lastSubmitBody).toEqual({
      clientOrder: "bco-1",
      instrument: "instr:AAPL",
      side: "buy",
      quantity: 5,
      limitPrice: { amount: 110, currency: "USD" },
      timeInForce: "DAY",
    });
    expect(order(h).submission).toBe("acknowledged");
    expect(order(h).execution).toBe("open");
    expect(order(h).externalOrder).toBe("X-1");
    expect(h.outbox.get(WORKSPACE, account(), intent.clientOrder, "submit")!.state).toBe("acknowledged");
    expect(h.pending.open(WORKSPACE)).toHaveLength(0);
    expect(usd(h)).toEqual({ currency: "USD", balance: 100_000, reserved: 550 });
  });

  it("books a broker rejection as the rejected submission axis with the reservation released", async () => {
    const h = harness();
    h.broker.mode = "reject";
    const intent = await submitted(h);
    const outcome = await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "rejected_by_broker", routeCalls: 1 });
    expect(order(h).submission).toBe("rejected");
    expect(usd(h)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
    expect(h.outbox.get(WORKSPACE, account(), intent.clientOrder, "submit")!.state).toBe("closed");
  });
});

describe("Submission Uncertainty + lookup-before-retry (§9/AT-08)", () => {
  it("keeps a timeout as submission_unknown with the reservation held and refuses a blind re-dispatch", async () => {
    const h = harness();
    h.broker.mode = "timeout";
    const intent = await submitted(h);
    const outcome = await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "submission_unknown", routeCalls: 1 });
    expect(order(h).submission).toBe("submission_unknown");
    expect(usd(h).reserved).toBe(550);
    // The row is `dispatched` now: a second direct dispatch is refused — only
    // reconcile (lookup-first) may touch it. Blind retry 0.
    expect(await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder)).toEqual({ status: "not_pending", routeCalls: 0 });
    expect(h.broker.submitCalls).toBe(1);
  });

  it("resolves an accepted-but-lost submit by lookup with zero resends (external orders ≤ 1)", async () => {
    const h = harness();
    h.broker.mode = "accept-lost";
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(order(h).submission).toBe("submission_unknown");

    h.broker.mode = "accept";
    const outcomes = await h.dispatcher.reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "resolved_by_lookup" }]);
    expect(order(h).submission).toBe("acknowledged");
    expect(order(h).externalOrder).toBe("X-1");
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.orders.size).toBe(1);
    expect(h.pending.open(WORKSPACE)).toHaveLength(0);
  });

  it("retries after a not-found lookup ONLY under a guaranteed horizon, reusing the same client identity", async () => {
    const h = harness({ horizonGuaranteed: true });
    h.broker.mode = "timeout";
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);

    h.broker.mode = "accept";
    const outcomes = await h.dispatcher.reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "retried_after_lookup" }]);
    expect(order(h).submission).toBe("acknowledged");
    expect(h.broker.submitCalls).toBe(2);
    expect(h.broker.orders.size).toBe(1);
    expect([...h.broker.orders.keys()]).toEqual(["bco-1"]);
  });

  it("keeps submission_unknown forever without a horizon guarantee: lookup only, blind retry 0", async () => {
    const h = harness({ horizonGuaranteed: false });
    h.broker.mode = "timeout";
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);

    h.broker.mode = "accept";
    const outcomes = await h.dispatcher.reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "kept_unknown" }]);
    expect(order(h).submission).toBe("submission_unknown");
    expect(usd(h).reserved).toBe(550);
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.lookupCalls).toBe(1);
  });
});

describe("generation-first revoke (SEC-10)", () => {
  it("makes zero route calls when the revoke commits before dispatch and resolves the order locally", async () => {
    const h = harness();
    const intent = await submitted(h);
    h.revoke();
    const outcome = await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "closed_unauthorized", routeCalls: 0 });
    expect(h.broker.submitCalls).toBe(0);
    expect(order(h).submission).toBe("rejected");
    expect(usd(h)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
    expect(h.pending.open(WORKSPACE)).toHaveLength(0);
  });
});

describe("cancel dispatch", () => {
  it("confirms a broker cancel end-to-end and releases the remaining reservation", async () => {
    const h = harness();
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    const cancelled = await h.service.cancel(account(), intent.clientOrder, control("k-cancel", h.book.currentRevision(WORKSPACE, account())), viewer());
    expect(cancelled.status).toBe("applied");
    expect(order(h).cancellation).toBe("requested");

    const outcome = await h.dispatcher.dispatchCancel(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "cancel_resolved", routeCalls: 1 });
    expect(order(h).cancellation).toBe("confirmed");
    expect(usd(h)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
    expect(h.broker.cancelCalls).toBe(1);
  });
});
