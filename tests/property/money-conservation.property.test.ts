import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { brandReference } from "../../src/shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../src/shared/contracts/brands";
import type { PaperFill, PaperOrderPayload } from "../../src/modules/paper-trading/internal/contracts";
import { MemoryPaperJournalStore, PaperJournal } from "../../src/modules/paper-trading/internal/journal";
import type { PaperJournalEntry } from "../../src/modules/paper-trading/internal/journal";

/**
 * Standing invariant (ticket 21, ADR 0004), re-established on the persistent
 * Paper journal after Stage 1 removed its old carrier (BrokerPaperBook, gone
 * with F9). The journal is now the ONLY money boundary, so conservation is
 * stated against its fold, over arbitrary interleavings of submits, fills,
 * cancels, expiries and dividends driven through the real append paths:
 *
 *   1. cash identity      — balance == seed − Σ buy gross + Σ sell gross + Σ dividends
 *   2. position identity  — quantity == Σ buy fills − Σ sell fills
 *   3. derived reservation — reserved == Σ remaining × unitPrice over reserving orders
 *   4. fail-closed        — balance, reserved and quantity never go negative
 *   5. exactly-once       — replaying every system event changes nothing
 *   6. restart            — a journal hydrated from the same store folds the
 *                           identical state (persistence conserves money)
 *
 * The oracle recomputes 1–3 from the raw applied entry list, independently of
 * foldAccountState's own bookkeeping. The journal runs on the SAME store port
 * the pg implementation passes (tests/persistence/paper-journal-contract.ts),
 * so what is proven here holds for the durable ledger.
 */

const WS = "ws-money-prop";
const SEED = 1_000_000;
const INSTRUMENT = "instr:PROP";
const NOW_BASE = Date.parse("2026-07-18T01:00:00.000Z");

function account(): InternalPaperAccountReference {
  return brandReference<string, "InternalPaperAccountReference">("acct-money-prop");
}

function payloadOf(side: "buy" | "sell", quantity: number, price: number): PaperOrderPayload {
  return {
    instrument: brandReference<string, "PaperInstrumentReference">(INSTRUMENT),
    venue: "NASDAQ",
    session: "regular",
    side,
    orderType: "limit",
    limitPrice: { amount: price, currency: "USD" },
    quantity,
    timeInForce: "GTC",
  } as PaperOrderPayload;
}

type Op =
  | Readonly<{ kind: "submit"; side: "buy" | "sell"; quantity: number; price: number }>
  | Readonly<{ kind: "fill"; orderIndex: number; quantity: number }>
  | Readonly<{ kind: "cancel"; orderIndex: number }>
  | Readonly<{ kind: "expire"; orderIndex: number }>
  | Readonly<{ kind: "dividend"; perShare: number }>;

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("submit" as const), side: fc.constantFrom("buy" as const, "sell" as const), quantity: fc.integer({ min: 1, max: 50 }), price: fc.integer({ min: 1, max: 500 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("fill" as const), orderIndex: fc.nat({ max: 40 }), quantity: fc.integer({ min: 1, max: 50 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("cancel" as const), orderIndex: fc.nat({ max: 40 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("expire" as const), orderIndex: fc.nat({ max: 40 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("dividend" as const), perShare: fc.integer({ min: 1, max: 20 }) }) },
);

type Driven = Readonly<{
  journal: PaperJournal;
  store: MemoryPaperJournalStore;
  acct: InternalPaperAccountReference;
  systemEvents: readonly Readonly<{ dedupeKey: string; body: Parameters<PaperJournal["appendSystem"]>[3] }>[];
}>;

/** Drive an op sequence through the real journal append paths (invalid ops are refused no-ops — that is part of the property). */
async function drive(ops: readonly Op[]): Promise<Driven> {
  const store = new MemoryPaperJournalStore();
  let tick = 0;
  const now = () => new Date(NOW_BASE + ++tick * 1_000).toISOString();
  const journal = await new PaperJournal(now, undefined, store).init();
  const acct = account();
  await journal.provision(WS, acct, [{ amount: SEED, currency: "USD" }]);

  const submitted: PaperOrderReference[] = [];
  const systemEvents: Array<Readonly<{ dedupeKey: string; body: Parameters<PaperJournal["appendSystem"]>[3] }>> = [];
  let sequence = 0;

  for (const op of ops) {
    sequence += 1;
    if (op.kind === "submit") {
      const revision = journal.currentRevision(WS, acct);
      const order = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:${revision + 1}`);
      const payload = payloadOf(op.side, op.quantity, op.price);
      const outcome = await journal.appendCommand(
        WS, acct, "submit", { idempotencyKey: `submit-${sequence}`, expectedRevision: String(revision) }, JSON.stringify(op),
        (context) => {
          // Mirrors the service decision: bound the reservation, refuse what cannot be covered.
          if (payload.side === "buy") {
            const cash = context.state.cash.get("USD");
            const available = (cash?.balance ?? 0) - (cash?.reserved ?? 0);
            if (available < op.quantity * op.price - 1e-9) return { refuse: "insufficient_cash" };
            return { entry: { kind: "order_submitted", order, payload, acceptedAt: now(), reservation: { kind: "cash", unitPrice: payload.limitPrice! } }, order };
          }
          const position = context.state.positions.get(INSTRUMENT);
          const sellable = (position?.quantity ?? 0) - (position?.reserved ?? 0);
          if (sellable < op.quantity) return { refuse: "insufficient_position" };
          return { entry: { kind: "order_submitted", order, payload, acceptedAt: now(), reservation: { kind: "quantity" } }, order };
        },
      );
      if (outcome.status === "applied") submitted.push(order);
      continue;
    }
    if (op.kind === "dividend") {
      const dedupeKey = `dividend-${sequence}`;
      const body = {
        kind: "dividend_applied" as const,
        action: brandReference<string, "PaperCorporateActionReference">(`action:${dedupeKey}`),
        instrument: brandReference<string, "PaperInstrumentReference">(INSTRUMENT),
        perShare: { amount: op.perShare, currency: "USD" },
      };
      if ((await journal.appendSystem(WS, acct, dedupeKey, body)).status === "applied") systemEvents.push({ dedupeKey, body });
      continue;
    }
    if (submitted.length === 0) continue;
    const order = submitted[op.orderIndex % submitted.length]!;
    if (op.kind === "fill") {
      const target = journal.state(WS, acct).orders.get(String(order));
      if (target === undefined) continue;
      const price = target.payload.limitPrice!.amount;
      const dedupeKey = `fill:${String(order)}:${sequence}`;
      const fill: PaperFill = {
        identity: brandReference<string, "PaperFillIdentity">(dedupeKey),
        order,
        quantity: op.quantity,
        price: { amount: price, currency: "USD" },
        eventTime: now(),
        receivedAt: now(),
        evidenceReference: `evidence:${sequence}`,
        policyVersion: "simulation-v1",
      };
      const body = { kind: "fill_applied" as const, fill };
      if ((await journal.appendSystem(WS, acct, dedupeKey, body)).status === "applied") systemEvents.push({ dedupeKey, body });
      continue;
    }
    if (op.kind === "cancel") {
      const revision = journal.currentRevision(WS, acct);
      await journal.appendCommand(
        WS, acct, "cancel", { idempotencyKey: `cancel-${sequence}`, expectedRevision: String(revision) }, JSON.stringify(op),
        (context) => {
          const current = context.state.orders.get(String(order));
          if (current === undefined) return { refuse: "unknown_order" };
          if (current.cancellation === "confirmed") return { refuse: "already_cancelled" };
          const cancellable = current.execution === "open" || current.execution === "partially_filled";
          return { entry: { kind: "cancellation_resolved", order, resolution: cancellable ? "confirmed" : "rejected" }, order };
        },
      );
      continue;
    }
    const dedupeKey = `expire:${String(order)}`;
    const body = { kind: "order_expired" as const, order };
    if ((await journal.appendSystem(WS, acct, dedupeKey, body)).status === "applied") systemEvents.push({ dedupeKey, body });
  }
  return { journal, store, acct, systemEvents };
}

/** Independent oracle over the raw applied entries — no shared code with foldAccountState's bookkeeping. */
function oracle(entries: readonly PaperJournalEntry[]) {
  let cash = 0;
  let quantity = 0;
  const open = new Map<string, { side: "buy" | "sell"; remaining: number; unitPrice: number; reservationKind: "cash" | "quantity"; live: boolean }>();
  for (const entry of entries) {
    switch (entry.kind) {
      case "account_opened":
        for (const seed of entry.seedCash) cash += seed.amount;
        break;
      case "order_submitted":
        open.set(String(entry.order), {
          side: entry.payload.side,
          remaining: entry.payload.quantity,
          unitPrice: entry.reservation.kind === "cash" ? entry.reservation.unitPrice.amount : 0,
          reservationKind: entry.reservation.kind,
          live: true,
        });
        break;
      case "fill_applied": {
        const gross = entry.fill.quantity * entry.fill.price.amount;
        const order = open.get(String(entry.fill.order))!;
        if (order.side === "buy") {
          cash -= gross;
          quantity += entry.fill.quantity;
        } else {
          cash += gross;
          quantity -= entry.fill.quantity;
        }
        order.remaining -= entry.fill.quantity;
        if (order.remaining <= 0) order.live = false;
        break;
      }
      case "cancellation_resolved":
        if (entry.resolution === "confirmed") open.get(String(entry.order))!.live = false;
        break;
      case "order_expired":
        open.get(String(entry.order))!.live = false;
        break;
      case "dividend_applied":
        if (quantity > 0) cash += quantity * entry.perShare.amount;
        break;
      case "corporate_action_applied":
        throw new Error("splits are covered by their own targeted property");
    }
  }
  let cashReserved = 0;
  let quantityReserved = 0;
  for (const order of open.values()) {
    if (!order.live) continue;
    if (order.reservationKind === "cash") cashReserved += order.remaining * order.unitPrice;
    else quantityReserved += order.remaining;
  }
  return { cash, quantity, cashReserved, quantityReserved };
}

describe("paper journal money conservation (standing property)", () => {
  it("conserves cash, positions and derived reservations over arbitrary op sequences, and never goes negative", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArbitrary, { maxLength: 30 }), async (ops) => {
        const { journal, acct } = await drive(ops);
        const entries = journal.list(WS, acct);
        const expected = oracle(entries);
        const state = journal.state(WS, acct);
        const usd = state.cash.get("USD")!;
        const position = state.positions.get(INSTRUMENT);

        expect(usd.balance).toBeCloseTo(expected.cash, 6);
        expect(position?.quantity ?? 0).toBe(expected.quantity);
        expect(usd.reserved).toBeCloseTo(expected.cashReserved, 6);
        expect(position?.reserved ?? 0).toBe(expected.quantityReserved);

        expect(usd.balance).toBeGreaterThanOrEqual(-1e-9);
        expect(usd.reserved).toBeGreaterThanOrEqual(0);
        expect(position?.quantity ?? 0).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("replaying every system event is a no-op: money moves exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArbitrary, { maxLength: 20 }), async (ops) => {
        const { journal, acct, systemEvents } = await drive(ops);
        const before = journal.state(WS, acct);
        for (const event of systemEvents) {
          const replay = await journal.appendSystem(WS, acct, event.dedupeKey, event.body);
          expect(replay.status).not.toBe("applied");
        }
        expect(journal.state(WS, acct)).toEqual(before);
      }),
    );
  });

  it("a restart conserves money: the hydrated journal folds the identical state", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArbitrary, { maxLength: 20 }), async (ops) => {
        const { journal, store, acct } = await drive(ops);
        const rehydrated = await new PaperJournal(() => new Date(NOW_BASE).toISOString(), undefined, store).init();
        expect(rehydrated.state(WS, acct)).toEqual(journal.state(WS, acct));
        expect(rehydrated.currentRevision(WS, acct)).toBe(journal.currentRevision(WS, acct));
      }),
    );
  });

  it("a split scales quantity exactly and moves no money: cash and total cost basis are invariant", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 40 }),
        async (numerator, denominator, lots) => {
          const quantity = lots * denominator; // whole-share precondition by construction
          const { journal, acct } = await drive([
            { kind: "submit", side: "buy", quantity, price: 100 },
            { kind: "fill", orderIndex: 0, quantity },
          ]);
          const before = journal.state(WS, acct);
          const outcome = await journal.appendSystem(WS, acct, "action:prop-split", {
            kind: "corporate_action_applied",
            action: brandReference<string, "PaperCorporateActionReference">("action:prop-split"),
            instrument: brandReference<string, "PaperInstrumentReference">(INSTRUMENT),
            adjustment: { kind: "split", numerator, denominator },
          });
          expect(outcome.status).toBe("applied");
          const after = journal.state(WS, acct);
          expect(after.cash.get("USD")).toEqual(before.cash.get("USD"));
          expect(after.positions.get(INSTRUMENT)?.quantity).toBe((quantity * numerator) / denominator);
          expect(after.positions.get(INSTRUMENT)?.costBasis).toEqual(before.positions.get(INSTRUMENT)?.costBasis);
        },
      ),
    );
  });
});
