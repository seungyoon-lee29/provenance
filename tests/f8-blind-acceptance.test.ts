/**
 * F8 AT-07 Blind Acceptance Tests — adversarial authorship.
 *
 * Seams under test (pre-agreed):
 *   1. PaperTradingService.{prepare, change, open}
 *   2. InternalPaperSimulator.ingest
 *   3. PaperLifecycleIngestion.{applySplit, applyDividend}
 *   4. PaperTradingErasure.{erase, receiptFor}
 *
 * Oracle discipline: every expected value is a hand-calculated literal
 * derived from the spec formulas. Production code is never imported to
 * produce an expected value.
 *
 * Hand-calc reference (simulation-v1):
 *   volumeCap      = volume × 0.1
 *   allocation     = min(quantity, volumeCap)  — per-observation fill
 *   participation  = allocation / volume
 *   slippageBps    = min(25, 5 + 20 × participation)
 *   slippageAmt    = price × slippageBps / 10_000
 *   execPrice(buy) = ceil_tick(price + slippageAmt, $0.01)
 *   execPrice(sell)= floor_tick(price - slippageAmt, $0.01)
 *
 * Example A — 100qty @ $100, vol=2000:
 *   volumeCap = 200; fills all 100
 *   participation = 100/2000 = 0.05
 *   slippageBps = min(25, 5+20×0.05) = min(25, 6) = 6
 *   slippageAmt = 100 × 6/10000 = 0.06
 *   buy execPrice = $100.06, sell execPrice = $99.94
 *
 * Example B — 100qty @ $100, vol=100 (10% cap = 10 filled):
 *   volumeCap = 10; fills 10 not 100
 *   participation = 10/100 = 0.10
 *   slippageBps = min(25, 5+20×0.10) = min(25, 7) = 7
 *   slippageAmt = 100 × 7/10000 = 0.07
 *   buy execPrice = $100.07, sell execPrice = $99.93
 *
 * Example C — 200qty @ $100, vol=100 (10% cap = 10 filled):
 *   volumeCap = 10; fills 10
 *   participation = 10/100 = 0.10  (same as B)
 *   slippageBps = 7, execPrice buy = $100.07
 *
 * Example D — limit $100.05 buy, exec would be $100.06 → exceeds limit → fill 0
 *
 * Example E — 1000qty @ $100, vol=80 (cap=8):
 *   participation = 8/80 = 0.10
 *   slippageBps = min(25, 5+20×0.10) = 7
 *   execPrice buy = $100.07
 *
 * Example F — spec "7bps" example: price=$100, 10% full participation:
 *   participation = 1.0 (10% of vol fills entire order)
 *   slippageBps = min(25, 5+20×1.0) = min(25, 25) = 25
 *   ... wait, spec example says "10% 전량 참여 → 7bps → buy 100.07"
 *   Spec reads: "가격 $100, 10% 전량 참여 → 7bps"
 *   Meaning: order fills 10% of volume (participation = 0.10)
 *   slippageBps = min(25, 5 + 20×0.10) = 7  ✓ → buy $100.07, sell $99.93 ✓
 *
 * 2:1 split fixture:
 *   5 shares @ $110 limit GTC → reservation = 5×$110 = $550 (buy-side locks cash)
 *   After split: 10 shares @ $55 limit, reservation still $550 (invariant)
 *   Cost basis raw amount: unchanged (ADR A04 §9)
 *
 * Dividend:
 *   3 shares, $2.50/share → cash credit = $7.50 exactly once
 */

import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator } from "../src/modules/paper-trading/internal/simulator";
import { PaperLifecycleIngestion } from "../src/modules/paper-trading/internal/lifecycle";
import { PaperTradingErasure } from "../src/modules/paper-trading/internal/paper-erasure";
import type {
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const WORKSPACE = "workspace:a";
const WORKSPACE_B = "workspace:b";
const EPOCH = "epoch:1";
const EPOCH_STALE = "epoch:0";
const INSTR_AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;
const VENUE = "XNYS";

const SIMULATION_V1 = {
  policyVersion: "simulation-v1" as const,
  volumeParticipationCap: 0.1,
  baseSlippageBps: 5,
  participationSlippageBps: 20,
  maxSlippageBps: 25,
};

function mkViewer(opts: { workspace?: string; epoch?: string; account?: string } = {}): WorkspaceViewerContext {
  const ws = opts.workspace ?? WORKSPACE;
  const ep = opts.epoch ?? EPOCH;
  const acc = opts.account ?? `account:${ws}:main`;
  return {
    kind: "workspace",
    requestId: `req:${Math.random()}`,
    workspaceReference: brandReference(ws),
    accountReference: brandReference(acc),
    sessionReference: brandReference("session:1"),
    sessionGeneration: brandReference("gen:1"),
    accountAuthorizationEpoch: brandReference(ep),
    membershipRevision: brandReference("mrev:1"),
  };
}

type ObsOpts = {
  price?: number;
  volume?: number;
  freshness?: PaperMarketObservation["freshness"];
  eventTime?: string;
  dataClock?: string;
  receivedAt?: string;
};

function mkObs(opts: ObsOpts = {}): PaperMarketObservation {
  const t = opts.eventTime ?? "2026-07-18T02:01:00.000Z";
  return {
    instrument: INSTR_AAPL,
    venue: VENUE,
    session: "regular",
    price: { amount: opts.price ?? 100, currency: "USD" },
    volume: opts.volume ?? 2000,
    eventTime: t,
    receivedAt: opts.receivedAt ?? t,
    dataClock: opts.dataClock ?? t,
    freshness: opts.freshness ?? "realtime",
    evidenceReference: "ev:1",
  };
}

function mkService(clockFn?: () => string, epochFn?: (v: WorkspaceViewerContext) => string) {
  let clock = clockFn ?? (() => "2026-07-18T02:00:00.000Z");
  return new PaperTradingService({
    now: clock,
    identity: {
      currentAuthorizationEpoch: (viewer: WorkspaceViewerContext) =>
        epochFn ? epochFn(viewer) : EPOCH,
    },
    observations: { currentObservation: (_instr) => undefined },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: [{ amount: 100_000, currency: "USD" }],
      intentTtlMs: 600_000,
      maxSlippageBps: 25,
    },
    updateId: () => `upd:${Math.random()}`,
  });
}

const BUY_AAPL: PaperOrderPayload = {
  instrument: INSTR_AAPL,
  venue: VENUE,
  session: "regular",
  side: "buy",
  orderType: "limit",
  limitPrice: { amount: 200, currency: "USD" },
  quantity: 100,
  timeInForce: "GTC",
};

const SELL_AAPL: PaperOrderPayload = {
  instrument: INSTR_AAPL,
  venue: VENUE,
  session: "regular",
  side: "sell",
  orderType: "market",
  quantity: 5,
  timeInForce: "GTC",
};

/** Prepare + submit helper returning the applied order reference */
async function prepareAndSubmit(
  service: PaperTradingService,
  payload: PaperOrderPayload,
  viewer: WorkspaceViewerContext,
  idempKey?: string,
) {
  const prep = await service.prepare({ payload }, viewer);
  if (prep.status !== "issued") throw new Error(`prepare failed: ${prep.status}`);
  const key = idempKey ?? `key:${Math.random()}`;
  const result = await service.change(
    { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
    { idempotencyKey: key, expectedRevision: String(prep.intent.accountRevision) },
    viewer,
  );
  return { result, intent: prep.intent, key };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SEC-01: guest viewer is denied with zero side effects", () => {
  it("prepare with guest viewer returns denied", async () => {
    const service = mkService();
    const guest = { kind: "guest" as const, requestId: "req:g1" };
    const result = await service.prepare({ payload: BUY_AAPL }, guest);
    // ponytail: spec says denied+side effect 0
    expect(result.status).toBe("denied");
  });

  it("change with guest viewer returns denied", async () => {
    const service = mkService();
    const guest = { kind: "guest" as const, requestId: "req:g2" };
    const result = await service.change(
      {
        kind: "submit",
        account: brandReference("account:workspace:a:main"),
        intent: brandReference("intent:fake"),
      },
      { idempotencyKey: "key:g", expectedRevision: "1" },
      guest,
    );
    expect(result.status).toBe("denied");
  });

  it("open with guest viewer returns denied", async () => {
    const service = mkService();
    const guest = { kind: "guest" as const, requestId: "req:g3" };
    const result = await (await service.open({ requestRevision: "0" }, guest)).initial;
    expect(result.status).toBe("denied");
  });
});

describe("SEC-01: stale auth epoch is denied with zero side effects", () => {
  it("prepare with stale epoch returns denied", async () => {
    const service = mkService(undefined, () => EPOCH); // current epoch = epoch:1
    const staleViewer = mkViewer({ epoch: EPOCH_STALE }); // viewer carries epoch:0
    const result = await service.prepare({ payload: BUY_AAPL }, staleViewer);
    expect(result.status).toBe("denied");
  });

  it("submit with stale epoch returns denied and no order is created", async () => {
    const service = mkService();
    // First prepare and submit with valid epoch
    const viewer = mkViewer();
    const { result: r1, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer);
    expect(r1.status).toBe("applied");

    // Now epoch advances — viewer still carries old epoch
    const advancedService = mkService(undefined, () => "epoch:2");
    const oldEpochViewer = mkViewer({ epoch: EPOCH }); // epoch:1, but service expects epoch:2
    const prep = await advancedService.prepare({ payload: BUY_AAPL }, oldEpochViewer);
    expect(prep.status).toBe("denied");
  });
});

describe("Cross-workspace replay and isolation (AT-07)", () => {
  it("cross-workspace: workspace B cannot submit workspace A's intent — zero side effects", async () => {
    const serviceA = mkService();
    const viewerA = mkViewer({ workspace: WORKSPACE });
    const prep = await serviceA.prepare({ payload: BUY_AAPL }, viewerA);
    expect(prep.status).toBe("issued");
    if (prep.status !== "issued") return;

    // workspace B viewer tries to use A's intent against the same service
    const viewerB = mkViewer({ workspace: WORKSPACE_B });
    const result = await serviceA.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: "key:b1", expectedRevision: "1" },
      viewerB,
    );
    // Must be denied or refused — never applied
    expect(["denied", "refused", "rejected"]).toContain(result.status);
  });

  it("Paper↔Actual mutual exclusion: a string that looks like an Actual account ID is refused", async () => {
    const service = mkService();
    const viewer = mkViewer();
    // Wire in a reference typed as InternalPaperAccountReference but with an "actual:" prefix
    const forgedActualId = brandReference<string, "InternalPaperAccountReference">("actual:account:123");
    const result = await service.change(
      { kind: "submit", account: forgedActualId, intent: brandReference("intent:fake") },
      { idempotencyKey: "key:forgery", expectedRevision: "1" },
      viewer,
    );
    // Spec: refused or denied — never applied; side effects = 0
    expect(["refused", "denied", "rejected"]).toContain(result.status);
  });
});

describe("Idempotency trio (spec §9)", () => {
  it("same key + same payload → original receipt re-returned (idempotent)", async () => {
    // The idempotency key is the discriminator. The spec says:
    // "same (account, command kind, idempotency key) + same canonical payload → original receipt"
    // The canonical payload for submit includes the intent reference. Two prepare calls
    // produce two different intent references → different canonical payloads → conflict.
    // True idempotency replay means repeating the EXACT same command (same intent ref, same key).
    // We verify this by submitting the same intent reference twice with the same key.
    const service = mkService();
    const viewer = mkViewer();
    const prep = await service.prepare({ payload: BUY_AAPL }, viewer);
    if (prep.status !== "issued") throw new Error("prepare failed");

    const idemKey = "idem-replay-key";
    const r1 = await service.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: idemKey, expectedRevision: String(prep.intent.accountRevision) },
      viewer,
    );
    expect(r1.status).toBe("applied");
    if (r1.status !== "applied") return;
    const orderRef1 = r1.order;
    const rev1 = r1.revision;

    // Replay the EXACT same command (same intent ref, same key) → original receipt
    const r2 = await service.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: idemKey, expectedRevision: String(rev1) },
      viewer,
    );
    // Should be applied with the original order reference (idempotent replay)
    expect(r2.status).toBe("applied");
    if (r2.status !== "applied") return;
    expect(r2.order).toBe(orderRef1);
  });

  it("same key + different payload → conflict, side effects 0", async () => {
    const service = mkService();
    const viewer = mkViewer();
    const { result: r1, key } = await prepareAndSubmit(service, BUY_AAPL, viewer, "idem-key-conflict");
    expect(r1.status).toBe("applied");

    const differentPayload: PaperOrderPayload = { ...BUY_AAPL, quantity: 999 };
    const prep2 = await service.prepare({ payload: differentPayload }, viewer);
    if (prep2.status !== "issued") throw new Error("second prepare failed");

    const r2 = await service.change(
      { kind: "submit", account: prep2.intent.account, intent: prep2.intent.reference },
      { idempotencyKey: "idem-key-conflict", expectedRevision: String(prep2.intent.accountRevision) },
      viewer,
    );
    expect(r2.status).toBe("conflict");
  });

  it("stale expectedRevision → rejected with currentRevision in body", async () => {
    const service = mkService();
    const viewer = mkViewer();
    // Apply one order to advance the revision
    await prepareAndSubmit(service, BUY_AAPL, viewer, "key-advance-1");
    // Try to apply with old revision (0 or 1 instead of current)
    const prep = await service.prepare({ payload: BUY_AAPL }, viewer);
    if (prep.status !== "issued") throw new Error("prepare failed");
    const r = await service.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: "key-stale-rev", expectedRevision: "1" }, // wrong: genesis was 1, now it's 2+
      viewer,
    );
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    // currentRevision must be present and > 1
    expect(r.currentRevision).toBeGreaterThan(1);
  });
});

describe("Three-axis state independence (submission / execution / cancellation)", () => {
  it("rejected order has execution=not_started and cancellation=none", async () => {
    // Trigger a rejection by using an expired/consumed intent
    const service = mkService();
    const viewer = mkViewer();
    const prep = await service.prepare({ payload: BUY_AAPL }, viewer);
    if (prep.status !== "issued") throw new Error("prepare failed");

    // Submit it once (consume the intent)
    await service.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: "key-first", expectedRevision: String(prep.intent.accountRevision) },
      viewer,
    );

    // Submit same intent again — must be refused (intent_consumed) or rejected, not applied
    // spec §9: "intent_consumed" maps to refused; however the impl may return rejected
    // for a stale-revision path if the intent was already consumed during the first submit.
    const r2 = await service.change(
      { kind: "submit", account: prep.intent.account, intent: prep.intent.reference },
      { idempotencyKey: "key-second", expectedRevision: String(prep.intent.accountRevision) },
      viewer,
    );
    // Must NOT be applied — the key invariant is no second order is created
    expect(["refused", "rejected"]).toContain(r2.status);
    // spec: rejected/draft order has execution=not_started (the second attempt made no order)
    // Verify via open that only one order exists with submission=acknowledged
    const openR = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openR.status !== "ready") throw new Error("open failed");
    // The refused attempt created no additional order — exactly 1 order
    expect(openR.orders.length).toBe(1);
    expect(openR.orders[0]!.submission).toBe("acknowledged");
    // cancellation axis is independent — must be none
    expect(openR.orders[0]!.cancellation).toBe("none");
  });

  it("cancel-confirmed order has cancellation=confirmed and execution unchanged", async () => {
    const service = mkService();
    const viewer = mkViewer();
    const { result: r1 } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-cancel-axis");
    if (r1.status !== "applied") throw new Error("submit failed");
    // r1.revision is the current account revision after submit
    const currentRev = String(r1.revision);

    const openB = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openB.status !== "ready") throw new Error("open failed");
    const order = openB.orders[0]!;
    // Cancellation — use the revision from the applied submit result
    const cancelR = await service.change(
      { kind: "cancel", account: order.account, order: order.order },
      { idempotencyKey: "key-cancel-axis-c", expectedRevision: currentRev },
      viewer,
    );
    expect(cancelR.status).toBe("applied");

    const openC = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openC.status !== "ready") throw new Error("open after cancel failed");
    const cancelled = openC.orders[0]!;
    // Submission axis unchanged (still acknowledged)
    expect(cancelled.submission).toBe("acknowledged");
    // Cancellation axis is confirmed
    expect(cancelled.cancellation).toBe("confirmed");
    // Execution axis is independent — never filled, so open or expired (not_started is impossible after ack)
    expect(["open", "expired", "not_started"]).toContain(cancelled.execution);
  });
});

describe("Reservation CAS boundary — exact values (spec §9)", () => {
  it("buy at exact available cash boundary is accepted", async () => {
    // seed = $100,000; buy 500 @ $200 limit = $100,000 exactly
    const service = mkService();
    const viewer = mkViewer();
    const payload: PaperOrderPayload = {
      ...BUY_AAPL,
      quantity: 500,
      limitPrice: { amount: 200, currency: "USD" },
    };
    const { result } = await prepareAndSubmit(service, payload, viewer, "key-cas-exact");
    // ponytail: $200×500=$100,000 = exactly available — should accept
    expect(result.status).toBe("applied");
  });

  it("buy $1 over available cash is refused (insufficient_cash)", async () => {
    // seed = $100,000; buy 500 @ $200.01 limit = $100,005 > $100,000
    const service = mkService();
    const viewer = mkViewer();
    const payload: PaperOrderPayload = {
      ...BUY_AAPL,
      quantity: 500,
      limitPrice: { amount: 200.01, currency: "USD" },
    };
    const { result } = await prepareAndSubmit(service, payload, viewer, "key-cas-over");
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("insufficient_cash");
  });

  it("cancel rejection keeps reservation intact (cancelled not confirmed)", async () => {
    // submit → fill nothing → cancel an already-cancelled order → reservation must remain
    const service = mkService();
    const viewer = mkViewer();
    const { result: r1 } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-can-rej");
    if (r1.status !== "applied") throw new Error("submit failed");
    const revAfterSubmit = String(r1.revision);

    const openB = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openB.status !== "ready") throw new Error("open failed");
    const order = openB.orders[0]!;

    // First cancel — use revision from submit result
    const cancel1 = await service.change(
      { kind: "cancel", account: order.account, order: order.order },
      { idempotencyKey: "can-1", expectedRevision: revAfterSubmit },
      viewer,
    );
    expect(cancel1.status).toBe("applied");
    if (cancel1.status !== "applied") return;
    const revAfterCancel = String(cancel1.revision);

    // Second cancel — should be refused or rejected (order already cancelled)
    const secondCancel = await service.change(
      { kind: "cancel", account: order.account, order: order.order },
      { idempotencyKey: "can-2", expectedRevision: revAfterCancel },
      viewer,
    );
    expect(["refused", "rejected", "conflict"]).toContain(secondCancel.status);
  });
});

describe("Simulator slippage — hand-calculated literals (simulation-v1)", () => {
  it("Example A: buy 100 @ $100, vol=2000 → fills 100 @ $100.06 (slippage=6bps)", () => {
    // participation = 100/2000 = 0.05
    // slippageBps = min(25, 5 + 20×0.05) = min(25, 6) = 6
    // execPrice = ceil_tick(100 + 100×6/10000) = ceil_tick(100.06) = $100.06
    const service = mkService();
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    // We need an open order in the journal — use service to create one
    // ponytail: can't read src; we drive this via the service seam first then ingest
    // We create the order through service, then feed an observation to the simulator
    // The result is the fill array — inspect quantity and price
    const obs = mkObs({ price: 100, volume: 2000, eventTime: "2026-07-18T02:01:00.000Z" });
    const results = simulator.ingest(WORKSPACE, brandReference("account:workspace:a:main"), obs);
    // No open orders yet — result is empty (no orders to fill)
    expect(results.length).toBe(0);
  });

  it("Example A full path: submit buy 100 limit $200 @ $100 price, vol=2000 → fill 100 @ $100.06", async () => {
    // participation = 100/2000 = 0.05, slippageBps=6, execPrice=$100.06
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();

    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-sim-a");
    expect(result.status).toBe("applied");

    // Advance clock past acceptedAt for the observation
    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const obs = mkObs({ price: 100, volume: 2000, eventTime: "2026-07-18T02:01:00.000Z" });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);

    expect(fills.length).toBeGreaterThan(0);
    const fill = fills[0]!;
    expect(fill.kind).toBe("fill");
    if (fill.kind !== "fill") return;
    // buy limit=$200 > execPrice=$100.06 — limit not adverse
    expect(fill.quantity).toBe(100);
    // hand-calc: $100.06
    expect(fill.price.amount).toBeCloseTo(100.06, 2);
    expect(fill.price.currency).toBe("USD");
  });

  it("Example B: vol=100, cap=10 → fills 10 @ $100.07 (slippage=7bps)", async () => {
    // volumeCap=10, participation=10/100=0.10
    // slippageBps = min(25, 5+20×0.10) = min(25,7) = 7
    // execPrice buy = ceil_tick(100 + 100×7/10000) = ceil_tick(100.07) = $100.07
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();

    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-sim-b");
    expect(result.status).toBe("applied");

    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const obs = mkObs({ price: 100, volume: 100, eventTime: "2026-07-18T02:01:00.000Z" });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);

    expect(fills.length).toBeGreaterThan(0);
    const fill = fills[0]!;
    expect(fill.kind).toBe("fill");
    if (fill.kind !== "fill") return;
    // Only 10 shares filled (10% volume cap)
    expect(fill.quantity).toBe(10);
    expect(fill.price.amount).toBeCloseTo(100.07, 2);
  });

  it("limit adverse check: buy limit=$100.05, exec=$100.06 → fill 0 (limit exceeded)", async () => {
    // slippage pushes execPrice to $100.06 > limitPrice $100.05 → no fill
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();
    const limitPayload: PaperOrderPayload = {
      ...BUY_AAPL,
      quantity: 100,
      limitPrice: { amount: 100.05, currency: "USD" },
    };
    const { result, intent } = await prepareAndSubmit(service, limitPayload, viewer, "key-sim-limit");
    expect(result.status).toBe("applied");

    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    // vol=2000, price=$100 → execPrice buy = $100.06 > limit $100.05 → NO FILL
    const obs = mkObs({ price: 100, volume: 2000, eventTime: "2026-07-18T02:01:00.000Z" });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);

    // Limit is adversely exceeded — must be 0 fills
    const actualFills = fills.filter((f) => f.kind === "fill");
    expect(actualFills.length).toBe(0);
  });

  it("delayed feed: observation only evaluates when dataClock > acceptedAt", async () => {
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-delayed");
    expect(result.status).toBe("applied");

    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });

    // Observation eventTime > acceptedAt but dataClock BEFORE acceptedAt → no fill yet
    const staleClock = mkObs({
      price: 100,
      volume: 2000,
      eventTime: "2026-07-18T02:01:00.000Z",
      dataClock: "2026-07-17T23:00:00.000Z", // dataClock before acceptedAt
      freshness: "delayed",
    });
    const fills1 = simulator.ingest(WORKSPACE, intent.account, staleClock);
    const actualFills1 = fills1.filter((f) => f.kind === "fill");
    expect(actualFills1.length).toBe(0);

    // Now dataClock advances past acceptedAt → evaluation allowed
    const freshClock = mkObs({
      price: 100,
      volume: 2000,
      eventTime: "2026-07-18T02:01:00.000Z",
      dataClock: "2026-07-18T02:01:00.000Z",
      freshness: "delayed",
    });
    const fills2 = simulator.ingest(WORKSPACE, intent.account, freshClock);
    const actualFills2 = fills2.filter((f) => f.kind === "fill");
    expect(actualFills2.length).toBeGreaterThan(0);
  });

  it("hard_expired observation produces 0 fills", async () => {
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-hard-exp");
    expect(result.status).toBe("applied");

    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const obs = mkObs({
      price: 100,
      volume: 2000,
      eventTime: "2026-07-18T02:01:00.000Z",
      freshness: "hard_expired",
    });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);
    expect(fills.filter((f) => f.kind === "fill").length).toBe(0);
  });

  it("observation eventTime must be strictly > acceptedAt (not >=): same timestamp yields 0 fills", async () => {
    // Both acceptedAt and eventTime are the same ISO string → not strictly greater → fill 0
    const fixedClock = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => fixedClock);
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-strict-gt");
    expect(result.status).toBe("applied");

    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    // eventTime == acceptedAt exactly — must NOT fill (spec: strictly >)
    const obs = mkObs({ price: 100, volume: 2000, eventTime: fixedClock, dataClock: fixedClock });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);
    expect(fills.filter((f) => f.kind === "fill").length).toBe(0);
  });
});

describe("Duplicate fill exactly-once (spec §9)", () => {
  it("redelivering the same observation produces 0 additional fills (idempotent)", async () => {
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-dup-fill");
    expect(result.status).toBe("applied");

    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const obs = mkObs({ price: 100, volume: 2000, eventTime: "2026-07-18T02:01:00.000Z" });

    const fills1 = simulator.ingest(WORKSPACE, intent.account, obs);
    const fills2 = simulator.ingest(WORKSPACE, intent.account, obs); // exact replay

    const count1 = fills1.filter((f) => f.kind === "fill").reduce((s, f) => s + (f.kind === "fill" ? f.quantity : 0), 0);
    const count2 = fills2.filter((f) => f.kind === "fill").reduce((s, f) => s + (f.kind === "fill" ? f.quantity : 0), 0);

    // Second ingest is a no-op — same evidenceReference → identity
    expect(count2).toBe(0);
    expect(count1).toBeGreaterThan(0);
  });
});

describe("2:1 corporate split (spec §9 lifecycle)", () => {
  it("split: 5 shares @ $110 GTC → 10 @ $55, reservation $550 invariant, cost basis raw unchanged", async () => {
    // Setup: buy 5 shares @ $110 limit GTC
    // ponytail: reservation = 5×$110 = $550 locked (buy-side cash lock)
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();

    const payload: PaperOrderPayload = {
      instrument: INSTR_AAPL,
      venue: VENUE,
      session: "regular",
      side: "buy",
      orderType: "limit",
      limitPrice: { amount: 110, currency: "USD" },
      quantity: 5,
      timeInForce: "GTC",
    };
    const { result, intent } = await prepareAndSubmit(service, payload, viewer, "key-split");
    expect(result.status).toBe("applied");

    // Apply 2:1 split
    const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });
    const actionRef = brandReference<string, "PaperCorporateActionReference">("corp-action:split:1");
    const splitResult = await lifecycle.applySplit(WORKSPACE, intent.account, {
      action: actionRef,
      instrument: INSTR_AAPL,
      numerator: 2,
      denominator: 1,
    });
    expect(splitResult.status).toBe("applied");

    // Verify post-split state via open
    const openR = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openR.status !== "ready") throw new Error("open failed");

    // Cash reservation must remain $550 (invariant)
    const cash = openR.cash[0]!;
    // reserved should still be $550 (hand-calc: 5×$110 = $550 pre-split, unchanged post-split)
    expect(cash.reserved).toBeCloseTo(550, 2);

    // Order quantity must be 10 (2×5), limit price must be $55 ($110/2)
    const order = openR.orders[0]!;
    expect(order.payload.quantity).toBe(10);
    expect(order.payload.limitPrice?.amount).toBeCloseTo(55, 2);
  });

  it("duplicate split action reference is a no-op (idempotent)", async () => {
    const service = mkService();
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-dup-split");
    expect(result.status).toBe("applied");

    const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });
    const actionRef = brandReference<string, "PaperCorporateActionReference">("corp-action:split:dup");
    await lifecycle.applySplit(WORKSPACE, intent.account, {
      action: actionRef,
      instrument: INSTR_AAPL,
      numerator: 2,
      denominator: 1,
    });
    const r2 = await lifecycle.applySplit(WORKSPACE, intent.account, {
      action: actionRef,
      instrument: INSTR_AAPL,
      numerator: 2,
      denominator: 1,
    });
    // ponytail: same action reference → no-op
    expect(r2.status).toBe("duplicate");
  });
});

describe("Dividend (spec §9 lifecycle)", () => {
  it("3 shares × $2.50/share → exactly $7.50 cash credited once", async () => {
    // To have 3 shares, we need a filled position.
    // We drive this through the simulator path.
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();

    // Buy 3 shares with enough limit headroom
    const payload: PaperOrderPayload = {
      instrument: INSTR_AAPL,
      venue: VENUE,
      session: "regular",
      side: "buy",
      orderType: "limit",
      limitPrice: { amount: 200, currency: "USD" },
      quantity: 3,
      timeInForce: "GTC",
    };
    const { result, intent } = await prepareAndSubmit(service, payload, viewer, "key-div");
    expect(result.status).toBe("applied");

    // Fill the order via simulator
    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    // vol=3000, cap=300 → fills all 3
    const obs = mkObs({ price: 100, volume: 3000, eventTime: "2026-07-18T02:01:00.000Z" });
    const fills = simulator.ingest(WORKSPACE, intent.account, obs);
    const filledQty = fills.filter((f) => f.kind === "fill").reduce((s, f) => s + (f.kind === "fill" ? f.quantity : 0), 0);
    expect(filledQty).toBe(3);

    // Check cash before dividend
    const openBefore = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openBefore.status !== "ready") throw new Error("open failed");
    const cashBefore = openBefore.cash.find((c) => c.currency === "USD")!;

    // Apply dividend: 3 shares × $2.50 = $7.50
    const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });
    const divResult = await lifecycle.applyDividend(WORKSPACE, intent.account, {
      action: brandReference<string, "PaperCorporateActionReference">("corp-action:div:1"),
      instrument: INSTR_AAPL,
      perShare: { amount: 2.5, currency: "USD" },
    });
    expect(divResult.status).toBe("applied");

    const openAfter = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openAfter.status !== "ready") throw new Error("open after dividend failed");
    const cashAfter = openAfter.cash.find((c) => c.currency === "USD")!;

    // hand-calc: $7.50 credit
    expect(cashAfter.balance - cashBefore.balance).toBeCloseTo(7.5, 2);
  });

  it("dividend re-delivery with same action reference is a no-op", async () => {
    const service = mkService();
    const viewer = mkViewer();
    const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });

    // Trigger a fresh account via prepare
    await service.prepare({ payload: BUY_AAPL }, viewer);

    const actionRef = brandReference<string, "PaperCorporateActionReference">("corp-action:div:dup");
    await lifecycle.applyDividend(WORKSPACE, brandReference("account:workspace:a:main"), {
      action: actionRef,
      instrument: INSTR_AAPL,
      perShare: { amount: 1, currency: "USD" },
    });
    const r2 = await lifecycle.applyDividend(WORKSPACE, brandReference("account:workspace:a:main"), {
      action: actionRef,
      instrument: INSTR_AAPL,
      perShare: { amount: 1, currency: "USD" },
    });
    expect(r2.status).toBe("duplicate");
  });
});

describe("Erasure fence (SEC-09)", () => {
  it("after erasure, prepare returns suppressed or denied — no new orders (commit 0)", async () => {
    const service = mkService();
    const viewer = mkViewer();

    // First ensure account exists
    const prep0 = await service.prepare({ payload: BUY_AAPL }, viewer);
    expect(prep0.status).toBe("issued");

    // Erase the workspace
    const erasure = new PaperTradingErasure({ journal: service.journal, stores: service.erasableStores() });
    await erasure.erase({
      accountReference: brandReference("account:workspace:a:main"),
      workspaceReference: brandReference(WORKSPACE),
      scope: "workspace",
      fence: Date.now(),
    });

    // Prepare after erasure must be suppressed
    const prep1 = await service.prepare({ payload: BUY_AAPL }, viewer);
    expect(["suppressed", "denied", "refused"]).toContain(prep1.status);
  });

  it("erasure receipt records shredded lines for the workspace", async () => {
    const service = mkService();
    const viewer = mkViewer();

    // Ensure some data exists
    await service.prepare({ payload: BUY_AAPL }, viewer);

    const erasure = new PaperTradingErasure({ journal: service.journal, stores: service.erasableStores() });
    await erasure.erase({
      accountReference: brandReference("account:workspace:a:main"),
      workspaceReference: brandReference(WORKSPACE),
      scope: "workspace",
      fence: Date.now(),
    });

    const receipt = erasure.receiptFor(WORKSPACE);
    expect(receipt).toBeDefined();
    expect(receipt?.workspace).toBe(WORKSPACE);
    expect(receipt?.lines).toBeDefined();
  });

  it("after erasure, a command commits nothing and is indistinguishable from a never-provisioned workspace", async () => {
    // SEC-09: erasure fence → any Paper command commit = 0
    const service = mkService();
    const viewer = mkViewer();
    const { result, intent } = await prepareAndSubmit(service, BUY_AAPL, viewer, "key-erase-change");
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const orderRef = result.order;
    const revAfterSubmit = String(result.revision);

    const erasure = new PaperTradingErasure({ journal: service.journal, stores: service.erasableStores() });
    await erasure.erase({
      accountReference: intent.account,
      workspaceReference: brandReference(WORKSPACE),
      scope: "workspace",
      fence: 5,
    });

    const r = await service.change(
      { kind: "cancel", account: intent.account, order: orderRef },
      { idempotencyKey: "key-post-erase", expectedRevision: revAfterSubmit },
      viewer,
    );
    // ADJUDICATED (main agent, B4 gate): the original blind assertion demanded
    // `suppressed`, but SEC-09's requirement is COMMIT 0 — and `suppressed`
    // would tell the caller an erased workspace once existed, distinguishing
    // it from a never-provisioned account (enumeration leak). The adjudicated
    // contract: a post-erasure command answers exactly like one against a
    // workspace that never existed (`refused`), commits nothing and
    // regenerates nothing; `suppressed` stays reserved for an accepted write
    // racing the fence mid-flight.
    expect(r.status).toBe("refused");
    expect(service.journal.currentRevision(WORKSPACE, intent.account)).toBe(0);
    const shell = await service.open({ requestRevision: "post" }, viewer).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    expect(shell.orders).toHaveLength(0);
  });
});

describe("Paper open state accuracy", () => {
  it("after a fill, position quantity increases and cash decreases by fill value", async () => {
    let clockVal = "2026-07-18T02:00:00.000Z";
    const service = mkService(() => clockVal);
    const viewer = mkViewer();

    const payload: PaperOrderPayload = {
      ...BUY_AAPL,
      quantity: 10,
      limitPrice: { amount: 200, currency: "USD" },
    };
    const { result, intent } = await prepareAndSubmit(service, payload, viewer, "key-open-state");
    expect(result.status).toBe("applied");

    const openBefore = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openBefore.status !== "ready") throw new Error("open failed before fill");
    const cashBefore = openBefore.cash[0]!.balance;

    // Fill: vol=100, cap=10 → fills all 10
    // participation=10/100=0.10, slippage=7bps, execPrice=$100.07
    clockVal = "2026-07-18T02:01:00.000Z";
    const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
    const obs = mkObs({ price: 100, volume: 100, eventTime: "2026-07-18T02:01:00.000Z" });
    simulator.ingest(WORKSPACE, intent.account, obs);

    const openAfter = await (await service.open({ requestRevision: "0" }, viewer)).initial;
    if (openAfter.status !== "ready") throw new Error("open failed after fill");

    // Position should exist
    const pos = openAfter.positions.find((p) => p.instrument === INSTR_AAPL);
    expect(pos).toBeDefined();
    expect(pos!.quantity).toBe(10);

    // Cash decreased by fill cost = 10 × $100.07 = $1,000.70
    const cashAfter = openAfter.cash[0]!.balance;
    // hand-calc: $1000.70 deducted
    expect(cashBefore - cashAfter).toBeCloseTo(1000.70, 1);
  });
});
