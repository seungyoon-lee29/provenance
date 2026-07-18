import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { BrokerPaperAccountReference, ProviderConnectionReference, Revision } from "../src/shared/contracts/brands";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { BrokerPaperBook } from "../src/modules/paper-trading/broker/book";
import { BrokerOutbox, BrokerPendingSubmissions } from "../src/modules/paper-trading/broker/outbox";
import { BrokerPaperTradingService } from "../src/modules/paper-trading/broker/service";
import type { PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

/**
 * Regression replays of the codex refutation panel (money + intent axes).
 * Each test is the panel's executed counterexample; the assertion is the
 * adjudicated contract the fix now upholds.
 */

const WORKSPACE = "workspace:a";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL");
const CONN = brandReference<string, "ProviderConnectionReference">("conn") as ProviderConnectionReference;

function acct(id = "acct"): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">(id) as BrokerPaperAccountReference;
}
function co(id: string) {
  return brandReference<string, "BrokerClientOrderReference">(id);
}
function limit(side: "buy" | "sell", quantity: number, price: number, currency = "USD"): PaperOrderPayload {
  return { instrument: AAPL, venue: "NASDAQ", session: "regular", side, orderType: "limit", limitPrice: { amount: price, currency }, quantity, timeInForce: "DAY" };
}
function ev(order: ReturnType<typeof co>, kind: string, externalIdentity: string, revision: number, body: Record<string, unknown>) {
  return { connection: CONN, order, kind, externalIdentity, revision, body } as never;
}
function usd(book: BrokerPaperBook, a = acct()) {
  return book.state(WORKSPACE, a).cash.find((row) => row.currency === "USD")!;
}

describe("money panel replays (book boundary)", () => {
  it("#3 refuses a fill that crosses an off-tick limit — the limit is rejected at submit", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }]);
    // 109.999999999 is off-tick: minor-unit rounding would have lifted it to
    // $110.00 and let a $110 fill through. It must be refused at submit.
    expect(book.submitLocal(WORKSPACE, acct(), co("c1"), limit("buy", 1, 109.999999999))).toEqual({ status: "refused", reason: "invalid_payload" });
    // A genuinely tick-aligned $110 limit is still fine, and a $110.01 fill on it is refused.
    book.submitLocal(WORKSPACE, acct(), co("c2"), limit("buy", 1, 110));
    book.ingest(WORKSPACE, acct(), ev(co("c2"), "accepted", "E", 1, { externalOrder: "X" }));
    expect(book.ingest(WORKSPACE, acct(), ev(co("c2"), "fill", "F", 2, { quantity: 1, price: { amount: 110.01, currency: "USD" } }))).toEqual({ status: "refused", reason: "over_limit_fill" });
    expect(usd(book).balance).toBe(100_000);
  });

  it("#4 refuses an overflowing price at submit and never yields non-finite cash", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 1e12, currency: "USD" }]);
    expect(book.submitLocal(WORKSPACE, acct(), co("c1"), limit("buy", 1, 1e307)).status).toBe("refused");
    // A within-bounds order that later receives an overflow fill price is refused at the fold.
    book.submitLocal(WORKSPACE, acct(), co("c2"), limit("buy", 1, 100));
    book.ingest(WORKSPACE, acct(), ev(co("c2"), "accepted", "E", 1, { externalOrder: "X" }));
    expect(book.ingest(WORKSPACE, acct(), ev(co("c2"), "fill", "F", 2, { quantity: 1, price: { amount: 1e307, currency: "USD" } }))).toEqual({ status: "refused", reason: "invalid_event" });
    expect(Number.isFinite(usd(book).balance)).toBe(true);
  });

  it("#2 quarantines a permuted-external-identity fill at an already-applied (order,kind,revision)", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }]);
    book.submitLocal(WORKSPACE, acct(), co("c1"), limit("buy", 5, 110));
    book.ingest(WORKSPACE, acct(), ev(co("c1"), "accepted", "E", 1, { externalOrder: "X" }));
    expect(book.ingest(WORKSPACE, acct(), ev(co("c1"), "fill", "F1", 2, { quantity: 1, price: { amount: 109, currency: "USD" } })).status).toBe("applied");
    const permuted = book.ingest(WORKSPACE, acct(), ev(co("c1"), "fill", "F2", 2, { quantity: 1, price: { amount: 109, currency: "USD" } }));
    expect(permuted.status).toBe("quarantined");
    expect(book.state(WORKSPACE, acct()).positions[0]!.quantity).toBe(1);
    // A genuine partial fill at a NEW revision still applies (position → 2).
    expect(book.ingest(WORKSPACE, acct(), ev(co("c1"), "fill", "F3", 3, { quantity: 1, price: { amount: 109, currency: "USD" } })).status).toBe("applied");
    expect(book.state(WORKSPACE, acct()).positions[0]!.quantity).toBe(2);
  });

  it("#1 a late fill on a cancelled order cannot consume a live order's reserved shares", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }]);
    // Buy 1 share and fill it → hold 1.
    book.submitLocal(WORKSPACE, acct(), co("buy"), limit("buy", 1, 110));
    book.ingest(WORKSPACE, acct(), ev(co("buy"), "accepted", "Eb", 1, { externalOrder: "Xb" }));
    book.ingest(WORKSPACE, acct(), ev(co("buy"), "fill", "Fb", 2, { quantity: 1, price: { amount: 100, currency: "USD" } }));

    // Sell A reserves the 1 share, then is confirmed-cancelled (releases it).
    book.submitLocal(WORKSPACE, acct(), co("sellA"), limit("sell", 1, 120));
    book.ingest(WORKSPACE, acct(), ev(co("sellA"), "accepted", "Ea", 1, { externalOrder: "Xa" }));
    book.ingest(WORKSPACE, acct(), ev(co("sellA"), "cancel_confirmed", "Ca", 3, {}));

    // Sell B now legitimately reserves the freed share.
    expect(book.submitLocal(WORKSPACE, acct(), co("sellB"), limit("sell", 1, 120)).status).toBe("accepted");

    // A late PRE-cancel fill for A (revision 2 < cancel revision 3) must NOT
    // consume B's reserved share — otherwise reserved would exceed held.
    const late = book.ingest(WORKSPACE, acct(), ev(co("sellA"), "fill", "Fa", 2, { quantity: 1, price: { amount: 120, currency: "USD" } }));
    expect(late).toEqual({ status: "refused", reason: "insufficient_position" });
    const held = book.state(WORKSPACE, acct()).positions[0]!.quantity;
    // reserved shares (B's 1) never exceeds the 1 held.
    expect(held).toBe(1);
  });

  it("#4b refuses a cross-currency fill instead of polluting an instrument's basis", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }, { amount: 100_000, currency: "EUR" }]);
    book.submitLocal(WORKSPACE, acct(), co("u"), limit("buy", 1, 100, "USD"));
    book.ingest(WORKSPACE, acct(), ev(co("u"), "accepted", "Eu", 1, { externalOrder: "Xu" }));
    book.ingest(WORKSPACE, acct(), ev(co("u"), "fill", "Fu", 2, { quantity: 1, price: { amount: 100, currency: "USD" } }));

    book.submitLocal(WORKSPACE, acct(), co("e"), limit("buy", 2, 50, "EUR"));
    book.ingest(WORKSPACE, acct(), ev(co("e"), "accepted", "Ee", 1, { externalOrder: "Xe" }));
    const euro = book.ingest(WORKSPACE, acct(), ev(co("e"), "fill", "Fe", 2, { quantity: 2, price: { amount: 50, currency: "EUR" } }));
    expect(euro).toEqual({ status: "refused", reason: "invalid_event" });
    const position = book.state(WORKSPACE, acct()).positions[0]!;
    expect(position.costBasis).toEqual({ amount: 100, currency: "USD" });
  });

  it("erasure fence cannot be bypassed by a higher write epoch (epoch is not a caller argument)", () => {
    const book = new BrokerPaperBook();
    book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }]);
    book.eraseWorkspace(WORKSPACE, 1);
    // provision no longer takes an epoch — there is no argument to lift above the fence.
    expect(book.provision(WORKSPACE, acct(), [{ amount: 100_000, currency: "USD" }]).status).toBe("suppressed");
    expect(book.state(WORKSPACE, acct()).cash).toEqual([]);
  });
});

// ─── Intent axis ─────────────────────────────────────────────────────────────

function viewer(overrides?: Partial<WorkspaceViewerContext>): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    ...overrides,
  };
}
function control(key: string, revision: number): MutationControl {
  return { idempotencyKey: key, expectedRevision: brandReference<string, "Revision">(String(revision)) as Revision };
}

function intentHarness() {
  const book = new BrokerPaperBook();
  const outbox = new BrokerOutbox();
  const pending = new BrokerPendingSubmissions();
  const nowRef = { value: "2026-07-18T10:00:00.000Z" };
  const identityEpoch = { value: "epoch:1" };
  let intentSeq = 0;
  let orderSeq = 0;
  const service = new BrokerPaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: () => identityEpoch.value },
    policy: { intentTtlMs: 60_000, seedCash: [{ amount: 100_000, currency: "USD" }] },
    book,
    outbox,
    pending,
    connections: { currentGeneration: () => "gen-1" },
    newIntentReference: () => `bpi-${++intentSeq}`,
    newClientOrder: () => `bco-${++orderSeq}`,
  });
  return { book, outbox, pending, service, nowRef, identityEpoch };
}

describe("intent panel replays (service)", () => {
  it("A: an auth epoch that advances between the trio and the durable write denies with zero side effects", async () => {
    // Identity agrees with the viewer at method entry (epoch:1) but reports an
    // advanced epoch by the time the act closure re-checks — the record and the
    // viewer both stay epoch:1, so ONLY the just-before-write recheck can catch
    // it. A call-sequenced stub models the mid-command epoch advance.
    const book = new BrokerPaperBook();
    const outbox = new BrokerOutbox();
    const pending = new BrokerPendingSubmissions();
    const epochByCall = ["epoch:1", "epoch:1", "epoch:2"]; // prepare entry, submit entry, act-time recheck (advanced)
    let call = 0;
    let intentSeq = 0;
    let orderSeq = 0;
    const service = new BrokerPaperTradingService({
      now: () => "2026-07-18T10:00:00.000Z",
      identity: { currentAuthorizationEpoch: () => epochByCall[Math.min(call++, epochByCall.length - 1)]! },
      policy: { intentTtlMs: 60_000, seedCash: [{ amount: 100_000, currency: "USD" }] },
      book,
      outbox,
      pending,
      connections: { currentGeneration: () => "gen-1" },
      newIntentReference: () => `bpi-${++intentSeq}`,
      newClientOrder: () => `bco-${++orderSeq}`,
    });
    const prepared = await service.prepare({ account: acct(), connection: CONN, payload: limit("buy", 1, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare");
    const outcome = await service.submit(prepared.intent.reference, control("k1", 0), viewer());
    expect(outcome).toEqual({ status: "denied" });
    expect(book.state(WORKSPACE, acct()).orders).toHaveLength(0);
    expect(outbox.list(WORKSPACE)).toHaveLength(0);
    expect(pending.list(WORKSPACE)).toHaveLength(0);
    expect(book.currentRevision(WORKSPACE, acct())).toBe(0);
  });

  it("D: an intent is expired AT the deadline, not only after it", async () => {
    const h = intentHarness();
    const prepared = await h.service.prepare({ account: acct(), connection: CONN, payload: limit("buy", 1, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error("prepare");
    h.nowRef.value = prepared.intent.expiresAt; // now === expiresAt
    expect(await h.service.submit(prepared.intent.reference, control("k1", 0), viewer())).toEqual({ status: "refused", reason: "intent_expired" });
    expect(h.book.state(WORKSPACE, acct()).orders).toHaveLength(0);
  });

  it("E: server-minted client order identities are unique across accounts (no forced collision)", async () => {
    const h = intentHarness();
    const x = await h.service.prepare({ account: acct("acct-x"), connection: CONN, payload: limit("buy", 1, 100) }, viewer());
    const y = await h.service.prepare({ account: acct("acct-y"), connection: CONN, payload: limit("buy", 1, 100) }, viewer());
    if (x.status !== "issued" || y.status !== "issued") throw new Error("prepare");
    expect(String(x.intent.clientOrder)).not.toBe(String(y.intent.clientOrder));
  });
});
