import { describe, expect, it } from "vitest";

import { PaperTradingErasure } from "../src/modules/paper-trading/internal/paper-erasure";
import { PaperJournal } from "../src/modules/paper-trading/internal/journal";
import { brokerErasables } from "../src/modules/paper-trading/broker/broker-erasure";
import { account, CONNECTION, harness, submitted, viewer, WORKSPACE } from "./f9-broker-harness";

function erasureOf(h: ReturnType<typeof harness>) {
  return new PaperTradingErasure({
    journal: new PaperJournal(() => "2026-07-18T10:00:00.000Z"),
    stores: brokerErasables(h.book, h.outbox, h.pending, h.service),
  });
}

describe("F9 erasure extension (SEC-09)", () => {
  it("shreds book/outbox/pending/intents behind one fence with real per-store counts", async () => {
    const h = harness();
    const intent = await submitted(h);
    await h.dispatcher.dispatchSubmit(WORKSPACE, viewer(), account(), intent.clientOrder);
    const erasure = erasureOf(h);

    await erasure.erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 1 });
    const receipt = erasure.receiptFor(WORKSPACE)!;
    const byLabel = Object.fromEntries(receipt.lines.map((line) => [line.label, line.shredded]));
    expect(byLabel["broker-book"]).toBe(1); // one account state
    expect(byLabel["broker-outbox"]).toBe(1); // one submit row
    expect(byLabel["broker-pending-submissions"]).toBe(1);
    expect(byLabel["broker-intents"]).toBe(1);
    expect(h.book.state(WORKSPACE, account())).toEqual({ cash: [], positions: [], orders: [], quarantine: [] });
    expect(h.outbox.list(WORKSPACE)).toHaveLength(0);
    expect(h.pending.list(WORKSPACE)).toHaveLength(0);
  });

  it("suppresses every late write behind the fence: commands, provider events, outbox, restore", async () => {
    const h = harness();
    const intent = await submitted(h);
    await erasureOf(h).erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 1 });

    // Late user command: denied at prepare (intent write suppressed) …
    const prepared = await h.service.prepare({ account: account(), connection: CONNECTION, payload: { ...intent } as never }, viewer());
    expect(prepared.status).not.toBe("issued");
    // … suppressed at the book boundary for the already-issued intent.
    const late = h.book.ingest(
      WORKSPACE,
      account(),
      { connection: CONNECTION, order: intent.clientOrder, kind: "accepted", externalIdentity: "E-9", revision: 1, body: { externalOrder: "X-9" } },
    );
    expect(late.status).toBe("suppressed");
    expect(h.outbox.commit(WORKSPACE, { kind: "submit", account: account(), connection: CONNECTION, clientOrder: intent.clientOrder, state: "pending_dispatch", attempts: 0 })).toEqual({ status: "suppressed" });
    // Backup restore (an old-epoch provision) regenerates nothing.
    expect(h.book.provision(WORKSPACE, account(), [{ amount: 100_000, currency: "USD" }]).status).toBe("suppressed");
    // The reconciliation worklist is empty: a restarted worker commits nothing.
    expect(await h.restartedDispatcher().reconcile(WORKSPACE, viewer())).toEqual([]);
  });

  it("keeps the original receipt on a replayed erase sweep", async () => {
    const h = harness();
    await submitted(h);
    const erasure = erasureOf(h);
    await erasure.erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 1 });
    const original = erasure.receiptFor(WORKSPACE)!;
    await erasure.erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 1 });
    expect(erasure.receiptFor(WORKSPACE)).toBe(original);
  });
});
