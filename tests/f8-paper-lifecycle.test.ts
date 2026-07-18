import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import { PaperLifecycleIngestion } from "../src/modules/paper-trading/internal/lifecycle";
import type {
  PaperCorporateActionReference,
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 B3 — server-only lifecycle ingestion + late/duplicate/concurrent
 * invariants (spec §9, AT-06/07).
 *
 * The spec's own 2:1 split policy fixture is the oracle: an open GTC
 * `5주 @ $110` becomes `10주 @ $55` — order event, Paper Reservation, position
 * and basis flip all-old/all-new in ONE account transaction, and a redelivery
 * of the same Corporate Action is a no-op. Expected values are hand-worked.
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

function actionReference(id: string): PaperCorporateActionReference {
  return brandReference<string, "PaperCorporateActionReference">(id) as PaperCorporateActionReference;
}

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
  const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });
  return { service, simulator, lifecycle, nowRef };
}

async function submit(service: PaperTradingService, payload: PaperOrderPayload, key: string, expectedRevision?: string) {
  const prepared = await service.prepare({ payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const outcome = service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey: key, expectedRevision: expectedRevision ?? String(prepared.intent.accountRevision) },
    viewer(),
  );
  if (outcome.status !== "applied") throw new Error(`submit failed: ${outcome.status}`);
  return { order: outcome.order, account: prepared.intent.account, revision: outcome.revision };
}

async function shellOf(service: PaperTradingService) {
  const shell = await service.open({ requestRevision: "read" }, viewer()).initial;
  if (shell.status !== "ready") throw new Error("open failed");
  return shell;
}

describe("2:1 split policy fixture (§9/AT-06)", () => {
  it("transforms an open GTC 5주 @ $110 into 10주 @ $55 with the reservation, in one transaction, and redelivery is a no-op", async () => {
    const { service, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "gtc-5");
    const before = await shellOf(service);
    // All-old: 5 @ $110, $550 reserved.
    expect(before.orders[0]!.payload.quantity).toBe(5);
    expect(before.orders[0]!.payload.limitPrice).toEqual({ amount: 110, currency: "USD" });
    expect(before.cash.find((row) => row.currency === "USD")!.reserved).toBe(550);

    const applied = lifecycle.applySplit(WORKSPACE, account, {
      action: actionReference("action:split-2-1"),
      instrument: AAPL,
      numerator: 2,
      denominator: 1,
    });
    expect(applied.status).toBe("applied");

    // All-new in one revision: 10 @ $55, reservation still exactly $550.
    const after = await shellOf(service);
    const order = after.orders[0]!;
    expect(order.payload.quantity).toBe(10);
    expect(order.payload.limitPrice).toEqual({ amount: 55, currency: "USD" });
    expect(order.execution).toBe("open");
    expect(after.cash.find((row) => row.currency === "USD")!.reserved).toBe(550);

    const replay = lifecycle.applySplit(WORKSPACE, account, {
      action: actionReference("action:split-2-1"),
      instrument: AAPL,
      numerator: 2,
      denominator: 1,
    });
    expect(replay.status).toBe("duplicate");
    const unchanged = await shellOf(service);
    expect(unchanged.orders[0]!.payload.quantity).toBe(10);
    expect(service.journal.currentRevision(WORKSPACE, account)).toBe(3);
  });

  it("scales a position's quantity while preserving its raw cost basis exactly once", async () => {
    const { service, simulator, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(10, 110), "seed-position");
    simulator.ingest(WORKSPACE, account, observation());
    const before = await shellOf(service);
    // Hand-worked from the B2 fixture: 10 shares, basis 10 × 100.07 = $1,000.70.
    expect(before.positions[0]!.quantity).toBe(10);
    expect(before.positions[0]!.costBasis.amount).toBeCloseTo(1_000.7, 10);

    lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-b"), instrument: AAPL, numerator: 2, denominator: 1 });
    const after = await shellOf(service);
    expect(after.positions[0]!.quantity).toBe(20);
    // Raw basis is NOT doubled — the adjustment applies exactly once to quantity.
    expect(after.positions[0]!.costBasis.amount).toBeCloseTo(1_000.7, 10);
  });

  it("scales a partially filled order's remaining quantity, filled quantity and reservation coherently", async () => {
    const { service, simulator, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(25, 110), "partial");
    simulator.ingest(WORKSPACE, account, observation());
    // 10 of 25 filled; remaining 15 × $110 = $1,650 reserved.
    const before = await shellOf(service);
    expect(before.orders[0]!.filledQuantity).toBe(10);
    expect(before.cash.find((row) => row.currency === "USD")!.reserved).toBeCloseTo(1_650, 10);

    lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-c"), instrument: AAPL, numerator: 2, denominator: 1 });
    const after = await shellOf(service);
    const order = after.orders[0]!;
    // 50 total, 20 filled, remaining 30 × $55 = $1,650 — value invariant holds.
    expect(order.payload.quantity).toBe(50);
    expect(order.filledQuantity).toBe(20);
    expect(order.execution).toBe("partially_filled");
    expect(after.cash.find((row) => row.currency === "USD")!.reserved).toBeCloseTo(1_650, 10);
    // The 10 filled shares became 20 (position side of the same transaction).
    expect(after.positions[0]!.quantity).toBe(20);
  });

  it("fails closed on a split that would create fractional shares and on invalid factors", async () => {
    const { service, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "frac");
    // 3:2 on 5 shares → 7.5: refused, nothing changes.
    const fractional = lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-3-2"), instrument: AAPL, numerator: 3, denominator: 2 });
    expect(fractional).toEqual({ status: "refused", reason: "fractional_result" });
    const invalid = lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-bad"), instrument: AAPL, numerator: 0, denominator: 1 });
    expect(invalid).toEqual({ status: "refused", reason: "invalid_adjustment" });
    const shell = await shellOf(service);
    expect(shell.orders[0]!.payload.quantity).toBe(5);
    expect(service.journal.currentRevision(WORKSPACE, account)).toBe(2);
  });

  it("redelivers an applied 3:2 split as a duplicate no-op even though the post-split state would no longer validate", async () => {
    const { service, simulator, lifecycle } = harness();
    // Fully filled 10-share position (B2 fixture) — no open orders, so only the
    // position path is exercised: 10 × 3/2 = 15 is integral and applies.
    const { account } = await submit(service, limitBuy(10, 110), "redeliver-3-2");
    simulator.ingest(WORKSPACE, account, observation());
    const applied = lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-3-2-again"), instrument: AAPL, numerator: 3, denominator: 2 });
    expect(applied.status).toBe("applied");
    expect((await shellOf(service)).positions[0]!.quantity).toBe(15);

    // §9: the Corporate Action reference IS the identity, so redelivery must be
    // a duplicate no-op — never re-validated against the already-transformed
    // state (15 × 3/2 = 22.5 would misreport fractional_result).
    const replay = lifecycle.applySplit(WORKSPACE, account, { action: actionReference("action:split-3-2-again"), instrument: AAPL, numerator: 3, denominator: 2 });
    expect(replay).toEqual({ status: "duplicate" });
    expect((await shellOf(service)).positions[0]!.quantity).toBe(15);
  });
});

describe("dividend entitlement (§9)", () => {
  it("credits per-share cash for the held position, exactly once across redeliveries", async () => {
    const { service, simulator, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(10, 110), "div-seed");
    simulator.ingest(WORKSPACE, account, observation());
    const balanceBefore = (await shellOf(service)).cash.find((row) => row.currency === "USD")!.balance;

    const applied = lifecycle.applyDividend(WORKSPACE, account, {
      action: actionReference("action:div-1"),
      instrument: AAPL,
      perShare: { amount: 0.5, currency: "USD" },
    });
    expect(applied.status).toBe("applied");
    const replay = lifecycle.applyDividend(WORKSPACE, account, {
      action: actionReference("action:div-1"),
      instrument: AAPL,
      perShare: { amount: 0.5, currency: "USD" },
    });
    expect(replay.status).toBe("duplicate");

    const shell = await shellOf(service);
    // 10 shares × $0.50 = exactly $5.00, once.
    expect(shell.cash.find((row) => row.currency === "USD")!.balance).toBeCloseTo(balanceBefore + 5, 10);
    // Dividends move cash only — the position is untouched.
    expect(shell.positions[0]!.quantity).toBe(10);
    expect(shell.positions[0]!.costBasis.amount).toBeCloseTo(1_000.7, 10);
  });

  it("credits nothing without a position and refuses a non-positive rate", async () => {
    const { service, lifecycle } = harness();
    const { account } = await submit(service, limitBuy(1, 10), "no-pos");
    const applied = lifecycle.applyDividend(WORKSPACE, account, {
      action: actionReference("action:div-empty"),
      instrument: AAPL,
      perShare: { amount: 0.5, currency: "USD" },
    });
    // Recorded idempotently, but no cash moves for a zero position.
    expect(applied.status).toBe("applied");
    const invalid = lifecycle.applyDividend(WORKSPACE, account, {
      action: actionReference("action:div-neg"),
      instrument: AAPL,
      perShare: { amount: -1, currency: "USD" },
    });
    expect(invalid).toEqual({ status: "refused", reason: "invalid_adjustment" });
    const shell = await shellOf(service);
    expect(shell.cash.find((row) => row.currency === "USD")!.balance).toBe(100_000);
  });
});

describe("late valid fill after confirmed cancellation (§9)", () => {
  it("applies a fill whose event time precedes the cancellation exactly once, and never one after it", async () => {
    const nowRef = { value: NOW };
    const { service, simulator, nowRef: clock } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(10, 110), "late-fill");
    // Cancellation confirmed at 02:05.
    clock.value = "2026-07-18T02:05:00.000Z";
    const cancel = service.change({ kind: "cancel", account, order }, { idempotencyKey: "cxl", expectedRevision: "2" }, viewer());
    expect(cancel.status).toBe("applied");
    expect((await shellOf(service)).cash.find((row) => row.currency === "USD")!.reserved).toBe(0);

    // A late observation from 02:01 (after acceptance, before cancellation).
    const late = observation({ eventTime: "2026-07-18T02:01:00.000Z", dataClock: "2026-07-18T02:06:00.000Z", receivedAt: "2026-07-18T02:06:00.000Z", evidenceReference: "evidence:late" });
    const events = simulator.ingest(WORKSPACE, account, late);
    expect(events).toEqual([expect.objectContaining({ kind: "fill", order, quantity: 10 })]);
    // Exactly once: redelivery is silent.
    expect(simulator.ingest(WORKSPACE, account, late)).toEqual([]);

    // An observation from after the cancellation instant never fills.
    const post = observation({ eventTime: "2026-07-18T02:07:00.000Z", dataClock: "2026-07-18T02:07:00.000Z", evidenceReference: "evidence:post-cancel" });
    expect(simulator.ingest(WORKSPACE, account, post)).toEqual([]);

    const shell = await shellOf(service);
    const view = shell.orders[0]!;
    // Independent axes: execution completed while cancellation stays confirmed.
    expect(view.execution).toBe("filled");
    expect(view.cancellation).toBe("confirmed");
    expect(shell.positions[0]!.quantity).toBe(10);
  });
});

describe("post-cancellation observations never fill (§9)", () => {
  it("an unfilled cancelled order ignores observations from after the cancellation instant", async () => {
    const nowRef = { value: NOW };
    const { service, simulator } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(10, 110), "cxl-then-obs");
    nowRef.value = "2026-07-18T02:05:00.000Z";
    const cancel = service.change({ kind: "cancel", account, order }, { idempotencyKey: "cxl", expectedRevision: "2" }, viewer());
    expect(cancel.status).toBe("applied");
    const post = observation({ eventTime: "2026-07-18T02:07:00.000Z", dataClock: "2026-07-18T02:07:00.000Z", evidenceReference: "evidence:after-cxl" });
    expect(simulator.ingest(WORKSPACE, account, post)).toEqual([]);
    const shell = await shellOf(service);
    expect(shell.orders[0]!.filledQuantity).toBe(0);
    expect(shell.positions).toHaveLength(0);
  });
});

describe("cancel rejection keeps state intact (§9)", () => {
  it("a cancel on a filled order records a rejection and resurrects nothing", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(10, 110), "cxl-filled");
    simulator.ingest(WORKSPACE, account, observation());
    const before = await shellOf(service);
    const cancel = service.change({ kind: "cancel", account, order }, { idempotencyKey: "cxl-late", expectedRevision: "3" }, viewer());
    expect(cancel.status).toBe("applied");
    const after = await shellOf(service);
    expect(after.orders[0]!.cancellation).toBe("rejected");
    expect(after.orders[0]!.execution).toBe("filled");
    expect(after.cash).toEqual(before.cash);
    expect(after.positions).toEqual(before.positions);
  });
});

describe("concurrent funds invariant (AT-07)", () => {
  it("keeps available = balance − reserved consistent across submit → partial fill → submit", async () => {
    const { service, simulator } = harness();
    // A: 900 × $101 → $90,900 reserved, $9,100 available.
    const a = await submit(service, limitBuy(900, 101), "cf-a");
    simulator.ingest(WORKSPACE, a.account, observation({ volume: 100, evidenceReference: "evidence:cf-1" }));
    // Filled 10 @ 100.07 (≤ limit 101) → balance 98,999.30,
    // remaining 890 × $101 = $89,890 reserved, available $9,109.30.
    const shell = await shellOf(service);
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.balance).toBeCloseTo(98_999.3, 10);
    expect(usd.reserved).toBeCloseTo(89_890, 10);
    expect(usd.available).toBeCloseTo(9_109.3, 10);

    // B: 92 × $100 = $9,200 > $9,109.30 available → refused, zero side effects.
    const preparedB = await service.prepare({ payload: limitBuy(92, 100) }, viewer());
    if (preparedB.status !== "issued") throw new Error("prepare failed");
    const b = service.change(
      { kind: "submit", account: preparedB.intent.account, intent: preparedB.intent.reference },
      { idempotencyKey: "cf-b", expectedRevision: String(preparedB.intent.accountRevision) },
      viewer(),
    );
    expect(b).toEqual({ status: "refused", reason: "insufficient_cash" });

    // C: 91 × $100 = $9,100 ≤ $9,109.30 → applied.
    const c = await submit(service, limitBuy(91, 100), "cf-c");
    expect(c.order).toBeDefined();
    const finalShell = await shellOf(service);
    const finalUsd = finalShell.cash.find((row) => row.currency === "USD")!;
    expect(finalUsd.reserved).toBeCloseTo(98_990, 10);
    // The invariant the CAS protects: reserved never exceeds balance.
    expect(finalUsd.reserved).toBeLessThanOrEqual(finalUsd.balance);
  });
});

describe("three-axis literal trace (AT-07)", () => {
  it("records the exact axis tuple at every step of submit → partial fill → cancel → late fill", async () => {
    const nowRef = { value: NOW };
    const { service, simulator } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(20, 110), "trace");
    const at = async () => {
      const view = (await shellOf(service)).orders.find((row) => row.order === order)!;
      return [view.submission, view.execution, view.cancellation] as const;
    };
    expect(await at()).toEqual(["acknowledged", "open", "none"]);

    simulator.ingest(WORKSPACE, account, observation({ volume: 100, evidenceReference: "evidence:t1" }));
    expect(await at()).toEqual(["acknowledged", "partially_filled", "none"]);

    nowRef.value = "2026-07-18T02:05:00.000Z";
    service.change({ kind: "cancel", account, order }, { idempotencyKey: "trace-cxl", expectedRevision: "3" }, viewer());
    expect(await at()).toEqual(["acknowledged", "partially_filled", "confirmed"]);

    const late = observation({ eventTime: "2026-07-18T02:02:00.000Z", dataClock: "2026-07-18T02:06:00.000Z", evidenceReference: "evidence:t2" });
    simulator.ingest(WORKSPACE, account, late);
    // The late valid fill completes execution while cancellation stays
    // confirmed — the axes are independent by construction.
    expect(await at()).toEqual(["acknowledged", "filled", "confirmed"]);
    const shell = await shellOf(service);
    expect(shell.orders.find((row) => row.order === order)!.filledQuantity).toBe(20);
  });
});
