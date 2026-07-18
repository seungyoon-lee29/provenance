import { describe, expect, it } from "vitest";

import { account, harness, limitBuy, control, order, submitted, usd, viewer, WORKSPACE } from "./f9-broker-harness";

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
