import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { MemoryPaperJournalStore, PaperJournal } from "../../src/modules/paper-trading/internal/journal";
import { brandReference } from "../../src/shared/contracts/brands";
import type {
  InternalPaperAccountReference,
  PaperOrderReference,
} from "../../src/shared/contracts/brands";
import {
  currencyMinorUnitScale,
  fromMinorUnits,
  toMinorUnits,
} from "../../src/modules/paper-trading/internal/contracts";
import type {
  PaperCorporateActionReference,
  PaperFill,
  PaperFillIdentity,
  PaperInstrumentReference,
  PaperOrderPayload,
} from "../../src/modules/paper-trading/internal/contracts";

/**
 * BLIND refutation tests (Stage 2-c gate). Authored from SPEC + public API
 * only — journal.ts / simulator.ts / service.ts and any existing
 * paper-trading test were NOT read while writing these. Every fixture below
 * was discovered empirically by running the suite against the real
 * implementation (black-box), never by reading its source.
 */

const WORKSPACE = "ws-blind";

function clock(startIso = "2026-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => new Date((t += 1_000)).toISOString();
}

function acct(id: string): InternalPaperAccountReference {
  return brandReference(id);
}
function orderRef(id: string): PaperOrderReference {
  return brandReference(id);
}
function instrumentRef(id: string): PaperInstrumentReference {
  return brandReference(id);
}
function fillIdentity(id: string): PaperFillIdentity {
  return brandReference(id);
}
function actionRef(id: string): PaperCorporateActionReference {
  return brandReference(id);
}

async function freshJournal(now: () => string) {
  const store = new MemoryPaperJournalStore();
  const journal = new PaperJournal(now, undefined, store);
  await journal.init();
  return { journal, store };
}

function buyPayload(instrument: PaperInstrumentReference, quantity: number, price: number, currency = "USD"): PaperOrderPayload {
  return {
    instrument,
    venue: "TEST",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: price, currency },
    quantity,
    timeInForce: "DAY",
  };
}

function sellPayload(instrument: PaperInstrumentReference, quantity: number, price: number, currency = "USD"): PaperOrderPayload {
  return {
    instrument,
    venue: "TEST",
    session: "regular",
    side: "sell",
    orderType: "limit",
    limitPrice: { amount: price, currency },
    quantity,
    timeInForce: "DAY",
  };
}

async function submit(
  journal: PaperJournal,
  account: InternalPaperAccountReference,
  now: () => string,
  order: PaperOrderReference,
  payload: PaperOrderPayload,
  idempotencyKey: string,
) {
  const acceptedAt = now();
  const expectedRevision = String(journal.currentRevision(WORKSPACE, account));
  const canonicalPayload = JSON.stringify(payload);
  return journal.appendCommand(
    WORKSPACE,
    account,
    "submit",
    { idempotencyKey, expectedRevision },
    canonicalPayload,
    () => ({
      entry: {
        kind: "order_submitted" as const,
        order,
        payload,
        acceptedAt,
        reservation: { kind: "cash" as const, unitPrice: payload.limitPrice! },
      },
      order,
    }),
  );
}

function makeFill(
  order: PaperOrderReference,
  identity: PaperFillIdentity,
  quantity: number,
  price: number,
  currency: string,
  eventTime: string,
  receivedAt: string,
): PaperFill {
  return {
    identity,
    order,
    quantity,
    price: { amount: price, currency },
    eventTime,
    receivedAt,
    evidenceReference: `evidence:${identity}`,
    policyVersion: "policy-v1",
  };
}

async function applyFill(
  journal: PaperJournal,
  account: InternalPaperAccountReference,
  fill: PaperFill,
) {
  return journal.appendSystem(WORKSPACE, account, `fill:${fill.identity}`, {
    kind: "fill_applied",
    fill,
  });
}

describe("stage 2-c blind refutation — minor-unit round-trip (SPEC 3)", () => {
  it("fromMinorUnits(toMinorUnits(m)) round-trips for representable major amounts", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("USD", "KRW"),
        fc.integer({ min: 0, max: 1_000_000 }),
        (currency, minorUnits) => {
          const money = fromMinorUnits(minorUnits, currency);
          expect(toMinorUnits(money)).toBe(minorUnits);
        },
      ),
    );
  });

  it("$10.50 USD seed folds to exactly 1050 minor units", () => {
    expect(toMinorUnits({ amount: 10.5, currency: "USD" })).toBe(1050);
    expect(currencyMinorUnitScale("USD")).toBe(100);
    expect(currencyMinorUnitScale("KRW")).toBe(1);
  });
});

describe("stage 2-c blind refutation — exact cash conservation (SPEC 1)", () => {
  it("balance == seed - buy fills + sell fills + dividends, in exact minor units, and never negative", async () => {
    const now = clock();
    const { journal } = await freshJournal(now);
    const account = acct("acct-conservation");
    const instrument = instrumentRef("instr:CASHTEST");
    const currency = "USD";

    const seed = { amount: 1000, currency };
    await journal.provision(WORKSPACE, account, [seed]);

    let expectedBalanceMinor = toMinorUnits(seed);

    // 1) buy 10 @ 50.00, filled in full -> debits balance by gross.
    const buyOrder = orderRef("paper-order:acct-conservation:1");
    const buyOutcome = await submit(journal, account, now, buyOrder, buyPayload(instrument, 10, 50, currency), "buy-1");
    expect(buyOutcome.status).toBe("applied");

    const buyFill = makeFill(buyOrder, fillIdentity("fill-1"), 10, 50, currency, now(), now());
    const buyFillOutcome = await applyFill(journal, account, buyFill);
    expect(buyFillOutcome.status).toBe("applied");
    expectedBalanceMinor -= toMinorUnits({ amount: buyFill.quantity * buyFill.price.amount, currency });

    // 2) sell 4 of those shares @ 55.00, filled in full -> credits balance by gross.
    const sellOrder = orderRef("paper-order:acct-conservation:2");
    const sellOutcome = await submit(journal, account, now, sellOrder, sellPayload(instrument, 4, 55, currency), "sell-1");
    expect(sellOutcome.status).toBe("applied");

    const sellFill = makeFill(sellOrder, fillIdentity("fill-2"), 4, 55, currency, now(), now());
    const sellFillOutcome = await applyFill(journal, account, sellFill);
    expect(sellFillOutcome.status).toBe("applied");
    expectedBalanceMinor += toMinorUnits({ amount: sellFill.quantity * sellFill.price.amount, currency });

    // 3) submit a third buy that we never fill, then cancel it -> no cash effect.
    const cancelOrder = orderRef("paper-order:acct-conservation:3");
    const cancelSubmitOutcome = await submit(journal, account, now, cancelOrder, buyPayload(instrument, 2, 20, currency), "cancel-1");
    expect(cancelSubmitOutcome.status).toBe("applied");
    const cancelExpectedRevision = String(journal.currentRevision(WORKSPACE, account));
    const cancelOutcome = await journal.appendCommand(
      WORKSPACE,
      account,
      "cancel",
      { idempotencyKey: "cancel-order-1", expectedRevision: cancelExpectedRevision },
      JSON.stringify({ order: cancelOrder }),
      () => ({
        entry: { kind: "cancellation_resolved" as const, order: cancelOrder, resolution: "confirmed" as const },
        order: cancelOrder,
      }),
    );
    expect(cancelOutcome.status).toBe("applied");
    // cancel must not move the balance either way.

    // 4) dividend on the remaining 6 shares @ $0.30/share -> credits balance.
    const perShare = { amount: 0.3, currency };
    const dividendOutcome = await journal.appendSystem(WORKSPACE, account, "dividend:1", {
      kind: "dividend_applied",
      action: actionRef("corp-action:div-1"),
      instrument,
      perShare,
    });
    expect(dividendOutcome.status).toBe("applied");
    const heldQty = buyFill.quantity - sellFill.quantity; // 6
    expectedBalanceMinor += toMinorUnits(perShare) * heldQty;

    const state = journal.state(WORKSPACE, account);
    const cashRow = state.cash.get(currency);
    expect(cashRow).toBeDefined();
    expect(cashRow!.balance).toBe(expectedBalanceMinor);
    expect(cashRow!.balance).toBeGreaterThanOrEqual(0);
  });

  it("property: seed + N buy fills stays exactly conserved and non-negative across random fill sizes", async () => {
    // seed is sized to cover the worst case (4 fills * 5 qty * 50 cents = 1000)
    // so every generated sequence is affordable end-to-end — no skip-and-pass.
    // `await` 필수: fc.assert 는 asyncProperty 에 대해 Promise 를 돌려주므로 안 받으면
    // it 이 즉시 끝나고 이 property 는 **무엇을 위반해도 초록**이 된다 (2026-07-27,
    // @typescript-eslint/no-floating-promises 도입이 잡은 건. 돈 보존 property 였다).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_000, max: 5_000 }), // seed cents
        fc.array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 50 })), { minLength: 1, maxLength: 4 }),
        async (seedCents, fills) => {
          const now = clock();
          const { journal } = await freshJournal(now);
          const account = acct("acct-prop");
          const instrument = instrumentRef("instr:PROP");
          const currency = "USD";
          const seed = fromMinorUnits(seedCents, currency);
          await journal.provision(WORKSPACE, account, [seed]);

          let expectedMinor = toMinorUnits(seed);
          let appliedCount = 0;
          let i = 0;
          for (const [qty, priceCents] of fills) {
            i += 1;
            const price = priceCents / 100;
            const gross = qty * priceCents; // already minor units, exact integers
            const ord = orderRef(`paper-order:acct-prop:${i}`);
            const submitOutcome = await submit(journal, account, now, ord, buyPayload(instrument, qty, price, currency), `buy-${i}`);
            expect(submitOutcome.status).toBe("applied");
            const fill = makeFill(ord, fillIdentity(`fill-${i}`), qty, price, currency, now(), now());
            const fillOutcome = await applyFill(journal, account, fill);
            expect(fillOutcome.status).toBe("applied");
            expectedMinor -= gross;
            appliedCount += 1;
          }

          expect(appliedCount).toBe(fills.length);
          const state = journal.state(WORKSPACE, account);
          const cashRow = state.cash.get(currency);
          expect(cashRow!.balance).toBe(expectedMinor);
          expect(cashRow!.balance).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe("stage 2-c blind refutation — §8 idempotency original receipt (SPEC 2)", () => {
  it("a replayed idempotency key on a journal that never cached the receipt returns the ORIGINAL outcome, not conflict, and reserves money exactly once", async () => {
    const store = new MemoryPaperJournalStore();
    const account = acct("acct-idem");
    const instrument = instrumentRef("instr:IDEM");
    const currency = "USD";
    const seed = { amount: 1000, currency };

    const now1 = clock("2026-01-01T00:00:00.000Z");
    const j1 = new PaperJournal(now1, undefined, store);
    await j1.init();
    await j1.provision(WORKSPACE, account, [seed]);

    // J2 initializes AFTER provision (sees genesis) but BEFORE j1's submit,
    // so its in-memory cache never observes the submit's receipt.
    const now2 = clock("2026-02-01T00:00:00.000Z");
    const j2 = new PaperJournal(now2, undefined, store);
    await j2.init();

    const order = orderRef("paper-order:acct-idem:1");
    const payload = buyPayload(instrument, 5, 10, currency);
    const key = "k";

    const applied = await submit(j1, account, now1, order, payload, key);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") return;

    // Replay through j2 with the identical key + identical canonical payload.
    const expectedRevision = String(j2.currentRevision(WORKSPACE, account));
    const replay = await j2.appendCommand(
      WORKSPACE,
      account,
      "submit",
      { idempotencyKey: key, expectedRevision },
      JSON.stringify(payload),
      () => ({
        entry: {
          kind: "order_submitted" as const,
          order,
          payload,
          acceptedAt: now2(),
          reservation: { kind: "cash" as const, unitPrice: payload.limitPrice! },
        },
        order,
      }),
    );

    expect(replay.status).toBe("applied");
    if (replay.status !== "applied") return;
    expect(replay.order).toBe(applied.order);
    expect(replay.revision).toBe(applied.revision);

    // A different payload under the SAME key must conflict, not silently apply.
    const differentPayload = buyPayload(instrument, 999, 10, currency);
    const conflictExpectedRevision = String(j2.currentRevision(WORKSPACE, account));
    const conflict = await j2.appendCommand(
      WORKSPACE,
      account,
      "submit",
      { idempotencyKey: key, expectedRevision: conflictExpectedRevision },
      JSON.stringify(differentPayload),
      () => ({
        entry: {
          kind: "order_submitted" as const,
          order: orderRef("paper-order:acct-idem:2"),
          payload: differentPayload,
          acceptedAt: now2(),
          reservation: { kind: "cash" as const, unitPrice: differentPayload.limitPrice! },
        },
        order: orderRef("paper-order:acct-idem:2"),
      }),
    );
    expect(conflict.status).toBe("conflict");

    // Money must be reserved exactly once: a THIRD journal reading the store
    // fresh must see revision advanced by exactly 1 (genesis + one submit),
    // and reserved cash equal to exactly one reservation, not doubled.
    const now3 = clock("2026-03-01T00:00:00.000Z");
    const j3 = new PaperJournal(now3, undefined, store);
    await j3.init();
    const finalRevision = j3.currentRevision(WORKSPACE, account);
    expect(finalRevision).toBe(applied.revision);

    const finalState = j3.state(WORKSPACE, account);
    const cashRow = finalState.cash.get(currency);
    const expectedReserved = toMinorUnits({ amount: payload.limitPrice!.amount * payload.quantity, currency });
    expect(cashRow!.reserved).toBe(expectedReserved);
  });
});

describe("stage 2-c blind refutation — split moves no cash (SPEC 4)", () => {
  it("a 2:1 split after a filled buy leaves cash.balance and total cost basis unchanged; quantity scales exactly", async () => {
    const now = clock();
    const { journal } = await freshJournal(now);
    const account = acct("acct-split");
    const instrument = instrumentRef("instr:SPLIT");
    const currency = "USD";
    const seed = { amount: 1000, currency };
    await journal.provision(WORKSPACE, account, [seed]);

    const buyOrder = orderRef("paper-order:acct-split:1");
    const submitOutcome = await submit(journal, account, now, buyOrder, buyPayload(instrument, 10, 20, currency), "split-buy-1");
    expect(submitOutcome.status).toBe("applied");

    const fill = makeFill(buyOrder, fillIdentity("split-fill-1"), 10, 20, currency, now(), now());
    const fillOutcome = await applyFill(journal, account, fill);
    expect(fillOutcome.status).toBe("applied");

    const beforeState = journal.state(WORKSPACE, account);
    const beforeCash = beforeState.cash.get(currency)!.balance;
    const beforePosition = beforeState.positions.get(instrument)!;
    const beforeQuantity = beforePosition.quantity;
    const beforeCostBasisMinor = beforePosition.costBasis.minorUnits;

    const splitOutcome = await journal.appendSystem(WORKSPACE, account, "split:1", {
      kind: "corporate_action_applied",
      action: actionRef("corp-action:split-1"),
      instrument,
      adjustment: { kind: "split", numerator: 2, denominator: 1 },
    });
    expect(splitOutcome.status).toBe("applied");

    const afterState = journal.state(WORKSPACE, account);
    const afterCash = afterState.cash.get(currency)!.balance;
    const afterPosition = afterState.positions.get(instrument)!;

    expect(afterCash).toBe(beforeCash);
    expect(afterPosition.costBasis.minorUnits).toBe(beforeCostBasisMinor);
    expect(afterPosition.quantity).toBe(beforeQuantity * 2);
  });
});
