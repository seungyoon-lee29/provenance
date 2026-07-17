import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import type {
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 B2 — simulation-v1 Simulated Fill engine (spec §9, AT-07).
 *
 * Every expected number below is hand-worked from the spec formulas:
 *   slippage bps = min(25, 5 + 20 × participation), participation = cumulative
 *   allocated / observation volume, allocation capped at 10% of volume,
 *   adverse tick rounding (buy up / sell down, $0.01 tick).
 * The spec fixture: price $100 at full 10% participation → 7 bps →
 * buy 100.07 / sell 99.93. The production simulator is never imported to
 * produce an expected value.
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

function harness(nowRef: { value: string } = { value: NOW }) {
  let updateCounter = 0;
  const service = new PaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    observations: { currentObservation: () => undefined },
    policy: { policyVersion: "simulation-v1", seedCash: [{ amount: 100_000, currency: "USD" }], intentTtlMs: 600_000, maxSlippageBps: 25 },
    updateId: () => `update:${updateCounter += 1}`,
  });
  const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
  return { service, simulator, nowRef };
}

async function submit(service: PaperTradingService, payload: PaperOrderPayload, key: string) {
  const prepared = await service.prepare({ payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const outcome = service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey: key, expectedRevision: String(prepared.intent.accountRevision) },
    viewer(),
  );
  if (outcome.status !== "applied") throw new Error(`submit failed: ${outcome.status}`);
  return { order: outcome.order, account: prepared.intent.account };
}

async function shellOf(service: PaperTradingService) {
  const shell = await service.open({ requestRevision: "read" }, viewer()).initial;
  if (shell.status !== "ready") throw new Error("open failed");
  return shell;
}

describe("spec slippage fixture (§9: buy 100.07 / sell 99.93)", () => {
  it("fills a full-cap buy at $100.07 and books cash/position/reservation exactly", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(10, 110), "buy-fixture");
    const events = simulator.ingest(WORKSPACE, account, observation());
    // 10 shares = the full 10% of 100 volume → participation 0.1 → 7 bps.
    expect(events).toEqual([
      expect.objectContaining({ kind: "fill", order, quantity: 10, price: { amount: 100.07, currency: "USD" } }),
    ]);
    const shell = await shellOf(service);
    const view = shell.orders[0]!;
    expect(view.execution).toBe("filled");
    expect(view.filledQuantity).toBe(10);
    expect(view.fills).toHaveLength(1);
    expect(view.fills[0]!.eventTime).toBe("2026-07-18T02:01:00.000Z");
    expect(view.fills[0]!.receivedAt).toBe("2026-07-18T02:01:01.000Z");
    expect(view.fills[0]!.evidenceReference).toBe("evidence:obs-1");
    expect(view.fills[0]!.policyVersion).toBe("simulation-v1");
    // Hand-worked: 100,000 − 10 × 100.07 = 98,999.30, reservation fully released.
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.balance).toBeCloseTo(98_999.3, 10);
    expect(usd.reserved).toBe(0);
    const position = shell.positions[0]!;
    expect(position.quantity).toBe(10);
    expect(position.costBasis.amount).toBeCloseTo(1_000.7, 10);
  });

  it("fills a full-cap sell at $99.93", async () => {
    const { service, simulator } = harness();
    const buy = await submit(service, limitBuy(10, 110), "seed-buy");
    simulator.ingest(WORKSPACE, buy.account, observation());
    const sell = await submit(service, { ...limitBuy(10, 90), side: "sell" }, "sell-fixture");
    const events = simulator.ingest(WORKSPACE, sell.account, observation({ evidenceReference: "evidence:obs-2", eventTime: "2026-07-18T02:02:00.000Z", dataClock: "2026-07-18T02:02:00.000Z" }));
    expect(events).toEqual([
      expect.objectContaining({ kind: "fill", order: sell.order, quantity: 10, price: { amount: 99.93, currency: "USD" } }),
    ]);
    const shell = await shellOf(service);
    // 98,999.30 + 10 × 99.93 = 99,998.60; position and its reservation are gone.
    expect(shell.cash.find((row) => row.currency === "USD")!.balance).toBeCloseTo(99_998.6, 10);
    expect(shell.positions).toHaveLength(0);
  });
});

describe("volume participation cap (§9: 10%)", () => {
  it("caps a 25-share order at 10 shares per 100-volume observation and converges across observations", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(25, 110), "big-order");
    const first = simulator.ingest(WORKSPACE, account, observation({ evidenceReference: "evidence:v1" }));
    expect(first).toEqual([expect.objectContaining({ kind: "fill", quantity: 10 })]);
    let shell = await shellOf(service);
    expect(shell.orders[0]!.execution).toBe("partially_filled");
    expect(shell.orders[0]!.filledQuantity).toBe(10);

    const second = simulator.ingest(WORKSPACE, account, observation({ evidenceReference: "evidence:v2", eventTime: "2026-07-18T02:02:00.000Z", dataClock: "2026-07-18T02:02:00.000Z" }));
    expect(second).toEqual([expect.objectContaining({ kind: "fill", quantity: 10 })]);
    const third = simulator.ingest(WORKSPACE, account, observation({ evidenceReference: "evidence:v3", eventTime: "2026-07-18T02:03:00.000Z", dataClock: "2026-07-18T02:03:00.000Z" }));
    // Only 5 remain — allocation is bounded by the order, not the cap.
    expect(third).toEqual([expect.objectContaining({ kind: "fill", quantity: 5, order })]);
    shell = await shellOf(service);
    expect(shell.orders[0]!.execution).toBe("filled");
    expect(shell.orders[0]!.filledQuantity).toBe(25);
  });

  it("allocates deterministically by acceptedAt across two orders sharing one observation, with cumulative participation slippage", async () => {
    const nowRef = { value: NOW };
    const { service, simulator } = harness(nowRef);
    const first = await submit(service, limitBuy(6, 110), "alloc-a");
    nowRef.value = "2026-07-18T02:00:30.000Z";
    const second = await submit(service, limitBuy(10, 110), "alloc-b");
    const events = simulator.ingest(WORKSPACE, first.account, observation({ eventTime: "2026-07-18T02:01:00.000Z" }));
    // Cap 10: A (earlier acceptedAt) takes 6, B takes the remaining 4.
    // A: cumulative 6/100 = 0.06 → 5 + 1.2 = 6.2 bps → 100.062 → tick-up 100.07.
    // B: cumulative 10/100 = 0.10 → 7 bps → 100.07.
    expect(events).toEqual([
      expect.objectContaining({ kind: "fill", order: first.order, quantity: 6, price: { amount: 100.07, currency: "USD" } }),
      expect.objectContaining({ kind: "fill", order: second.order, quantity: 4, price: { amount: 100.07, currency: "USD" } }),
    ]);
    const shell = await shellOf(service);
    expect(shell.orders.find((view) => view.order === second.order)!.filledQuantity).toBe(4);
  });
});

describe("observation validity gates (§9)", () => {
  it("never fills from an observation whose event time is at or before acceptedAt", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "pre-event");
    const atAccepted = simulator.ingest(WORKSPACE, account, observation({ eventTime: NOW, dataClock: NOW }));
    const before = simulator.ingest(WORKSPACE, account, observation({ eventTime: "2026-07-18T01:59:00.000Z", dataClock: "2026-07-18T02:01:00.000Z", evidenceReference: "evidence:old" }));
    expect(atAccepted).toEqual([]);
    expect(before).toEqual([]);
    expect((await shellOf(service)).orders[0]!.filledQuantity).toBe(0);
  });

  it("evaluates a delayed feed only after its data clock passes acceptedAt", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(5, 110), "delayed");
    const tooEarly = simulator.ingest(WORKSPACE, account, observation({
      freshness: "delayed",
      eventTime: "2026-07-18T02:01:00.000Z",
      // The feed's clock has not yet passed the acceptance instant.
      dataClock: "2026-07-18T01:59:00.000Z",
      evidenceReference: "evidence:lagging",
    }));
    expect(tooEarly).toEqual([]);
    const caughtUp = simulator.ingest(WORKSPACE, account, observation({
      freshness: "delayed",
      eventTime: "2026-07-18T02:01:00.000Z",
      dataClock: "2026-07-18T02:05:00.000Z",
      evidenceReference: "evidence:caught-up",
    }));
    expect(caughtUp).toEqual([expect.objectContaining({ kind: "fill", order, quantity: 5 })]);
  });

  it("never fills from hard-expired evidence or a mismatched instrument/venue", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "gates");
    expect(simulator.ingest(WORKSPACE, account, observation({ freshness: "hard_expired", evidenceReference: "evidence:dead" }))).toEqual([]);
    expect(simulator.ingest(WORKSPACE, account, observation({ venue: "XKRX", evidenceReference: "evidence:other-venue" }))).toEqual([]);
    const msft = brandReference<string, "PaperInstrumentReference">("instr:MSFT") as PaperInstrumentReference;
    expect(simulator.ingest(WORKSPACE, account, observation({ instrument: msft, evidenceReference: "evidence:other-instr" }))).toEqual([]);
    expect((await shellOf(service)).orders[0]!.filledQuantity).toBe(0);
  });

  it("redelivery of the same observation is exactly-once: no second fill", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(10, 110), "dedupe");
    const first = simulator.ingest(WORKSPACE, account, observation({ volume: 50 }));
    // 10% of 50 → 5 shares filled.
    expect(first).toEqual([expect.objectContaining({ kind: "fill", quantity: 5 })]);
    const replay = simulator.ingest(WORKSPACE, account, observation({ volume: 50 }));
    expect(replay).toEqual([]);
    expect((await shellOf(service)).orders[0]!.filledQuantity).toBe(5);
  });
});

describe("limit guard (§9: slippage crossing the limit → fill 0)", () => {
  it("a marketable-looking limit buy at the observed price does not fill because slippage crosses it", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(10, 100), "at-market-limit");
    // Adjusted price 100.07 > limit 100 → fill 0, order stays open.
    expect(simulator.ingest(WORKSPACE, account, observation())).toEqual([]);
    const shell = await shellOf(service);
    expect(shell.orders[0]!.execution).toBe("open");
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(1_000);
  });

  it("a sell limit above the slippage-adjusted price does not fill", async () => {
    const { service, simulator } = harness();
    const buy = await submit(service, limitBuy(10, 110), "seed");
    simulator.ingest(WORKSPACE, buy.account, observation());
    const sell = await submit(service, { ...limitBuy(10, 99.94), side: "sell" }, "sell-tight");
    // Adjusted 99.93 < limit 99.94 → unfavorable → fill 0.
    const events = simulator.ingest(WORKSPACE, sell.account, observation({ evidenceReference: "evidence:s2", eventTime: "2026-07-18T02:02:00.000Z", dataClock: "2026-07-18T02:02:00.000Z" }));
    expect(events).toEqual([]);
  });
});

describe("DAY expiry (§9 time in force)", () => {
  it("expires an open DAY order on a later-day observation instead of filling it, releasing the reservation", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, { ...limitBuy(10, 110), timeInForce: "DAY" }, "day-order");
    const events = simulator.ingest(WORKSPACE, account, observation({
      eventTime: "2026-07-19T14:30:00.000Z",
      dataClock: "2026-07-19T14:30:00.000Z",
      evidenceReference: "evidence:next-day",
    }));
    expect(events).toEqual([expect.objectContaining({ kind: "expired", order })]);
    const shell = await shellOf(service);
    expect(shell.orders[0]!.execution).toBe("expired");
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(0);
    // Expiry redelivery is a no-op.
    expect(simulator.ingest(WORKSPACE, account, observation({ eventTime: "2026-07-19T15:00:00.000Z", dataClock: "2026-07-19T15:00:00.000Z", evidenceReference: "evidence:later" }))).toEqual([]);
  });

  it("a GTC order survives the day boundary and fills next day", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(5, 110), "gtc-order");
    const events = simulator.ingest(WORKSPACE, account, observation({
      eventTime: "2026-07-19T14:30:00.000Z",
      dataClock: "2026-07-19T14:30:00.000Z",
      evidenceReference: "evidence:next-day",
    }));
    expect(events).toEqual([expect.objectContaining({ kind: "fill", order, quantity: 5 })]);
  });
});

describe("market order (§9)", () => {
  it("fills a market buy at the slippage-adjusted price within the reservation bound", async () => {
    let updateCounter = 0;
    // Reservation bounding uses the service's observation port at submit.
    const service = new PaperTradingService({
      now: () => NOW,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      observations: { currentObservation: () => observation({ eventTime: "2026-07-18T01:59:00.000Z", dataClock: "2026-07-18T01:59:00.000Z", evidenceReference: "evidence:quote" }) },
      policy: { policyVersion: "simulation-v1", seedCash: [{ amount: 100_000, currency: "USD" }], intentTtlMs: 600_000, maxSlippageBps: 25 },
      updateId: () => `update:${updateCounter += 1}`,
    });
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const market: PaperOrderPayload = { ...limitBuy(10, 1), orderType: "market", limitPrice: undefined };
    const prepared = await service.prepare({ payload: market }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const submitted = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "market-buy", expectedRevision: "1" },
      viewer(),
    );
    if (submitted.status !== "applied") throw new Error(`submit failed: ${submitted.status}`);
    // Reservation bound: 100 × 1.0025 = 100.25/share → $1,002.50 reserved.
    const shellBefore = await service.open({ requestRevision: "r" }, viewer()).initial;
    if (shellBefore.status !== "ready") throw new Error("open failed");
    expect(shellBefore.cash.find((row) => row.currency === "USD")!.reserved).toBeCloseTo(1_002.5, 10);
    const events = simulator.ingest(WORKSPACE, prepared.intent.account, observation());
    expect(events).toEqual([expect.objectContaining({ kind: "fill", order: submitted.order, quantity: 10, price: { amount: 100.07, currency: "USD" } })]);
  });
});
