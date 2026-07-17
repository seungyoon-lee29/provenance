import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ViewerContext, WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import type { ActualAccountReference, ActualPortfolioCommand } from "../src/modules/actual-portfolio/baseline/contracts";
import type { ActualPriceFxPort } from "../src/modules/actual-portfolio/baseline/valuation";
import { ActualPortfolioService, shouldPaint } from "../src/modules/actual-portfolio/baseline/portfolio-load";

const NOW = "2026-07-17T06:00:00.000Z";
const ACCOUNT = brandReference<string, "ActualAccountReference">("actual-account:a1") as ActualAccountReference;

function viewer(overrides: Partial<WorkspaceViewerContext> = {}): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:w1"),
    accountReference: brandReference<string, "AccountReference">("account:acc1"),
    sessionReference: brandReference<string, "SessionReference">("session:s1"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    ...overrides,
  };
}

const guest: ViewerContext = { kind: "guest", requestId: "req-guest" };

function openingCommand(symbol = "AAPL", quantity = 10): ActualPortfolioCommand {
  return {
    kind: "record_opening_position",
    account: ACCOUNT,
    position: {
      instrument: brandReference<string, "ActualInstrumentReference">(`instr:${symbol}`),
      signedQuantity: quantity,
      currency: "KRW",
      asOf: "2026-07-01",
      source: brandReference<string, "ActualSourceReference">(`source:manual:${symbol}`),
    },
  };
}

const control = (key: string, revision: number) => ({ idempotencyKey: key, expectedRevision: String(revision) });

function world(options: { epoch?: string } = {}) {
  const journal = new ActualJournal(() => NOW);
  let currentEpoch = options.epoch ?? "epoch:1";
  const port: ActualPriceFxPort = {
    quote: () => ({ available: true, unitPrice: { amount: 70_000, currency: "KRW" }, asOf: NOW }),
    fxRate: (from, to) => (from === to ? { available: true, rate: 1, asOf: NOW } : { available: false }),
  };
  let updateCounter = 0;
  const service = new ActualPortfolioService({
    journal,
    port,
    identity: { currentAuthorizationEpoch: () => currentEpoch },
    policyVersion: "policy:f6-1",
    now: () => NOW,
    updateId: () => `update:${(updateCounter += 1)}`,
  });
  return { journal, service, setEpoch: (epoch: string) => { currentEpoch = epoch; } };
}

describe("SEC-01: only the Viewer Context grants access", () => {
  it("guest open yields a denied shell and zero updates", async () => {
    const w = world();
    const load = w.service.open({ sections: ["positions", "valuation"], requestRevision: "r1" }, guest);
    const initial = await load.initial;
    expect(initial.status).toBe("denied");
    expect(await load.refresh("valuation")).toBeUndefined();
  });

  it("guest and stale-epoch change commands are denied with zero side effects", () => {
    const w = world();
    expect(w.service.change(openingCommand(), control("k1", 0), guest)).toEqual({ status: "denied" });
    const stale = viewer({ accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:0") });
    expect(w.service.change(openingCommand(), control("k1", 0), stale)).toEqual({ status: "denied" });
    expect(w.journal.list("workspace:w1", ACCOUNT)).toHaveLength(0);
  });

  it("an account owned by another workspace is denied without touching either journal", () => {
    const w = world();
    const owner = viewer();
    expect(w.service.change(openingCommand(), control("k1", 0), owner).status).toBe("applied");

    const intruder = viewer({
      workspaceReference: brandReference<string, "WorkspaceReference">("workspace:w2"),
      accountReference: brandReference<string, "AccountReference">("account:acc2"),
    });
    expect(w.service.change(openingCommand("MSFT", 1), control("k9", 0), intruder)).toEqual({ status: "denied" });
    expect(w.journal.list("workspace:w1", ACCOUNT)).toHaveLength(1);
    expect(w.journal.list("workspace:w2", ACCOUNT)).toHaveLength(0);
  });
});

describe("PortfolioLoad initial + section updates (spec §8)", () => {
  it("initial waits only for the normalized journal state — valuation stays pending, port untouched", async () => {
    const w = world();
    w.service.change(openingCommand(), control("k1", 0), viewer());
    let portCalls = 0;
    const slowPort: ActualPriceFxPort = {
      quote: () => { portCalls += 1; throw new Error("initial must not value"); },
      fxRate: () => { portCalls += 1; throw new Error("initial must not value"); },
    };
    const slowWorld = new ActualPortfolioService({
      journal: w.journal,
      port: slowPort,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      policyVersion: "policy:f6-1",
      now: () => NOW,
      updateId: () => "update:x",
    });
    const load = slowWorld.open({ sections: ["positions", "valuation"], requestRevision: "r1" }, viewer());
    const initial = await load.initial;
    expect(initial.status).toBe("ready");
    if (initial.status !== "ready") throw new Error("unreachable");
    expect(initial.positions).toHaveLength(1);
    expect(initial.sections.valuation).toBe("pending");
    expect(portCalls).toBe(0);
  });

  it("a section update carries the full §8 metadata set", async () => {
    const w = world();
    w.service.change(openingCommand(), control("k1", 0), viewer());
    const load = w.service.open({ sections: ["valuation"], requestRevision: "r7" }, viewer());
    const update = await load.refresh("valuation");
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      sectionKey: "valuation",
      sequence: 1,
      requestRevision: "r7",
      authorizationEpoch: "epoch:1",
      scope: "workspace:w1",
      policyVersion: "policy:f6-1",
      resumeCursor: "valuation:1",
    });
    expect(update?.updateId).toBe("update:1");
    expect(update?.accountRevisions).toEqual({ [String(ACCOUNT)]: 1 });
    expect(update?.evidenceWatermark).toBe(NOW);
    expect(update?.section.completeness).toBe("complete");
  });

  it("per-section sequences are monotonic with unique update ids", async () => {
    const w = world();
    w.service.change(openingCommand(), control("k1", 0), viewer());
    const load = w.service.open({ sections: ["valuation"], requestRevision: "r1" }, viewer());
    const first = await load.refresh("valuation");
    const second = await load.refresh("valuation");
    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
    expect(second?.updateId).not.toBe(first?.updateId);
    expect(second?.resumeCursor).toBe("valuation:2");
  });

  it("re-checks the auth epoch immediately before emit: a revoked session yields nothing", async () => {
    const w = world();
    w.service.change(openingCommand(), control("k1", 0), viewer());
    const load = w.service.open({ sections: ["valuation"], requestRevision: "r1" }, viewer());
    w.setEpoch("epoch:2"); // revoke-all happened after open
    expect(await load.refresh("valuation")).toBeUndefined();
  });

  it("resume cursor continues the sequence without replaying delivered updates", async () => {
    const w = world();
    w.service.change(openingCommand(), control("k1", 0), viewer());
    const load = w.service.open(
      { sections: ["valuation"], requestRevision: "r2", resume: { valuation: "valuation:2" } },
      viewer(),
    );
    const update = await load.refresh("valuation");
    expect(update?.sequence).toBe(3);
  });
});

describe("stale-paint guard (pure)", () => {
  const update = (sequence: number, requestRevision = "r1") => ({ sequence, requestRevision });

  it("drops out-of-order and superseded-request updates, paints newer sequences", () => {
    expect(shouldPaint(undefined, update(1), "r1")).toBe(true);
    expect(shouldPaint({ sequence: 2 }, update(1), "r1")).toBe(false); // slow update arrives late
    expect(shouldPaint({ sequence: 2 }, update(3), "r1")).toBe(true);
    expect(shouldPaint({ sequence: 2 }, update(2), "r1")).toBe(false); // duplicate
    expect(shouldPaint(undefined, update(5, "r0"), "r1")).toBe(false); // superseded request
  });
});
