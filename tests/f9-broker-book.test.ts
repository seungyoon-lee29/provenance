import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { BrokerPaperAccountReference, ProviderConnectionReference } from "../src/shared/contracts/brands";
import { BrokerPaperBook } from "../src/modules/paper-trading/broker/book";
import type { BrokerClientOrderReference, BrokerExternalOrderEvent } from "../src/modules/paper-trading/broker/contracts";
import type { PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

const WORKSPACE = "ws-broker-1";
const EPOCH = 1;
const AAPL = brandReference<string, "PaperInstrumentReference">("instrument:AAPL");

function account(id = "broker-acct-1"): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">(id) as BrokerPaperAccountReference;
}

function connection(id = "conn-alpaca-paper"): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">(id) as ProviderConnectionReference;
}

function clientOrder(id: string): BrokerClientOrderReference {
  return brandReference<string, "BrokerClientOrderReference">(id) as BrokerClientOrderReference;
}

function limitBuy(quantity: number, limit: number): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "NASDAQ",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce: "DAY",
  };
}

function limitSell(quantity: number, limit: number): PaperOrderPayload {
  return { ...limitBuy(quantity, limit), side: "sell" };
}

function event(order: BrokerClientOrderReference, overrides: Partial<BrokerExternalOrderEvent> & Pick<BrokerExternalOrderEvent, "kind" | "externalIdentity" | "revision" | "body">): BrokerExternalOrderEvent {
  return { connection: connection(), order, ...overrides };
}

function seeded(): { book: BrokerPaperBook; acct: BrokerPaperAccountReference } {
  const book = new BrokerPaperBook();
  const acct = account();
  book.provision(WORKSPACE, acct, [{ amount: 100_000, currency: "USD" }], EPOCH);
  return { book, acct };
}

function usd(book: BrokerPaperBook, acct: BrokerPaperAccountReference) {
  return book.state(WORKSPACE, acct).cash.find((row) => row.currency === "USD")!;
}

describe("provision (genesis exactly-once)", () => {
  it("seeds cash once and treats redelivery as a duplicate", () => {
    const book = new BrokerPaperBook();
    const acct = account();
    expect(book.provision(WORKSPACE, acct, [{ amount: 100_000, currency: "USD" }], EPOCH).status).toBe("applied");
    expect(book.provision(WORKSPACE, acct, [{ amount: 100_000, currency: "USD" }], EPOCH).status).toBe("duplicate");
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
  });
});

describe("local submit + derived reservation CAS (§9)", () => {
  it("commits a pending_submission order whose reservation is derived before any broker ack", () => {
    const { book, acct } = seeded();
    const outcome = book.submitLocal(WORKSPACE, acct, clientOrder("co-1"), limitBuy(5, 110), EPOCH);
    expect(outcome.status).toBe("accepted");
    const order = book.state(WORKSPACE, acct).orders[0]!;
    expect(order.submission).toBe("pending_submission");
    expect(order.execution).toBe("not_started");
    expect(order.cancellation).toBe("none");
    // 5 × $110 held the moment the durable local record exists (durable-before-send).
    expect(usd(book, acct).reserved).toBe(550);
  });

  it("refuses an unaffordable buy with no order row (overspend 0)", () => {
    const { book, acct } = seeded();
    const outcome = book.submitLocal(WORKSPACE, acct, clientOrder("co-big"), limitBuy(1_000, 110), EPOCH);
    expect(outcome).toEqual({ status: "refused", reason: "insufficient_cash" });
    expect(book.state(WORKSPACE, acct).orders).toHaveLength(0);
    expect(usd(book, acct).reserved).toBe(0);
  });

  it("refuses an oversell with no position (oversell 0)", () => {
    const { book, acct } = seeded();
    const outcome = book.submitLocal(WORKSPACE, acct, clientOrder("co-sell"), limitSell(5, 120), EPOCH);
    expect(outcome).toEqual({ status: "refused", reason: "insufficient_position" });
    expect(book.state(WORKSPACE, acct).orders).toHaveLength(0);
  });

  it("refuses a market order fail-closed (no pre-submit price bound in the broker lane)", () => {
    const { book, acct } = seeded();
    const payload: PaperOrderPayload = { ...limitBuy(5, 110), orderType: "market" };
    delete (payload as { limitPrice?: unknown }).limitPrice;
    const outcome = book.submitLocal(WORKSPACE, acct, clientOrder("co-mkt"), payload, EPOCH);
    expect(outcome).toEqual({ status: "refused", reason: "unsupported_order_type" });
  });

  it("treats a redelivered identical local submit as a duplicate, not a second order", () => {
    const { book, acct } = seeded();
    book.submitLocal(WORKSPACE, acct, clientOrder("co-1"), limitBuy(5, 110), EPOCH);
    const replay = book.submitLocal(WORKSPACE, acct, clientOrder("co-1"), limitBuy(5, 110), EPOCH);
    expect(replay.status).toBe("duplicate");
    expect(book.state(WORKSPACE, acct).orders).toHaveLength(1);
    expect(usd(book, acct).reserved).toBe(550);
  });
});

describe("external event fold — durable unique + quarantine (§9/AT-08)", () => {
  it("folds accepted → fill into acknowledged/filled with exact cash literals", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);

    const ack = book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X9" } }), EPOCH);
    expect(ack.status).toBe("applied");
    let order = book.state(WORKSPACE, acct).orders[0]!;
    expect(order.submission).toBe("acknowledged");
    expect(order.execution).toBe("open");
    expect(order.externalOrder).toBe("X9");

    const fill = book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 109.9, currency: "USD" } } }), EPOCH);
    expect(fill.status).toBe("applied");
    order = book.state(WORKSPACE, acct).orders[0]!;
    expect(order.execution).toBe("filled");
    expect(order.filledQuantity).toBe(5);
    // Hand-worked: 100,000 − 5 × 109.90 = 99,450.50; nothing left reserved.
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 99_450.5, reserved: 0 });
    const position = book.state(WORKSPACE, acct).positions[0]!;
    expect(position.quantity).toBe(5);
    expect(position.costBasis).toEqual({ amount: 549.5, currency: "USD" });
  });

  it("keeps the remaining reservation exact across a partial fill", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-p");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(25, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X1" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 10, price: { amount: 109.9, currency: "USD" } } }), EPOCH);
    const order = book.state(WORKSPACE, acct).orders[0]!;
    expect(order.execution).toBe("partially_filled");
    // 100,000 − 1,099 = 98,901 balance; remaining 15 × $110 = $1,650 reserved.
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 98_901, reserved: 1_650 });
  });

  it("re-applies nothing on stream/poll duplicate delivery of the same event identity+revision", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X9" } }), EPOCH);
    const fill = event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 109.9, currency: "USD" } } });
    book.ingest(WORKSPACE, acct, fill, EPOCH);
    const replay = book.ingest(WORKSPACE, acct, fill, EPOCH);
    expect(replay.status).toBe("duplicate");
    expect(usd(book, acct).balance).toBe(99_450.5);
    expect(book.state(WORKSPACE, acct).positions[0]!.quantity).toBe(5);
  });

  it("quarantines a same-revision divergent payload without touching the book", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X9" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 109.9, currency: "USD" } } }), EPOCH);
    const divergent = book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 109.8, currency: "USD" } } }), EPOCH);
    expect(divergent.status).toBe("quarantined");
    // Book unchanged; the divergence is visible as a Reconciliation Issue record.
    expect(usd(book, acct).balance).toBe(99_450.5);
    expect(book.state(WORKSPACE, acct).quarantine).toHaveLength(1);
    expect(book.state(WORKSPACE, acct).quarantine[0]!.order).toBe(co);
  });

  it("releases the whole reservation on a broker rejected event", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "rejected", externalIdentity: "R1", revision: 1, body: {} }), EPOCH);
    const order = book.state(WORKSPACE, acct).orders[0]!;
    expect(order.submission).toBe("rejected");
    expect(order.execution).toBe("not_started");
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
  });

  it("refuses an over-limit buy fill at the boundary (provider degradation, no money movement)", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X9" } }), EPOCH);
    const over = book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 110.01, currency: "USD" } } }), EPOCH);
    expect(over).toEqual({ status: "refused", reason: "over_limit_fill" });
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 100_000, reserved: 550 });
  });
});

describe("cancellation axis + late fill (§9 three axes)", () => {
  it("releases remaining reservation on cancel_confirmed and still applies a late pre-cancel fill exactly once", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-c");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(10, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X1" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 4, price: { amount: 109.9, currency: "USD" } } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "cancel_confirmed", externalIdentity: "C1", revision: 4, body: {} }), EPOCH);
    // 100,000 − 439.60 = 99,560.40 and the open remainder is no longer held.
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 99_560.4, reserved: 0 });
    expect(book.state(WORKSPACE, acct).orders[0]!.cancellation).toBe("confirmed");

    // A fill fact from before the cancel arrives late (revision 3): once, exactly.
    const late = event(co, { kind: "fill", externalIdentity: "F2", revision: 3, body: { quantity: 2, price: { amount: 109.9, currency: "USD" } } });
    expect(book.ingest(WORKSPACE, acct, late, EPOCH).status).toBe("applied");
    expect(book.ingest(WORKSPACE, acct, late, EPOCH).status).toBe("duplicate");
    // 99,560.40 − 219.80 = 99,340.60; position 4 + 2 = 6; cancellation stays confirmed.
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 99_340.6, reserved: 0 });
    expect(book.state(WORKSPACE, acct).positions[0]!.quantity).toBe(6);
    expect(book.state(WORKSPACE, acct).orders[0]!.cancellation).toBe("confirmed");
  });

  it("refuses a fill whose revision is at or after the confirmed cancellation", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-post");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(10, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X1" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "cancel_confirmed", externalIdentity: "C1", revision: 2, body: {} }), EPOCH);
    const post = book.ingest(WORKSPACE, acct, event(co, { kind: "fill", externalIdentity: "F9", revision: 3, body: { quantity: 1, price: { amount: 109.9, currency: "USD" } } }), EPOCH);
    expect(post).toEqual({ status: "refused", reason: "not_fillable" });
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 100_000, reserved: 0 });
  });

  it("keeps the reservation intact on cancel_rejected and never regresses a confirmed cancellation", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-r");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X1" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(co, { kind: "cancel_rejected", externalIdentity: "C1", revision: 2, body: {} }), EPOCH);
    expect(book.state(WORKSPACE, acct).orders[0]!.cancellation).toBe("rejected");
    expect(usd(book, acct).reserved).toBe(550);

    book.ingest(WORKSPACE, acct, event(co, { kind: "cancel_confirmed", externalIdentity: "C2", revision: 3, body: {} }), EPOCH);
    const regress = book.ingest(WORKSPACE, acct, event(co, { kind: "cancel_rejected", externalIdentity: "C3", revision: 4, body: {} }), EPOCH);
    expect(regress.status).toBe("refused");
    expect(book.state(WORKSPACE, acct).orders[0]!.cancellation).toBe("confirmed");
  });
});

describe("sell path", () => {
  it("reserves shares for a sell and credits exact proceeds on fill", () => {
    const { book, acct } = seeded();
    const buy = clientOrder("co-b");
    book.submitLocal(WORKSPACE, acct, buy, limitBuy(5, 110), EPOCH);
    book.ingest(WORKSPACE, acct, event(buy, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X1" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(buy, { kind: "fill", externalIdentity: "F1", revision: 2, body: { quantity: 5, price: { amount: 109.9, currency: "USD" } } }), EPOCH);

    const sell = clientOrder("co-s");
    expect(book.submitLocal(WORKSPACE, acct, sell, limitSell(5, 120), EPOCH).status).toBe("accepted");
    // All 5 shares now back a sell; a second oversell must fail CAS.
    expect(book.submitLocal(WORKSPACE, acct, clientOrder("co-s2"), limitSell(1, 120), EPOCH)).toEqual({ status: "refused", reason: "insufficient_position" });

    book.ingest(WORKSPACE, acct, event(sell, { kind: "accepted", externalIdentity: "E2", revision: 1, body: { externalOrder: "X2" } }), EPOCH);
    book.ingest(WORKSPACE, acct, event(sell, { kind: "fill", externalIdentity: "F2", revision: 2, body: { quantity: 5, price: { amount: 120.5, currency: "USD" } } }), EPOCH);
    // 99,450.50 + 5 × 120.50 = 100,053; position closed.
    expect(usd(book, acct)).toEqual({ currency: "USD", balance: 100_053, reserved: 0 });
    expect(book.state(WORKSPACE, acct).positions).toHaveLength(0);
  });
});

describe("erasure fence (SEC-09 substrate)", () => {
  it("suppresses provision and ingest at or below the fence", () => {
    const { book, acct } = seeded();
    const co = clientOrder("co-1");
    book.submitLocal(WORKSPACE, acct, co, limitBuy(5, 110), EPOCH);
    book.eraseWorkspace(WORKSPACE, EPOCH);
    expect(book.state(WORKSPACE, acct).orders).toHaveLength(0);
    expect(book.provision(WORKSPACE, acct, [{ amount: 100_000, currency: "USD" }], EPOCH).status).toBe("suppressed");
    const late = book.ingest(WORKSPACE, acct, event(co, { kind: "accepted", externalIdentity: "E1", revision: 1, body: { externalOrder: "X9" } }), EPOCH);
    expect(late.status).toBe("suppressed");
  });
});
