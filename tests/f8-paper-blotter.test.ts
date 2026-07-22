import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import { PaperLifecycleIngestion } from "../src/modules/paper-trading/internal/lifecycle";
import { presentBlotter } from "../src/modules/paper-trading/internal/blotter";
import type {
  PaperCorporateActionReference,
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 B5 — Paper Blotter presentation (spec §9, UF-07): submit/fill/cancel/
 * reject/expiry in journal-time order, Internal Paper records only. The row
 * kinds form a closed union — an Actual or Live record has no representation.
 */

const NOW = "2026-07-18T02:00:00.000Z";

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:a"),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;
const WORKSPACE = "workspace:a";

function limitBuy(quantity: number, limit: number, timeInForce: "DAY" | "GTC" = "GTC"): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce,
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

describe("Paper Blotter presentation (§9/UF-07)", () => {
  it("shows submit/fill/cancel/expiry rows in journal order with account source and both fill times", async () => {
    const nowRef = { value: NOW };
    let updateCounter = 0;
    const service = new PaperTradingService({
      now: () => nowRef.value,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      observations: { currentObservation: () => undefined },
      policy: { policyVersion: "simulation-v1", seedCash: [{ amount: 100_000, currency: "USD" }], intentTtlMs: 600_000, maxSlippageBps: 25 },
      updateId: () => `update:${updateCounter += 1}`,
    });
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });

    // a: GTC 25 — partially filled (10 of 25) so its cancel confirms.
    const a = await submit(service, limitBuy(25, 110), "bl-a");
    // b: DAY, limit 120 — gets nothing from obs-1 (a consumed the full 10% cap).
    const b = await submit(service, limitBuy(4, 120, "DAY"), "bl-b");
    await simulator.ingest(WORKSPACE, a.account, observation());
    nowRef.value = "2026-07-18T02:05:00.000Z";
    const cancel = await service.change({ kind: "cancel", account: a.account, order: a.order }, { idempotencyKey: "bl-cxl", expectedRevision: "4" }, viewer());
    expect(cancel.status).toBe("applied");
    // Next-day observation expires the DAY order (a is GTC + cancelled → untouched).
    await simulator.ingest(WORKSPACE, a.account, observation({ eventTime: "2026-07-19T14:30:00.000Z", dataClock: "2026-07-19T14:30:00.000Z", evidenceReference: "evidence:next-day" }));
    await lifecycle.applyDividend(WORKSPACE, a.account, {
      action: brandReference<string, "PaperCorporateActionReference">("action:div") as PaperCorporateActionReference,
      instrument: AAPL,
      perShare: { amount: 0.5, currency: "USD" },
    });

    const rows = presentBlotter(service.journal.list(WORKSPACE, a.account));
    // Hand-worked journal order (genesis excluded from the blotter):
    expect(rows.map((row) => row.kind)).toEqual(["submit", "submit", "fill", "cancel_confirmed", "expiry", "dividend"]);
    expect(rows[0]!.order).toBe(a.order);
    expect(rows[1]!.order).toBe(b.order);
    const fillRow = rows.find((row) => row.kind === "fill" && row.order === a.order)!;
    expect(fillRow.quantity).toBe(10);
    expect(fillRow.price).toEqual({ amount: 100.07, currency: "USD" });
    expect(fillRow.eventTime).toBe("2026-07-18T02:01:00.000Z");
    expect(fillRow.receivedAt).toBe("2026-07-18T02:01:01.000Z");
    const cancelRow = rows.find((row) => row.kind === "cancel_confirmed")!;
    expect(cancelRow.order).toBe(a.order);
    const expiryRow = rows.find((row) => row.kind === "expiry")!;
    expect(expiryRow.order).toBe(b.order);
    const dividendRow = rows.find((row) => row.kind === "dividend")!;
    expect(dividendRow.quantity).toBeUndefined();
    // Every row names its Internal Paper account source.
    for (const row of rows) expect(String(row.account)).toBe(String(a.account));
    // No genesis/account row leaks into the blotter.
    expect(rows.some((row) => (row.kind as string) === "account_opened")).toBe(false);
    // Journal-time order is non-decreasing.
    const revisions = rows.map((row) => row.revision);
    expect([...revisions].sort((x, y) => x - y)).toEqual(revisions);
  });
});
