import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { foldAccountState } from "../src/modules/paper-trading/internal/journal";
import type { PaperJournalEntry, PaperReservationSpec } from "../src/modules/paper-trading/internal/journal";
import type { PaperFill, PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

/**
 * A-1 (adversarial re-gate 2026-07-25). The average-cost basis relief is computed
 * in BigInt so `basis·quantity` crossing 2^53 does not drift a full liquidation
 * off exactly 0. At basis ≈ 2^53 the old `Math.round((basis·q)/q)` left a residual
 * ±1 cost basis with zero shares held — a fabricated basis. Folded directly (the
 * property this pins is pure fold arithmetic; validation is validateSystemBody's).
 */

const ACCOUNT = brandReference<string, "InternalPaperAccountReference">("acct-relief");
const INSTRUMENT = brandReference<string, "PaperInstrumentReference">("instr:RELIEF");
const KRW = "KRW";
const ACCEPTED_AT = "2026-07-18T00:00:00.000Z";
const EVENT_TIME = "2026-07-18T01:00:00.000Z";

let rev = 0;
function envelope() {
  rev += 1;
  return {
    entryReference: brandReference<string, "PaperJournalEntryReference">(`e:${rev}`),
    account: ACCOUNT,
    revision: rev,
    recordedAt: EVENT_TIME,
  };
}
function opened(amount: number): PaperJournalEntry {
  return { ...envelope(), kind: "account_opened", seedCash: [{ amount, currency: KRW }] };
}
function submitted(order: string, side: "buy" | "sell", quantity: number): PaperJournalEntry {
  const payload: PaperOrderPayload = { instrument: INSTRUMENT, venue: "KRX", session: "regular", side, orderType: "market", quantity, timeInForce: "GTC" };
  const reservation: PaperReservationSpec = side === "buy" ? { kind: "cash", unitPrice: { amount: 1, currency: KRW } } : { kind: "quantity" };
  return { ...envelope(), kind: "order_submitted", order: brandReference<string, "PaperOrderReference">(order), payload, acceptedAt: ACCEPTED_AT, reservation };
}
function filled(order: string, quantity: number, priceAmount: number): PaperJournalEntry {
  const fill: PaperFill = {
    identity: brandReference<string, "PaperFillIdentity">(`f:${order}:${rev + 1}`),
    order: brandReference<string, "PaperOrderReference">(order),
    quantity,
    price: { amount: priceAmount, currency: KRW },
    eventTime: EVENT_TIME,
    receivedAt: EVENT_TIME,
    evidenceReference: "test:relief",
    policyVersion: "simulation-v1",
  };
  return { ...envelope(), kind: "fill_applied", fill };
}

describe("A-1 average-cost relief at the 2^53 ledger ceiling", () => {
  it("returns cost basis to EXACTLY 0 on a full liquidation whose basis·quantity crosses 2^53", () => {
    // Buy 5 @ ~1.8e15 → basis ≈ 9,007,199,254,740,001 (just under 2^53).
    const buy = [opened(9_007_199_254_740_001), submitted("o-buy", "buy", 5), filled("o-buy", 5, 1_801_439_850_948_000.2)];
    const basis = foldAccountState(buy).positions.get(String(INSTRUMENT))!.costBasis.minorUnits;
    // Premise: the setup built a basis whose product with the sold quantity really
    // overflows 2^53 — otherwise the drift path is not exercised at all.
    expect(basis).toBeGreaterThan(2 ** 52);
    expect(basis * 5).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    const full = [...buy, submitted("o-sell", "sell", 5), filled("o-sell", 5, 1_000_000)];
    const position = foldAccountState(full).positions.get(String(INSTRUMENT))!;
    expect(position.quantity).toBe(0);
    // BigInt relief ⇒ exactly 0. The old float Math.round left ±1 here (mutation kill).
    expect(position.costBasis.minorUnits).toBe(0);
  });
});
