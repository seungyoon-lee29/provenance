import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext, ViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import { PaperTradingErasure } from "../src/modules/paper-trading/internal/paper-erasure";
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

// The behavioral Actual↔Paper mutual-invariance test (AT-07, ADR A04) was
// removed with Stage 2 T4: actual-portfolio no longer has a stateful ledger
// (baseline/journal deleted) to be invariant against — only pure calculation
// functions remain. The structural isolation (no shared imports) is still
// pinned by f6-actual-paper-isolation and actual-paper-isolation.property.
