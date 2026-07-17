import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext, ViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import type {
  PaperInstrumentReference,
  PaperObservationPort,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 B1 — PaperTrading.open/prepare/change spine (spec §9, SEC-01, AT-07).
 *
 * Seam under test: the module public service only (spec §6 fixes it as the
 * product seam). Expected values are hand-worked literals; the production
 * journal/simulator is never imported to produce an expected value.
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

const GUEST: ViewerContext = { kind: "guest", requestId: "req-guest" };

const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;

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

/** No-observation port: B1 limit-order paths never consult it. */
const NO_OBSERVATIONS: PaperObservationPort = { currentObservation: () => undefined };

function makeService(nowRef: { value: string } = { value: NOW }, epochOf: (v: ViewerContext) => string = () => "epoch:1") {
  let updateCounter = 0;
  return new PaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: epochOf },
    observations: NO_OBSERVATIONS,
    policy: {
      policyVersion: "simulation-v1",
      seedCash: [{ amount: 100_000, currency: "USD" }],
      intentTtlMs: 10 * 60 * 1000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${updateCounter += 1}`,
  });
}

async function submitOrder(
  service: PaperTradingService,
  payload: PaperOrderPayload,
  idempotencyKey: string,
  asViewer: WorkspaceViewerContext = viewer(),
) {
  const prepared = await service.prepare({ payload }, asViewer);
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const shell = await service.open({ requestRevision: "r1" }, asViewer).initial;
  if (shell.status !== "ready") throw new Error("open failed");
  return service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey, expectedRevision: String(prepared.intent.accountRevision) },
    asViewer,
  );
}

describe("prepare", () => {
  it("issues an opaque one-time intent bound to workspace/account/revision/environment/policy/expiry", async () => {
    const service = makeService();
    const outcome = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    expect(outcome.status).toBe("issued");
    if (outcome.status !== "issued") return;
    const intent = outcome.intent;
    expect(intent.accountKind).toBe("internal");
    expect(intent.environment).toBe("paper");
    expect(intent.policyVersion).toBe("simulation-v1");
    // Provisioned default account starts at revision 1 (genesis entry).
    expect(intent.accountRevision).toBe(1);
    // 10-minute expiry from the fixed clock.
    expect(intent.expiresAt).toBe("2026-07-18T02:10:00.000Z");
    // Opaque reference, not an assembled payload echo.
    expect(String(intent.reference).length).toBeGreaterThan(0);
  });

  it("denies a guest with zero side effects", async () => {
    const service = makeService();
    const outcome = await service.prepare({ payload: limitBuy(1, 10) }, GUEST);
    expect(outcome.status).toBe("denied");
    const shell = await service.open({ requestRevision: "r1" }, viewer()).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    // The guest prepare provisioned nothing: a fresh workspace still sees only
    // its own genesis account with zero orders.
    expect(shell.orders).toHaveLength(0);
  });

  it("refuses a limit order without a limit price and a non-integer quantity", async () => {
    const service = makeService();
    const noLimit = await service.prepare(
      { payload: { ...limitBuy(1, 10), limitPrice: undefined } },
      viewer(),
    );
    expect(noLimit.status).toBe("refused");
    const fractional = await service.prepare({ payload: limitBuy(1.5, 10) }, viewer());
    expect(fractional.status).toBe("refused");
  });
});

describe("submit", () => {
  it("creates the order and cash reservation in one transaction: 10 @ $100 limit reserves exactly $1,000", async () => {
    const service = makeService();
    const outcome = await submitOrder(service, limitBuy(10, 100), "idem-1");
    expect(outcome.status).toBe("applied");
    const shell = await service.open({ requestRevision: "r2" }, viewer()).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    expect(shell.orders).toHaveLength(1);
    const order = shell.orders[0]!;
    // Three axes after internal acceptance (AT-07: ack만 open).
    expect(order.submission).toBe("acknowledged");
    expect(order.execution).toBe("open");
    expect(order.cancellation).toBe("none");
    expect(order.acceptedAt).toBe(NOW);
    // Hand-worked: 10 × $100 = $1,000 reserved out of the $100,000 seed.
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.balance).toBe(100_000);
    expect(usd.reserved).toBe(1_000);
    expect(usd.available).toBe(99_000);
    // Fills only ever move positions; a submit must not.
    expect(shell.positions).toHaveLength(0);
  });

  it("§8 idempotency trio: same key+payload → original receipt; same key different payload → conflict; stale revision → rejected", async () => {
    const service = makeService();
    const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const control = { idempotencyKey: "idem-trio", expectedRevision: String(prepared.intent.accountRevision) };
    const command = { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference } as const;

    const first = service.change(command, control, viewer());
    expect(first.status).toBe("applied");
    const replay = service.change(command, control, viewer());
    expect(replay).toEqual(first);

    const otherIntent = await service.prepare({ payload: limitBuy(1, 50) }, viewer());
    if (otherIntent.status !== "issued") throw new Error("prepare failed");
    const different = service.change(
      { kind: "submit", account: otherIntent.intent.account, intent: otherIntent.intent.reference },
      control,
      viewer(),
    );
    expect(different.status).toBe("conflict");

    const stale = service.change(
      { kind: "submit", account: otherIntent.intent.account, intent: otherIntent.intent.reference },
      { idempotencyKey: "idem-stale", expectedRevision: "1" },
      viewer(),
    );
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") expect(stale.currentRevision).toBe(2);

    // Side-effect check: exactly one order landed across all four calls.
    const shell = await service.open({ requestRevision: "r3" }, viewer()).initial;
    if (shell.status !== "ready") throw new Error("open failed");
    expect(shell.orders).toHaveLength(1);
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.reserved).toBe(1_000);
  });
});

async function readShell(service: PaperTradingService, asViewer: WorkspaceViewerContext = viewer()) {
  const shell = await service.open({ requestRevision: "read" }, asViewer).initial;
  if (shell.status !== "ready") throw new Error("open failed");
  return shell;
}

describe("intent one-time and binding re-checks (AT-07)", () => {
  it("rejects reuse of a consumed intent with zero side effects", async () => {
    const service = makeService();
    const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const command = { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference } as const;
    const first = service.change(command, { idempotencyKey: "one", expectedRevision: "1" }, viewer());
    expect(first.status).toBe("applied");
    // New idempotency key + already-consumed intent: refused, nothing lands.
    const reuse = service.change(command, { idempotencyKey: "two", expectedRevision: "2" }, viewer());
    expect(reuse).toEqual({ status: "refused", reason: "intent_consumed" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(1);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(1_000);
  });

  it("rejects an expired intent with zero side effects", async () => {
    const nowRef = { value: NOW };
    const service = makeService(nowRef);
    const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    // 10 minutes and 1 ms later the intent is dead.
    nowRef.value = "2026-07-18T02:10:00.001Z";
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "late", expectedRevision: "1" },
      viewer(),
    );
    expect(outcome).toEqual({ status: "refused", reason: "intent_expired" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(0);
  });

  it("denies a submit whose auth epoch moved after prepare (SEC-06)", async () => {
    let currentEpoch = "epoch:1";
    const service = makeService({ value: NOW }, () => currentEpoch);
    const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    // All-session revoke bumps the account authorization epoch; a viewer
    // carrying the new epoch still must not consume the old-epoch intent.
    currentEpoch = "epoch:2";
    const rotated = viewer({ accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:2") });
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "rotated", expectedRevision: "1" },
      rotated,
    );
    expect(outcome).toEqual({ status: "denied" });
    const shell = await readShell(service, rotated);
    expect(shell.orders).toHaveLength(0);
  });

  it("rejects a stale-revision intent after the account moved (§9 binding)", async () => {
    const service = makeService();
    const staleIntent = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    if (staleIntent.status !== "issued") throw new Error("prepare failed");
    // Another order lands first → account revision advances past the binding.
    const other = await submitOrder(service, limitBuy(2, 20), "first-in");
    expect(other.status).toBe("applied");
    const outcome = service.change(
      { kind: "submit", account: staleIntent.intent.account, intent: staleIntent.intent.reference },
      { idempotencyKey: "stale-intent", expectedRevision: "2" },
      viewer(),
    );
    expect(outcome).toEqual({ status: "rejected", currentRevision: 2 });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(1);
  });

  it("cross-workspace intent replay is refused: workspace B cannot consume workspace A's intent", async () => {
    const service = makeService();
    const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const intruder = viewer({
      workspaceReference: brandReference<string, "WorkspaceReference">("workspace:b"),
      accountReference: brandReference<string, "AccountReference">("account:b"),
    });
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "intrude", expectedRevision: "1" },
      intruder,
    );
    // Workspace A's account resolves to a different owner → denied, side effect 0.
    expect(outcome).toEqual({ status: "denied" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(0);
  });
});

describe("forged Actual account (AT-07, ADR A04)", () => {
  it("a wire Actual account id in a Paper command is refused with zero side effects", async () => {
    const service = makeService();
    await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    // Simulates a client casting an Actual account id onto the Paper wire —
    // the branded types forbid this in checked code, so cast through unknown.
    const forged = brandReference<string, "InternalPaperAccountReference">("actual-account:a1") as never;
    const outcome = service.change(
      { kind: "submit", account: forged, intent: brandReference<string, "PaperOrderIntentReference">("paper-intent:workspace:a:1") as never },
      { idempotencyKey: "forge", expectedRevision: "1" },
      viewer(),
    );
    expect(outcome).toEqual({ status: "refused", reason: "unknown_account" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(0);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(0);
  });
});

describe("reservation CAS (§9: overspend/oversell 0)", () => {
  it("refuses a buy that exceeds available (unreserved) cash: $99,000 + $2,000 > $100,000 seed", async () => {
    const service = makeService();
    // 990 × $100 = $99,000 reserved.
    const first = await submitOrder(service, limitBuy(990, 100), "big");
    expect(first.status).toBe("applied");
    // 20 × $100 = $2,000 > $1,000 available → refused, nothing lands.
    const prepared = await service.prepare({ payload: limitBuy(20, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const second = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "over", expectedRevision: "2" },
      viewer(),
    );
    expect(second).toEqual({ status: "refused", reason: "insufficient_cash" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(1);
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(99_000);
    // Exactly at the boundary is allowed: 10 × $100 = the remaining $1,000.
    const third = await submitOrder(service, limitBuy(10, 100), "exact");
    expect(third.status).toBe("applied");
  });

  it("refuses a sell without a sellable position (oversell 0)", async () => {
    const service = makeService();
    const sell: PaperOrderPayload = { ...limitBuy(1, 10), side: "sell" };
    const prepared = await service.prepare({ payload: sell }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "oversell", expectedRevision: "1" },
      viewer(),
    );
    expect(outcome).toEqual({ status: "refused", reason: "insufficient_position" });
    const shell = await readShell(service);
    expect(shell.orders).toHaveLength(0);
  });

  it("refuses a market buy when no valid observation can bound the spend (fail closed)", async () => {
    const service = makeService();
    const market: PaperOrderPayload = { ...limitBuy(1, 10), orderType: "market", limitPrice: undefined };
    const prepared = await service.prepare({ payload: market }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare failed");
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "market-no-obs", expectedRevision: "1" },
      viewer(),
    );
    expect(outcome).toEqual({ status: "refused", reason: "no_valid_observation" });
  });
});

describe("journal system-event exactly-once (§9 dedupe layer)", () => {
  it("a redelivered system event with the same dedupe key is a duplicate no-op", async () => {
    const service = makeService();
    await submitOrder(service, limitBuy(1, 10), "seed");
    const account = (await readShell(service)).account;
    const body = {
      kind: "dividend_applied",
      action: brandReference<string, "PaperCorporateActionReference">("action:div-1") as never,
      instrument: AAPL,
      perShare: { amount: 1, currency: "USD" },
    } as const;
    const first = service.journal.appendSystem("workspace:a", account, "action:div-1", body);
    expect(first.status).toBe("applied");
    const replay = service.journal.appendSystem("workspace:a", account, "action:div-1", body);
    expect(replay).toEqual({ status: "duplicate" });
    // Revision advanced exactly once for the pair.
    expect(service.journal.currentRevision("workspace:a", account)).toBe(3);
  });
});

describe("cancellation axis (§9)", () => {
  it("cancel of an open order confirms and releases the remaining reservation", async () => {
    const service = makeService();
    const submitted = await submitOrder(service, limitBuy(10, 100), "to-cancel");
    if (submitted.status !== "applied") throw new Error("submit failed");
    const cancel = service.change(
      { kind: "cancel", account: (await readShell(service)).account, order: submitted.order },
      { idempotencyKey: "cancel-1", expectedRevision: "2" },
      viewer(),
    );
    expect(cancel.status).toBe("applied");
    const shell = await readShell(service);
    const order = shell.orders[0]!;
    expect(order.cancellation).toBe("confirmed");
    // Submission/execution axes are untouched by cancellation (independent axes).
    expect(order.submission).toBe("acknowledged");
    const usd = shell.cash.find((row) => row.currency === "USD")!;
    expect(usd.reserved).toBe(0);
    expect(usd.balance).toBe(100_000);
  });

  it("cancel of an unknown order is refused; cancel after confirmed cancellation is refused with state intact", async () => {
    const service = makeService();
    const submitted = await submitOrder(service, limitBuy(5, 40), "c2");
    if (submitted.status !== "applied") throw new Error("submit failed");
    const account = (await readShell(service)).account;
    const unknown = service.change(
      { kind: "cancel", account, order: brandReference<string, "PaperOrderReference">("paper-order:nope:9") as never },
      { idempotencyKey: "c-unknown", expectedRevision: "2" },
      viewer(),
    );
    expect(unknown).toEqual({ status: "refused", reason: "unknown_order" });

    const first = service.change({ kind: "cancel", account, order: submitted.order }, { idempotencyKey: "c-a", expectedRevision: "2" }, viewer());
    expect(first.status).toBe("applied");
    // The cancellation axis is terminal at confirmed: a second cancel is a
    // side-effect-free refusal, not another journal row (blind-gate finding).
    const second = service.change({ kind: "cancel", account, order: submitted.order }, { idempotencyKey: "c-b", expectedRevision: "3" }, viewer());
    expect(second).toEqual({ status: "refused", reason: "already_cancelled" });
    const shell = await readShell(service);
    expect(shell.orders[0]!.cancellation).toBe("confirmed");
    expect(shell.cash.find((row) => row.currency === "USD")!.reserved).toBe(0);
    expect(service.journal.currentRevision("workspace:a", account)).toBe(3);
  });
});
