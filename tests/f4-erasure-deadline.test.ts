import { describe, expect, it } from "vitest";

import { AI_DEADLINE_MS, DATA_DEADLINE_MS, deadlineTimeoutOutcome, withDeadline } from "../src/modules/financial-information/data/deadline";
import { PersonalCacheStore, personalCacheErasureParticipant } from "../src/modules/financial-information/data/personal-cache";
import type { ErasureParticipant } from "../src/modules/identity/identity-service";
import type { AvailableInformation, InformationOutcome } from "@/shared";

function ok(label: string): AvailableInformation<{ label: string }> {
  return {
    status: "available", value: { label }, evidenceReference: "e" as never, provider: "synthetic", feed: "f",
    asOf: "2026-01-02T14:30:00.000Z", receivedAt: "2026-01-02T14:30:00.000Z", freshness: "realtime",
    licenseScope: { audience: "public", purposes: ["x"], validUntil: "2027-01-01T00:00:00.000Z" }, policyVersion: "p" as never,
  };
}

describe("withDeadline (§11.3 no infinite spinner)", () => {
  const never: Sleep = () => new Promise<void>(() => {});
  const immediate: Sleep = () => Promise.resolve();
  it("returns the work outcome when it settles before the deadline", async () => {
    const out = await withDeadline(Promise.resolve(ok("live")), { deadlineMs: DATA_DEADLINE_MS, sleep: never, onTimeout: () => deadlineTimeoutOutcome("p", "f", "t") });
    expect(out.status).toBe("available");
  });
  it("returns a normalized timeout when work misses the deadline", async () => {
    const stuck = new Promise<InformationOutcome<{ label: string }>>(() => {});
    const out = await withDeadline(stuck, { deadlineMs: AI_DEADLINE_MS, sleep: immediate, onTimeout: () => deadlineTimeoutOutcome("gemini", "research", "2026-01-02T14:30:20.000Z") });
    expect(out.status).toBe("failed");
    if (out.status === "failed") { expect(out.degradation.code).toBe("timeout"); expect(out.degradation.retryable).toBe(true); }
  });
});

describe("PersonalCacheStore + erasure participant (SEC-09)", () => {
  it("shreds behind the fence and suppresses late/restore writes", () => {
    const store = new PersonalCacheStore<string>();
    expect(store.write("ws-a", "quote:AAA", "101.25", 1)).toBe(true);
    expect(store.write("ws-a", "research:r1", "summary", 1)).toBe(true);
    expect(store.read("ws-a", "quote:AAA")).toBe("101.25");
    expect(store.size("ws-a")).toBe(2);

    const receipt = store.eraseWorkspace("ws-a", 5);
    expect(receipt.shredded).toBe(2);
    expect(store.read("ws-a", "quote:AAA")).toBeUndefined();
    expect(store.isErased("ws-a", 5)).toBe(true);

    // late worker result / backup restore at an old epoch → suppressed.
    expect(store.write("ws-a", "quote:AAA", "101.25", 3)).toBe(false);
    expect(store.read("ws-a", "quote:AAA")).toBeUndefined();
    // a genuinely new post-erasure authorized epoch may write again.
    expect(store.write("ws-a", "quote:BBB", "9.9", 6)).toBe(true);
    expect(store.read("ws-a", "quote:BBB")).toBe("9.9");
  });

  it("isolates workspaces: erasing A does not fence B", () => {
    const store = new PersonalCacheStore<string>();
    store.write("ws-a", "k", "va", 1);
    store.write("ws-b", "k", "vb", 1);
    store.eraseWorkspace("ws-a", 9);
    expect(store.read("ws-a", "k")).toBeUndefined();
    expect(store.read("ws-b", "k")).toBe("vb");
    expect(store.isErased("ws-b", 1)).toBe(false);
  });

  it("both FinancialInformation and ResearchAssistant participants shred behind one fence, with receipts", async () => {
    const financial = new PersonalCacheStore<string>();
    const research = new PersonalCacheStore<string>();
    financial.write("ws-a", "follow:AAA", "cache", 1);
    research.write("ws-a", "job:r1", "result", 1);

    const receipts: Array<Readonly<{ label: string; workspace: string; shredded: number; fence: number }>> = [];
    const participants: readonly ErasureParticipant[] = [
      personalCacheErasureParticipant("financial-information", financial, receipts),
      personalCacheErasureParticipant("research-assistant", research, receipts),
    ];
    // mimic the Identity erasure coordinator loop (fence-first already done upstream).
    for (const participant of participants) {
      await participant.erase({ accountReference: "account:a1", workspaceReference: "ws-a", scope: "account", fence: 7 });
    }

    expect(financial.read("ws-a", "follow:AAA")).toBeUndefined();
    expect(research.read("ws-a", "job:r1")).toBeUndefined();
    expect(receipts.map((r) => r.label).sort()).toEqual(["financial-information", "research-assistant"]);
    expect(receipts.every((r) => r.shredded === 1 && r.fence === 7)).toBe(true);
    // restore suppression holds for both after erasure.
    expect(financial.write("ws-a", "follow:AAA", "cache", 2)).toBe(false);
    expect(research.write("ws-a", "job:r1", "result", 2)).toBe(false);
  });
});

type Sleep = (durationMs: number, signal?: AbortSignal) => Promise<void>;
