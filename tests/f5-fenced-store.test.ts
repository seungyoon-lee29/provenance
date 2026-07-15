import { describe, expect, it } from "vitest";

import { FencedKeyedStore, notificationErasureParticipant, type ErasureReceiptLine } from "../src/modules/notification-center/fenced-store";
import type { ErasureParticipant } from "../src/modules/identity/identity-service";

describe("FencedKeyedStore (SEC-09 substrate)", () => {
  it("writes, reads, lists and counts per subject", () => {
    const store = new FencedKeyedStore<string>();
    expect(store.write("ws-a", "k1", "v1", 1)).toBe(true);
    expect(store.write("ws-a", "k2", "v2", 1)).toBe(true);
    expect(store.get("ws-a", "k1")).toBe("v1");
    expect(store.size("ws-a")).toBe(2);
    expect([...store.list("ws-a")].sort()).toEqual(["v1", "v2"]);
  });

  it("writeIfAbsent is idempotent for a unique key and returns the existing value on replay", () => {
    const store = new FencedKeyedStore<string>();
    const first = store.writeIfAbsent("ws-a", "intent:1", "planned", 1);
    expect(first).toEqual({ written: true, value: "planned" });
    const replay = store.writeIfAbsent("ws-a", "intent:1", "planned-again", 1);
    expect(replay).toEqual({ written: false, value: "planned" });
    expect(store.size("ws-a")).toBe(1);
  });

  it("shreds behind the fence and suppresses late/restore writes; a genuinely new epoch may write again", () => {
    const store = new FencedKeyedStore<string>();
    store.write("ws-a", "k1", "v1", 1);
    store.write("ws-a", "k2", "v2", 1);
    expect(store.eraseSubject("ws-a", 5)).toBe(2);
    expect(store.get("ws-a", "k1")).toBeUndefined();
    expect(store.isErased("ws-a", 5)).toBe(true);
    // late worker / backup restore at an old epoch → suppressed.
    expect(store.write("ws-a", "k1", "v1", 3)).toBe(false);
    expect(store.writeIfAbsent("ws-a", "k1", "v1", 5)).toEqual({ written: false, value: undefined });
    expect(store.size("ws-a")).toBe(0);
    // a genuinely new post-erasure authorized epoch may write again.
    expect(store.write("ws-a", "k3", "v3", 6)).toBe(true);
    expect(store.get("ws-a", "k3")).toBe("v3");
  });

  it("isolates subjects: erasing one does not fence another", () => {
    const store = new FencedKeyedStore<string>();
    store.write("ws-a", "k", "va", 1);
    store.write("pending:p1", "k", "vp", 1);
    store.eraseSubject("ws-a", 9);
    expect(store.get("ws-a", "k")).toBeUndefined();
    expect(store.get("pending:p1", "k")).toBe("vp");
    expect(store.isErased("pending:p1", 1)).toBe(false);
  });
});

describe("notificationErasureParticipant (module receipt for SEC-09 coordinator)", () => {
  it("shreds every registered store behind one fence with a receipt line each, and restore suppression holds", async () => {
    const records = new FencedKeyedStore<string>();
    const outbox = new FencedKeyedStore<string>();
    records.write("ws-a", "record:1", "unread", 1);
    outbox.write("ws-a", "intent:1", "planned", 1);

    const receipts: ErasureReceiptLine[] = [];
    const participant: ErasureParticipant = notificationErasureParticipant(
      [{ label: "notification-records", store: records }, { label: "delivery-outbox", store: outbox }],
      receipts,
    );
    await participant.erase({ accountReference: "account:a1", workspaceReference: "ws-a", scope: "account", fence: 7 });

    expect(records.get("ws-a", "record:1")).toBeUndefined();
    expect(outbox.get("ws-a", "intent:1")).toBeUndefined();
    expect(receipts.map((r) => r.label).sort()).toEqual(["delivery-outbox", "notification-records"]);
    expect(receipts.every((r) => r.shredded === 1 && r.fence === 7 && r.workspace === "ws-a")).toBe(true);
    // restore suppression holds for both stores after erasure.
    expect(records.write("ws-a", "record:1", "unread", 2)).toBe(false);
    expect(outbox.write("ws-a", "intent:1", "planned", 2)).toBe(false);
  });
});
