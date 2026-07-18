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

/** Shared F9 test harness: scripted broker behind the pinned TransportExecutor seam (network-off, §12.2). */

export const WORKSPACE = "workspace:a";
export const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL");
export const CONNECTION = brandReference<string, "ProviderConnectionReference">("conn-scripted-paper") as ProviderConnectionReference;

export function viewer(): WorkspaceViewerContext {
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

export function account(): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">("broker-acct-1") as BrokerPaperAccountReference;
}

export function limitBuy(quantity: number, limit: number): PaperOrderPayload {
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

export function control(key: string, revision: number): MutationControl {
  return { idempotencyKey: key, expectedRevision: brandReference<string, "Revision">(String(revision)) as Revision };
}

export type BrokerRecord = { externalOrder: string; state: "accepted" | "rejected" | "cancel_confirmed" | "cancel_rejected"; externalIdentity: string; revision: number };

/** Deterministic in-memory broker. `onAccept` fires after the broker durably records an accept (race hook). */
export class ScriptedBroker {
  orders = new Map<string, BrokerRecord>();
  submitCalls = 0;
  lookupCalls = 0;
  cancelCalls = 0;
  lastSubmitBody: unknown;
  mode: "accept" | "reject" | "timeout" | "accept-lost" = "accept";
  onAccept: (() => void) | undefined;
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
      if (record.state === "accepted") this.onAccept?.();
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

export function harness(options: Readonly<{ horizonGuaranteed?: boolean }> = {}) {
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

  return {
    broker,
    book,
    outbox,
    pending,
    service,
    dispatcher,
    /** A fresh dispatcher over the same durable stores — models a process restart. */
    restartedDispatcher: () => new BrokerDispatcher({ book, outbox, pending, transport }),
    revoke: () => {
      state.current = { ...state.current, connectionState: "revoked" };
    },
  };
}

export type Harness = ReturnType<typeof harness>;

export async function submitted(h: Harness, payload = limitBuy(5, 110)) {
  const revision = h.book.currentRevision(WORKSPACE, account());
  const prepared = await h.service.prepare({ account: account(), connection: CONNECTION, payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare: ${prepared.status}`);
  const outcome = await h.service.submit(prepared.intent.reference, control(`k-${String(prepared.intent.reference)}`, revision), viewer());
  if (outcome.status !== "applied") throw new Error(`submit: ${outcome.status}`);
  return prepared.intent;
}

export function usd(h: Harness) {
  return h.book.state(WORKSPACE, account()).cash.find((row) => row.currency === "USD")!;
}

export function order(h: Harness) {
  return h.book.state(WORKSPACE, account()).orders[0]!;
}
