import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import type {
  PaperFillIdentity,
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 — journal-boundary defense (codex panel finding, money axis).
 *
 * The journal is the ONLY mutation path for Paper cash/positions, and it is
 * reachable as a module-public surface (service.journal; F9 builds on it).
 * The §9 invariants (overspend/oversell 0, fills only into fillable orders,
 * genesis once, whole-share lots) must therefore hold AT THE JOURNAL
 * BOUNDARY, not merely inside the simulator's own guards. These tests replay
 * the panel's forged-fill attack verbatim and pin the boundary contract.
 */

const NOW = "2026-07-18T02:00:00.000Z";
const WORKSPACE = "workspace:a";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
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

function limitSell(quantity: number, limit: number): PaperOrderPayload {
  return { ...limitBuy(quantity, limit), side: "sell" };
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
  const outcome = await service.change(
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

function forgedFill(order: string, quantity: number, price: number, overrides?: Partial<{ eventTime: string; identity: string }>) {
  return {
    kind: "fill_applied" as const,
    fill: {
      identity: brandReference<string, "PaperFillIdentity">(overrides?.identity ?? `forged:${order}`) as PaperFillIdentity,
      order: brandReference<string, "PaperOrderReference">(order),
      quantity,
      price: { amount: price, currency: "USD" },
      eventTime: overrides?.eventTime ?? "2026-07-18T02:01:00.000Z",
      receivedAt: "2026-07-18T02:01:01.000Z",
      evidenceReference: "evidence:forged",
      policyVersion: "simulation-v1",
    },
  };
}

describe("journal boundary refuses unaffordable/forged fills (§9 overspend 0)", () => {
  it("replays the panel attack: a fill costing more than the seed after a confirmed cancel is refused, cash never goes negative", async () => {
    const nowRef = { value: NOW };
    const { service } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(10, 110), "panel-attack");
    nowRef.value = "2026-07-18T02:05:00.000Z";
    const cancel = await service.change({ kind: "cancel", account, order }, { idempotencyKey: "panel-cxl", expectedRevision: "2" }, viewer());
    expect(cancel.status).toBe("applied");

    // The panel's forged fill: 10 shares at a price that overdraws the account
    // ($10,000.10 × 10 = $100,001 > $100,000), event time before cancellation.
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "panel-forged-fill", forgedFill(String(order), 10, 10_000.1, { eventTime: "2026-07-18T02:01:00.000Z" }));
    expect(outcome.status).toBe("refused");
    const shell = await shellOf(service);
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.balance).toBe(100_000);
    expect(usd.available).toBeGreaterThanOrEqual(0);
    expect(shell.positions).toHaveLength(0);
    expect(shell.orders[0]!.filledQuantity).toBe(0);
  });

  it("still allows the legitimate late valid fill through the boundary (§9 must not regress)", async () => {
    const nowRef = { value: NOW };
    const { service } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(10, 110), "legit-late");
    nowRef.value = "2026-07-18T02:05:00.000Z";
    await service.change({ kind: "cancel", account, order }, { idempotencyKey: "legit-cxl", expectedRevision: "2" }, viewer());
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "legit-late-fill", forgedFill(String(order), 10, 100.07, { eventTime: "2026-07-18T02:01:00.000Z" }));
    expect(outcome.status).toBe("applied");
    const shell = await shellOf(service);
    expect(shell.positions[0]!.quantity).toBe(10);
  });

  it("refuses a fill whose event time is at/after the confirmed cancellation or at/before acceptance", async () => {
    const nowRef = { value: NOW };
    const { service } = harness(nowRef);
    const { order, account } = await submit(service, limitBuy(10, 110), "time-guards");
    nowRef.value = "2026-07-18T02:05:00.000Z";
    await service.change({ kind: "cancel", account, order }, { idempotencyKey: "tg-cxl", expectedRevision: "2" }, viewer());
    const postCancel = await service.journal.appendSystem(WORKSPACE, account, "tg-post", forgedFill(String(order), 1, 100, { eventTime: "2026-07-18T02:06:00.000Z", identity: "tg-post" }));
    expect(postCancel.status).toBe("refused");
    const preAccept = await service.journal.appendSystem(WORKSPACE, account, "tg-pre", forgedFill(String(order), 1, 100, { eventTime: NOW, identity: "tg-pre" }));
    expect(preAccept.status).toBe("refused");
    expect((await shellOf(service)).orders[0]!.filledQuantity).toBe(0);
  });

  it("refuses over-quantity fills, fills for unknown orders and non-positive quantities/prices", async () => {
    const { service } = harness();
    const { order, account } = await submit(service, limitBuy(10, 110), "qty-guards");
    expect((await service.journal.appendSystem(WORKSPACE, account, "q1", forgedFill(String(order), 11, 100, { identity: "q1" }))).status).toBe("refused");
    expect((await service.journal.appendSystem(WORKSPACE, account, "q2", forgedFill("paper-order:nope:9", 1, 100, { identity: "q2" }))).status).toBe("refused");
    expect((await service.journal.appendSystem(WORKSPACE, account, "q3", forgedFill(String(order), 0, 100, { identity: "q3" }))).status).toBe("refused");
    expect((await service.journal.appendSystem(WORKSPACE, account, "q4", forgedFill(String(order), 1, -5, { identity: "q4" }))).status).toBe("refused");
    expect((await shellOf(service)).orders[0]!.filledQuantity).toBe(0);
  });

  it("a redelivered dedupe key stays duplicate even though validation would now refuse it", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(10, 110), "dup-guard");
    await simulator.ingest(WORKSPACE, account, observation());
    // The order is now filled; replaying the SAME fill identity must answer
    // duplicate (converged), not refused.
    const identity = `fill:${String(order)}:evidence:obs-1`;
    const replay = await service.journal.appendSystem(WORKSPACE, account, identity, forgedFill(String(order), 10, 100.07, { identity }));
    expect(replay).toEqual({ status: "duplicate" });
  });
});

describe("journal boundary enforces the (post-split) limit on fills (codex lifecycle-axis findings)", () => {
  async function splitOrder(service: PaperTradingService) {
    const { order, account } = await submit(service, limitBuy(5, 110), "split-limit");
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "action:boundary-split", {
      kind: "corporate_action_applied",
      action: brandReference<string, "PaperCorporateActionReference">("action:boundary-split") as never,
      instrument: AAPL,
      adjustment: { kind: "split", numerator: 2, denominator: 1 },
    });
    if (outcome.status !== "applied") throw new Error("split failed");
    return { order, account };
  }

  it("refuses a stale pre-split-priced fill (5 @ $110 against the converted 10 @ $55 order)", async () => {
    const { service } = harness();
    const { order, account } = await splitOrder(service);
    const stale = await service.journal.appendSystem(WORKSPACE, account, "stale-price", forgedFill(String(order), 5, 110, { identity: "stale-price" }));
    expect(stale.status).toBe("refused");
    const shell = await shellOf(service);
    expect(shell.positions).toHaveLength(0);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(550);
  });

  it("refuses an over-limit fill (10 @ $56 > $55) but accepts an at-limit fill", async () => {
    const { service } = harness();
    const { order, account } = await splitOrder(service);
    const over = await service.journal.appendSystem(WORKSPACE, account, "over-limit", forgedFill(String(order), 10, 56, { identity: "over-limit" }));
    expect(over.status).toBe("refused");
    const atLimit = await service.journal.appendSystem(WORKSPACE, account, "at-limit", forgedFill(String(order), 10, 55, { identity: "at-limit" }));
    expect(atLimit.status).toBe("applied");
    const shell = await shellOf(service);
    // Money conservation: exactly 10 × $55 = $550 spent, reservation released.
    expect(shell.cash.find((row) => row.currency === "USD")!.balance).toBe(99_450);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(0);
    expect(shell.positions[0]!.quantity).toBe(10);
  });
});

describe("journal boundary bounds a split's cash reservation by the balance (OF-6)", () => {
  async function splitFor(service: PaperTradingService, account: Parameters<typeof service.journal.appendSystem>[1], key: string, numerator: number) {
    return service.journal.appendSystem(WORKSPACE, account, key, {
      kind: "corporate_action_applied",
      action: brandReference<string, "PaperCorporateActionReference">(`action:${key}`) as never,
      instrument: AAPL,
      adjustment: { kind: "split", numerator, denominator: 1 },
    });
  }

  it("stops the runaway reservation at the balance: repeated 2:1 splits on a 1¢ order refuse once the hold would exceed the cash", async () => {
    // The original OF-6 probe drove `reserved` to 2^53 with 53 of these while
    // the balance never moved. The hold may now grow (a ceiling remainder is
    // unavoidable when an odd cent is halved) but never past its own backing.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(1, 0.01), "of6-runaway");
    const usd = async () => (await shellOf(service)).cash.find((row) => row.currency === "USD")!;

    let applied = 0;
    let refusal: unknown;
    for (let i = 0; i < 53; i += 1) {
      const outcome = await splitFor(service, account, `of6-runaway-${i}`, 2);
      if (outcome.status !== "applied") { refusal = outcome; break; }
      applied += 1;
      const cash = await usd();
      expect(cash.reserved).toBeLessThanOrEqual(cash.balance);
    }
    expect(refusal).toEqual({ status: "refused", reason: "reservation_exceeds_balance" });
    expect(applied).toBeLessThan(53);
    const cash = await usd();
    expect(cash.reserved).toBeLessThanOrEqual(cash.balance);
  });

  it("accepts an ordinary split at an ODD cent — exact conservation would have refused half of all prices", async () => {
    // 100 @ $101.03 → 200 @ $50.52 (ceil of 50.515). The hold moves 1010300¢ →
    // 1010400¢: one minor unit per share of ceiling remainder, the account's own
    // cash, still backed by the balance.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(100, 101.03), "of6-odd");
    expect((await shellOf(service)).cash.find((row) => row.currency === "USD")!.reserved).toBe(10_103);

    expect((await splitFor(service, account, "of6-odd-split", 2)).status).toBe("applied");
    const shell = await shellOf(service);
    expect(shell.orders[0]!.payload.quantity).toBe(200);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(10_104);
  });

  it("refuses a 3:1 split that would leave a 1¢ limit BUY unfillable at 0¢ (the cash ceiling does not imply this)", async () => {
    const { service } = harness();
    const { account } = await submit(service, limitBuy(3, 0.01), "of6-zero");
    expect(await splitFor(service, account, "of6-zero-split", 3)).toEqual({
      status: "refused",
      reason: "fractional_result",
    });
  });

  it("refuses a 3:1 split that would leave a 1¢ limit SELL unfillable (its reservation is shares, so the cash ceiling cannot see it)", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(10, 110), "of6-sell-seed");
    await simulator.ingest(WORKSPACE, account, observation());
    await submit(service, limitSell(1, 0.01), "of6-sell");

    const outcome = await service.journal.appendSystem(WORKSPACE, account, "of6-sell-split", {
      kind: "corporate_action_applied",
      action: brandReference<string, "PaperCorporateActionReference">("action:of6-sell") as never,
      instrument: AAPL,
      adjustment: { kind: "split", numerator: 3, denominator: 1 },
    });
    expect(outcome).toEqual({ status: "refused", reason: "fractional_result" });
    expect((await shellOf(service)).positions[0]!.quantity).toBe(10);
  });
});

describe("journal boundary refuses other forged system events", () => {
  it("refuses expiry on a filled order", async () => {
    const { service, simulator } = harness();
    const { order, account } = await submit(service, limitBuy(10, 110), "exp-guard");
    await simulator.ingest(WORKSPACE, account, observation());
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "forged-expiry", { kind: "order_expired", order });
    expect(outcome.status).toBe("refused");
    expect((await shellOf(service)).orders[0]!.execution).toBe("filled");
  });

  it("refuses a second genesis and command-only bodies on the system path", async () => {
    const { service } = harness();
    const { account } = await submit(service, limitBuy(1, 10), "genesis-guard");
    const reseed = await service.journal.appendSystem(WORKSPACE, account, "second-genesis", {
      kind: "account_opened",
      seedCash: [{ amount: 1_000_000, currency: "USD" }],
    });
    expect(reseed.status).toBe("refused");
    expect((await shellOf(service)).cash.find((row) => row.currency === "USD")!.balance).toBe(100_000);

    const smuggledSubmit = await service.journal.appendSystem(WORKSPACE, account, "smuggled", {
      kind: "order_submitted",
      order: brandReference<string, "PaperOrderReference">("paper-order:smuggled:1"),
      payload: limitBuy(1, 10),
      acceptedAt: NOW,
      reservation: { kind: "cash", unitPrice: { amount: 10, currency: "USD" } },
    });
    expect(smuggledSubmit.status).toBe("refused");
  });

  it("refuses a fractional-result split injected directly (bypassing lifecycle validation)", async () => {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "frac-guard");
    await simulator.ingest(WORKSPACE, account, observation({ volume: 50 }));
    // Position 5 shares; a direct 3:2 split would make 7.5 — must be refused.
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "forged-split", {
      kind: "corporate_action_applied",
      action: brandReference<string, "PaperCorporateActionReference">("action:forged") as never,
      instrument: AAPL,
      adjustment: { kind: "split", numerator: 3, denominator: 2 },
    });
    expect(outcome.status).toBe("refused");
    expect((await shellOf(service)).positions[0]!.quantity).toBe(5);
  });
});
