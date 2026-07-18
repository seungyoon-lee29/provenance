import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";
import { effectiveBrokerEvents, projectBrokerBook } from "../src/modules/actual-portfolio/broker-sync/projection";
import { eventKey } from "../src/modules/actual-portfolio/broker-sync/contracts";
import type { BrokerComponentKey, BrokerSyncAccountReference, BrokerSyncEvent } from "../src/modules/actual-portfolio/broker-sync/contracts";

function conn(): ProviderConnectionReference {
  return brandReference<string, "ProviderConnectionReference">("conn-live") as ProviderConnectionReference;
}
function acct(): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">("acct-1") as BrokerSyncAccountReference;
}

function position(entity: string, signedQuantity: number, revision: number, overrides: Partial<BrokerSyncEvent> = {}): BrokerSyncEvent {
  return {
    connection: conn(),
    account: acct(),
    component: "positions",
    entity,
    kind: "position",
    externalIdentity: `${entity}-${revision}`,
    revision,
    asOf: "2026-07-19T00:00:00Z",
    body: { signedQuantity, currency: "USD" },
    ...overrides,
  } as BrokerSyncEvent;
}

const ALL: readonly BrokerComponentKey[] = ["positions", "cash", "activity"];

describe("F10 broker projection — effective fold + absence-vs-zero", () => {
  it("projects base position events into rows", () => {
    const events = [position("AAPL", 10, 1), position("MSFT", 5, 1)];
    const book = projectBrokerBook(effectiveBrokerEvents(events), new Set(ALL));
    expect(book.positions.map((row) => [row.entity, row.body.signedQuantity])).toEqual([["AAPL", 10], ["MSFT", 5]]);
    expect(book.components.positions).toBe("present");
  });

  it("resolves a correction chain deterministically regardless of arrival order", () => {
    const base = position("AAPL", 10, 1);
    const restated = position("AAPL", 12, 2, { corrects: eventKey(base) });
    const forward = projectBrokerBook(effectiveBrokerEvents([base, restated]), new Set(ALL));
    const reversed = projectBrokerBook(effectiveBrokerEvents([restated, base]), new Set(ALL));
    expect(forward.positions).toEqual(reversed.positions);
    expect(forward.positions.map((row) => row.body.signedQuantity)).toEqual([12]);
  });

  it("voids a reversed position but keeps the component present (zero, not absent)", () => {
    const base = position("AAPL", 10, 1);
    const reversal = position("AAPL", 0, 2, { kind: "reversal", corrects: eventKey(base) });
    const book = projectBrokerBook(effectiveBrokerEvents([base, reversal]), new Set(ALL));
    expect(book.positions).toHaveLength(0);
    expect(book.components.positions).toBe("present");
  });

  it("distinguishes an empty-but-present component from an absent one", () => {
    const book = projectBrokerBook(effectiveBrokerEvents([]), new Set<BrokerComponentKey>(["positions", "cash"]));
    expect(book.components.cash).toBe("present");
    expect(book.components.activity).toBe("absent");
    expect(book.cash).toHaveLength(0);
  });

  it("preserves an unsupported position's source reference without valuing it", () => {
    const short = position("SPY", -3, 1, { body: { signedQuantity: -3, currency: "USD", unsupported: true, sourceType: "short", sourceReference: "opaque-src-9" } } as Partial<BrokerSyncEvent>);
    const book = projectBrokerBook(effectiveBrokerEvents([short]), new Set(ALL));
    expect(book.positions[0]?.body).toMatchObject({ unsupported: true, sourceReference: "opaque-src-9", signedQuantity: -3 });
  });
});
