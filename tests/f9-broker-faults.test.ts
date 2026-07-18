import { describe, expect, it } from "vitest";

import { FaultInjected } from "../src/modules/paper-trading/broker/dispatcher";
import { account, harness, order, submitted, usd, viewer, WORKSPACE } from "./f9-broker-harness";

/**
 * AT-08: the four canonical named fault points. Each test crashes at the seam,
 * then "restarts" with a FRESH dispatcher over the same durable stores and
 * proves convergence: broker accepted ≤ 1, blind retry 0, money exact.
 */

async function crashAt(h: ReturnType<typeof harness>, clientOrder: Parameters<ReturnType<typeof harness>["dispatcher"]["dispatchSubmit"]>[3], point: ConstructorParameters<typeof FaultInjected>[0]) {
  await expect(h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), clientOrder, { faultAt: point })).rejects.toThrow(FaultInjected);
}

describe("fault: after-intent-commit", () => {
  it("restart re-dispatches safely — the send provably never happened", async () => {
    const h = harness();
    const intent = await submitted(h);
    await crashAt(h, intent.clientOrder, "after-intent-commit");
    expect(h.broker.submitCalls).toBe(0);
    expect(order(h).submission).toBe("pending_submission");

    const outcomes = await h.restartedDispatcher().reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "dispatched_fresh" }]);
    expect(order(h).submission).toBe("acknowledged");
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.orders.size).toBe(1);
    expect(h.pending.open(WORKSPACE)).toHaveLength(0);
  });
});

describe("fault: after-authorize-before-route-dispatch", () => {
  it("restart treats the order as Submission Uncertainty and resolves via lookup-verified retry", async () => {
    const h = harness({ horizonGuaranteed: true });
    const intent = await submitted(h);
    await crashAt(h, intent.clientOrder, "after-authorize-before-route-dispatch");
    // Crash landed after the durable dispatched marker but before the route
    // call: the process cannot know the send never happened.
    expect(h.broker.submitCalls).toBe(0);

    const outcomes = await h.restartedDispatcher().reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "retried_after_lookup" }]);
    expect(order(h).submission).toBe("acknowledged");
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.orders.size).toBe(1);
  });

  it("a revoke that lands after the crash keeps uncertainty: route calls 0, reservation held, late resolution only", async () => {
    const h = harness();
    const intent = await submitted(h);
    await crashAt(h, intent.clientOrder, "after-authorize-before-route-dispatch");
    h.revoke();

    const outcomes = await h.restartedDispatcher().reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "unauthorized" }]);
    // Dispatch WAS possible before the crash, so this must stay
    // submission_unknown — never a fabricated local rejection.
    expect(order(h).submission).toBe("submission_unknown");
    expect(usd(h).reserved).toBe(550);
    expect(h.broker.submitCalls).toBe(0);
    expect(h.broker.lookupCalls).toBe(0);
  });
});

describe("fault: after-broker-accept-before-local-ack", () => {
  it("restart resolves by lookup exactly once — no resend, no double fact", async () => {
    const h = harness();
    const intent = await submitted(h);
    await crashAt(h, intent.clientOrder, "after-broker-accept-before-local-ack");
    // The broker durably accepted; the local book never heard back.
    expect(h.broker.orders.size).toBe(1);
    expect(order(h).submission).toBe("pending_submission");

    const restarted = h.restartedDispatcher();
    const outcomes = await restarted.reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "resolved_by_lookup" }]);
    expect(order(h).submission).toBe("acknowledged");
    expect(order(h).externalOrder).toBe("X-1");
    expect(h.broker.submitCalls).toBe(1);
    expect(h.broker.orders.size).toBe(1);

    // A second reconcile is a no-op: the worklist is empty and the fact unique.
    expect(await restarted.reconcile(WORKSPACE, viewer())).toEqual([]);
    expect(h.book.state(WORKSPACE, account()).quarantine).toHaveLength(0);
  });
});

describe("fault: after-local-commit-before-queue-ack", () => {
  it("restart only acknowledges the queue — zero route calls, state already converged", async () => {
    const h = harness();
    const intent = await submitted(h);
    await crashAt(h, intent.clientOrder, "after-local-commit-before-queue-ack");
    expect(order(h).submission).toBe("acknowledged");
    expect(h.pending.open(WORKSPACE)).toHaveLength(1);
    const callsBefore = { submit: h.broker.submitCalls, lookup: h.broker.lookupCalls };

    const outcomes = await h.restartedDispatcher().reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "queue_acknowledged" }]);
    expect(h.pending.open(WORKSPACE)).toHaveLength(0);
    expect(h.broker.submitCalls).toBe(callsBefore.submit);
    expect(h.broker.lookupCalls).toBe(callsBefore.lookup);
  });
});

describe("late commit fence (SEC-10)", () => {
  it("a revoke racing the broker accept fences the local ack; the accepted order stays an honest uncertainty", async () => {
    const h = harness();
    const intent = await submitted(h);
    h.broker.onAccept = () => h.revoke(); // revoke commits between accept and local commit
    const outcome = await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    expect(outcome).toEqual({ status: "submission_unknown", routeCalls: 1 });
    // Broker accepted exactly once; the local book refused to paint it.
    expect(h.broker.orders.size).toBe(1);
    expect(order(h).submission).toBe("submission_unknown");
    expect(usd(h).reserved).toBe(550);

    const outcomes = await h.restartedDispatcher().reconcile(WORKSPACE, viewer());
    expect(outcomes).toEqual([{ clientOrder: intent.clientOrder, resolution: "unauthorized" }]);
    expect(order(h).submission).toBe("submission_unknown");
  });
});

describe("stream/poll duplicate redelivery after convergence", () => {
  it("re-ingesting the acknowledged fact via stream is a duplicate with no revision movement", async () => {
    const h = harness();
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    const revision = h.book.currentRevision(WORKSPACE, account());
    const redelivered = h.book.ingest(
      WORKSPACE,
      account(),
      { connection: intent.connection, order: intent.clientOrder, kind: "accepted", externalIdentity: "E-1", revision: 1, body: { externalOrder: "X-1" } },
      1,
    );
    expect(redelivered.status).toBe("duplicate");
    expect(h.book.currentRevision(WORKSPACE, account())).toBe(revision);
  });
});
