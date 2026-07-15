import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { DeliveryFactLog, projectDeliveryStatus } from "../src/modules/notification-center/delivery-fact";
import type { DeliveryFactInput } from "../src/modules/notification-center/delivery-fact";
import type { DeliveryFactKind } from "../src/modules/notification-center/delivery-fact";

const WS = "workspace:w1";
const CAUSE = brandReference<string, "DeliveryCauseId">("cause:alert:rule:1");
const KEY = "cause:alert:rule:1|email|fp:alice";

function fact(kind: DeliveryFactKind, occurredAt = "2026-07-16T00:00:00.000Z"): DeliveryFactInput {
  return { causeId: CAUSE, intentUniqueKey: KEY, kind, occurredAt };
}

describe("DeliveryFactLog — append-only, promotion 0 (spec §11 line 341)", () => {
  it("appends facts and lists them for a delivery in sequence order", () => {
    const log = new DeliveryFactLog();
    log.append(WS, fact("queued"), 1);
    log.append(WS, fact("provider_accepted"), 1);
    const facts = log.listForDelivery(WS, KEY);
    expect(facts.map((f) => f.kind)).toEqual(["queued", "provider_accepted"]);
    expect(facts.map((f) => f.sequence)).toEqual([1, 2]);
  });

  it("has no API to mutate or promote a recorded fact — accepted never becomes delivered/seen/sent", () => {
    const log = new DeliveryFactLog();
    log.append(WS, fact("queued"), 1);
    log.append(WS, fact("provider_accepted"), 1);
    // The provider only accepted; nothing confirms delivery or a read.
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("provider_accepted");
    const kinds = log.listForDelivery(WS, KEY).map((f) => f.kind);
    expect(kinds).not.toContain("delivered");
    expect(kinds).not.toContain("seen");
  });

  it("reports delivered/seen only when such a fact was actually recorded", () => {
    const log = new DeliveryFactLog();
    for (const k of ["queued", "provider_accepted", "delivered", "seen"] as const) log.append(WS, fact(k), 1);
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("seen");
  });

  it("advances from accepted to delivered once a delivered fact is recorded", () => {
    const log = new DeliveryFactLog();
    log.append(WS, fact("queued"), 1);
    log.append(WS, fact("provider_accepted"), 1);
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("provider_accepted");
    log.append(WS, fact("delivered"), 1);
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("delivered");
  });

  it("surfaces a terminal failure over prior progress", () => {
    const log = new DeliveryFactLog();
    log.append(WS, fact("queued"), 1);
    log.append(WS, fact("provider_accepted"), 1);
    log.append(WS, fact("bounced"), 1);
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("bounced");
  });

  it("projects 'none' for a delivery with no facts", () => {
    const log = new DeliveryFactLog();
    expect(projectDeliveryStatus(log.listForDelivery(WS, KEY))).toBe("none");
  });

  it("suppresses appends for an erased workspace and shreds its facts (SEC-09)", () => {
    const log = new DeliveryFactLog();
    log.append(WS, fact("queued"), 1);
    log.append(WS, fact("provider_accepted"), 1);
    expect(log.eraseSubject(WS, 5)).toBe(2);
    expect(log.list(WS)).toHaveLength(0);
    // a late provider webhook at the old epoch cannot regenerate a fact.
    expect(log.append(WS, fact("delivered"), 3)).toEqual({ appended: false });
    expect(log.list(WS)).toHaveLength(0);
  });

  it("keeps facts for distinct deliveries separate within a workspace", () => {
    const log = new DeliveryFactLog();
    const otherKey = "cause:alert:rule:1|web_push|fp:alice";
    log.append(WS, fact("queued"), 1);
    log.append(WS, { causeId: CAUSE, intentUniqueKey: otherKey, kind: "queued", occurredAt: "2026-07-16T00:00:00.000Z" }, 1);
    expect(log.listForDelivery(WS, KEY)).toHaveLength(1);
    expect(log.listForDelivery(WS, otherKey)).toHaveLength(1);
    expect(log.list(WS)).toHaveLength(2);
  });
});
