import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { BrokerPaperAccountReference, ProviderConnectionReference, Revision } from "../src/shared/contracts/brands";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import type { ViewerContext, WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { BrokerPaperBook } from "../src/modules/paper-trading/broker/book";
import { BrokerOutbox, BrokerPendingSubmissions } from "../src/modules/paper-trading/broker/outbox";
import { BrokerPaperTradingService } from "../src/modules/paper-trading/broker/service";
import type { PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

const WORKSPACE = "workspace:a";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL");

function viewer(overrides?: Partial<WorkspaceViewerContext>): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    ...overrides,
  };
}

function guest(): ViewerContext {
  return { kind: "guest", requestId: "req-g" } as ViewerContext;
}

function account(id = "broker-acct-1"): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">(id) as BrokerPaperAccountReference;
}

function connection(id = "conn-alpaca-paper"): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">(id) as ProviderConnectionReference;
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

function harness() {
  const book = new BrokerPaperBook();
  const outbox = new BrokerOutbox();
  const pending = new BrokerPendingSubmissions();
  const nowRef = { value: "2026-07-18T10:00:00.000Z" };
  const generationRef = { value: "gen-1" as string | undefined };
  const identityEpochRef = { value: "epoch:1" };
  let intentSeq = 0;
  let orderSeq = 0;
  const service = new BrokerPaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: () => identityEpochRef.value },
    policy: { intentTtlMs: 60_000, seedCash: [{ amount: 100_000, currency: "USD" }] },
    book,
    outbox,
    pending,
    connections: { currentGeneration: () => generationRef.value },
    newIntentReference: () => `bpi-${++intentSeq}`,
    newClientOrder: () => `bco-${++orderSeq}`,
  });
  return { book, outbox, pending, service, nowRef, generationRef, identityEpochRef };
}

async function issued(h: ReturnType<typeof harness>, payload = limitBuy(5, 110)) {
  const prepared = await h.service.prepare({ account: account(), connection: connection(), payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  return prepared.intent;
}

describe("prepare (opaque one-time intent, §9)", () => {
  it("issues an intent bound to workspace/epoch/account/revision/connection generation with a stable client order identity", async () => {
    const h = harness();
    const intent = await issued(h);
    expect(intent.reference).toBe("bpi-1");
    expect(intent.clientOrder).toBe("bco-1");
    expect(intent.accountKind).toBe("broker");
    expect(intent.environment).toBe("paper");
    expect(intent.accountRevision).toBe(0);
    expect(intent.connectionGeneration).toBe("gen-1");
    expect(intent.expiresAt).toBe("2026-07-18T10:01:00.000Z");
  });

  it("denies a guest and refuses a market payload fail-closed", async () => {
    const h = harness();
    const denied = await h.service.prepare({ account: account(), connection: connection(), payload: limitBuy(5, 110) }, guest());
    expect(denied.status).toBe("denied");
    const market: PaperOrderPayload = { ...limitBuy(5, 110), orderType: "market" };
    const refused = await h.service.prepare({ account: account(), connection: connection(), payload: market }, viewer());
    expect(refused).toEqual({ status: "refused", reason: "unsupported_order_type" });
  });

  it("refuses prepare when the connection has no current generation (revoked/unknown)", async () => {
    const h = harness();
    h.generationRef.value = undefined;
    const refused = await h.service.prepare({ account: account(), connection: connection(), payload: limitBuy(5, 110) }, viewer());
    expect(refused).toEqual({ status: "refused", reason: "connection_unavailable" });
  });
});

describe("submit — durable-before-send in one transaction (§9/AT-08)", () => {
  it("applies: consumes the intent, books pending_submission + reservation, commits outbox and PendingBrokerSubmission", async () => {
    const h = harness();
    const intent = await issued(h);
    const outcome = await h.service.submit(intent.reference, control("k1", 0), viewer());
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.revision).toBe(1);
    expect(outcome.order.submission).toBe("pending_submission");

    const state = h.book.state(WORKSPACE, account());
    expect(state.cash[0]).toEqual({ currency: "USD", balance: 100_000, reserved: 550 });
    // Everything the dispatcher needs is durable BEFORE any route call.
    const rows = h.outbox.list(WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("submit");
    expect(rows[0]!.state).toBe("pending_dispatch");
    expect(rows[0]!.clientOrder).toBe("bco-1");
    expect(h.pending.list(WORKSPACE).map((row) => String(row.clientOrder))).toEqual(["bco-1"]);

    const reuse = await h.service.submit(intent.reference, control("k2", 1), viewer());
    expect(reuse).toEqual({ status: "refused", reason: "intent_consumed" });
  });

  it("returns the original receipt on same key + same intent, with zero extra side effects", async () => {
    const h = harness();
    const intent = await issued(h);
    const first = await h.service.submit(intent.reference, control("k1", 0), viewer());
    const replay = await h.service.submit(intent.reference, control("k1", 0), viewer());
    expect(replay).toEqual(first);
    expect(h.book.state(WORKSPACE, account()).orders).toHaveLength(1);
    expect(h.outbox.list(WORKSPACE)).toHaveLength(1);
    expect(h.book.currentRevision(WORKSPACE, account())).toBe(1);
  });

  it("conflicts on same key + different intent and rejects a stale expectedRevision with the current one", async () => {
    const h = harness();
    const intentA = await issued(h);
    await h.service.submit(intentA.reference, control("k1", 0), viewer());
    const intentB = await issued(h, limitBuy(1, 100));
    const conflict = await h.service.submit(intentB.reference, control("k1", 1), viewer());
    expect(conflict).toEqual({ status: "conflict" });
    const stale = await h.service.submit(intentB.reference, control("k9", 0), viewer());
    expect(stale).toEqual({ status: "rejected", currentRevision: 1 });
    expect(h.book.state(WORKSPACE, account()).orders).toHaveLength(1);
    expect(h.outbox.list(WORKSPACE)).toHaveLength(1);
  });

  it("refuses an expired intent and a stale intent binding after the account revision moves", async () => {
    const h = harness();
    const intentA = await issued(h);
    h.nowRef.value = "2026-07-18T10:01:00.001Z";
    expect(await h.service.submit(intentA.reference, control("k1", 0), viewer())).toEqual({ status: "refused", reason: "intent_expired" });

    h.nowRef.value = "2026-07-18T10:00:00.000Z";
    const intentB = await issued(h); // bound at revision 0
    const intentC = await issued(h);
    await h.service.submit(intentB.reference, control("k2", 0), viewer()); // revision → 1
    expect(await h.service.submit(intentC.reference, control("k3", 1), viewer())).toEqual({ status: "refused", reason: "stale_intent_binding" });
  });

  it("refuses submit when the connection generation changed after prepare (generation-first, route call 0)", async () => {
    const h = harness();
    const intent = await issued(h);
    h.generationRef.value = "gen-2";
    expect(await h.service.submit(intent.reference, control("k1", 0), viewer())).toEqual({ status: "refused", reason: "connection_revoked" });
    expect(h.outbox.list(WORKSPACE)).toHaveLength(0);
    expect(h.book.state(WORKSPACE, account()).orders).toHaveLength(0);
  });

  it("keeps cross-workspace intents invisible and denies a stale viewer epoch", async () => {
    const h = harness();
    const intent = await issued(h);
    const other = viewer({ workspaceReference: brandReference<string, "WorkspaceReference">("workspace:b") });
    expect(await h.service.submit(intent.reference, control("k1", 0), other)).toEqual({ status: "refused", reason: "unknown_intent" });

    h.identityEpochRef.value = "epoch:2"; // identity moved on; the viewer's epoch is stale
    expect((await h.service.submit(intent.reference, control("k1", 0), viewer())).status).toBe("denied");
  });

  it("refuses an unaffordable submit without consuming the intent or touching the outbox", async () => {
    const h = harness();
    const intentA = await issued(h, limitBuy(900, 110)); // 99,000 of 100,000
    await h.service.submit(intentA.reference, control("k1", 0), viewer());
    const intentB = await issued(h, limitBuy(10, 110)); // 1,100 > 1,000 available
    expect(await h.service.submit(intentB.reference, control("k2", 1), viewer())).toEqual({ status: "refused", reason: "insufficient_cash" });
    expect(h.book.state(WORKSPACE, account()).orders).toHaveLength(1);
    expect(h.outbox.list(WORKSPACE)).toHaveLength(1);
    expect(h.book.currentRevision(WORKSPACE, account())).toBe(1);
  });
});

describe("cancel command (three axes, §9)", () => {
  it("marks the cancellation axis requested and commits a cancel outbox row", async () => {
    const h = harness();
    const intent = await issued(h);
    await h.service.submit(intent.reference, control("k1", 0), viewer());
    const outcome = await h.service.cancel(account(), intent.clientOrder, control("k2", 1), viewer());
    expect(outcome.status).toBe("applied");
    expect(h.book.state(WORKSPACE, account()).orders[0]!.cancellation).toBe("requested");
    const rows = h.outbox.list(WORKSPACE);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.kind).toBe("cancel");
    expect(rows[1]!.state).toBe("pending_dispatch");
  });

  it("refuses a second cancel while one is pending and replays the first receipt verbatim", async () => {
    const h = harness();
    const intent = await issued(h);
    await h.service.submit(intent.reference, control("k1", 0), viewer());
    const first = await h.service.cancel(account(), intent.clientOrder, control("k2", 1), viewer());
    expect(await h.service.cancel(account(), intent.clientOrder, control("k2", 1), viewer())).toEqual(first);
    expect(await h.service.cancel(account(), intent.clientOrder, control("k3", 2), viewer())).toEqual({ status: "refused", reason: "cancel_pending" });
    expect(h.outbox.list(WORKSPACE)).toHaveLength(2);
  });
});
