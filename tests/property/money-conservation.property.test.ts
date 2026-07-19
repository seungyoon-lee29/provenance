import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { brandReference } from "../../src/shared/contracts/brands";
import type { BrokerPaperAccountReference } from "../../src/shared/contracts/brands";
import { BrokerPaperBook } from "../../src/modules/paper-trading/broker/book";
import type { BrokerClientOrderReference } from "../../src/modules/paper-trading/broker/contracts";
import type { PaperOrderPayload } from "../../src/modules/paper-trading/internal/contracts";

/**
 * Standing invariant (ticket 21, ADR 0004): the broker book conserves money.
 * Reservation is DERIVED from the open reserving orders (never a stored
 * counter), so for any sequence of limit buys the reserved cash equals the sum
 * of accepted orders' cost and can never exceed the balance (no overspend).
 * A refused order changes nothing, so the identity holds across refusals too.
 */

const WS = "ws-prop";
const SEED = 1_000_000;

function account(): BrokerPaperAccountReference {
  return brandReference<string, "BrokerPaperAccountReference">("acct-prop") as BrokerPaperAccountReference;
}
function clientOrder(id: string): BrokerClientOrderReference {
  return brandReference<string, "BrokerClientOrderReference">(id) as BrokerClientOrderReference;
}
function limitBuy(quantity: number, price: number): PaperOrderPayload {
  return {
    instrument: brandReference<string, "PaperInstrumentReference">("instr:X"),
    venue: "NASDAQ",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: price, currency: "USD" },
    quantity,
    timeInForce: "DAY",
  } as PaperOrderPayload;
}

describe("broker book money conservation", () => {
  it("reserved cash equals the sum of accepted orders and never exceeds the balance", () => {
    const order = fc.record({ qty: fc.integer({ min: 1, max: 100 }), price: fc.integer({ min: 1, max: 1000 }) });
    fc.assert(
      fc.property(fc.array(order, { maxLength: 25 }), (orders) => {
        const book = new BrokerPaperBook();
        book.provision(WS, account(), [{ amount: SEED, currency: "USD" }]);
        let expectedReserved = 0;
        orders.forEach((entry, index) => {
          const outcome = book.submitLocal(WS, account(), clientOrder(`c-${index}`), limitBuy(entry.qty, entry.price));
          if (outcome.status === "accepted") expectedReserved += entry.qty * entry.price;
        });
        const usd = book.state(WS, account()).cash.find((row) => row.currency === "USD");
        expect(usd).toBeDefined();
        // Derived reservation identity: reserved == Σ accepted cost.
        expect(usd?.reserved).toBe(expectedReserved);
        // A buy only reserves; the balance is untouched until a fill.
        expect(usd?.balance).toBe(SEED);
        // No overspend: reservations never exceed the balance.
        expect(usd?.reserved).toBeLessThanOrEqual(SEED);
      }),
    );
  });

  it("refuses any single buy whose cost exceeds the available cash (no overspend)", () => {
    const smallSeed = 500;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 1000 }), (qty, price) => {
        fc.pre(qty * price > smallSeed); // only orders that would overspend the seed
        const book = new BrokerPaperBook();
        book.provision(WS, account(), [{ amount: smallSeed, currency: "USD" }]);
        const outcome = book.submitLocal(WS, account(), clientOrder("c-over"), limitBuy(qty, price));
        expect(outcome.status).toBe("refused");
        expect(book.state(WS, account()).cash.find((row) => row.currency === "USD")?.reserved).toBe(0);
      }),
    );
  });
});
