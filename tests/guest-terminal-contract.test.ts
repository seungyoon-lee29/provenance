import { describe, expect, it } from "vitest";

import type {
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestFinancialQuery,
  GuestFinancialUpdates,
} from "../src/modules/terminal-view/presentation/guest/contracts";
import {
  createGuestSessionProof,
  createGuestTerminalRequest,
  createGuestTerminalView,
} from "../src/modules/terminal-view/presentation/guest/guest-terminal-view";
import { ManualClock } from "./harness/manual-clock";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("guest TerminalView.open", () => {
  it("publishes pending immediately, provider-wait at 2 seconds, and a normalized timeout at 10 seconds", async () => {
    const never = new Promise<never>(() => undefined);
    const financialInformation: GuestFinancialInformation = {
      read(query): GuestFinancialLoad {
        return { kind: "FinancialLoad", cache: "miss", query, result: never };
      },
      follow(): GuestFinancialUpdates {
        return { async *[Symbol.asyncIterator]() { return; } };
      },
    };
    const clock = new ManualClock();
    const terminalView = createGuestTerminalView({ financialInformation, clock });
    const load = terminalView.open(
      createGuestTerminalRequest(["index-usdkrw"], "r1"),
      createGuestSessionProof("test-request"),
    );

    const initial = await load.initial;
    expect(initial.safetyDeadlineAfterMs).toBe(10_000);
    expect(initial.panels).toEqual([
      { panelKey: "index-usdkrw", state: "pending", phase: "initial", since: 0, requestRevision: "r1" },
    ]);

    const iterator = load.updates[Symbol.asyncIterator]();
    const waitingUpdate = iterator.next();
    await flush();
    clock.advanceBy(1_999);
    await flush();
    clock.advanceBy(1);
    expect((await waitingUpdate).value).toMatchObject({
      panelKey: "index-usdkrw",
      sequence: 1,
      state: { state: "pending", phase: "provider_wait" },
    });

    const deadlineUpdate = iterator.next();
    await flush();
    clock.advanceBy(7_999);
    await flush();
    clock.advanceBy(1);
    const deadline = (await deadlineUpdate).value;
    expect(deadline).toMatchObject({
      panelKey: "index-usdkrw",
      sequence: 2,
      completed: true,
      state: {
        state: "ready",
        outcome: { status: "failed", degradation: { code: "timeout", retryable: true } },
      },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("awaits cache hits for initial while leaving cache misses independent", async () => {
    const queries: GuestFinancialQuery[] = [];
    const financialInformation: GuestFinancialInformation = {
      read(query): GuestFinancialLoad {
        queries.push(query);
        if (query.panelKey === "market-overview") {
          return {
            kind: "FinancialLoad",
            cache: "hit",
            query,
            result: Promise.resolve({
              status: "unavailable",
              reason: "no_data",
              queryRange: "latest",
              asOf: "2026-01-02T14:30:00.000Z",
              policyVersion: "policy:test" as never,
            }),
          };
        }
        return { kind: "FinancialLoad", cache: "miss", query, result: new Promise<never>(() => undefined) };
      },
      follow(): GuestFinancialUpdates {
        return { async *[Symbol.asyncIterator]() { return; } };
      },
    };
    const terminalView = createGuestTerminalView({ financialInformation, clock: new ManualClock() });
    const snapshot = await terminalView.open(
      createGuestTerminalRequest(["market-overview", "index-usdkrw"], "r2"),
      createGuestSessionProof("test-request"),
    ).initial;

    expect(queries.map((query) => query.panelKey)).toEqual(["market-overview", "index-usdkrw"]);
    expect(snapshot.panels[0]).toMatchObject({ state: "ready", outcome: { status: "unavailable", reason: "no_data" } });
    expect(snapshot.panels[1]).toMatchObject({ state: "pending", phase: "initial" });
  });

  it("anchors provider wait and deadline to open even when update iteration starts late", async () => {
    const financialInformation: GuestFinancialInformation = {
      read(query): GuestFinancialLoad {
        return { kind: "FinancialLoad", cache: "miss", query, result: new Promise<never>(() => undefined) };
      },
      follow(): GuestFinancialUpdates {
        return { async *[Symbol.asyncIterator]() { return; } };
      },
    };
    const clock = new ManualClock();
    const load = createGuestTerminalView({ financialInformation, clock }).open(
      createGuestTerminalRequest(["index-usdkrw"], "late-claim"),
      createGuestSessionProof("late-claim-request"),
    );
    await load.initial;
    clock.advanceBy(9_999);

    const iterator = load.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      sequence: 1,
      state: { state: "pending", phase: "provider_wait" },
    });
    const deadline = iterator.next();
    await flush();
    clock.advanceBy(1);
    expect((await deadline).value).toMatchObject({
      sequence: 2,
      completed: true,
      state: { state: "ready", outcome: { status: "failed", degradation: { code: "timeout" } } },
    });
  });
});
