import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext, ViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import { PaperTradingErasure } from "../src/modules/paper-trading/internal/paper-erasure";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import { ActualPortfolioService } from "../src/modules/actual-portfolio/baseline/portfolio-load";
import type {
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 B4 — SEC-09 erasure and the BEHAVIORAL Actual↔Paper mutual invariance
 * that closes F6's residual AT-07 risk.
 */

const NOW = "2026-07-18T02:00:00.000Z";

function viewer(overrides?: Partial<WorkspaceViewerContext>): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:a"),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    ...overrides,
  };
}

const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;
const WORKSPACE = "workspace:a";

function limitBuy(quantity: number, limit: number): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce: "GTC",
  };
}

function observation(overrides?: Partial<PaperMarketObservation>): PaperMarketObservation {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    price: { amount: 100, currency: "USD" },
    volume: 100,
    eventTime: "2026-07-18T02:01:00.000Z",
    receivedAt: "2026-07-18T02:01:01.000Z",
    dataClock: "2026-07-18T02:01:00.000Z",
    freshness: "realtime",
    evidenceReference: "evidence:obs-1",
    ...overrides,
  };
}

function harness(epochOf: (v: ViewerContext) => string = () => "epoch:1") {
  let updateCounter = 0;
  const identity = { currentAuthorizationEpoch: epochOf };
  const service = new PaperTradingService({
    now: () => NOW,
    identity,
    observations: { currentObservation: () => undefined },
    policy: { policyVersion: "simulation-v1", seedCash: [{ amount: 100_000, currency: "USD" }], intentTtlMs: 600_000, maxSlippageBps: 25 },
    updateId: () => `update:${updateCounter += 1}`,
  });
  const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
  const erasure = new PaperTradingErasure({
    journal: service.journal,
    stores: [...service.erasableStores()],
  });
  return { service, simulator, erasure };
}

async function submit(service: PaperTradingService, payload: PaperOrderPayload, key: string) {
  const prepared = await service.prepare({ payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const outcome = await service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey: key, expectedRevision: String(prepared.intent.accountRevision) },
    viewer(),
  );
  if (outcome.status !== "applied") throw new Error(`submit failed: ${outcome.status}`);
  return { order: outcome.order, account: prepared.intent.account };
}

describe("SEC-09 administrative erasure", () => {
  async function erasedHarness() {
    const built = harness();
    const { service, simulator, erasure } = built;
    const { order, account } = await submit(service, limitBuy(10, 110), "erase-seed");
    await simulator.ingest(WORKSPACE, account, observation());
    await erasure.erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 5 });
    return { ...built, order, account };
  }

  it("collects a receipt with real per-store shred counts and keeps the ORIGINAL receipt on a replayed sweep", async () => {
    const context = await erasedHarness();
    const receipt = context.erasure.receiptFor(WORKSPACE);
    expect(receipt).toBeDefined();
    expect(receipt!.fence).toBe(5);
    const journalLine = receipt!.lines.find((line) => line.label === "paper-journal")!;
    // genesis + submit + fill = 3 journal entries shredded.
    expect(journalLine.shredded).toBe(3);
    expect(receipt!.lines.find((line) => line.label === "paper-intents")!.shredded).toBeGreaterThanOrEqual(1);

    await context.erasure.erase({ accountReference: "account:a", workspaceReference: WORKSPACE, scope: "workspace", fence: 4 });
    expect(context.erasure.receiptFor(WORKSPACE)).toEqual(receipt);
  });

  it("blocks every read/command/fill path after the fence with zero regeneration", async () => {
    const { service, simulator, order, account } = await erasedHarness();
    // Read: the shell holds no personal data any more.
    const shell = await service.open({ requestRevision: "post" }, viewer()).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    expect(shell.orders).toHaveLength(0);
    expect(shell.cash).toHaveLength(0);
    expect(shell.positions).toHaveLength(0);
    // Command: the account no longer resolves; nothing is written.
    const cancel = await service.change({ kind: "cancel", account, order }, { idempotencyKey: "post-cxl", expectedRevision: "0" }, viewer());
    expect(cancel).toEqual({ status: "refused", reason: "unknown_account" });
    const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    expect(prepared).toEqual({ status: "refused", reason: "unknown_account" });
    // Fill: the simulator commits nothing behind the fence.
    expect(await simulator.ingest(WORKSPACE, account, observation({ evidenceReference: "evidence:post" }))).toEqual([]);
    expect(service.journal.currentRevision(WORKSPACE, account)).toBe(0);
  });

  it("suppresses a backup restore: a write at a pre-erasure epoch never lands", async () => {
    const { service, account } = await erasedHarness();
    const restore = await service.journal.appendSystem(WORKSPACE, account, "restore:genesis", {
      kind: "account_opened",
      seedCash: [{ amount: 100_000, currency: "USD" }],
    });
    expect(restore).toEqual({ status: "suppressed" });
    const shell = await service.open({ requestRevision: "post-restore" }, viewer()).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    expect(shell.cash).toHaveLength(0);
  });
});

describe("behavioral Actual↔Paper mutual invariance (AT-07, ADR A04)", () => {
  it("Paper submit/fill/cancel leaves every Actual public field byte-identical, and vice versa", async () => {
    const { service, simulator } = harness();
    const actualJournal = new ActualJournal(() => NOW);
    const actual = new ActualPortfolioService({
      journal: actualJournal,
      port: {
        quote: () => ({ status: "unavailable" as const }),
        fxRate: () => ({ status: "unavailable" as const }),
      } as never,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      policyVersion: "actual-v1",
      now: () => NOW,
      updateId: () => "actual-update",
    });
    const actualAccount = brandReference<string, "ActualAccountReference">("actual-account:iso");
    const record = actual.change(
      {
        kind: "record_opening_position",
        account: actualAccount as never,
        position: {
          instrument: brandReference<string, "ActualInstrumentReference">("instr:AAPL") as never,
          signedQuantity: 7,
          currency: "USD",
          asOf: "2026-07-01",
          source: brandReference<string, "ActualSourceReference">("source:manual") as never,
        },
      },
      { idempotencyKey: "iso-open", expectedRevision: "0" },
      viewer(),
    );
    expect(record.status).toBe("applied");
    const actualBefore = JSON.stringify(await actual.open({ sections: ["positions"], requestRevision: "iso" }, viewer()).initial);

    // Paper activity of every kind.
    const { order, account } = await submit(service, limitBuy(10, 110), "iso-paper");
    await simulator.ingest(WORKSPACE, account, observation());
    await service.change({ kind: "cancel", account, order }, { idempotencyKey: "iso-cxl", expectedRevision: "3" }, viewer());

    const actualAfter = JSON.stringify(await actual.open({ sections: ["positions"], requestRevision: "iso" }, viewer()).initial);
    expect(actualAfter).toBe(actualBefore);

    // And the other direction: Actual changes leave the Paper shell identical.
    const paperBefore = JSON.stringify(await service.open({ requestRevision: "iso-2" }, viewer()).initial);
    actual.change(
      {
        kind: "record_activity",
        account: actualAccount as never,
        activity: { activityKind: "cash_deposit", signedCashAmount: { amount: 500, currency: "USD" }, occurredAt: NOW, source: brandReference<string, "ActualSourceReference">("source:manual") as never },
      },
      { idempotencyKey: "iso-deposit", expectedRevision: "1" },
      viewer(),
    );
    const paperAfter = JSON.stringify(await service.open({ requestRevision: "iso-2" }, viewer()).initial);
    expect(paperAfter).toBe(paperBefore);
  });
});
